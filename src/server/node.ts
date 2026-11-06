/**
 * Demo host on Render (decision D-012): the same Hono app as the Worker, on Node, with Cloudflare D1 / Vectorize /
 * Workers AI / KV reached over the REST API. Production stays on Cloudflare Workers.
 *
 *   npm run build && npm run start:render
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { app } from "../worker/index";
import { SECURITY_HEADERS } from "../worker/security/headers";
import { RestAi, RestD1, RestKv, RestVectorize, type CfRestConfig } from "./cloudflare-rest";

const REQUIRED = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "D1_DATABASE_ID",
  "VECTORIZE_INDEX",
  "KV_NAMESPACE_ID",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODELS",
  "LLM_SMALL_MODEL",
  "ANON_ID_SECRET",
  "ADMIN_INGEST_TOKEN",
] as const;

/** Build the same `Env` the Worker gets, from process environment variables. Fails fast if anything is missing. */
export function envFromProcess(vars: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): Env {
  const missing = REQUIRED.filter((k) => !vars[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  const cf: CfRestConfig = { accountId: vars.CLOUDFLARE_ACCOUNT_ID!, apiToken: vars.CLOUDFLARE_API_TOKEN!, fetch: fetchImpl };
  return {
    DB: new RestD1(cf, vars.D1_DATABASE_ID!),
    VECTORIZE: new RestVectorize(cf, vars.VECTORIZE_INDEX!),
    AI: new RestAi(cf),
    CACHE: new RestKv(cf, vars.KV_NAMESPACE_ID!),
    LLM_API_KEY: vars.LLM_API_KEY!,
    LLM_BASE_URL: vars.LLM_BASE_URL!,
    LLM_MODELS: vars.LLM_MODELS!,
    LLM_SMALL_MODEL: vars.LLM_SMALL_MODEL!,
    UPLOADS_ENABLED: vars.UPLOADS_ENABLED ?? "true",
    ANON_ID_SECRET: vars.ANON_ID_SECRET!,
    ANON_ID_SECRET_PREV: vars.ANON_ID_SECRET_PREV ?? "",
    ADMIN_INGEST_TOKEN: vars.ADMIN_INGEST_TOKEN!,
  } as unknown as Env;
}

/**
 * Render terminates TLS and forwards plain HTTP with `X-Forwarded-Proto: https`. Restore the https URL so the
 * same-origin CSRF check compares against what the browser actually sent.
 */
export function restoreProto(req: Request): Request {
  const url = new URL(req.url);
  if (req.headers.get("x-forwarded-proto") === "https" && url.protocol === "http:") {
    url.protocol = "https:";
    return new Request(url, req);
  }
  return req;
}

export function createSite(env: Env, clientDir = "./dist/client") {
  const site = new Hono();
  // Static files get the same security headers as the Worker serves via public/_headers.
  site.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
    if (c.req.path.startsWith("/assets/")) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    // The page itself is always re-checked, so a reload after a deploy loads the new code (an old upload client
    // without a chat ID failed after the T-7.11 deploy).
    else if (c.res.headers.get("Content-Type")?.startsWith("text/html")) c.res.headers.set("Cache-Control", "no-cache");
  });
  site.all("/api/*", (c) => app.fetch(c.req.raw, env));
  site.use("*", serveStatic({ root: clientDir }));
  site.get("*", serveStatic({ root: clientDir, path: "index.html" })); // SPA fallback
  return site;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const site = createSite(envFromProcess());
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: (req) => site.fetch(restoreProto(req)), port }, (info) => {
    console.log(JSON.stringify({ level: "info", msg: "SustainIQ demo server listening", port: info.port }));
  });
}
