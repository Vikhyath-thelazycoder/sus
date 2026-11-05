import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { timingSafeEqualStrings } from "../src/worker/security/admin";
import { call } from "./helpers";

describe("admin token gate (SECURITY §5.1)", () => {
  it("rejects missing and wrong tokens", async () => {
    expect((await call("/api/admin/ping")).status).toBe(401);
    const wrong = await call("/api/admin/ping", { headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("accepts the right token", async () => {
    const res = await call("/api/admin/ping", {
      headers: { Authorization: `Bearer ${env.ADMIN_INGEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("compares strings correctly regardless of length", async () => {
    expect(await timingSafeEqualStrings("abc", "abc")).toBe(true);
    expect(await timingSafeEqualStrings("abc", "abd")).toBe(false);
    expect(await timingSafeEqualStrings("abc", "abcd")).toBe(false);
  });
});
