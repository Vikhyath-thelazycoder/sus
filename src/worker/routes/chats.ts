import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../types";
import { parseJson } from "../security/errors";
import { cleanText } from "../../shared/text";
import { fetchChunks, joinBodies, type ChunkRow, type Passage } from "../rag/search";
import { toClientSource } from "./chat";

/** Chat history (T-6.3): list, open, rename, delete. Every statement is scoped to the caller's owner ID. */
const chatId = z.uuid();
const notFound = () => new HTTPException(404, { message: "Not found" });

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations_json: string | null;
  status: "ok" | "declined" | "unverified" | "error";
  feedback: number | null;
  created_at: number;
}

function citations(json: string | null): { n: number; chunkIds: string[] }[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((c): c is { n: number; chunkIds: string[] } => Number.isInteger(c?.n) && Array.isArray(c?.chunkIds)).slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

const body = (text: string) => text.slice(text.indexOf("\n") + 1);

export const chats = new Hono<AppEnv>();

chats.get("/chats", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, created_at, updated_at FROM chats WHERE owner_id = ?1 ORDER BY updated_at DESC LIMIT 100",
  )
    .bind(c.get("ownerId"))
    .all<{ id: string; title: string; created_at: number; updated_at: number }>();
  return c.json({ chats: results.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at })) });
});

/**
 * Reopen a chat. Sources are rebuilt from the stored chunk IDs through the same owner re-check as search, so the panel
 * shows the stored passage, and a paper deleted since then simply drops out of the list.
 */
chats.get("/chats/:id", async (c) => {
  const id = c.req.param("id");
  if (!chatId.safeParse(id).success) throw notFound();
  const ownerId = c.get("ownerId");
  const db = c.env.DB;
  const chat = await db.prepare("SELECT id, title FROM chats WHERE id = ?1 AND owner_id = ?2").bind(id, ownerId).first<{ id: string; title: string }>();
  if (!chat) throw notFound();
  const { results: rows } = await db
    .prepare(
      "SELECT id, role, content, citations_json, status, feedback, created_at FROM messages WHERE chat_id = ?1 AND owner_id = ?2 ORDER BY created_at LIMIT 200",
    )
    .bind(id, ownerId)
    .all<MessageRow>();

  const allIds = [...new Set(rows.flatMap((r) => citations(r.citations_json).flatMap((x) => x.chunkIds)))];
  const chunks = new Map<string, ChunkRow>();
  for (let i = 0; i < allIds.length; i += 90) for (const [k, v] of await fetchChunks(c.env, allIds.slice(i, i + 90), ownerId)) chunks.set(k, v);

  const messages = rows.map((r) => {
    const sources = citations(r.citations_json).flatMap(({ n, chunkIds }) => {
      const found = chunkIds.map((cid) => chunks.get(cid)).filter((x): x is ChunkRow => Boolean(x));
      const first = found[0];
      if (!first) return [];
      const passage: Passage = {
        n,
        chunkIds: found.map((f) => f.id),
        paperId: first.paper_id,
        title: first.title,
        year: first.year,
        doi: first.doi,
        authors: first.authors,
        section: first.section,
        pageStart: Math.min(...found.map((f) => f.page_start)),
        pageEnd: Math.max(...found.map((f) => f.page_end)),
        ownerId: first.owner_id,
        text: `\n${found.map((f) => body(f.text)).reduce(joinBodies)}`,
        score: 0,
      };
      return [toClientSource(passage)];
    });
    return {
      id: r.id,
      role: r.role,
      content: r.content,
      status: r.status,
      feedback: r.feedback ?? 0,
      createdAt: r.created_at,
      ...(r.role === "assistant" ? { sources } : {}),
    };
  });
  return c.json({ chat: { id: chat.id, title: chat.title }, messages });
});

chats.patch("/chats/:id", async (c) => {
  const id = c.req.param("id");
  if (!chatId.safeParse(id).success) throw notFound();
  const { title } = await parseJson(c, z.strictObject({ title: z.string().trim().min(1).max(80) }));
  const res = await c.env.DB.prepare("UPDATE chats SET title = ?1 WHERE id = ?2 AND owner_id = ?3").bind(cleanText(title), id, c.get("ownerId")).run();
  if (!res.meta.changes) throw notFound();
  return c.body(null, 204);
});

chats.delete("/chats/:id", async (c) => {
  const id = c.req.param("id");
  if (!chatId.safeParse(id).success) throw notFound();
  const ownerId = c.get("ownerId");
  const db = c.env.DB;
  // Messages first (explicitly, not relying on the foreign-key cascade), then the chat, in one batch.
  const [, del] = await db.batch([
    db.prepare("DELETE FROM messages WHERE chat_id = ?1 AND owner_id = ?2").bind(id, ownerId),
    db.prepare("DELETE FROM chats WHERE id = ?1 AND owner_id = ?2").bind(id, ownerId),
  ]);
  if (!del!.meta.changes) throw notFound();
  return c.body(null, 204);
});
