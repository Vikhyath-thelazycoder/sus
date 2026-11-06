import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSignedCookie } from "hono/cookie";
import { app } from "../src/worker/index";
import { EMBED_DIMS } from "../src/worker/platform";
import { chatFilter, fetchChunks, keywordSearch, ownerFilter, retrieve } from "../src/worker/rag/search";
import { runCleanup } from "../src/worker/cron";
import { UPLOAD } from "../src/shared/limits";
import { ORIGIN } from "./helpers";

const A = "a7a7a7a7-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "b7b7b7b7-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT_A = "c7c7c7c7-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_A2 = "c7c7c7c7-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CHAT_B = "c7c7c7c7-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const chatOf = (owner: string) => (owner === A ? CHAT_A : CHAT_B);

/** In-memory Workers AI and Vectorize; the fake index applies the same `$in` owner filter Vectorize does. */
function fakes(overrides: Partial<Record<string, unknown>> = {}) {
  type Meta = { owner_id: string; chat_id?: string };
  const vectors = new Map<string, { values: number[]; metadata: Meta }>();
  const state = { failDeletes: 0 };
  const AI = {
    run: async (_m: string, input: { text: string[] }) => ({
      data: input.text.map(() => Array(EMBED_DIMS).fill(0.01)),
    }),
  };
  const VECTORIZE = {
    upsert: async (vs: { id: string; values: number[]; metadata: Meta }[]) =>
      vs.forEach((v) => vectors.set(v.id, v)),
    deleteByIds: async (ids: string[]) => {
      if (state.failDeletes-- > 0) throw new Error("vectorize down");
      ids.forEach((id) => vectors.delete(id));
    },
    // Applies the same filters Vectorize does: `$in` on owner_id, or plain equality on owner_id and chat_id.
    query: async (_v: number[], o: { filter: { owner_id: string | { $in: string[] }; chat_id?: string } }) => ({
      matches: [...vectors]
        .filter(([, { metadata: m }]) => {
          const own = o.filter.owner_id;
          return (typeof own === "string" ? m.owner_id === own : own.$in.includes(m.owner_id)) &&
            (o.filter.chat_id === undefined || m.chat_id === o.filter.chat_id);
        })
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

const create = (pages = 3, title = "My notes on PHA", chatId = CHAT_A) => ({
  chatId,
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

async function upload(owner: string, text: string, pages = 3, chatId = chatOf(owner)) {
  const res = await as(owner, "POST", "/api/uploads", create(pages, undefined, chatId));
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
  await env.DB.batch(
    [
      [CHAT_A, A],
      [CHAT_A2, A],
      [CHAT_B, B],
    ].map(([id, owner]) =>
      env.DB.prepare("INSERT INTO chats (id, owner_id, created_at, updated_at) VALUES (?1, ?2, 0, 0)").bind(id, owner),
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
    expect(f.vectors.get(`${id}:c0`)?.metadata).toEqual({ owner_id: A, paper_id: id, chat_id: CHAT_A });
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

  it("'finish' doesn't wait for Vectorize: a question right after Ready finds the upload by keyword (T-7.9)", async () => {
    const id = await upload(A, "fresh-kiwi-token");
    f.vectors.clear(); // Vectorize hasn't applied the writes yet
    const hits = (await retrieve(f.bindings, "fresh-kiwi-token", A, { mode: "hybrid", chatId: CHAT_A })).hits;
    expect(hits.map((h) => h.id)).toEqual([`${id}:c0`]);
    expect((await retrieve(f.bindings, "fresh-kiwi-token", B, { mode: "hybrid", chatId: CHAT_B })).hits).toEqual([]);
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
    expect((await as(B, "POST", "/api/uploads", create(2, undefined, CHAT_B))).status).toBe(201);
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
    expect(await keywordSearch(f.bindings, "secret-B-token", A, 30, CHAT_A)).toEqual([]);
    expect(await keywordSearch(f.bindings, "secret-B-token", A, 30, CHAT_B)).toEqual([]);
    expect(await keywordSearch(f.bindings, "secret-B-token", B, 30, CHAT_B)).toEqual([`${idB}:c0`]);
    const vectorIdsForA = (
      await f.bindings.VECTORIZE.query([], { filter: ownerFilter(A) } as never)
    ).matches.map((m) => m.id);
    expect(vectorIdsForA).toEqual([`${idA}:c0`]);
    // Even if a vector hit leaked through, the D1 re-check drops it.
    expect([...(await fetchChunks(f.bindings, [`${idB}:c0`, `${idA}:c0`], A, CHAT_A)).keys()]).toEqual([`${idA}:c0`]);
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
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A, CHAT_A)).size).toBe(0); // still processing
    await as(A, "POST", `/api/uploads/${id}/finish`);
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A, CHAT_A)).size).toBe(1);
    await env.DB.prepare("UPDATE papers SET expires_at = 1 WHERE id = ?1").bind(id).run();
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A, CHAT_A)).size).toBe(0);
  });
});

describe("deleting (T-7.5, SECURITY §12 #16)", () => {
  it("delete a paper, then search its unique text: gone from FTS, D1 and Vectorize (SECURITY §13 #23)", async () => {
    const id = await upload(A, "unique-zebra-token");
    expect(await keywordSearch(f.bindings, "unique-zebra-token", A, 30, CHAT_A)).toHaveLength(1);
    expect((await as(A, "DELETE", `/api/uploads/${id}`)).status).toBe(204);
    expect(await keywordSearch(f.bindings, "unique-zebra-token", A, 30, CHAT_A)).toEqual([]);
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
    expect(await count("SELECT count(*) AS n FROM chats WHERE owner_id = ?1", B)).toBe(2);
    expect([...f.vectors.keys()]).toEqual([`${idB}:c0`]);
  });

  it("if Vectorize fails during a delete, the rows are gone and the cron removes the vectors later", async () => {
    const id = await upload(A, "flaky-delete-token");
    f.state.failDeletes = 1;
    expect((await as(A, "DELETE", `/api/uploads/${id}`)).status).toBe(500);
    expect(await count("SELECT count(*) AS n FROM chunks WHERE paper_id = ?1", id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM vector_tombstones")).toBe(1);
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A, CHAT_A)).size).toBe(0); // never shown meanwhile
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

describe("chat-scoped PDFs (T-7.11) and the library switch (T-7.12)", () => {
  const ids = async (owner: string, q: string, opts: { chatId?: string; library?: boolean }) =>
    (await retrieve(f.bindings, q, owner, { mode: "hybrid", ...opts })).hits.map((h) => h.id);

  it("a PDF uploaded in chat A is found in chat A only: not in chat B, not by another user", async () => {
    const id = await upload(A, "orchid-scope-token", 3, CHAT_A);
    expect(f.vectors.get(`${id}:c0`)!.metadata).toMatchObject({ owner_id: A, chat_id: CHAT_A });
    expect(await ids(A, "orchid-scope-token", { chatId: CHAT_A })).toEqual([`${id}:c0`]);
    expect(await ids(A, "orchid-scope-token", { chatId: CHAT_A2 })).toEqual([]);
    expect(await ids(A, "orchid-scope-token", {})).toEqual([]); // a chat with no ID yet
    expect(await ids(B, "orchid-scope-token", { chatId: CHAT_A })).toEqual([]);
    // Each layer on its own: keyword list, Vectorize filter, D1 re-check.
    expect(await keywordSearch(f.bindings, "orchid-scope-token", A, 30, CHAT_A2)).toEqual([]);
    expect(await keywordSearch(f.bindings, "orchid-scope-token", A)).toEqual([]);
    expect(await keywordSearch(f.bindings, "orchid-scope-token", B, 30, CHAT_A)).toEqual([]);
    const q = (filter: object) => f.bindings.VECTORIZE.query([0], { topK: 30, filter } as never);
    expect((await q(chatFilter(A, CHAT_A2))).matches).toEqual([]);
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A, CHAT_A2)).size).toBe(0);
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A, null)).size).toBe(0);
    expect((await fetchChunks(f.bindings, [`${id}:c0`], B, CHAT_A)).size).toBe(0);
    expect((await fetchChunks(f.bindings, [`${id}:c0`], A, CHAT_A, false)).size).toBe(1);
  });

  it("won't upload into another owner's chat, or without a chat", async () => {
    expect((await as(A, "POST", "/api/uploads", create(2, undefined, CHAT_B))).status).toBe(404);
    const noChat: Partial<ReturnType<typeof create>> = create(2);
    delete noChat.chatId;
    expect((await as(A, "POST", "/api/uploads", noChat)).status).toBe(400);
  });

  it("library off searches only the chat's PDFs; library uploads (not tied to a chat) need it on", async () => {
    const own = await upload(A, "lotus-lib-token shared-word", 3, CHAT_A);
    const lib = await upload(A, "lotus-lib-token shared-word", 3, CHAT_A2);
    await env.DB.prepare("UPDATE papers SET chat_id = NULL WHERE id = ?1").bind(lib).run(); // kept from a deleted chat
    expect((await ids(A, "shared-word", { chatId: CHAT_A, library: false })).sort()).toEqual([`${own}:c0`]);
    expect((await ids(A, "shared-word", { chatId: CHAT_A, library: true })).sort()).toEqual([`${lib}:c0`, `${own}:c0`].sort());
  });

  it("deleting a chat deletes its PDFs only when asked; otherwise they move to the library", async () => {
    const kept = await upload(A, "kept-token", 3, CHAT_A);
    expect((await as(A, "DELETE", `/api/chats/${CHAT_A}`)).status).toBe(204);
    expect(await env.DB.prepare("SELECT chat_id FROM papers WHERE id = ?1").bind(kept).first("chat_id")).toBeNull();
    const gone = await upload(A, "gone-token", 3, CHAT_A2);
    expect((await as(B, "DELETE", `/api/chats/${CHAT_A2}?pdfs=delete`)).status).toBe(404);
    expect(await count("SELECT count(*) AS n FROM papers WHERE id = ?1", gone)).toBe(1);
    expect((await as(A, "DELETE", `/api/chats/${CHAT_A2}?pdfs=delete`)).status).toBe(204);
    expect(await count("SELECT count(*) AS n FROM papers WHERE id = ?1", gone)).toBe(0);
    expect(f.vectors.has(`${gone}:c0`)).toBe(false);
    expect(await count("SELECT count(*) AS n FROM papers WHERE id = ?1", kept)).toBe(1);
  });

  it("POST /api/chats makes an empty chat for the caller; GET reports its PDFs and library choice", async () => {
    const res = await as(A, "POST", "/api/chats");
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await upload(A, "x", 3, id);
    const got = (await (await as(A, "GET", `/api/chats/${id}`)).json()) as { chat: { pdfs: number; useLibrary: null } };
    expect(got.chat).toMatchObject({ pdfs: 1, useLibrary: null });
    expect((await as(B, "GET", `/api/chats/${id}`)).status).toBe(404);
  });
});
