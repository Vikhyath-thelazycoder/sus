import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./types";
import { securityHeaders } from "./security/headers";
import { requestGuard } from "./security/request-guard";
import { identity } from "./security/identity";
import { requireAdmin } from "./security/admin";
import { errorHandler } from "./security/errors";
import { spikeGraph } from "./rag/graph";

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
// T-1.7 platform check: runs the LangGraph spike so CPU can be read from `wrangler tail`. Removed in P4.
admin.get("/diag/graph", async (c) => {
  const out = await spikeGraph.invoke({ question: "  How fast does PLA   degrade? " });
  return c.json({ ok: out.answer === "received: How fast does PLA degrade?" });
});
app.route("/api/admin", admin);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError(errorHandler);

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
