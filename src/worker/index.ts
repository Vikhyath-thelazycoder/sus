import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./types";
import { securityHeaders } from "./security/headers";
import { requestGuard } from "./security/request-guard";
import { identity } from "./security/identity";
import { requireAdmin } from "./security/admin";
import { errorHandler } from "./security/errors";
import { llmConfigFromEnv } from "./llm";
import { adminPapers } from "./routes/admin-papers";

export const app = new Hono<AppEnv>();

app.use("/api/*", securityHeaders);
app.use(
  "/api/*",
  bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }),
);
app.use("/api/*", requestGuard);

app.get("/api/health", (c) => c.json({ ok: true }));

// Everything else under /api/* (except admin) runs with the signed anonymous identity.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/admin/")) return next();
  return identity(c, next);
});

/** Ensures the anonymous session cookie exists before the first question. */
app.get("/api/session", (c) => c.body(null, 204));

const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);
/** Lets the local ingest script check its token before uploading anything. */
admin.get("/ping", (c) => c.json({ ok: true }));

/** Provider health: a 1-token call per model, returning only status and the provider's rate-limit headers. */
admin.get("/llm-check", async (c) => {
  const { apiKey, baseURL, models } = llmConfigFromEnv(c.env);
  const results = await Promise.all(
    models.map(async (model) => {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      });
      const limits = Object.fromEntries([...res.headers].filter(([k]) => k.startsWith("x-ratelimit-")));
      return { model, status: res.status, limits };
    }),
  );
  const listed = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const available = listed.ok
    ? ((await listed.json()) as { data: { id: string; active?: boolean; context_window?: number }[] }).data
        .filter((m) => m.active !== false)
        .map((m) => ({ id: m.id, context: m.context_window }))
    : [];
  return c.json({ results, available });
});
admin.route("/", adminPapers);
app.route("/api/admin", admin);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError(errorHandler);

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
