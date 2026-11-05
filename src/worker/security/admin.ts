import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";

const encoder = new TextEncoder();

/**
 * Constant-time string compare: hash both sides so lengths can't leak, then compare every byte.
 * Portable (Workers and Node): crypto.subtle.timingSafeEqual exists only on Cloudflare.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Bearer-token gate for the local ingest script and diagnostics (SECURITY §5.1). */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.env.ADMIN_INGEST_TOKEN;
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !token || !(await timingSafeEqualStrings(token, expected))) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
});
