import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../types";
import { parseJson } from "../security/errors";
import { cleanText } from "../../shared/text";
import { UPLOAD } from "../../shared/limits";
import { deleteVectors, embed, upsertVectors } from "../platform";
import { purgePapers } from "../cron";
import { chunkId, sectionId } from "./admin-papers";

/**
 * User uploads (T-7.2, SECURITY §5.1). The browser parses the PDF and sends text; nothing it sends is trusted:
 * every field is re-validated here, the server picks all IDs and timestamps and computes the embeddings, and the
 * there is no per-user cap on PDFs or pages (owner, 2026-11-06). Same three steps as curated ingestion: create → chunks → finish.
 */
const PAPER_ID = /^p_[0-9a-f]{24}$/;
const page = z.number().int().min(1).max(UPLOAD.maxPages);
const createSchema = z.strictObject({
  /**
   * The chat it is added in (T-7.11): searched only there. The client creates the chat first (POST /api/chats).
   * Absent = added from the Library (T-7.13): a personal-library PDF, used in any chat with the library on.
   */
  chatId: z.uuid().optional(),
  title: z.string().trim().min(1).max(300),
  pages: page,
  sections: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(200),
        text: z.string().max(UPLOAD.sectionPreviewChars),
        pageStart: page,
        pageEnd: page,
      }),
    )
    .min(1)
    .max(200),
});
const chunksSchema = z.strictObject({
  chunks: z
    .array(
      z.strictObject({
        sectionIdx: z.number().int().min(0).max(199),
        idx: z
          .number()
          .int()
          .min(0)
          .max(UPLOAD.maxChunks - 1),
        text: z.string().min(1).max(4000),
        pageStart: page,
        pageEnd: page,
      }),
    )
    .min(1)
    .max(UPLOAD.chunksPerBatch),
});

const bad = () => new HTTPException(400, { message: "Invalid request" });
const notFound = () => new HTTPException(404, { message: "Not found" });
const ordered = (s: { pageStart: number; pageEnd: number }, pages: number) =>
  s.pageStart <= s.pageEnd && s.pageEnd <= pages;

function newPaperId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `p_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function paperIdParam(id: string): string {
  if (!PAPER_ID.test(id)) throw notFound();
  return id;
}

export const uploads = new Hono<AppEnv>();

uploads.post("/uploads", async (c) => {
  // Feature flag for abuse waves (SECURITY incident response); deleting stays possible.
  if (c.env.UPLOADS_ENABLED !== "true") return c.json({ error: "Uploads are paused" }, 503);
  const { chatId, title, pages, sections } = await parseJson(c, createSchema);
  if (sections.some((s) => !ordered(s, pages))) throw bad();

  const ownerId = c.get("ownerId");
  const db = c.env.DB;
  if (
    chatId &&
    !(await db.prepare("SELECT 1 AS x FROM chats WHERE id = ?1 AND owner_id = ?2").bind(chatId, ownerId).first())
  )
    throw notFound();
  const id = newPaperId();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO papers (id, owner_id, title, authors, verified, pages, status, created_at, expires_at, chat_id)
       VALUES (?1, ?2, ?3, '[]', 0, ?4, 'processing', ?5, ?6, ?7)`,
    )
    .bind(id, ownerId, cleanText(title), pages, now, now + UPLOAD.ttlMs, chatId ?? null)
    .run();

  await db.batch(
    sections.map((s, i) =>
      db
        .prepare(
          "INSERT INTO sections (id, paper_id, idx, name, text, page_start, page_end) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(sectionId(id, i), id, i, cleanText(s.name), cleanText(s.text), s.pageStart, s.pageEnd),
    ),
  );
  return c.json({ paperId: id, expiresAt: now + UPLOAD.ttlMs }, 201);
});

/** The caller's own upload that is still being written; anything else is a 404. */
async function ownProcessing(env: Env, id: string, ownerId: string) {
  return env.DB.prepare(
    "SELECT pages, chat_id, (SELECT count(*) FROM sections WHERE paper_id = ?1) AS sections FROM papers WHERE id = ?1 AND owner_id = ?2 AND status = 'processing'",
  )
    .bind(id, ownerId)
    .first<{ pages: number; sections: number; chat_id: string | null }>();
}

uploads.post("/uploads/:id/chunks", async (c) => {
  const id = paperIdParam(c.req.param("id"));
  const { chunks } = await parseJson(c, chunksSchema);
  const ownerId = c.get("ownerId");
  const found = await ownProcessing(c.env, id, ownerId);
  if (!found) throw notFound();
  if (chunks.some((ch) => ch.sectionIdx >= found.sections || !ordered(ch, found.pages))) throw bad();

  const texts = chunks.map((ch) => cleanText(ch.text));
  const vectors = await embed(c.env, texts); // server-side embeddings only; client vectors are never accepted
  const db = c.env.DB;
  await db.batch(
    chunks.map((ch, i) =>
      db
        .prepare(
          `INSERT INTO chunks (id, paper_id, section_id, owner_id, idx, text, page_start, page_end)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (id) DO UPDATE SET text = excluded.text, section_id = excluded.section_id,
             page_start = excluded.page_start, page_end = excluded.page_end`,
        )
        .bind(
          chunkId(id, ch.idx),
          id,
          sectionId(id, ch.sectionIdx),
          ownerId,
          ch.idx,
          texts[i],
          ch.pageStart,
          ch.pageEnd,
        ),
    ),
  );
  const ids = chunks.map((ch) => chunkId(id, ch.idx));
  await upsertVectors(
    c.env,
    ids.map((vid, i) => ({ id: vid, values: vectors[i]!, metadata: { owner_id: ownerId, paper_id: id, ...(found.chat_id ? { chat_id: found.chat_id } : {}) } })),
  );
  // Deleted while this batch was embedding? Then these vectors have no rows: remove them now.
  if (!(await db.prepare("SELECT 1 AS x FROM papers WHERE id = ?1").bind(id).first()))
    await deleteVectors(c.env, ids);
  return c.json({ stored: chunks.length });
});

uploads.post("/uploads/:id/finish", async (c) => {
  const id = paperIdParam(c.req.param("id"));
  if (!(await ownProcessing(c.env, id, c.get("ownerId")))) throw notFound();
  // No wait for Vectorize: keyword search (with an own-uploads list in fusion) finds the chunks at once (T-7.9).
  const res = await c.env.DB.prepare(
    `UPDATE papers SET status = 'ready'
     WHERE id = ?1 AND owner_id = ?2 AND status = 'processing' AND EXISTS (SELECT 1 FROM chunks WHERE paper_id = ?1)`,
  )
    .bind(id, c.get("ownerId"))
    .run();
  if (!res.meta.changes) throw notFound();
  return c.body(null, 204);
});

uploads.delete("/uploads/:id", async (c) => {
  const id = paperIdParam(c.req.param("id"));
  const own = await c.env.DB.prepare("SELECT id FROM papers WHERE id = ?1 AND owner_id = ?2")
    .bind(id, c.get("ownerId"))
    .first();
  if (!own) throw notFound();
  await purgePapers(c.env, [id]);
  return c.body(null, 204);
});

/** "Delete my data" (SECURITY §9): every upload with its vectors, every chat and message, and the usage counters. */
uploads.post("/me/delete", async (c) => {
  const ownerId = c.get("ownerId");
  const db = c.env.DB;
  const { results } = await db
    .prepare("SELECT id FROM papers WHERE owner_id = ?1")
    .bind(ownerId)
    .all<{ id: string }>();
  for (let i = 0; i < results.length; i += 50)
    await purgePapers(
      c.env,
      results.slice(i, i + 50).map((r) => r.id),
    );
  await db.batch([
    db.prepare("DELETE FROM messages WHERE owner_id = ?1").bind(ownerId),
    db.prepare("DELETE FROM chats WHERE owner_id = ?1").bind(ownerId),
    db.prepare("DELETE FROM usage WHERE owner_id = ?1").bind(ownerId),
  ]);
  return c.body(null, 204);
});
