# Technical Requirements — SustainIQ

How it will be built (spec §20.2). Full reasoning: [../PROJECT_PLAN.md](../PROJECT_PLAN.md) §2–3. RAG rules: [../RAG_PRODUCTION_GUIDE.md](../RAG_PRODUCTION_GUIDE.md).

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript (strict) | One language for web, Worker and scripts |
| Frontend | React + Vite, Tailwind CSS, `react-markdown` | Simple SPA served as static assets by the Worker |
| API | Hono on Cloudflare Workers | Small, fast, Workers-native; also runs on Node (demo fallback) |
| Orchestration | Plain TypeScript functions (demo); LangGraph.js in the MVP | LangGraph exceeded the free 10 ms CPU limit in P1; returns on the paid plan for agents |
| Validation | zod | Schema at every trust boundary |
| PDF parsing | pdf.js (`pdfjs-dist`) | Free, keeps page numbers, runs in the browser and in Node |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Tests on the real Workers runtime |

## Architecture

Single Worker serving the SPA and `/api/*`; RAG over D1 (FTS5) + Vectorize; Groq for generation. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Infrastructure

- **Demo:** Render free web service `sustainiq-demo` (Singapore), https://sustainiq-demo.onrender.com, running `src/server/node.ts` (same Hono app). Data on Cloudflare via the REST API (`src/server/cloudflare-rest.ts`, token `CLOUDFLARE_API_TOKEN` with D1/Vectorize/KV edit + Workers AI read). Deployed with the Render CLI; `render.yaml` documents the settings (D-012).
- **Production:** Cloudflare Workers **Paid** only, custom domain (P9).
- Environments: `dev` (local `wrangler dev` + remote dev resources) and `production`, each with its own D1, Vectorize, KV and secrets.

## APIs

| Route | Method | Purpose | Auth | Limits |
|---|---|---|---|---|
| `/api/health` | GET | Liveness | none | — |
| `/api/chat` | POST (SSE) | Ask a question | anon cookie + Turnstile (first) | 20/min, 200/day |
| `/api/chats`, `/api/chats/:id` | GET/PATCH/DELETE | History | anon cookie, owner-scoped | standard |
| `/api/papers`, `/api/papers/:id` | GET/DELETE | Library | anon cookie, owner-scoped | standard |
| `/api/upload` | POST | Batches of parsed chunks | anon cookie + Turnstile | 5 PDFs / 100 pages; 3 batches/min |
| `/api/me/delete` | POST | Delete my uploads and history | anon cookie | 1/min |
| `/api/admin/ingest` | POST | Curated paper ingestion | `ADMIN_INGEST_TOKEN` | local script only |

External: Groq (OpenAI-compatible Chat Completions), Crossref (metadata, from the local script only), Turnstile verify.

## Database

- **D1** (SQLite): `papers`, `sections`, `chunks`, `chunks_fts` (FTS5), `chats`, `messages`, `usage`. Schema in PP §5.4. Migrations in `migrations/` via `wrangler d1 migrations`.
- **Vectorize:** index `sustainiq-chunks`, 1024 dims, cosine, metadata index on `owner_id`; vector ID = `chunks.id`.
- **KV:** answer cache (public-only scope).
- **Backups:** D1 Time Travel; Vectorize can be rebuilt from D1 chunk text.
- **Decision:** D1 + Vectorize over Supabase (see PROJECT_DECISIONS.md).

## Integrations

| Service | Data sent | Failure handling |
|---|---|---|
| Groq | Question + top passages | Fallback chain gpt-oss-120b → qwen3.8-27b → gpt-oss-20b → "busy" message |
| Workers AI | Chunk/query text (embeddings, rerank) | Retry once; rerank failure → RRF order |
| Crossref | DOI | Script-only; manual metadata if it fails |
| Turnstile | Token | Fail closed on uploads; retry prompt on chat |

## AI/LLM system

- **Embeddings:** `@cf/baai/bge-m3` (1024 dims), the same model for chunks and queries (RAG §4.5).
- **Reranker:** `@cf/baai/bge-reranker-base`.
- **Generation:** Groq `openai/gpt-oss-120b` (fallbacks `qwen/qwen3.8-27b`, `openai/gpt-oss-20b`); rewrite/guard on `openai/gpt-oss-20b`. gpt-oss models reason before answering, so P4 sets low reasoning effort and counts reasoning tokens in the budget. Temperature 0.2, max 800 output tokens, ~3,000 tokens of sources.
- **Data sent:** questions and retrieved passages only; no identifiers.
- **Evaluation:** golden set (30 + 5), recall@6, MRR, faithfulness, decline accuracy (`npm run eval`).
- **Cost limits:** free tiers; a global daily budget guard stops before the Groq and Workers AI quotas are exhausted.

## Runtime

- One Worker: `fetch` (SPA + API) and `scheduled` (cron).
- Cron daily: delete expired uploads (7 days), clean orphan vectors.
- Browser Web Worker: PDF parsing and chunking for uploads.
- Local Node script: `scripts/ingest.ts`, `scripts/eval.ts`.

## Deployment

- `npm test && npm run build && wrangler deploy` (P1 manual; CI added in P8).
- Rollback: `wrangler rollback` to the previous version; D1 migrations are forward-only, with a written down-script for each.

## Environment variables

| Name | Purpose | Where |
|---|---|---|
| `LLM_API_KEY` | LLM access | `wrangler secret` |
| `ANON_ID_SECRET` (+ `_PREV`) | Signs anonymous cookies | `wrangler secret` |
| `ADMIN_INGEST_TOKEN` | Protects the ingest endpoint | `wrangler secret` + local `.dev.vars` |
| `TURNSTILE_SECRET` | Bot check | `wrangler secret` |
| `TURNSTILE_SITE_KEY` | Public key for the widget | `wrangler.toml` vars |
| `LLM_PROVIDER`, `LLM_BASE_URL` | Provider switch (Groq ↔ OpenAI) | `wrangler.toml` vars |
| `UPLOADS_ENABLED` | Kill switch | `wrangler.toml` vars |

## Dependencies

`hono`, `zod`, `openai` (Groq/OpenAI client), `react`, `react-dom`, `react-markdown`, `pdfjs-dist`, `tailwindcss`, `vitest`, `@cloudflare/vitest-pool-workers`, `wrangler`. Nothing else without a reason recorded here.
