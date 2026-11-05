import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../types";
import { parseJson } from "../security/errors";
import { cleanText } from "../../shared/text";
import { answer, defaultSteps, type AnswerEvent, type AnswerResult, type Steps, type Turn } from "../rag/answer";

/**
 * POST /api/chat → Server-Sent Events (T-4.7). The client sends only the chat ID and the new question; history is
 * loaded from D1 (SECURITY §6.7). Events: status, token, replace (clear/replace the draft), done, error.
 */
const schema = z.strictObject({
  chatId: z.uuid().optional(),
  question: z.string().trim().min(1).max(1000),
});

const CACHE_TTL = 24 * 60 * 60;
const CACHE_VERSION = "v1"; // bump when the prompt or retrieval changes

/** Only questions with no history from owners with no uploads are cached, so an entry is public-only (SECURITY §8). */
export async function cacheKey(question: string): Promise<string> {
  const norm = cleanText(question).toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  return `ans:${CACHE_VERSION}:public:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function parseAuthors(json: string | null): string[] {
  try {
    const v: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** What the citation panel shows: stored passage text and metadata from D1, never model text (SECURITY §7.2). */
const sourcesOut = (r: AnswerResult) =>
  r.sources.map((s) => ({
    n: s.n,
    paperId: s.paperId,
    title: s.title,
    year: s.year,
    doi: s.doi,
    authors: parseAuthors(s.authors),
    section: s.section,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    text: s.text.slice(s.text.indexOf("\n") + 1),
    upload: s.ownerId !== "public",
  }));

export function chatRoutes(steps: Steps = defaultSteps) {
  const chat = new Hono<AppEnv>();

  chat.post("/chat", async (c) => {
    const { chatId: requested, question } = await parseJson(c, schema);
    const ownerId = c.get("ownerId");
    const db = c.env.DB;
    const now = Date.now();

    let chatId = requested;
    let history: Turn[] = [];
    if (chatId) {
      const found = await db.prepare("SELECT id FROM chats WHERE id = ?1 AND owner_id = ?2").bind(chatId, ownerId).first();
      if (!found) throw new HTTPException(404, { message: "Not found" });
      const { results } = await db
        .prepare(
          "SELECT role, content FROM messages WHERE chat_id = ?1 AND owner_id = ?2 AND status = 'ok' ORDER BY created_at DESC LIMIT 10",
        )
        .bind(chatId, ownerId)
        .all<Turn>();
      history = results.reverse();
    } else {
      chatId = crypto.randomUUID();
      await db
        .prepare("INSERT INTO chats (id, owner_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
        .bind(chatId, ownerId, cleanText(question).slice(0, 80), now)
        .run();
    }

    const hasUploads = await db.prepare("SELECT 1 AS x FROM papers WHERE owner_id = ?1 LIMIT 1").bind(ownerId).first();
    const key = !history.length && !hasUploads ? await cacheKey(question) : null;

    return streamSSE(c, async (stream) => {
      const send = (e: AnswerEvent | { type: "done" | "error"; [k: string]: unknown }) =>
        stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      try {
        let result: AnswerResult & { cached?: boolean };
        const hit = key ? await c.env.CACHE.get(key) : null;
        if (hit) {
          result = { ...(JSON.parse(hit) as AnswerResult), cached: true };
          await send({ type: "token", text: result.content });
        } else {
          result = await answer(c.env, { question, history, ownerId, signal: c.req.raw.signal }, send, steps);
          if (key && result.status === "ok") await c.env.CACHE.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL });
        }

        const messageId = crypto.randomUUID();
        const citations = result.sources.map((s) => ({ n: s.n, chunkIds: s.chunkIds }));
        await db.batch([
          db
            .prepare("INSERT INTO messages (id, chat_id, owner_id, role, content, status, created_at) VALUES (?1, ?2, ?3, 'user', ?4, 'ok', ?5)")
            .bind(crypto.randomUUID(), chatId, ownerId, question, now),
          db
            .prepare(
              `INSERT INTO messages (id, chat_id, owner_id, role, content, citations_json, status, model, created_at)
               VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6, ?7, ?8)`,
            )
            .bind(messageId, chatId, ownerId, result.content, JSON.stringify(citations), result.status, result.model, now + 1),
          db.prepare("UPDATE chats SET updated_at = ?1 WHERE id = ?2 AND owner_id = ?3").bind(now + 1, chatId, ownerId),
        ]);
        await send({
          type: "done",
          chatId,
          messageId,
          status: result.status,
          notFound: result.notFound,
          cached: Boolean(result.cached),
          content: result.content,
          sources: sourcesOut(result),
        });
      } catch (err) {
        console.error(JSON.stringify({ level: "error", event: "chat_failed", error: String(err) }));
        await send({ type: "error", message: "Something went wrong" });
      }
    });
  });

  /** Thumbs up/down on an answer (T-5.3). Only the owner's own assistant messages; 0 clears it. */
  chat.post("/messages/:id/feedback", async (c) => {
    const { value } = await parseJson(c, z.strictObject({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }));
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) throw new HTTPException(404, { message: "Not found" });
    const res = await c.env.DB.prepare("UPDATE messages SET feedback = ?1 WHERE id = ?2 AND owner_id = ?3 AND role = 'assistant'")
      .bind(value || null, id, c.get("ownerId"))
      .run();
    if (!res.meta.changes) throw new HTTPException(404, { message: "Not found" });
    return c.body(null, 204);
  });

  return chat;
}
