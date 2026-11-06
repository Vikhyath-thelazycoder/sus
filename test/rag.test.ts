import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EMBED_DIMS, RERANK_MODEL } from "../src/worker/platform";
import {
  buildPassages,
  fetchChunks,
  joinBodies,
  keywordSearch,
  ownerFilter,
  retrieve,
  rrf,
  toFtsQuery,
  type ChunkRow,
  type Hit,
} from "../src/worker/rag/search";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** Seed three papers: two public, one uploaded by owner B containing a secret token. */
beforeAll(async () => {
  const db = env.DB;
  const paper = (id: string, owner: string, title: string) =>
    db
      .prepare("INSERT INTO papers (id, owner_id, title, status, created_at) VALUES (?1, ?2, ?3, 'ready', 0)")
      .bind(id, owner, title);
  const section = (paperId: string, name: string) =>
    db
      .prepare("INSERT INTO sections (id, paper_id, idx, name, text, page_start, page_end) VALUES (?1, ?2, 0, ?3, 'x', 1, 9)")
      .bind(`${paperId}:s0`, paperId, name);
  const chunk = (paperId: string, owner: string, idx: number, text: string, page = 1) =>
    db
      .prepare(
        "INSERT INTO chunks (id, paper_id, section_id, owner_id, idx, text, page_start, page_end) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
      )
      .bind(`${paperId}:c${idx}`, paperId, `${paperId}:s0`, owner, idx, text, page);
  await db.batch([
    paper("p_pub1", "public", "PLA composting"),
    section("p_pub1", "Results"),
    chunk("p_pub1", "public", 0, "Paper: PLA composting. Section: Results.\nPLA meets ASTM D6400 in industrial compost."),
    chunk("p_pub1", "public", 1, "Paper: PLA composting. Section: Results.\nBlends of PLA and PBAT degrade faster.", 2),
    chunk("p_pub1", "public", 2, "Paper: PLA composting. Section: Results.\nHome composting is slower.", 3),
    paper("p_pub2", "public", "Chitin"),
    section("p_pub2", "Method"),
    chunk("p_pub2", "public", 0, "Paper: Chitin. Section: Method.\nHydrochloric acid removes calcium carbonate."),
    paper("p_userb", B, "My upload"),
    section("p_userb", "Notes"),
    chunk("p_userb", B, 0, "Paper: My upload. Section: Notes.\nsecret-B-token PLA notes."),
  ]);
});

describe("keyword search (T-3.3)", () => {
  it("quotes every term so FTS5 syntax is literal", () => {
    expect(toFtsQuery('owner_id:x NEAR( "a" b* ^c')).toBe('"owner_id:x" OR "NEAR(" OR """a""" OR "b*" OR "^c"');
    expect(toFtsQuery("   ")).toBe("");
    expect(toFtsQuery(Array(40).fill("w").join(" ")).split(" OR ")).toHaveLength(32);
    expect(toFtsQuery("x".repeat(100))).toBe(`"${"x".repeat(64)}"`);
  });

  it("finds exact technical terms", async () => {
    expect(await keywordSearch(env, "ASTM D6400", A)).toContain("p_pub1:c0");
    expect(await keywordSearch(env, "PBAT", A)).toEqual(["p_pub1:c1"]);
    // The contextual header ("Paper: PLA composting") is indexed too, so every chunk of that paper matches.
    expect((await keywordSearch(env, "PLA", A)).sort()).toEqual(["p_pub1:c0", "p_pub1:c1", "p_pub1:c2"]);
  });

  it("treats SQL and FTS5 payloads as text: no error, no leak (SECURITY §13 #5, #6)", async () => {
    for (const q of ["' OR 1=1 --", "owner_id:*", "owner_id:" + B, "NEAR(", '"', "*", "^", "PLA) OR (secret", "secret-B-token"]) {
      const ids = await keywordSearch(env, q, A);
      expect(ids.some((id) => id.startsWith("p_userb"))).toBe(false);
    }
  });

  it("keeps uploads to their owner (SECURITY §13 #4, D1 FTS)", async () => {
    expect(await keywordSearch(env, "secret-B-token", A)).toEqual([]);
    expect(await keywordSearch(env, "secret-B-token", B)).toEqual(["p_userb:c0"]);
  });
});

describe("owner isolation in meaning search (T-3.2, SECURITY §13 #4)", () => {
  it("builds the Vectorize filter on the server from the owner ID", () => {
    expect(ownerFilter(A)).toEqual({ owner_id: { $in: ["public", A] } });
  });

  it("re-checks owners in D1, so a leaky vector index still can't return B's chunk to A", async () => {
    const rows = await fetchChunks(env, ["p_userb:c0", "p_pub1:c0", "p_missing:c9"], A);
    expect([...rows.keys()]).toEqual(["p_pub1:c0"]);
    expect([...(await fetchChunks(env, ["p_userb:c0"], B)).keys()]).toEqual(["p_userb:c0"]);
  });

  it("end to end: user A never sees user B's upload, even if Vectorize ignored the filter", async () => {
    const filters: unknown[] = [];
    const AI = {
      run: async (model: string, input: { text?: string[]; contexts?: unknown[] }) =>
        model === RERANK_MODEL
          ? { response: input.contexts!.map((_, id) => ({ id, score: 0.5 })) }
          : { data: input.text!.map(() => Array(EMBED_DIMS).fill(0.01)) },
    };
    const VECTORIZE = {
      query: async (_v: number[], o: { filter: unknown }) => {
        filters.push(o.filter);
        return { matches: [{ id: "p_userb:c0", score: 0.99 }, { id: "p_pub1:c0", score: 0.8 }] };
      },
    };
    const bindings = { ...env, AI, VECTORIZE } as unknown as Env;
    const r = await retrieve(bindings, "secret-B-token PLA", A);
    expect(filters).toEqual([{ owner_id: { $in: ["public", A] } }]);
    expect(r.hits.map((h) => h.id)).not.toContain("p_userb:c0");
    expect(r.passages.flatMap((p) => p.chunkIds)).not.toContain("p_userb:c0");
    expect(r.hits[0]!.rerankScore).toBe(0.5);
  });
});

describe("fusion (T-3.4)", () => {
  it("matches the RAG guide's worked example", () => {
    expect(rrf([["D", "A", "C"], ["A", "B", "D"]]).map((x) => x.id)).toEqual(["A", "D", "B", "C"]);
  });
  it("deduplicates ids present in both lists", () => {
    expect(rrf([["A", "B"], ["B", "A"]])).toHaveLength(2);
  });
  it("an own upload Vectorize hasn't applied yet still beats curated chunks (T-7.9)", async () => {
    expect((await keywordSearch(env, "PLA", B))[0]).not.toBe("p_userb:c0"); // curated chunks rank first alone
    expect(await keywordSearch(env, "PLA", B, 30, true)).toEqual(["p_userb:c0"]);
    const AI = { run: async () => ({ data: [Array(EMBED_DIMS).fill(0.01)] }) };
    // Vectorize lags: it returns only curated text. (A curated chunk top of both other lists can still tie the upload.)
    const VECTORIZE = { query: async () => ({ matches: [{ id: "p_pub2:c0", score: 0.9 }] }) };
    const bindings = { ...env, AI, VECTORIZE } as unknown as Env;
    const r = await retrieve(bindings, "PLA", B, { mode: "hybrid", fuseTop: 1 });
    expect(r.hits.map((h) => h.id)).toEqual(["p_userb:c0"]);
  });
});

describe("passages (T-3.5)", () => {
  const row = (idx: number, body: string, section = "s0", paper = "p"): ChunkRow => ({
    id: `${paper}:c${idx}`,
    paper_id: paper,
    section_id: `${paper}:${section}`,
    idx,
    text: `Paper: T. Section: S.\n${body}`,
    page_start: idx + 1,
    page_end: idx + 1,
    section: "S",
    title: "T",
    year: 2020,
    doi: null,
    authors: null,
    owner_id: "public",
  });
  const hit = (r: ChunkRow, score: number): Hit => ({ ...r, score });

  it("removes the sentence overlap when joining neighbours", () => {
    expect(joinBodies("One here. Two is carried over.", "Two is carried over. Three.")).toBe("One here. Two is carried over. Three.");
    expect(joinBodies("No overlap.", "Fresh start.")).toBe("No overlap. Fresh start.");
  });

  it("keeps best-first order, adds same-section neighbours and merges touching chunks", () => {
    const c1 = row(1, "Middle bit."), c2 = row(2, "Next bit."), c0 = row(0, "First bit.");
    const other = row(5, "Elsewhere.", "s1");
    const hits = [hit(c2, 0.9), hit(other, 0.5)];
    const nb = new Map([c1, row(3, "Other section.", "s9"), row(4, "Before other.", "s0"), row(6, "After other.", "s1")].map((r) => [r.id, r]));
    const ps = buildPassages(hits, nb);
    expect(ps.map((p) => p.n)).toEqual([1, 2]);
    expect(ps[0]!.chunkIds).toEqual(["p:c1", "p:c2"]); // c3 is another section: not added
    expect(ps[0]!.text).toBe("Paper: T. Section: S.\nMiddle bit. Next bit.");
    expect(ps[0]!.pageStart).toBe(2);
    expect(ps[1]!.chunkIds).toEqual(["p:c5", "p:c6"]); // c4 is in s0, not s1
    // Two hits that touch become one passage, ranked at the better hit.
    expect(buildPassages([hit(c1, 0.9), hit(c0, 0.8)], new Map()).map((p) => p.chunkIds)).toEqual([["p:c0", "p:c1"]]);
  });

  it("never exceeds the token budget", () => {
    const big = (i: number) => row(i * 10, "x".repeat(2000)); // ~506 tokens each with the header
    const hits = Array.from({ length: 8 }, (_, i) => hit(big(i), 1 - i / 10));
    const nb = new Map(Array.from({ length: 8 }, (_, i) => row(i * 10 + 1, "y".repeat(2000))).map((r) => [r.id, r]));
    const ps = buildPassages(hits, nb, 3000);
    const tokens = ps.reduce((n, p) => n + Math.ceil(p.text.length / 4), 0);
    expect(tokens).toBeLessThanOrEqual(3000);
    expect(ps[0]!.chunkIds[0]).toBe("p:c0"); // best hit always first
    expect(ps.length).toBe(5);
  });
});
