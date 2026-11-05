import { createMiddleware } from "hono/factory";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AppEnv } from "../types";

/** Sent as `__Host-sid`: Secure, Path=/ and no Domain are enforced by the browser for this prefix. */
export const SESSION_COOKIE = "sid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const THIRTY_DAYS = 30 * 24 * 60 * 60;

/**
 * Anonymous identity (SECURITY §3.2): the server issues a random UUID in an HMAC-signed cookie and never
 * trusts an ID from the body, query or localStorage. A missing or bad signature gets a fresh ID.
 * ANON_ID_SECRET_PREV lets the secret rotate without logging everyone out (SECURITY §12 #6).
 */
export const identity = createMiddleware<AppEnv>(async (c, next) => {
  const current = c.env.ANON_ID_SECRET;
  if (!current) throw new Error("ANON_ID_SECRET is not set"); // fail closed

  let ownerId: string | undefined;
  let needsCookie = true;
  const secrets = [current, c.env.ANON_ID_SECRET_PREV].filter((s): s is string => Boolean(s));
  for (const [i, secret] of secrets.entries()) {
    const value = await getSignedCookie(c, secret, SESSION_COOKIE, "host");
    if (typeof value === "string" && UUID_RE.test(value)) {
      ownerId = value;
      needsCookie = i > 0; // valid under the previous secret: re-sign with the current one
      break;
    }
  }

  ownerId ??= crypto.randomUUID();
  if (needsCookie) {
    await setSignedCookie(c, SESSION_COOKIE, ownerId, current, {
      prefix: "host",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: THIRTY_DAYS,
    });
  }
  c.set("ownerId", ownerId);
  await next();
});
