import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generateSignedCookie } from "hono/cookie";
import { identity } from "../src/worker/security/identity";
import type { AppEnv } from "../src/worker/types";
import { call } from "./helpers";

const COOKIE = "__Host-sid";

/** A probe app that echoes the resolved owner ID, so tests can see what the middleware decided. */
const probe = new Hono<AppEnv>().use(identity).get("/", (c) => c.json({ ownerId: c.get("ownerId") }));
const ask = (cookie?: string, bindings: Partial<Env> = {}) =>
  probe.request("https://sustainiq.test/", { headers: cookie ? { Cookie: cookie } : {} }, { ...env, ...bindings });

const cookiePair = (setCookie: string | null) => setCookie!.split(";")[0]!;

describe("anonymous identity (SECURITY §3.2, tests #2, #3)", () => {
  it("issues a signed __Host- cookie with safe flags on first visit", async () => {
    const res = await call("/api/session");
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^__Host-sid=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/);
  });

  it("keeps the same ID when the cookie is valid, without re-setting it", async () => {
    const first = await ask();
    const { ownerId } = await first.json<{ ownerId: string }>();
    const second = await ask(cookiePair(first.headers.get("Set-Cookie")));
    expect((await second.json<{ ownerId: string }>()).ownerId).toBe(ownerId);
    expect(second.headers.get("Set-Cookie")).toBeNull();
  });

  it("gives a tampered cookie a brand-new ID", async () => {
    const first = await ask();
    const { ownerId } = await first.json<{ ownerId: string }>();
    const [name, value] = cookiePair(first.headers.get("Set-Cookie")).split("=");
    const tampered = `${name}=${decodeURIComponent(value!).replace(/^./, (ch) => (ch === "a" ? "b" : "a"))}`;
    const res = await ask(tampered);
    const body = await res.json<{ ownerId: string }>();
    expect(body.ownerId).not.toBe(ownerId);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-sid=/);
  });

  it("rejects a cookie signed with an unknown secret", async () => {
    const forged = await generateSignedCookie("sid", crypto.randomUUID(), "attacker-secret", { prefix: "host", secure: true, path: "/" });
    const victim = forged.split(";")[0]!.split("=")[1];
    const res = await ask(`${COOKIE}=${victim}`);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-sid=/); // fresh identity issued
  });

  it("rejects a signed value that isn't a UUID", async () => {
    const odd = await generateSignedCookie("sid", "public", env.ANON_ID_SECRET, { prefix: "host", secure: true, path: "/" });
    const res = await ask(odd.split(";")[0]);
    expect((await res.json<{ ownerId: string }>()).ownerId).not.toBe("public");
  });

  it("accepts the previous secret during rotation and re-signs with the current one", async () => {
    const id = crypto.randomUUID();
    const old = await generateSignedCookie("sid", id, env.ANON_ID_SECRET_PREV, { prefix: "host", secure: true, path: "/" });
    const res = await ask(old.split(";")[0]);
    expect((await res.json<{ ownerId: string }>()).ownerId).toBe(id);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-sid=/);
  });

  it("ignores owner IDs supplied anywhere but the signed cookie", async () => {
    const res = await probe.request(
      "https://sustainiq.test/?owner_id=public",
      { headers: { "X-Owner-Id": "public" } },
      env,
    );
    expect((await res.json<{ ownerId: string }>()).ownerId).not.toBe("public");
  });

  it("fails closed when the signing secret is missing", async () => {
    const res = await ask(undefined, { ANON_ID_SECRET: "" });
    expect(res.status).toBe(500);
  });
});
