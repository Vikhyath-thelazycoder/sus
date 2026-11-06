import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSignedCookie } from "hono/cookie";
import { app } from "../src/worker/index";
import { EMBED_DIMS } from "../src/worker/platform";
import { fetchChunks, keywordSearch, ownerFilter } from "../src/worker/rag/search";
import { runCleanup } from "../src/worker/cron";
import { UPLOAD } from "../src/shared/limits";
import { ORIGIN } from "./helpers";

const A = "a7a7a7a7-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "b7b7b7b7-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** In-memory Workers AI and Vectorize; the fake index applies the same `$in` owner filter Vectorize does. */
function fakes(overrides: Partial<Record<string, unknown>> = {}) {
  const vectors = new Map<string, { values: number[]; metadata: { owner_id: string } }>();
  const state = { failDeletes: 0, lagChecks: 0, describeCalls: 0 };
  const AI = {
    run: async (_m: string, input: { text: string[] }) => ({
      data: input.text.map(() => Array(EMBED_DIMS).fill(0.01)),
    }),
  };
  const VECTORIZE = {
    upsert: async (vs: { id: string; values: number[]; metadata: { owner_id: string } }[]) =>
      vs.forEach((v) => vectors.set(v.id, v)),
    deleteByIds: async (ids: string[]) => {
      if (state.failDeletes-- > 0) throw new Error("vectorize down");
      ids.forEach((id) => vectors.delete(id));
    },
    // Vectorize applies writes in batches: report "processed up to" in the past while `lagChecks` lasts.
    describe: async () => ({ processedUpToDatetime: new Date(state.describeCalls++ < state.lagChecks ? 0 : Date.now() + 1).toISOString() }),
    query: async (_v: number[], o: { filter: { owner_id: { $in: string[] } } }) => ({
      matches: [...vectors]
        .filter(([, v]) => o.filter.owner_id.$in.includes(v.metadata.owner_id))
        .map(([id]) => ({ id, score: 1 })),
    }),
  };
  return { vectors, state, bindings: { ...env, AI, VECTORIZE, ...overrides } as unknown as Env };
}

const cookieFor = async (owner: string) =>
  (
    await generateSignedCookie("sid", owner, env.ANON_ID_SECRET, { prefix: "host", path: "/", secure: true })
  ).split(";")[0]!;

let f: ReturnType<typeof fakes>;
async function as(owner: string, method: string, path: string, body?: unknown, bindings = f.bindings) {
  return app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: { Cookie: await cookieFor(owner), Origin: ORIGIN, "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    },
    bindings,
  );
}

const create = (pages = 3, title = "My notes on PHA") => ({
  title,
  pages,
  sections: [
    { name: "Introduction", text: "Intro preview.", pageStart: 1, pageEnd: 1 },
    { name: "Results", text: "Results preview.", pageStart: 2, pageEnd: pages },
  ],
});
const chunk = (idx: number, text = `Paper: x. Section: Results.\nchunk ${idx}`, sectionIdx = 1) => ({
  sectionIdx,
  idx,
  text,
  pageStart: 2,
  pageEnd: 2,
});

async function upload(owner: string, text: string, pages = 3) {
  const res = await as(owner, "POST", "/api/uploads", create(pages));
  expect(res.status).toBe(201);
  const { paperId } = (await res.json()) as { paperId: string };
  expect(
    (
      await as(owner, "POST", `/api/uploads/${paperId}/chunks`, {
        chunks: [chunk(0, `Paper: x. Section: Results.\n${text}`)],
      })
    ).status,
  ).toBe(200);
  expect((await as(owner, "POST", `/api/uploads/${paperId}/finish`)).status).toBe(204);
  return paperId;
}

const count = async (sql: string, ...params: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;

beforeEach(async () => {
  f = fakes();
  await env.DB.batch(
    ["chunks", "sections", "papers", "messages", "chats", "vector_tombstones"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});

describe("uploads: server re-validation (T-7.2, SECURITY §5.1)", () => {
  it("assigns IDs, owner and embeddings itself and stores the upload as an unverified, expiring paper", async () => {
    const id = await upload(A, "PHA films degrade ​in soil.");
    expect(id).toMatch(/^p_[0-9a-f]{24}$/);
    const p = await env.DB.prepare(
      "SELECT owner_id, verified, status, expires_at, created_at FROM papers WHERE id = ?1",
    )
      .bind(id)
      .first<Record<string, number | string>>();
    expect(p).toMatchObject({ owner_id: A, verified: 0, status: "ready" });
    expect(Number(p!.expires_at) - Number(p!.created_at)).toBe(UPLOAD.ttlMs);
    const c = await env.DB.prepare("SELECT id, owner_id, text FROM chunks WHERE paper_id = ?1")
      .bind(id)
      .first<Record<string, string>>();
    expect(c).toMatchObject({ id: `${id}:c0`, owner_id: A });
    expect(c!.text).not.toContain("​"); // hidden characters stripped
    expect(f.vectors.get(`${id}:c0`)?.metadata).toEqual({ owner_id: A, paper_id: id });
  });

  it("rejects unknown fields, client IDs, owner fields and vectors", async () => {
    expect((await as(A, "POST", "/api/uploads", { ...create(), owner_id: B })).status).toBe(400);
    expect((await as(A, "POST", "/api/uploads", { ...create(), id: "p_" + "0".repeat(24) })).status).toBe(
      400,
    );
    const id = ((await (await as(A, "POST", "/api/uploads", create())).json()) as { paperId: string })
      .paperId;
    expect(
      (await as(A, "POST", `/api/uploads/${id}/chunks`, { chunks: [{ ...chunk(0), vector: [1, 2] }] }))
        .status,
    ).toBe(400);
    expect(
      (await as(A, "POST", `/api/uploads/${id}/chunks`, { chunks: [{ ...chunk(0), ownerId: B }] })).status,
    ).toBe(400);
  });

  it("rejects a 101-page PDF and pages outside the document (SECURITY §13 #13)", async () => {
    expect((await as(A, "POST", "/api/uploads", create(101))).status).toBe(400);
    const bad = create(3);
    bad.sections[1]!.pageEnd = 4;
    expect((await as(A, "POST", "/api/uploads", bad)).status).toBe(400);
    const id = ((await (await as(A, "POST", "/api/uploads", create(3))).json()) as { paperId: string })
      .paperId;
    expect(
      (
        await as(A, "POST", `/api/uploads/${id}/chunks`, {
          chunks: [{ ...chunk(0), pageStart: 2, pageEnd: 9 }],
        })
      ).status,
    ).toBe(400);
    expect((await as(A, "POST", `/api/uploads/${id}/chunks`, { chunks: [chunk(0, "x", 5)] })).status).toBe(
      400,
    ); // no such section
    expect(
      (await as(A, "POST", `/api/uploads/${id}/chunks`, { chunks: [chunk(UPLOAD.maxChunks)] })).status,
    ).toBe(400);
  });

  it("refuses oversized bodies and 10,000 chunks without writing anything (SECURITY §13 #14)", async () => {
    const id = ((await (await as(A, "POST", "/api/uploads", create())).json()) as { paperId: string })
      .paperId;
    const many = { chunks: Array.from({ length: 10_000 }, (_, i) => chunk(i, "x".repeat(200))) };
    expect((await as(A, "POST", `/api/uploads/${id}/chunks`, many)).status).toBe(413);
    expect(
      (
        await as(A, "POST", `/api/uploads/${id}/chunks`, {
          chunks: Array.from({ length: 33 }, (_, i) => chunk(i)),
        })
      ).status,
    ).toBe(400);
    expect(await count("SELECT count(*) AS n FROM chunks")).toBe(0);
    expect(f.vectors.size).toBe(0);
  });

  it("'finish' waits until Vectorize has applied the vectors, so Ready means a question can find it", async () => {
    const id = ((await (await as(A, "POST", "/api/uploads", create())).json()) as { paperId: string }).paperId;
    await as(A, "POST", `/api/uploads/${id}/chunks`, { chunks: [chunk(0)] });
    f.state.lagChecks = 1;
    const t0 = Date.now();
    expect((await as(A, "POST", `/api/uploads/${id}/finish`)).status).toBe(204);
    expect(f.state.describeCalls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(UPLOAD.searchablePollMs - 50);
  });

  it("won't let another owner add to, finish or delete an upload (404)", async () => {
    const id = ((await (await as(A, "POST", "/api/uploads", create())).json()) as { paperId: string })
      .paperId;
    expect((await as(B, "POST", `/api/uploads/${id}/chunks`, { chunks: [chunk(0)] })).status).toBe(404);
    expect((await as(B, "POST", `/api/uploads/${id}/finish`)).status).toBe(404);
    expect((await as(B, "DELETE", `/api/uploads/${id}`)).status).toBe(404);
    expect((await as(A, "POST", `/api/uploads/${id}/finish`)).status).toBe(404); // no chunks yet
  });

  it("is switched off by UPLOADS_ENABLED=false", async () => {
    const off = fakes({ UPLOADS_ENABLED: "false" });
    expect((await as(A, "POST", "/api/uploads", create(), off.bindings)).status).toBe(503);
  });
});

describe("uploads: quota (SECURITY §12 #3)", () => {
  it("10 parallel uploads with 4 PDFs already stored → exactly 1 succeeds (SECURITY §13 #19)", async () => {
    for (let i = 0; i < 4; i++) await upload(A, `paper ${i}`, 2);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => as(A, "POST", "/api/uploads", create(2))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await count("SELECT count(*) AS n FROM papers WHERE owner_id = ?1", A)).toBe(5);
    // A 6th PDF is refused; B has its own quota.
    expect((await as(A, "POST", "/api/uploads", create(2))).status).toBe(409);
    expect((await as(B, "POST", "/api/uploads", create(2))).status).toBe(201);
  });

  it("counts pages across uploads, and expired uploads stop counting", async () => {
    await upload(A, "big", 95);
    expect((await as(A, "POST", "/api/uploads", create(6))).status).toBe(409);
    expect((await as(A, "POST", "/api/uploads", create(5))).status).toBe(201);
    await env.DB.prepare("UPDATE papers SET expires_at = 1 WHERE owner_id = ?1").bind(A).run();
    expect((await as(A, "POST", "/api/uploads", create(100))).status).toBe(201);
  });
});

describe("uploads are private to their owner (T-7.4, SECURITY §13 #4)", () => {
  it("user A never finds user B's upload, by keyword or by meaning", async () => {
    const idB = await upload(B, "secret-B-token appears here");
    const idA = await upload(A, "my own passage");
    expect(await keywordSearch(f.bindings, "secret-B-token", A)).toEqual([]);
    expect(await keywordSearch(f.bindings, "secret-B-token", B)).toEqual([`${idB}:c0`]);
    const vectorIdsForA = (
      await f.bindings.VECTORIZE.query([], { filter: ownerFilter(A) } as never)
    ).matches.map((m) => m.id);
    expect(vectorIdsForA).toEqual([`${idA}:c0`]);
    // Even if a vector hit leaked through, the D1 re-check drops it.
    expect([...(await fetchChunks(f.bindings, [`${idB}:c0`, `${idA}:c0`], A)).keys()]).toEqual([`${idA}:c0`]);
    // The library lists it only for its owner, labelled as an upload.
    const listA = (
      (await (await as(A, "GET", "/api/papers")).json()) as { papers: { id: string; upload: boolean }[] }
    ).papers;
    expect(listA.map((p) => p.id)).toEqual([idA]);
    expect(listA[0]!.upload).toBe(true);
  });

  it("an unfinished or expired upload is not searchable", async () => {
    const id = ((await (await as(A, "POST", "/api/uploads", create())).json()) as { paperId: string })
      .paperId;
    await as(A, "POST", `/api/uploads/${id}/chunks`, { chunks: [chunk(0)] });
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A)).size).toBe(0); // still processing
    await as(A, "POST", `/api/uploads/${id}/finish`);
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A)).size).toBe(1);
    await env.DB.prepare("UPDATE papers SET expires_at = 1 WHERE id = ?1").bind(id).run();
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A)).size).toBe(0);
  });
});

describe("deleting (T-7.5, SECURITY §12 #16)", () => {
  it("delete a paper, then search its unique text: gone from FTS, D1 and Vectorize (SECURITY §13 #23)", async () => {
    const id = await upload(A, "unique-zebra-token");
    expect(await keywordSearch(f.bindings, "unique-zebra-token", A)).toHaveLength(1);
    expect((await as(A, "DELETE", `/api/uploads/${id}`)).status).toBe(204);
    expect(await keywordSearch(f.bindings, "unique-zebra-token", A)).toEqual([]);
    expect(f.vectors.size).toBe(0);
    expect(await count("SELECT count(*) AS n FROM sections WHERE paper_id = ?1", id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM vector_tombstones")).toBe(0);
    expect((await as(A, "DELETE", `/api/uploads/${id}`)).status).toBe(404);
  });

  it("never deletes curated papers through the upload routes", async () => {
    const pub = "p_" + "9".repeat(24);
    await env.DB.prepare(
      "INSERT INTO papers (id, owner_id, title, status, created_at) VALUES (?1, 'public', 'Curated', 'ready', 0)",
    )
      .bind(pub)
      .run();
    expect((await as(A, "DELETE", `/api/uploads/${pub}`)).status).toBe(404);
    await runCleanup(f.bindings, Number.MAX_SAFE_INTEGER);
    expect(await count("SELECT count(*) AS n FROM papers WHERE id = ?1", pub)).toBe(1);
  });

  it("'delete my data' removes the owner's uploads, vectors, chats and messages, and nobody else's", async () => {
    await upload(A, "a1");
    const idB = await upload(B, "b1");
    const chat = (o: string, id: string) =>
      env.DB.prepare(
        "INSERT INTO chats (id, owner_id, title, created_at, updated_at) VALUES (?1, ?2, 't', 1, 1)",
      ).bind(id, o);
    await env.DB.batch([
      chat(A, "c1111111-1111-4111-8111-111111111111"),
      chat(B, "c2222222-2222-4222-8222-222222222222"),
    ]);
    expect((await as(A, "POST", "/api/me/delete")).status).toBe(204);
    expect(await count("SELECT count(*) AS n FROM papers WHERE owner_id = ?1", A)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM chats WHERE owner_id = ?1", A)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM chats WHERE owner_id = ?1", B)).toBe(1);
    expect([...f.vectors.keys()]).toEqual([`${idB}:c0`]);
  });

  it("if Vectorize fails during a delete, the rows are gone and the cron removes the vectors later", async () => {
    const id = await upload(A, "flaky-delete-token");
    f.state.failDeletes = 1;
    expect((await as(A, "DELETE", `/api/uploads/${id}`)).status).toBe(500);
    expect(await count("SELECT count(*) AS n FROM chunks WHERE paper_id = ?1", id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM vector_tombstones")).toBe(1);
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A)).size).toBe(0); // never shown meanwhile
    expect(await runCleanup(f.bindings)).toEqual({ papers: 0, vectors: 1 });
    expect(f.vectors.size).toBe(0);
    expect(await count("SELECT count(*) AS n FROM vector_tombstones")).toBe(0);
  });
});

describe("daily cleanup cron, fixed clock (T-7.5)", () => {
  it("removes uploads past 7 days and unfinished uploads older than an hour, keeps the rest", async () => {
    const keep = await upload(A, "fresh-token");
    const old = await upload(B, "old-token");
    const stuck = ((await (await as(A, "POST", "/api/uploads", create())).json()) as { paperId: string })
      .paperId;
    await as(A, "POST", `/api/uploads/${stuck}/chunks`, { chunks: [chunk(0, "stuck-token")] });
    const created = Date.now();
    await env.DB.prepare("UPDATE papers SET expires_at = ?2 WHERE id = ?1")
      .bind(old, created + 1000)
      .run();
    await env.DB.prepare("UPDATE papers SET expires_at = ?2 WHERE id = ?1")
      .bind(keep, created + 10 * UPLOAD.ttlMs)
      .run();

    const later = created + UPLOAD.staleMs + 5000;
    expect(await runCleanup(f.bindings, later)).toEqual({ papers: 2, vectors: 2 });
    const left = (await env.DB.prepare("SELECT id FROM papers").all<{ id: string }>()).results.map(
      (r) => r.id,
    );
    expect(left).toEqual([keep]);
    expect([...f.vectors.keys()]).toEqual([`${keep}:c0`]);
    expect(await keywordSearch(f.bindings, "old-token", B)).toEqual([]);
  });
});
