import { UPLOAD } from "../shared/limits";
import { deleteVectors } from "./platform";

/**
 * Deleting uploads (T-7.5, SECURITY §12 #16). D1 rows and their vector IDs go together: the IDs are written as
 * tombstones in the same batch that deletes the rows, then removed from Vectorize, then the tombstones are cleared.
 * If Vectorize fails half-way, the cron finishes the job. Search re-checks every hit against D1, so a leftover
 * vector is never shown in the meantime.
 */
/** Returns how many vectors were removed. */
export async function purgePapers(env: Env, paperIds: string[], now = Date.now()): Promise<number> {
  if (!paperIds.length) return 0;
  const db = env.DB;
  const marks = paperIds.map((_, i) => `?${i + 2}`).join(", ");
  // Never curated papers, whatever the caller passes.
  const scope = `paper_id IN (${marks}) AND paper_id IN (SELECT id FROM papers WHERE owner_id != 'public')`;
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO vector_tombstones (id, created_at) SELECT id, ?1 FROM chunks WHERE ${scope}`,
      )
      .bind(now, ...paperIds),
    db.prepare(`DELETE FROM chunks WHERE ${scope}`).bind(now, ...paperIds),
    db.prepare(`DELETE FROM sections WHERE ${scope}`).bind(now, ...paperIds),
    db.prepare(`DELETE FROM papers WHERE id IN (${marks}) AND owner_id != 'public'`).bind(now, ...paperIds),
  ]);
  return flushTombstones(env, 5000);
}

/** Remove tombstoned vectors from Vectorize, then forget them. Safe to repeat. */
export async function flushTombstones(env: Env, limit = 500): Promise<number> {
  const db = env.DB;
  let done = 0;
  for (;;) {
    const { results } = await db
      .prepare("SELECT id FROM vector_tombstones LIMIT ?1")
      .bind(Math.min(90, limit - done))
      .all<{ id: string }>();
    const ids = results.map((r) => r.id);
    if (!ids.length) return done;
    await deleteVectors(env, ids);
    await db
      .prepare(`DELETE FROM vector_tombstones WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})`)
      .bind(...ids)
      .run();
    done += ids.length;
    if (done >= limit) return done;
  }
}

/** Daily job: expired uploads, uploads that never finished, then any vectors still waiting to be deleted. */
export async function runCleanup(env: Env, now = Date.now()) {
  let papers = 0;
  let vectors = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM papers WHERE owner_id != 'public'
         AND ((expires_at IS NOT NULL AND expires_at <= ?1) OR (status != 'ready' AND created_at < ?2))
       LIMIT 50`,
    )
      .bind(now, now - UPLOAD.staleMs)
      .all<{ id: string }>();
    if (!results.length) break;
    vectors += await purgePapers(
      env,
      results.map((r) => r.id),
      now,
    );
    papers += results.length;
  }
  vectors += await flushTombstones(env, 5000);
  return { papers, vectors };
}
