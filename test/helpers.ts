import { env } from "cloudflare:test";
import { app } from "../src/worker/index";

export const ORIGIN = "https://sustainiq.test";

/** Call the Worker's Hono app in-process with the test bindings. */
export function call(path: string, init: RequestInit = {}) {
  return app.request(`${ORIGIN}${path}`, init, env);
}

/** A same-origin JSON POST, as the real web app sends it. */
export function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}
