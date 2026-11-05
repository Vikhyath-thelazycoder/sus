import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../types";
import { parseJson } from "../security/errors";
import { cleanText } from "../../shared/text";
import { deleteVectors, embed, upsertVectors } from "../platform";

/** Curated papers (T-2.6). Only reachable with the admin token; everything here is owned by "public". */
const OWNER = "public";
const TOPICS = ["biopolymers", "green-chemistry", "packaging", "biomaterials"] as const;

const page = z.number().int().min(1).max(500);
const createSchema = z.strictObject({
  paper: z.strictObject({
    doi: z.string().regex(/^10\.\d{4,9}\/\S{1,200}$/),
    title: z.string().min(3).max(500),
    authors: z.array(z.string().max(200)).max(50),
    year: z.number().int().min(1900).max(2100).nullable(),
    journal: z.string().max(300).nullable(),
    license: z.string().max(50),
    sourceUrl: z.url({ protocol: /^https$/ }).max(1000),
    topic: z.enum(TOPICS),
    pages: page,
  }),
  sections: z
    .array(z.strictObject({ name: z.string().min(1).max(200), text: z.string().min(1).max(100_000), pageStart: page, pageEnd: page }))
    .min(1)
    .max(200),
});
const chunksSchema = z.strictObject({
  chunks: z
    .array(
      z.strictObject({
        sectionIdx: z.number().int().min(0).max(199),
        idx: z.number().int().min(0).max(9999),
        text: z.string().min(1).max(4000),
        pageStart: page,
        pageEnd: page,
      }),
    )
    .min(1)
    .max(32),
});

/** Deterministic ID from owner + DOI, so re-ingesting a paper replaces it instead of duplicating it. */
export async function paperIdFor(owner: string, doi: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${owner}:${doi.toLowerCase()}`));
  return `p_${[...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
export const sectionId = (paperId: string, i: number) => `${paperId}:s${i}`;
export const chunkId = (paperId: string, idx: number) => `${paperId}:c${idx}`;

export const adminPapers = new Hono<AppEnv>();

adminPapers.post("/papers", async (c) => {
  const { paper, sections } = await parseJson(c, createSchema);
  const db = c.env.DB;
  const paperId = await paperIdFor(OWNER, paper.doi);

  // Replace any earlier version: its vectors first (D1 cascade removes rows and keyword-index entries).
  const old = await db.prepare("SELECT id FROM chunks WHERE paper_id = ?1").bind(paperId).all<{ id: string }>();
  await deleteVectors(c.env, old.results.map((r) => r.id));

  await db.batch([
    db.prepare("DELETE FROM papers WHERE id = ?1").bind(paperId),
    db
      .prepare(
        `INSERT INTO papers (id, owner_id, title, authors, year, journal, doi, license, source_url, topic, verified, pages, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, 'processing', ?12)`,
      )
      .bind(
        paperId,
        OWNER,
        cleanText(paper.title),
        JSON.stringify(paper.authors.map(cleanText)),
        paper.year,
        paper.journal && cleanText(paper.journal),
        paper.doi,
        paper.license,
        paper.sourceUrl,
        paper.topic,
        paper.pages,
        Date.now(),
      ),
    ...sections.map((s, i) =>
      db
        .prepare("INSERT INTO sections (id, paper_id, idx, name, text, page_start, page_end) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(sectionId(paperId, i), paperId, i, cleanText(s.name), cleanText(s.text), s.pageStart, s.pageEnd),
    ),
  ]);
  return c.json({ paperId, sections: sections.length }, 201);
});

adminPapers.post("/papers/:id/chunks", async (c) => {
  const paperId = c.req.param("id");
  if (!/^p_[0-9a-f]{24}$/.test(paperId)) throw new HTTPException(400, { message: "Invalid request" });
  const { chunks } = await parseJson(c, chunksSchema);
  const db = c.env.DB;

  const found = await db
    .prepare("SELECT (SELECT count(*) FROM sections WHERE paper_id = ?1) AS sections FROM papers WHERE id = ?1 AND owner_id = ?2")
    .bind(paperId, OWNER)
    .first<{ sections: number }>();
  if (!found) throw new HTTPException(404, { message: "Not found" });
  if (chunks.some((ch) => ch.sectionIdx >= found.sections)) throw new HTTPException(400, { message: "Invalid request" });

  const texts = chunks.map((ch) => cleanText(ch.text));
  const vectors = await embed(c.env, texts);

  // Upsert, so a retried batch never creates duplicates.
  await db.batch([
    ...chunks.map((ch, i) =>
      db
        .prepare(
          `INSERT INTO chunks (id, paper_id, section_id, owner_id, idx, text, page_start, page_end)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (id) DO UPDATE SET text = excluded.text, section_id = excluded.section_id,
             page_start = excluded.page_start, page_end = excluded.page_end`,
        )
        .bind(chunkId(paperId, ch.idx), paperId, sectionId(paperId, ch.sectionIdx), OWNER, ch.idx, texts[i], ch.pageStart, ch.pageEnd),
    ),
    db.prepare("UPDATE papers SET status = 'ready' WHERE id = ?1").bind(paperId),
  ]);
  await upsertVectors(
    c.env,
    chunks.map((ch, i) => ({ id: chunkId(paperId, ch.idx), values: vectors[i]!, metadata: { owner_id: OWNER, paper_id: paperId } })),
  );
  return c.json({ stored: chunks.length });
});
