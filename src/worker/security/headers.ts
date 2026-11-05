import { createMiddleware } from "hono/factory";

/**
 * Security headers (SECURITY §3.3). The same set is served for static files via public/_headers;
 * test/headers.test.ts fails if the two drift apart.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
};

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
  // API responses may hold one user's data: never cache them anywhere (SECURITY §12 #5).
  c.res.headers.set("Cache-Control", "no-store, private");
});
