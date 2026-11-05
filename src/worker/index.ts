import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./types";
import { securityHeaders } from "./security/headers";
import { requestGuard } from "./security/request-guard";
import { identity } from "./security/identity";
import { requireAdmin } from "./security/admin";
import { errorHandler } from "./security/errors";

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
app.route("/api/admin", admin);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError(errorHandler);

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
