import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { parseJson } from "../security/errors";
import { retrieve } from "../rag/search";

/** Admin-only retrieval probe for scripts/eval.ts (T-3.6). Searches public papers only; returns the ranking, no text. */
const EVAL_OWNER = "admin-eval"; // not a UUID, so it can never match an anonymous user's uploads

const schema = z.strictObject({
  query: z.string().min(1).max(500),
  mode: z.enum(["vector", "keyword", "hybrid", "rerank"]),
  searchK: z.number().int().min(1).max(100).optional(),
  fuseTop: z.number().int().min(1).max(50).optional(),
  rerankTop: z.number().int().min(1).max(50).optional(),
});

export const adminSearch = new Hono<AppEnv>();

adminSearch.post("/search", async (c) => {
  const { query, ...opts } = await parseJson(c, schema);
  const t0 = Date.now();
  const { hits, timings } = await retrieve(c.env, query, EVAL_OWNER, { ...opts, rankingOnly: true });
  return c.json({
    hits: hits.map((h) => ({ id: h.id, paper_id: h.paper_id, section: h.section, page_start: h.page_start, page_end: h.page_end, score: h.score, rerankScore: h.rerankScore })),
    timings: { ...timings, total: Date.now() - t0 },
  });
});
