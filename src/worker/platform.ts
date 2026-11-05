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

export async function upsertVectors(env: Env, vectors: { id: string; values: number[]; metadata: VectorMeta }[]) {
  if (vectors.length) await env.VECTORIZE.upsert(vectors as unknown as VectorizeVector[]);
}

export async function deleteVectors(env: Env, ids: string[]) {
  for (let i = 0; i < ids.length; i += 100) await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
}
