import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSignedCookie } from "hono/cookie";
import { call, ORIGIN } from "./helpers";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cookieFor = async (owner: string) =>
  (await generateSignedCookie("sid", owner, env.ANON_ID_SECRET, { prefix: "host", path: "/", secure: true })).split(";")[0]!;

const as = async (owner: string, path: string, init: RequestInit = {}) =>
  call(path, {
    ...init,
    headers: { Cookie: await cookieFor(owner), Origin: ORIGIN, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

const PUB = "p_" + "1".repeat(24);
const UP_A = "p_" + "a".repeat(24);
const UP_B = "p_" + "b".repeat(24);
const EXPIRED = "p_" + "e".repeat(24);
const CHAT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHAT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

beforeAll(async () => {
  const db = env.DB;
  const paper = (id: string, owner: string, title: string, expires: number | null = null) =>
    db
      .prepare(
        "INSERT INTO papers (id, owner_id, title, authors, year, doi, topic, verified, pages, status, created_at, expires_at, source_url) VALUES (?1, ?2, ?3, '[\"A. One\",\"B. Two\"]', 2020, ?4, 'packaging', ?5, 9, 'ready', 0, ?6, 'https://example.org/x')",
      )
      .bind(id, owner, title, owner === "public" ? "10.1/pub" : null, owner === "public" ? 1 : 0, expires);
  const section = (pid: string, idx: number, name: string, text: string) =>
    db.prepare("INSERT INTO sections (id, paper_id, idx, name, text, page_start, page_end) VALUES (?1, ?2, ?3, ?4, ?5, 1, 2)").bind(`${pid}:s${idx}`, pid, idx, name, text);
  const chunk = (pid: string, owner: string, idx: number, text: string) =>
    db
      .prepare("INSERT INTO chunks (id, paper_id, section_id, owner_id, idx, text, page_start, page_end) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 3, 3)")
      .bind(`${pid}:c${idx}`, pid, `${pid}:s1`, owner, idx, `Paper: x. Section: Results.\n${text}`);
  const now = Date.now();
  await db.batch([
    paper(PUB, "public", "Bacterial cellulose packaging"),
    section(PUB, 0, "Abstract", "BC is a promising packaging material."),
    section(PUB, 1, "Results", "Results text."),
    chunk(PUB, "public", 0, "One. This sentence is shared by both."),
    chunk(PUB, "public", 1, "This sentence is shared by both. Two."),
    paper(UP_A, A, "<img src=x onerror=alert(1)> my notes"),
    section(UP_A, 1, "Results", "mine"),
    chunk(UP_A, A, 0, "A's private passage."),
    paper(UP_B, B, "B's secret upload"),
    section(UP_B, 1, "Results", "secret"),
    chunk(UP_B, B, 0, "secret-B-token"),
    paper(EXPIRED, A, "Expired upload", now - 1000),
    db.prepare("INSERT INTO chats (id, owner_id, title, created_at, updated_at) VALUES (?1, ?2, 'A chat', 1, 2)").bind(CHAT_A, A),
    db.prepare("INSERT INTO chats (id, owner_id, title, created_at, updated_at) VALUES (?1, ?2, 'B chat', 1, 3)").bind(CHAT_B, B),
    db.prepare("INSERT INTO messages (id, chat_id, owner_id, role, content, status, created_at) VALUES ('11111111-0000-4000-8000-000000000001', ?1, ?2, 'user', 'Does BC work?', 'ok', 10)").bind(CHAT_A, A),
    db
      .prepare(
        "INSERT INTO messages (id, chat_id, owner_id, role, content, citations_json, status, model, feedback, created_at) VALUES ('11111111-0000-4000-8000-000000000002', ?1, ?2, 'assistant', 'Yes [1][2].', ?3, 'ok', 'm', 1, 11)",
      )
      // [3] points at B's chunk: a tampered or stale citation must never reveal it.
      .bind(CHAT_A, A, JSON.stringify([{ n: 1, chunkIds: [`${PUB}:c0`, `${PUB}:c1`] }, { n: 2, chunkIds: [`${UP_A}:c0`] }, { n: 3, chunkIds: [`${UP_B}:c0`] }])),
  ]);
});

describe("papers API (T-6.1, SECURITY §13 #1)", () => {
  it("lists public papers and the caller's own live uploads only", async () => {
    const res = await as(A, "/api/papers");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const { papers } = await res.json<{ papers: { id: string; upload: boolean; authors: string[]; verified: boolean }[] }>();
    expect(papers.map((p) => p.id).sort()).toEqual([PUB, UP_A].sort());
    expect(papers.find((p) => p.id === PUB)).toMatchObject({ upload: false, verified: true, authors: ["A. One", "B. Two"] });
    expect(papers.find((p) => p.id === UP_A)).toMatchObject({ upload: true, verified: false });
  });

  it("returns paper detail with the abstract and sections, and 404 for other owners, expired or malformed IDs", async () => {
    const ok = await (await as(A, `/api/papers/${PUB}`)).json<{ summary: { name: string }; sections: { name: string }[] }>();
    expect(ok.summary.name).toBe("Abstract");
    expect(ok.sections.map((s) => s.name)).toEqual(["Abstract", "Results"]);
    expect((await as(A, `/api/papers/${UP_B}`)).status).toBe(404);
    expect((await as(B, `/api/papers/${UP_A}`)).status).toBe(404);
    expect((await as(A, `/api/papers/${EXPIRED}`)).status).toBe(404);
    expect((await as(A, "/api/papers/' OR 1=1 --")).status).toBe(404);
  });
});

describe("chat history API (T-6.3, SECURITY §13 #1)", () => {
  it("lists only the caller's chats", async () => {
    const { chats } = await (await as(A, "/api/chats")).json<{ chats: { id: string }[] }>();
    expect(chats.map((c) => c.id)).toContain(CHAT_A);
    expect(chats.map((c) => c.id)).not.toContain(CHAT_B);
  });

  it("reopens a chat with citations rebuilt from stored passages, never another owner's", async () => {
    const res = await as(A, `/api/chats/${CHAT_A}`);
    const { messages } = await res.json<{ messages: { role: string; feedback: number; sources?: { n: number; text: string; upload: boolean }[] }[] }>();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const answer = messages[1]!;
    expect(answer.feedback).toBe(1);
    expect(answer.sources!.map((s) => s.n)).toEqual([1, 2]); // [3] (B's chunk) is dropped
    expect(answer.sources![0]!.text).toBe("One. This sentence is shared by both. Two."); // neighbours joined, overlap removed
    expect(answer.sources![1]!.upload).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("secret-B-token");
  });

  it("hides other owners' chats: open, rename and delete all return 404", async () => {
    expect((await as(B, `/api/chats/${CHAT_A}`)).status).toBe(404);
    expect((await as(B, `/api/chats/${CHAT_A}`, { method: "PATCH", body: JSON.stringify({ title: "pwned" }) })).status).toBe(404);
    expect((await as(B, `/api/chats/${CHAT_A}`, { method: "DELETE" })).status).toBe(404);
    expect((await as(A, "/api/chats/not-a-uuid")).status).toBe(404);
  });

  it("renames with validation", async () => {
    expect((await as(A, `/api/chats/${CHAT_A}`, { method: "PATCH", body: JSON.stringify({ title: "  PLA notes  " }) })).status).toBe(204);
    const { chats } = await (await as(A, "/api/chats")).json<{ chats: { id: string; title: string }[] }>();
    expect(chats.find((c) => c.id === CHAT_A)!.title).toBe("PLA notes");
    expect((await as(A, `/api/chats/${CHAT_A}`, { method: "PATCH", body: JSON.stringify({ title: "" }) })).status).toBe(400);
    expect((await as(A, `/api/chats/${CHAT_A}`, { method: "PATCH", body: JSON.stringify({ title: "x", owner_id: B }) })).status).toBe(400);
  });

  it("deletes a chat and its messages", async () => {
    expect((await as(A, `/api/chats/${CHAT_A}`, { method: "DELETE" })).status).toBe(204);
    expect((await as(A, `/api/chats/${CHAT_A}`)).status).toBe(404);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM messages WHERE chat_id = ?1").bind(CHAT_A).first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect((await as(B, `/api/chats/${CHAT_B}`)).status).toBe(200); // B's chat untouched
  });
});
