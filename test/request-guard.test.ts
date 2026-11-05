import { describe, expect, it } from "vitest";
import { call, ORIGIN, postJson } from "./helpers";

describe("request guard (SECURITY §3.1, §3.3)", () => {
  it("rejects state-changing requests from another origin", async () => {
    const res = await postJson("/api/session", {}, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("rejects state-changing requests with no Origin", async () => {
    const res = await call("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("rejects non-JSON bodies", async () => {
    const res = await call("/api/session", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(415);
  });

  it("passes same-origin JSON through to routing", async () => {
    const res = await postJson("/api/session", {});
    expect(res.status).toBe(404); // guard passed; no POST route exists yet
  });

  it("rejects bodies over 1 MB with 413", async () => {
    const res = await postJson("/api/session", { pad: "x".repeat(1024 * 1024 + 10) });
    expect(res.status).toBe(413);
  });
});
