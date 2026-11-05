import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../src/worker/security/headers";
import { call } from "./helpers";
// Vite's ?raw import keeps this test independent of the filesystem inside the Workers runtime.
import staticHeaders from "../public/_headers?raw";

describe("security headers (SECURITY §3.3, test #21)", () => {
  it("are set on API responses, with no-store", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
  });

  it("are also set on error responses", async () => {
    const res = await call("/api/session", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Security-Policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
  });

  it("static _headers file matches the Worker's headers exactly", () => {
    const parsed = Object.fromEntries(
      staticHeaders
        .split("\n")
        .filter((line) => /^\s+\S/.test(line))
        .map((line) => {
          const i = line.indexOf(":");
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        }),
    );
    expect(parsed).toEqual(SECURITY_HEADERS);
  });

  it("unknown API routes return JSON 404 without leaking details", async () => {
    const res = await call("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
