# Architecture — SustainIQ

Components, boundaries and data flow (spec §20.3).

## Major components

| Component | Responsibility | Location |
|---|---|---|
| **Web app** | Chat, citation panel, library, upload, history; renders AI output safely | `src/web` |
| **Upload parser** | pdf.js in a Web Worker: PDF → pages → sections → chunks | `src/web/upload` + `src/shared/chunker.ts` |
| **API** | Routes, validation, identity, rate limits, headers | `src/worker/routes`, `src/worker/security` |
| **RAG graph** | LangGraph: guard → rewrite → retrieve → rerank → generate → validate → save | `src/worker/rag` |
| **Retrieval** | Vectorize search, FTS5 search, RRF, rerank, owner checks | `src/worker/rag/search.ts` etc. |
| **LLM adapter** | Groq/OpenAI client, fallback chain, streaming | `src/worker/llm.ts` |
| **Platform adapter** | All D1 / Vectorize / Workers AI / KV calls in one module, so the demo can move hosts | `src/worker/platform.ts` |
| **Cron** | Expire uploads, clean orphan vectors | `src/worker/cron.ts` |
| **Ingest script** | Curated papers → admin endpoint (local Mac) | `scripts/ingest.ts` |
| **Eval script** | Golden-set scoring | `scripts/eval.ts` |

## Boundaries

- **Web ↔ API:** JSON over HTTPS, same origin; contracts defined as zod schemas in `src/shared/schemas.ts`, used by both sides.
- **API ↔ RAG graph:** `runGraph({ ownerId, chatId, question }) → AsyncIterable<event>`. The graph never touches HTTP.
- **RAG ↔ platform:** only through `platform.ts` (`searchVectors`, `searchKeywords`, `embed`, `rerank`, `getChunks`, `cache`).
- **RAG ↔ LLM:** only through `llm.ts` (`complete`, `stream`), so the provider is swappable.
- **Shared chunker:** one module used by the browser and the ingest script; same input → same chunks.

## Data flow

```
Ingest (curated):  PDF ─► ingest.ts (pdf.js, chunker) ─► /api/admin/ingest ─► embed (bge-m3)
                                                                         ─► D1 papers/sections/chunks/FTS
                                                                         ─► Vectorize (owner_id=public)
Ingest (upload):   PDF ─► browser Web Worker (pdf.js, chunker) ─► /api/upload (re-validate, quota)
                                                                ─► embed ─► D1 + Vectorize (owner_id=me)
Question:          browser ─► /api/chat ─► guard ─► rewrite (history from D1)
                   ─► [Vectorize top30 ∥ FTS5 top30] ─► RRF top20 ─► D1 owner re-check ─► rerank top6
                   ─► +neighbours ─► prompt ─► Groq (stream) ─► validate citations ─► D1 messages ─► SSE to browser
Citation click:    browser ─► /api/chats/:id (stored citations) ─► D1 chunk text ─► panel
```

## Trust boundaries

| Boundary | Untrusted input | Control |
|---|---|---|
| Browser → API | Every field, cookie, uploaded chunk | zod, signed cookie, server-assigned IDs, quotas (SEC §3, §5) |
| User text → D1 / FTS5 / Vectorize | Query text | Prepared statements, FTS phrase escaping, server-built filters (SEC §4) |
| Paper text → LLM | Hidden instructions | Fenced sources, no tools, canary, citation validation (SEC §6) |
| LLM output → browser | Markdown, links, images | No raw HTML, no images, link allowlist, CSP (SEC §7.3, §12 #1) |
| Ingest script → admin API | Curated papers | Admin token, curated list (SEC §5.1) |

Auth: anonymous signed cookie in the demo, real login in P9 (SEC §10). Authorization: `owner_id` on every query.

## Integrations

Groq, Workers AI, Turnstile, Crossref. Each behind one module (`llm.ts`, `platform.ts`, `security/turnstile.ts`, `scripts/ingest.ts`) with timeouts and a defined fallback (TRD Integrations).

## Infrastructure

Everything runs on Cloudflare: Worker (global edge), D1, Vectorize, Workers AI, KV, Cron Triggers. Groq is the only external runtime dependency. The ingest and eval scripts run on the developer's Mac.

## Failure modes

| Failure | Detection | Degradation |
|---|---|---|
| Groq 429 / quota / down | Status code, timeout | Fallback chain → "SustainIQ is busy, try again shortly" |
| Workers AI embed fails | Error/timeout | Retry once → keyword-only search (FTS5) with a note |
| Reranker fails | Error/timeout | Use RRF order |
| Vectorize down | Error | Keyword-only search |
| D1 down | Error | Friendly error; no partial writes |
| Free quota exhausted | Budget guard | Uploads paused first, then questions |
| Worker over CPU limit (1102) | Logs | Reduce work per request; P1 gate decides the fallback |
| Bad citations | Validator | Retry once → marked answer or "couldn't find" |
