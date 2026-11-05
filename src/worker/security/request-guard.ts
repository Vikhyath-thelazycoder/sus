import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard for state-changing requests (SECURITY §3.3): same-origin `Origin` header and JSON body only.
 * Admin routes are exempt from the Origin check because the local ingest script has no Origin;
 * they are protected by a bearer token instead.
 */
export const requestGuard = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  if (!c.req.path.startsWith("/api/admin/")) {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
  }
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HTTPException(415, { message: "Unsupported content type" });
  }
  return next();
});
