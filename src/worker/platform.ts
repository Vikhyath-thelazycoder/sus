/**
 * Every Workers AI and Vectorize call goes through here (ARCHITECTURE.md "Platform adapter"), so tests can swap in
 * fakes and the demo could move hosts without touching the RAG code.
 */
export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIMS = 1024;

export interface VectorMeta {
  owner_id: string;
  paper_id: string;
}

/** Embed texts with the one model used for both chunks and queries (RAG §4.5 rule 1). */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out = (await env.AI.run(EMBED_MODEL, { text: texts })) as { data?: number[][] };
  const data = out.data;
  if (!data || data.length !== texts.length || data.some((v) => v.length !== EMBED_DIMS)) {
    throw new Error("Unexpected embedding response");
  }
  return data;
}

export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** Cross-encoder relevance score for each text, in input order (RAG §5.6). */
export async function rerankScores(env: Env, query: string, texts: string[]): Promise<number[]> {
  const out = (await env.AI.run(RERANK_MODEL, { query, contexts: texts.map((text) => ({ text })) } as never)) as {
    response?: { id?: number; score?: number }[];
  };
  const scores = new Array<number>(texts.length).fill(Number.NEGATIVE_INFINITY);
  for (const r of out.response ?? []) if (r.id !== undefined && r.id < texts.length) scores[r.id] = r.score ?? 0;
  if (scores.some((s) => s === Number.NEGATIVE_INFINITY)) throw new Error("Unexpected rerank response");
  return scores;
}

export async function upsertVectors(env: Env, vectors: { id: string; values: number[]; metadata: VectorMeta }[]) {
  if (vectors.length) await env.VECTORIZE.upsert(vectors as unknown as VectorizeVector[]);
}

export async function deleteVectors(env: Env, ids: string[]) {
  for (let i = 0; i < ids.length; i += 100) await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
}

/** Up to when Vectorize has applied queued writes: it applies them in batches, seconds to a minute after upsert. */
export async function vectorsProcessedAt(env: Env): Promise<number> {
  const info = (await env.VECTORIZE.describe()) as { processedUpToDatetime?: string | number | null };
  return info.processedUpToDatetime ? new Date(info.processedUpToDatetime).getTime() : 0;
}
