import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSite, envFromProcess, restoreProto } from "../../src/server/node";
import { RestD1, RestKv, RestVectorize } from "../../src/server/cloudflare-rest";
import { SECURITY_HEADERS } from "../../src/worker/security/headers";

const ADMIN = "admin-token-for-tests-0123456789abcdef";
const VARS = {
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_API_TOKEN: "cf-token",
  D1_DATABASE_ID: "db1",
  VECTORIZE_INDEX: "idx",
  KV_NAMESPACE_ID: "kv1",
  LLM_API_KEY: "k",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_MODELS: "m1",
  LLM_SMALL_MODEL: "m1",
  ANON_ID_SECRET: "anon-secret-0123456789abcdef0123",
  ADMIN_INGEST_TOKEN: ADMIN,
};

/** A fake Cloudflare REST API that records calls and answers like the real one. */
function fakeCloudflare() {
  const calls: { method: string; path: string; body: string; auth: string | null; type: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body, auth: headers.get("Authorization"), type: headers.get("Content-Type") });
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (url.pathname.endsWith("/query") && url.pathname.includes("/d1/")) {
      const { batch } = JSON.parse(body) as { batch: { sql: string }[] };
      return ok(batch.map((s) => ({ success: true, meta: {}, results: /\) AS sections FROM papers/.test(s.sql) ? [{ sections: 1 }] : [] })));
    }
    if (url.pathname.includes("/ai/run/")) {
      const { text } = JSON.parse(body) as { text: string[] };
      return ok({ data: text.map(() => Array(1024).fill(0.02)), shape: [text.length, 1024] });
    }
    if (url.pathname.includes("/vectorize/")) return ok({ mutationId: "m" });
    if (url.pathname.includes("/storage/kv/") && (init?.method ?? "GET") === "GET") return new Response("nf", { status: 404 });
    return ok({});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function clientDir() {
  const dir = mkdtempSync(join(tmpdir(), "sustainiq-client-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>SustainIQ</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log(1)");
  return dir;
}

describe("Render demo server (D-012)", () => {
  it("refuses to start when a required secret is missing", () => {
    const rest: Record<string, string | undefined> = { ...VARS };
    delete rest.ADMIN_INGEST_TOKEN;
    expect(() => envFromProcess(rest)).toThrow(/ADMIN_INGEST_TOKEN/);
  });

  it("serves the API with the same security headers and no-store", async () => {
    const site = createSite(envFromProcess(VARS, fakeCloudflare().fetchImpl), clientDir());
    const res = await site.fetch(new Request("https://demo.onrender.com/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Content-Security-Policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
  });

  it("serves the SPA and static assets with security headers; hashed assets are cacheable", async () => {
    const site = createSite(envFromProcess(VARS, fakeCloudflare().fetchImpl), clientDir());
    const page = await site.fetch(new Request("https://demo.onrender.com/library"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>SustainIQ</title>");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    const asset = await site.fetch(new Request("https://demo.onrender.com/assets/app-abc.js"));
    expect(asset.headers.get("Cache-Control")).toContain("immutable");
    expect(asset.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("restores https behind Render's proxy so the same-origin check works", async () => {
    const site = createSite(envFromProcess(VARS, fakeCloudflare().fetchImpl), clientDir());
    const proxied = new Request("http://demo.onrender.com/api/session", {
      method: "POST",
      headers: { "x-forwarded-proto": "https", Origin: "https://demo.onrender.com", "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await site.fetch(restoreProto(proxied))).status).toBe(404); // guard passed (no POST route), not 403
    const spoofedOrigin = new Request("http://demo.onrender.com/api/session", {
      method: "POST",
      headers: { "x-forwarded-proto": "https", Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await site.fetch(restoreProto(spoofedOrigin))).status).toBe(403);
  });

  it("ingests a paper end to end through the REST adapters", async () => {
    const cf = fakeCloudflare();
    const site = createSite(envFromProcess(VARS, cf.fetchImpl), clientDir());
    const auth = { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" };
    const created = await site.fetch(
      new Request("https://demo.onrender.com/api/admin/papers", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          paper: { doi: "10.1234/x.1", title: "PLA", authors: [], year: 2020, journal: null, license: "cc-by", sourceUrl: "https://e.org/p", topic: "biopolymers", pages: 2 },
          sections: [{ name: "Intro", text: "t", pageStart: 1, pageEnd: 1 }],
        }),
      }),
    );
    expect(created.status).toBe(201);
    const { paperId } = (await created.json()) as { paperId: string };
    const stored = await site.fetch(
      new Request(`https://demo.onrender.com/api/admin/papers/${paperId}/chunks`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ chunks: [{ sectionIdx: 0, idx: 0, text: "Paper: PLA. Section: Intro.\nhello", pageStart: 1, pageEnd: 1 }] }),
      }),
    );
    expect(stored.status).toBe(200);

    expect(cf.calls.every((c) => c.auth === "Bearer cf-token")).toBe(true);
    const upsert = cf.calls.find((c) => c.path.endsWith("/vectorize/v2/indexes/idx/upsert"))!;
    expect(upsert.type).toBe("application/x-ndjson");
    expect(JSON.parse(upsert.body.split("\n")[0]!)).toMatchObject({ id: `${paperId}:c0`, metadata: { owner_id: "public", paper_id: paperId } });
    expect(cf.calls.some((c) => c.path === "/client/v4/accounts/acc/ai/run/@cf/baai/bge-m3")).toBe(true);
  });
});

describe("REST adapters", () => {
  it("D1 sends statements as one batch with their params", async () => {
    const cf = fakeCloudflare();
    const db = new RestD1({ accountId: "acc", apiToken: "t", fetch: cf.fetchImpl }, "db1");
    await db.batch([db.prepare("SELECT ?1").bind(5), db.prepare("SELECT ?1, ?2").bind("a", null)]);
    expect(JSON.parse(cf.calls[0]!.body)).toEqual({ batch: [{ sql: "SELECT ?1", params: [5] }, { sql: "SELECT ?1, ?2", params: ["a", null] }] });
    expect(await db.prepare("SELECT 1").first()).toBeNull();
  });

  it("surfaces Cloudflare errors without echoing the request", async () => {
    const failing = (async () => Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 })) as typeof fetch;
    const db = new RestD1({ accountId: "acc", apiToken: "secret-token", fetch: failing }, "db1");
    const err = await db.prepare("SELECT 1").all().catch((e: Error) => e);
    expect(String(err)).toContain("Authentication error");
    expect(String(err)).not.toContain("secret-token");
  });

  it("Vectorize deletes by id and KV treats 404 as missing", async () => {
    const cf = fakeCloudflare();
    const cfg = { accountId: "acc", apiToken: "t", fetch: cf.fetchImpl };
    await new RestVectorize(cfg, "idx").deleteByIds(["a", "b"]);
    expect(JSON.parse(cf.calls[0]!.body)).toEqual({ ids: ["a", "b"] });
    expect(await new RestKv(cfg, "kv1").get("nope")).toBeNull();
  });
});
