import { describe, expect, it } from "vitest";
import { complete, LlmUnavailableError, llmConfigFromEnv, streamChat, type LlmConfig } from "../src/worker/llm";
import { env } from "cloudflare:test";

/** A fake OpenAI-compatible endpoint: each model answers with the status listed for it. */
function fakeProvider(statusByModel: Record<string, number>) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.model);
    const status = statusByModel[body.model] ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
    return Response.json({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `hi from ${body.model}` } }],
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const config = (fetchImpl: typeof fetch): LlmConfig => ({
  apiKey: "k",
  baseURL: "https://llm.test/v1",
  models: ["big", "medium", "small"],
  fetch: fetchImpl,
});

describe("LLM provider + fallback chain (PROJECT_PLAN §6.6)", () => {
  it("uses the first model when it works", async () => {
    const { calls, fetchImpl } = fakeProvider({});
    const out = await complete(config(fetchImpl), [{ role: "user", content: "q" }]);
    expect(out).toEqual({ text: "hi from big", model: "big" });
    expect(calls).toEqual(["big"]);
  });

  it("falls back on 429 and 5xx", async () => {
    const { calls, fetchImpl } = fakeProvider({ big: 429, medium: 503 });
    const out = await complete(config(fetchImpl), [{ role: "user", content: "q" }]);
    expect(out.model).toBe("small");
    expect(calls).toEqual(["big", "medium", "small"]);
  });

  it("does not fall back on a client error such as a bad key", async () => {
    const { calls, fetchImpl } = fakeProvider({ big: 401 });
    await expect(complete(config(fetchImpl), [{ role: "user", content: "q" }])).rejects.toThrow();
    expect(calls).toEqual(["big"]);
  });

  it("reports unavailable when every model is rate limited", async () => {
    const { fetchImpl } = fakeProvider({ big: 429, medium: 429, small: 429 });
    await expect(complete(config(fetchImpl), [{ role: "user", content: "q" }])).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("reads provider settings from config, so switching to OpenAI needs no code change", () => {
    const cfg = llmConfigFromEnv(env);
    expect(cfg.baseURL).toBe("https://api.groq.com/openai/v1");
    expect(cfg.models).toEqual(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
    // The small model leads for guard/rewrite and falls back to the answer models.
    expect(llmConfigFromEnv(env, "small").models).toEqual(["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
  });
});

describe("streaming (T-4.4)", () => {
  /** SSE chunks in the OpenAI format; a model listed in `stall` sends headers and then nothing. */
  function streamingProvider(stall: string[]) {
    const calls: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { model } = JSON.parse(String(init?.body));
      calls.push(model);
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(ctrl) {
          if (stall.includes(model)) {
            init?.signal?.addEventListener("abort", () => ctrl.error(new DOMException("aborted", "AbortError")));
            return;
          }
          for (const piece of ["PLA ", "composts ", "[1]."]) {
            const chunk = { id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
          ctrl.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("streams token by token", async () => {
    const { fetchImpl } = streamingProvider([]);
    const pieces: string[] = [];
    const out = await streamChat(config(fetchImpl), [{ role: "user", content: "q" }], (t) => void pieces.push(t));
    expect(pieces).toEqual(["PLA ", "composts ", "[1]."]);
    expect(out).toMatchObject({ text: "PLA composts [1].", model: "big" });
  });

  it("moves to the next model when a stream stalls past the deadline (SECURITY §7.4)", async () => {
    const { calls, fetchImpl } = streamingProvider(["big"]);
    const t0 = Date.now();
    const out = await streamChat({ ...config(fetchImpl), timeoutMs: 200 }, [{ role: "user", content: "q" }], () => {});
    expect(out.model).toBe("medium");
    expect(calls).toEqual(["big", "medium"]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

