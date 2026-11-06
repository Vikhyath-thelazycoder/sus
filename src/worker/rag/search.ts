/**
 * Retrieval (RAG §5.3–5.8): meaning search + keyword search in parallel → RRF → owner re-check in D1 → rerank →
 * neighbour expansion within a token budget. Owner scoping is always built here from the verified owner ID; the
 * client never sends filters (SECURITY §4.3).
 */
import { approxTokens } from "../../shared/text";
import { embed, rerankScores } from "../platform";

export const RETRIEVAL = {
  /** Candidates from each search (RAG §5.5 "retrieve wide"). */
  searchK: 30,
  /** RRF constant from Cormack et al. 2009 (RAG §5.4). */
  rrfK: 60,
  /** Merged candidates sent to the reranker (10 beat 20 and 30 on the golden set, and halves rerank input). */
  fuseTop: 10,
  /** Hits kept after reranking. */
  rerankTop: 6,
  /** Prompt context budget for passages (T-3.5). */
  maxContextTokens: 3000,
} as const;

export type Mode = "vector" | "keyword" | "hybrid" | "rerank";

export interface ChunkRow {
  id: string;
  paper_id: string;
  section_id: string;
  idx: number;
  text: string;
  page_start: number;
  page_end: number;
  section: string;
  title: string;
  year: number | null;
  doi: string | null;
  /** JSON array of names, as stored in D1. */
  authors: string | null;
  owner_id: string;
}

export interface Hit extends ChunkRow {
  score: number;
  /** Cross-encoder score (0–1), kept for the P4 no-answer decision; only set in "rerank" mode. */
  rerankScore?: number;
}

export interface Passage {
  /** Rank-ordered, best first; `n` is the 1-based source number used for citations later (P4). */
  n: number;
  chunkIds: string[];
  paperId: string;
  title: string;
  year: number | null;
  doi: string | null;
  authors: string | null;
  section: string;
  pageStart: number;
  pageEnd: number;
  ownerId: string;
  text: string;
  score: number;
}

// ---------------------------------------------------------------- keyword search (SECURITY §4.2)

/** Each word becomes a quoted literal phrase, so FTS5 operators, column filters and `*`/`^` are inert. */
export function toFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 32)
    .map((t) => `"${t.slice(0, 64).replaceAll('"', '""')}"`)
    .join(" OR ");
}

export async function keywordSearch(env: Env, query: string, ownerId: string, k: number = RETRIEVAL.searchK): Promise<string[]> {
  const match = toFtsQuery(query);
  if (!match) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT c.id FROM chunks_fts JOIN chunks c ON c.seq = chunks_fts.rowid
       WHERE chunks_fts MATCH ?1 AND c.owner_id IN ('public', ?2)
       ORDER BY bm25(chunks_fts) LIMIT ?3`,
    )
      .bind(match, ownerId, k)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  } catch (err) {
    // A malformed query must not become a 500 that leaks SQL (SECURITY §4.2).
    console.error(JSON.stringify({ level: "warn", event: "fts_error", error: String(err) }));
    return [];
  }
}

// ---------------------------------------------------------------- meaning search (SECURITY §4.3)

/** The only place a Vectorize filter is built: public papers plus the caller's own uploads. */
export const ownerFilter = (ownerId: string) => ({ owner_id: { $in: ["public", ownerId] } });

export async function vectorSearch(env: Env, queryVector: number[], ownerId: string, k: number = RETRIEVAL.searchK) {
  const res = await env.VECTORIZE.query(queryVector, { topK: k, filter: ownerFilter(ownerId) });
  return res.matches.map((m) => ({ id: m.id, score: m.score }));
}

// ---------------------------------------------------------------- fusion + owner re-check

/** Reciprocal Rank Fusion (RAG §5.4): compares ranks, not incomparable BM25 and cosine scores. */
export function rrf(lists: string[][], k: number = RETRIEVAL.rrfK): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/** Second owner layer (SECURITY §4.3): only rows that D1 says are public or the caller's own survive. */
export async function fetchChunks(env: Env, ids: string[], ownerId: string): Promise<Map<string, ChunkRow>> {
  if (!ids.length) return new Map();
  const marks = ids.map((_, i) => `?${i + 3}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.paper_id, c.section_id, c.idx, c.text, c.page_start, c.page_end, c.owner_id,
            s.name AS section, p.title, p.year, p.doi, p.authors
     FROM chunks c JOIN sections s ON s.id = c.section_id JOIN papers p ON p.id = c.paper_id
     WHERE c.id IN (${marks}) AND c.owner_id IN ('public', ?1) AND p.owner_id = c.owner_id AND p.status = 'ready'
       AND (p.expires_at IS NULL OR p.expires_at > ?2)`,
  )
    .bind(ownerId, Date.now(), ...ids)
    .all<ChunkRow>();
  return new Map(results.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------- neighbour expansion (RAG §5.8)

const body = (text: string) => text.slice(text.indexOf("\n") + 1);

/** Join consecutive chunks, dropping the ~15% sentence overlap the chunker carried from one into the next. */
export function joinBodies(a: string, b: string): string {
  for (let n = Math.min(a.length, b.length, 800); n >= 20; n--) {
    if (a.endsWith(b.slice(0, n))) return a + b.slice(n);
  }
  return `${a} ${b}`;
}

/**
 * Turn reranked hits into prompt passages: add the chunk before/after each hit (same section) while the budget
 * allows, merge touching chunks into one passage, keep best-first order.
 */
export function buildPassages(hits: Hit[], neighbours: Map<string, ChunkRow>, maxTokens: number = RETRIEVAL.maxContextTokens): Passage[] {
  const chosen = new Map<string, ChunkRow>();
  let used = 0;
  for (const h of hits) {
    const t = approxTokens(h.text);
    if (used + t > maxTokens) continue;
    chosen.set(h.id, h);
    used += t;
  }
  const keyOf = (r: ChunkRow, d: number) => `${r.paper_id}:c${r.idx + d}`;
  for (const h of hits) {
    if (!chosen.has(h.id)) continue;
    for (const d of [-1, 1]) {
      const nb = neighbours.get(keyOf(h, d));
      if (!nb || nb.section_id !== h.section_id || chosen.has(nb.id)) continue;
      const t = approxTokens(body(nb.text));
      if (used + t > maxTokens) continue;
      chosen.set(nb.id, nb);
      used += t;
    }
  }

  const passages: Passage[] = [];
  const placed = new Set<string>();
  for (const h of hits) {
    if (!chosen.has(h.id) || placed.has(h.id)) continue;
    let lo = h.idx;
    let hi = h.idx;
    const inRun = (idx: number) => {
      const r = chosen.get(`${h.paper_id}:c${idx}`);
      return r && r.section_id === h.section_id ? r : undefined;
    };
    while (inRun(lo - 1)) lo--;
    while (inRun(hi + 1)) hi++;
    const run = Array.from({ length: hi - lo + 1 }, (_, i) => inRun(lo + i)!);
    run.forEach((r) => placed.add(r.id));
    const header = run[0]!.text.slice(0, run[0]!.text.indexOf("\n") + 1);
    passages.push({
      n: passages.length + 1,
      chunkIds: run.map((r) => r.id),
      paperId: h.paper_id,
      title: h.title,
      year: h.year,
      doi: h.doi,
      authors: h.authors,
      section: h.section,
      pageStart: Math.min(...run.map((r) => r.page_start)),
      pageEnd: Math.max(...run.map((r) => r.page_end)),
      ownerId: h.owner_id,
      text: header + run.map((r) => body(r.text)).reduce(joinBodies),
      score: h.score,
    });
  }
  return passages;
}

// ---------------------------------------------------------------- pipeline

export interface RetrieveOptions {
  mode?: Mode;
  searchK?: number;
  fuseTop?: number;
  rerankTop?: number;
  maxContextTokens?: number;
  /** Skip neighbour expansion and passage building (the eval only needs the ranking). */
  rankingOnly?: boolean;
}

export interface RetrieveResult {
  /** Final ranking, best first (after rerank when mode = "rerank"). */
  hits: Hit[];
  passages: Passage[];
  timings: Record<string, number>;
}

export async function retrieve(env: Env, query: string, ownerId: string, opts: RetrieveOptions = {}): Promise<RetrieveResult> {
  const mode = opts.mode ?? "rerank";
  const searchK = opts.searchK ?? RETRIEVAL.searchK;
  const fuseTop = opts.fuseTop ?? RETRIEVAL.fuseTop;
  const rerankTop = opts.rerankTop ?? RETRIEVAL.rerankTop;
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, p: Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await p;
    } finally {
      timings[name] = Date.now() - t0;
    }
  };

  const wantVector = mode !== "keyword";
  const wantKeyword = mode !== "vector";
  const [vector, keyword] = await Promise.all([
    wantVector
      ? timed("vector", embed(env, [query]).then(([v]) => vectorSearch(env, v!, ownerId, searchK)))
      : Promise.resolve([]),
    wantKeyword ? timed("keyword", keywordSearch(env, query, ownerId, searchK)) : Promise.resolve([]),
  ]);

  const fused =
    mode === "vector"
      ? vector.slice(0, fuseTop)
      : mode === "keyword"
        ? keyword.slice(0, fuseTop).map((id, i) => ({ id, score: 1 / (i + 1) }))
        : rrf([vector.map((v) => v.id), keyword]).slice(0, fuseTop);

  const rows = await timed("d1", fetchChunks(env, fused.map((f) => f.id), ownerId));
  let hits: Hit[] = fused.flatMap((f) => {
    const row = rows.get(f.id);
    return row ? [{ ...row, score: f.score }] : [];
  });

  if (mode === "rerank" && hits.length) {
    // bge-reranker-base alone lost to plain hybrid on the golden set; fusing both orders beat each (docs/evidence/P3.md).
    const scores = await timed("rerank", rerankScores(env, query, hits.map((h) => h.text)));
    const scored = hits.map((h, i) => ({ ...h, rerankScore: scores[i]! }));
    const byRerank = [...scored].sort((a, b) => b.rerankScore - a.rerankScore).map((h) => h.id);
    const byId = new Map(scored.map((h) => [h.id, h]));
    hits = rrf([scored.map((h) => h.id), byRerank])
      .slice(0, rerankTop)
      .map((f) => ({ ...byId.get(f.id)!, score: f.score }));
  }

  if (opts.rankingOnly) return { hits, passages: [], timings };
  const top = mode === "rerank" ? hits : hits.slice(0, rerankTop);
  const neighbourIds = top.flatMap((h) => [`${h.paper_id}:c${h.idx - 1}`, `${h.paper_id}:c${h.idx + 1}`]);
  const neighbours = await timed("neighbours", fetchChunks(env, [...new Set(neighbourIds)], ownerId));
  return { hits, passages: buildPassages(top, neighbours, opts.maxContextTokens), timings };
}
