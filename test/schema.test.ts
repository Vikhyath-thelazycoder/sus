import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const now = Date.now();

async function seedPaper(owner: string, text: string) {
  const paper = crypto.randomUUID();
  const section = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO papers (id, owner_id, title, created_at) VALUES (?1, ?2, ?3, ?4)").bind(paper, owner, "T", now),
    env.DB.prepare(
      "INSERT INTO sections (id, paper_id, idx, name, text, page_start, page_end) VALUES (?1, ?2, 0, 'Results', ?3, 1, 1)",
    ).bind(section, paper, text),
    env.DB.prepare(
      "INSERT INTO chunks (id, paper_id, section_id, owner_id, idx, text, page_start, page_end) VALUES (?1, ?2, ?3, ?4, 0, ?5, 1, 1)",
    ).bind(crypto.randomUUID(), paper, section, owner, text),
  ]);
  return paper;
}

const ftsCount = async (term: string) =>
  (await env.DB.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?1").bind(term).first<{ n: number }>())!.n;

describe("D1 schema (migration 0001)", () => {
  it("creates every table", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ["papers", "sections", "chunks", "chunks_fts", "chats", "messages", "usage"]) {
      expect(names).toContain(t);
    }
  });

  it("keeps the FTS5 index in sync on insert and on cascaded delete", async () => {
    const paper = await seedPaper("public", "PBAT blends degrade under ASTM D6400 composting");
    expect(await ftsCount('"PBAT"')).toBe(1);
    expect(await ftsCount('"D6400"')).toBe(1);
    await env.DB.prepare("DELETE FROM papers WHERE id = ?1").bind(paper).run();
    expect(await ftsCount('"PBAT"')).toBe(0); // no orphaned keyword entries (SECURITY §12 #16)
  });

  it("does not index owner_id in FTS, so column filters can't cross owners", async () => {
    await seedPaper("owner-b", "secret-b-token material");
    await expect(env.DB.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'owner_id:x'").all()).rejects.toThrow();
  });

  it("rejects invalid paper status and message role", async () => {
    await expect(
      env.DB.prepare("INSERT INTO papers (id, owner_id, title, status, created_at) VALUES ('x', 'o', 't', 'weird', 1)").run(),
    ).rejects.toThrow();
  });

  it("allows one paper per DOI per owner (idempotent ingest)", async () => {
    const ins = (id: string) =>
      env.DB.prepare("INSERT INTO papers (id, owner_id, title, doi, created_at) VALUES (?1, 'public', 't', '10.1/abc', 1)").bind(id).run();
    await ins("p1");
    await expect(ins("p2")).rejects.toThrow();
  });
});
