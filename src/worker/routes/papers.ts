import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";

/**
 * Library (T-6.1): curated papers plus the caller's own uploads. Every query is scoped to
 * owner_id IN ('public', me); anything else is a 404, never a 403, so IDs can't be probed (SECURITY §3.2).
 */
const PAPER_ID = /^p_[0-9a-f]{24}$/;
const VISIBLE = "owner_id IN ('public', ?1) AND status = 'ready' AND (expires_at IS NULL OR expires_at > ?2)";

interface PaperRow {
  id: string;
  owner_id: string;
  title: string;
  authors: string | null;
  year: number | null;
  journal: string | null;
  doi: string | null;
  license: string | null;
  source_url: string | null;
  topic: string | null;
  verified: number;
  pages: number | null;
}

export function parseAuthors(json: string | null): string[] {
  try {
    const v: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}

const paperOut = (p: PaperRow) => ({
  id: p.id,
  title: p.title,
  authors: parseAuthors(p.authors),
  year: p.year,
  journal: p.journal,
  doi: p.doi,
  license: p.license,
  // Only https links reach the client; ingestion already validated them (admin-papers schema).
  sourceUrl: p.source_url?.startsWith("https://") ? p.source_url : null,
  topic: p.topic,
  pages: p.pages,
  upload: p.owner_id !== "public",
  verified: p.verified === 1,
});

export const papers = new Hono<AppEnv>();

const COLUMNS = "id, owner_id, title, authors, year, journal, doi, license, source_url, topic, verified, pages";

// shortcut: the whole visible library in one response (≈25 rows); paginate and search server-side past a few hundred papers.
papers.get("/papers", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM papers WHERE ${VISIBLE} ORDER BY owner_id = 'public', title`)
    .bind(c.get("ownerId"), Date.now())
    .all<PaperRow>();
  return c.json({ papers: results.map(paperOut) });
});

papers.get("/papers/:id", async (c) => {
  const id = c.req.param("id");
  if (!PAPER_ID.test(id)) throw new HTTPException(404, { message: "Not found" });
  const db = c.env.DB;
  const paper = await db.prepare(`SELECT ${COLUMNS} FROM papers WHERE id = ?3 AND ${VISIBLE}`).bind(c.get("ownerId"), Date.now(), id).first<PaperRow>();
  if (!paper) throw new HTTPException(404, { message: "Not found" });
  const { results: sections } = await db
    .prepare("SELECT idx, name, page_start, page_end, substr(text, 1, 2400) AS preview FROM sections WHERE paper_id = ?1 ORDER BY idx")
    .bind(id)
    .all<{ idx: number; name: string; page_start: number; page_end: number; preview: string }>();
  // The abstract (or, without one, the first section) is shown as the summary; the rest as a table of contents.
  const summary = sections.find((s) => /^abstract$/i.test(s.name)) ?? sections[0];
  return c.json({
    paper: paperOut(paper),
    summary: summary ? { name: summary.name, text: summary.preview } : null,
    sections: sections.map((s) => ({ name: s.name, pageStart: s.page_start, pageEnd: s.page_end })),
  });
});
