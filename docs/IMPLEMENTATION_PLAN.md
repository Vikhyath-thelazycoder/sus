# Implementation Plan — SustainIQ

The one living plan for this project (spec §20.7, §21). Add changes to the phase they belong to
(`agylite plan reconcile "<request>"`); do not create separate mini-plans. Statuses use spec §25:
NOT_STARTED · PLANNED · IN_PROGRESS · PARTIALLY_COMPLETE · BLOCKED · READY_FOR_VERIFICATION · VERIFIED · COMPLETED ·
INTENTIONALLY_DEFERRED. `agylite plan index` keeps a compact index in `.agylite/plan-index.yaml`.

**Reference docs:**
- [PRD](PRD.md) · [TRD](TRD.md) · [Architecture](ARCHITECTURE.md) · [System workflow](SYSTEM_WORKFLOW.md) · [Design](../DESIGN.md) · [Features](FEATURES.md) · [Security baseline](SECURITY.md) · [Decisions](PROJECT_DECISIONS.md)
- Full security rules and tests: [../SECURITY.md](../SECURITY.md) (cited as **SEC §n**)
- RAG rules: [../RAG_PRODUCTION_GUIDE.md](../RAG_PRODUCTION_GUIDE.md) (cited as **RAG §n**)
- Product overview and decisions: [../PROJECT_PLAN.md](../PROJECT_PLAN.md) (cited as **PP §n**)

**Scope:** P9–P17 are the **production plan** (audit → cleanup → production launch → blueprint; the pilot stage was removed by the owner on 2026-11-15, D-025), written 2026-11-06 from the production blueprint and the client call. P1–P8 built the **demo** (Render free web service at https://sustainiq-demo.onrender.com with data on Cloudflare, Groq, no login; D-012). P9 is the **paid MVP** on Cloudflare Workers Paid, deferred until the client accepts the deal.

**Progress (2026-11-06, night):** P1–P7 ✅ done (P7 closed by the owner today) · **P8 (hardening and demo launch) dropped by the owner: the project goes straight to production** · **P9 production is next**, scoped in a new session. Changes from the first draft: no LangGraph in the demo (D-010), Groq models updated (D-011), demo hosted on Render (D-012), gpt-oss-20b removed from the answer chain (D-013), browser OCR for the demo (D-016), topic guard relaxed for own uploads (D-017), P8 skipped for production (D-019).

**Done today (2026-11-06), all live and checked by the owner:**
- **T-7.8 Faster OCR:** 2,000 px render, title pass on page 1 only. The owner's 4-page scan reaches Ready in ~19 s on the live site.
- **T-7.9 No Vectorize wait:** `/finish` no longer waits. The chat's own PDFs are a separate keyword list in fusion, counted twice, so a question right after Ready is answered from the new PDF.
- **T-7.11 Chat-scoped PDFs:** migration `0004` (`papers.chat_id`, `chats.use_library`), `chat_id` vector metadata, and a `chat_id` metadata index on Vectorize (prod and dev). Scope is applied in keyword search, Vectorize (two queries: library + chat) and the D1 re-check. `POST /api/chats` creates the chat on the first attached PDF. Deleting a chat asks each time: delete its PDFs, or keep them in the library.
- **T-7.12 "Use the library" switch** in the chat box, saved with the chat when changed. Answers with the library off are never cached.
- **Fix:** the demo server sends `Cache-Control: no-cache` for the page, so a reload after a deploy gets the new code. An open tab with the old code had failed uploads with "The upload didn't finish".
- Uploads made before migration `0004` have no chat, so they count as personal-library PDFs.

**Done this evening (2026-11-06), deployed:** T-7.14 several PDFs per chat (queued one at a time, chat file list), T-7.13 Upload button in the Library, T-7.10 OCR "may be misread" warning, T-7.7 UI check (local 1280/768/375 + 375 dark, live on Render; [evidence](evidence/P7.md)).
**Bug fixed (`30d1e8e`):** answers to the owner's biomaterials questions came back "I couldn't find this in the papers". Cause: gpt-oss sometimes cites as `[1†L1-L4]`; the validator only knew `[1]`/`【1】`, rejected both drafts as uncited and showed not-found. Now normalised to `[n]`; 8/8 answered, 0 rejections (local, owner's volumes 1–2).

**Next session, start here (owner's wish: talk about the future first, no code until agreed):**
1. **Start P9 (audit).** The production plan P9–P17 below replaces this list. Kept for history: **Production scope.** Owner's target: **5–10 GB of sources: PDFs, PPT and others**, no demo limits. What the demo can't do today and P9 must answer:
   - Parsing runs in the browser (pdf.js + tesseract); PPT/DOCX not supported → server-side ingestion with a queue (T-9.4, T-9.5, T-9.8).
   - **Per-user limit removed** (owner, 2026-11-06): no cap on PDFs or total pages per user. Still in place: 100 pages / 25 MB per PDF (browser parsing) and 7-day expiry → retention, storage (R2 for originals), server-side parsing for bigger files.
   - Free tiers: Render, Workers free, D1 (size), Vectorize, Groq free quota (200k tokens/day/model) → paid hosting and LLM (T-9.1, T-9.2).
   - Anonymous cookie identity → real login (T-9.3); hardening items from P8 fold into P9 (T-9.7).
2. **Open decisions. Don't assume them:** "Use the library" default (off with a PDF, on without; not confirmed); deleting a chat asks each time; Library also lists chat PDFs as "Your upload" (hide, or label with the chat?); T-7.10 confidence threshold 60 not measured on a bad scan.
3. **Owner decisions (2026-11-15):** Workers Paid plus own domain from the start, everything on Cloudflare (D-021); any LLM provider by config (D-022); rate limits and Turnstile required (D-023, T-10.5). Login built into the app with an auth library (D-024, T-11.3). Full security review: SEC §12b.
4. **Known open items:** the first live run right after the `dcda18f` deploy failed once (404 on the new chat) and didn't repeat; 9 leftover test uploads on **dev** D1/Vectorize (owner to delete); the citation form `[1†…]` can flash while an answer streams (the final text is clean).
5. **Deploys:** the owner runs the production commands; Claude prepares them (memory: deploy flow).

**Definition of done for every task:** `agylite verify` passes (tests, types, lint, build), the acceptance column is met, and the SEC items it touches have their tests.

---

## P1 · Foundations and platform check
Status: VERIFIED · Depends: — · Paths: package.json, wrangler.toml, src/worker/**, src/web/**, migrations/**, test/** · Flags: security, testing · Evidence: docs/evidence/P1.md
Objective: An empty but secure app shell deployed to workers.dev, with every Cloudflare binding wired up, and a measurement of whether LangGraph fits the free plan (3 MB compressed / 10 ms CPU).

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-1.1 | Scaffold: TypeScript, Vite + React (`src/web`), Hono Worker (`src/worker`), shared code (`src/shared`), ESLint, Prettier, Vitest with `@cloudflare/vitest-pool-workers` | VERIFIED | — | engineering/implementation | — | — | `npm test`, `tsc`, lint run clean | `npm run dev` serves the React shell and `/api/health` |
| T-1.2 | `wrangler.toml` with dev/prod environments and bindings: D1, Vectorize (1024-dim, cosine, `owner_id` metadata index), Workers AI, KV, static assets, cron | VERIFIED | T-1.1 | engineering/backend | Separate dev/prod resources (SEC §2) | — | Binding smoke test in vitest | `wrangler dev` starts with all bindings |
| T-1.3 | D1 migration 0001: `papers`, `sections`, `chunks`, `chunks_fts` (FTS5), `chats`, `messages`, `usage` (PP §5.4) | VERIFIED | T-1.2 | engineering/backend | `owner_id` on every table (SEC §3.2) | — | Migration applies on a fresh DB | `wrangler d1 migrations apply` succeeds locally and remotely |
| T-1.4 | Security middleware: headers + CSP, `no-store` on `/api/*`, JSON-only + Origin check, zod error handler with generic messages | VERIFIED | T-1.1 | engineering/security | SEC §3.1, §3.3, §12 #5 | — | Header tests (SEC §13 #21) | `curl -I` shows every header from SEC §3.3 |
| T-1.5 | Signed anonymous identity cookie (HMAC, `crypto.subtle.verify`, two-secret rotation) | VERIFIED | T-1.4 | engineering/security | SEC §3.2, §12 #6 | — | Forged and tampered cookie tests (SEC §13 #2) | Tampered cookie gets a new ID and no data |
| T-1.6 | LLM provider module: OpenAI SDK pointed at Groq (`baseURL` + key from secret); fallback chain config (PP §6.6) | VERIFIED | T-1.1 | engineering/ai-systems | Key only in `wrangler secret` (SEC §2) | — | Unit test with a mocked provider, incl. 429 → fallback | One config value switches provider |
| T-1.7 | **Platform check:** a minimal LangGraph graph (2 nodes) + Hono; measure the bundle with `wrangler deploy --dry-run --outdir` and the CPU per request on workers.dev | VERIFIED | T-1.6 | engineering/architecture, engineering/performance | — | — | Measurements recorded in `docs/evidence/P1.md` | Report: bundle size vs 3 MB, CPU ms vs 10 ms, recommendation. **Owner decides the demo fallback if it doesn't fit.** |
| T-1.8 | First deploy to `*.workers.dev`; secrets set (`LLM_API_KEY`, `ANON_ID_SECRET`, `ADMIN_INGEST_TOKEN`); verify the free-tier figures on our account (PP §3) | VERIFIED | T-1.7 | engineering/release | Secret scan (SEC §13 #16) | — | Live smoke: `/api/health`, headers | Live URL serves the shell; free-tier limits confirmed and noted |

## P2 · Paper ingestion
Status: VERIFIED · Depends: P1 · Paths: src/shared/**, scripts/ingest.ts, src/worker/routes/admin-papers.ts, src/worker/platform.ts, src/server/**, render.yaml, data/papers/** · Flags: security, testing · Evidence: docs/evidence/P2.md
Objective: 15–25 curated open-access papers parsed, chunked by structure, embedded and stored, with text a human has read and checked (RAG §4).

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-2.1 | Pick 15–25 open-access papers across biopolymers, green chemistry, packaging and biomaterials; record DOI, licence and source URL in `data/papers/metadata.json` | VERIFIED | — | research/web | Licence recorded; curated only (SEC §5.1) | — | Every paper has an open licence | List reviewed by the owner |
| T-2.2 | PDF text extraction with pdf.js: page numbers, two-column ordering, header/footer removal, de-hyphenation, invisible-character stripping, scanned-PDF detection (PP §5.2) | VERIFIED | T-1.1 | engineering/implementation | Strip invisible Unicode (SEC §6.8) | — | Fixture tests on 3 real papers | Parsed text of 3 papers **read by eye** and correct (RAG §4.1) |
| T-2.3 | Section detection; References section kept out of the index | VERIFIED | T-2.2 | engineering/ai-systems | — | — | Unit tests: headings found on fixtures | Sections match the papers' headings |
| T-2.4 | Shared chunker: parent = section, child ≈ 350 tokens, 15% overlap, never crosses sections, contextual header `Paper: … Section: …` (RAG §4.3, §4.4) | VERIFIED | T-2.3 | engineering/ai-systems | — | — | Unit tests: sizes, overlap, boundaries, page ranges | Same output in Node and in a browser Web Worker |
| T-2.5 | **Table quality check:** inspect how 5 table-heavy papers parse; decide whether the optional Python parser is needed (PP decision) | VERIFIED | T-2.2 | engineering/ai-systems | — | — | Findings in `docs/evidence/P2.md` | Owner informed: pdf.js OK, or Python parser proposed for the MVP |
| T-2.6 | Protected admin ingest endpoint (`ADMIN_INGEST_TOKEN`, constant-time compare); embeds with `bge-m3` in batches, writes D1 + FTS + Vectorize with `owner_id='public'` | VERIFIED | T-1.3, T-2.4 | engineering/backend | Token auth, server-assigned IDs (SEC §5.1) | — | API tests: bad token → 401; idempotent re-run | Re-ingesting the same paper creates no duplicates |
| T-2.7 | `scripts/ingest.ts`: local run over `data/papers`, OpenAlex metadata (stored in metadata.json), progress output, `--remote` flag | VERIFIED | T-2.6 | engineering/implementation | Scoped token, never committed (SEC §12 #17) | — | Dry run on 2 papers | All papers ingested; chunk count reported; Vectorize within the free limit |
| T-2.8 | Move the demo host to Render (D-012): same Hono app on Node, Cloudflare D1/Vectorize/Workers AI/KV via REST, Render CLI deploy | VERIFIED | T-2.6 | engineering/release | — | — | — | Live checks pass on sustainiq-demo.onrender.com; 20 papers ingested through Render |

## P3 · Retrieval and evaluation
Status: VERIFIED · Depends: P2 · Paths: src/worker/rag/**, scripts/eval.ts, data/golden.json, src/worker/routes/admin-search.ts · Flags: security, testing · Evidence: docs/evidence/P3.md
Objective: Hybrid search + RRF + reranker returning the right passages, **measured** on a golden set before any answer generation is built (RAG §5.3–5.8, §9).

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-3.1 | Golden set: 30 real-style questions with the correct paper, section and page, plus 5 unanswerable ones (RAG §9.1) | VERIFIED | T-2.7 | engineering/ai-systems | — | — | Reviewed by hand | `data/golden.json` with 35 entries |
| T-3.2 | Meaning search: embed the query with `bge-m3`, Vectorize top 30, **server-built** owner pre-filter (RAG §5.3) | VERIFIED | T-2.6 | engineering/ai-systems | SEC §4.3 | — | Unit + owner-isolation test (SEC §13 #4) | Returns only `public` + own chunks |
| T-3.3 | Keyword search: FTS5 BM25 top 30 with escaped phrase query; malformed query → empty result | VERIFIED | T-1.3 | engineering/backend | SEC §4.1, §4.2 | — | Injection tests (SEC §13 #5, #6) | Exact terms (PLA, PBAT, ASTM D6400) are found |
| T-3.4 | RRF merge (k = 60) → top 20 → re-check owners in D1 (RAG §5.4) | VERIFIED | T-3.2, T-3.3 | engineering/ai-systems | Second-layer owner check (SEC §4.3) | — | Unit test with the worked example from RAG §5.4 | Merged list is correct and deduplicated |
| T-3.5 | Rerank with `bge-reranker-base` → top 6; neighbour expansion (±1 child) within the token budget; best first (RAG §5.6, §5.8) | VERIFIED | T-3.4 | engineering/ai-systems | — | — | Unit tests: ordering, budget cap | Prompt context ≤ ~3,000 tokens |
| T-3.6 | `scripts/eval.ts`: recall@6, MRR; compare vector-only vs hybrid vs hybrid + rerank (RAG §9.2) | VERIFIED | T-3.1, T-3.5 | engineering/ai-systems, testing/regression | — | — | Eval runs locally and against the Render demo (REST latency recorded) | Scores recorded in `docs/evidence/P3.md` |
| T-3.7 | Tune chunk size, k and rerank count on the golden set; plot the score histogram before any threshold (RAG §5.7) | VERIFIED | T-3.6 | engineering/ai-systems | — | — | Before/after numbers | Chosen settings justified with numbers |

## P4 · Answer generation
Status: VERIFIED · Depends: P3 · Paths: src/worker/rag/answer.ts, src/worker/routes/chat.ts, src/worker/llm.ts, scripts/eval-answers.ts · Flags: security, testing · Evidence: docs/evidence/P4.md
Objective: Streaming, grounded answers with validated citations and an honest "I couldn't find this", run as a pipeline of plain functions (PP §6, RAG §5.9–5.11).

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-4.1 | Guard node: topic check + hazardous-chemistry refusal + override-attempt speed bump → polite decline | VERIFIED | T-1.6 | engineering/ai-systems, engineering/security | SEC §6.5–6.6, §12 #11 | — | SEC §13 #15, #22 | Off-topic and hazardous questions are declined |
| T-4.2 | Rewrite node (small model, only with history; history from D1 only) (RAG §5.1) | VERIFIED | T-1.6 | engineering/ai-systems | SEC §6.7 | — | SEC §13 #18 | Follow-up questions become standalone |
| T-4.3 | Prompt builder: fenced `<sources>`, tag escaping, canary, numbered sources with title/section/page (RAG §5.9) | VERIFIED | T-3.5 | engineering/ai-systems | SEC §6.1–6.4 | — | SEC §13 #7, #8, #9 | Injected chunks don't change behaviour |
| T-4.4 | Generate node: Groq streaming, temperature 0.2, max 800 tokens, timeout, fallback chain | VERIFIED | T-4.3 | engineering/ai-systems | SEC §7.4, §12 #20 | — | Mocked-provider tests incl. 429 fallback | Streams token by token; fallback works |
| T-4.5 | Validate node: citation check, retry edge once, fallback message (RAG §5.10) | VERIFIED | T-4.4 | engineering/ai-systems | SEC §7.2 | — | SEC §13 #10 | No answer ships with a citation that wasn't retrieved |
| T-4.6 | Pipeline runner: call guard → rewrite → retrieve → rerank → generate → validate → save in order, with the single retry (no LangGraph in the demo, per T-1.7) | VERIFIED | T-4.1–T-4.5 | engineering/architecture | — | — | Graph test with each path (decline, ok, retry) | Each path covered by a test |
| T-4.7 | `/api/chat` SSE route; save the message and citation chunk IDs to D1; KV answer cache for public-only questions | VERIFIED | T-4.6 | engineering/backend | Cache never crosses owners (SEC §8) | — | API tests; cache-scope test | Second identical public question served from cache |
| T-4.8 | Answer evaluation: faithfulness + "I don't know" accuracy on the golden set, with an LLM judge checked by hand (RAG §9.2–9.3) | VERIFIED | T-4.7 | engineering/ai-systems, testing/regression | — | — | `npm run eval` extended | Scores in `docs/evidence/P4.md`; ≥ 90% correct declines on unanswerable questions (target) |

## P5 · UI foundation and chat
Status: VERIFIED · Depends: P1 · Paths: src/web/**, migrations/0002_feedback.sql · Flags: design, testing · Evidence: docs/evidence/P5.md
Objective: The calm, minimal, desktop-first and mobile-ready chat experience with the citation side panel and bottom sheet (DESIGN.md). Can start in parallel with P2–P4 against a mocked API.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-5.1 | Design tokens (colour, type, spacing, radius) as CSS variables + Tailwind config; light/dark, with dark following the system setting and a toggle | VERIFIED | T-1.1 | design/design-system | — | DESIGN.md tokens | `agylite design` token check | No ad-hoc colour or spacing values |
| T-5.2 | App shell: history sidebar (desktop) / drawer (mobile), header, main column ≤ 720 px | VERIFIED | T-5.1 | design/frontend | — | DESIGN.md layout | Responsive checks at 375 / 768 / 1280 px | No horizontal scroll on phones |
| T-5.3 | Chat view: input, suggested questions, streaming answer, inline `[n]`, sources row, copy, thumbs up/down | VERIFIED | T-5.2 | design/frontend | Safe markdown: no raw HTML, no images, link allowlist (SEC §7.3, §12 #1) | DESIGN.md interaction | SEC §13 #11, #17; component tests | Streams smoothly; XSS payloads render as text |
| T-5.4 | Citation panel (desktop) / bottom sheet (mobile): stored passage, highlight, title, authors, year, page, DOI, Curated / Your upload badge | VERIFIED | T-5.3 | design/frontend | Passage from D1, DOI link built by us (SEC §7.2–7.3) | DESIGN.md | Component + keyboard tests | Opens from `[n]` with mouse, touch and keyboard |
| T-5.5 | All states: empty, loading skeletons, error, "couldn't find", rate-limited, busy | VERIFIED | T-5.3 | design/ux | Generic errors only | DESIGN.md states | Visual check | Every state has friendly copy |
| T-5.6 | Accessibility pass: WCAG AA contrast, focus-visible, labels, reduced motion | VERIFIED | T-5.4 | design/accessibility | — | DESIGN.md accessibility | testing/accessibility checks | No AA failures |

## P6 · Library and chat history
Status: VERIFIED · Depends: P4, P5 · Paths: src/worker/routes/papers.ts, src/worker/routes/chats.ts, src/web/pages/**, src/web/App.tsx, src/shared/pdf/structure.ts · Flags: security, testing · Evidence: docs/evidence/P6.md
Objective: Browse the paper library and return to past conversations, each strictly scoped to its owner.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-6.1 | `GET /api/papers` (public + own), `GET /api/papers/:id` with sections | VERIFIED | T-2.6 | engineering/backend | Owner-scoped SQL, 404 for others (SEC §3.2) | — | SEC §13 #1 | Other owners' papers return 404 |
| T-6.2 | Library page: search, topic filters, paper cards, paper detail | VERIFIED | T-6.1, T-5.2 | design/frontend | Titles rendered as text | DESIGN.md | Component tests | Filters and search work on mobile and desktop |
| T-6.3 | Chat history API: list, open, rename, delete (D1, owner-scoped) | VERIFIED | T-4.7 | engineering/backend | SEC §3.2 | — | SEC §13 #1 | History survives reloads; others' chats return 404 |
| T-6.4 | History sidebar wired to the API; new chat; grouping by date | VERIFIED | T-6.3, T-5.2 | design/frontend | — | DESIGN.md | Component tests | Past chats reopen with their citations |

## P7 · PDF uploads
Status: VERIFIED · Depends: P2, P6 · Paths: src/web/upload/**, src/worker/routes/upload.ts, src/worker/cron.ts, src/shared/limits.ts, migrations/0003_vector_tombstones.sql · Flags: security, testing · Evidence: docs/evidence/P7.md
Objective: Users upload their own PDFs (5 × 100 pages), parsed in the browser, re-validated on the server, private to them, deleted after 7 days.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-7.1 | Browser parsing in a Web Worker with pdf.js (scripting off, magic-byte check, size/page caps, timeout) using the shared chunker | VERIFIED | T-2.4 | engineering/frontend | SEC §9, §12 #15 | — | Fixture tests; malicious-PDF caps | A 30-page paper parses in the browser |
| T-7.2 | `POST /api/upload` in batches: zod re-validation, server IDs and embeddings, **atomic** quota check (5 PDFs / 100 pages) | VERIFIED | T-7.1, T-2.6 | engineering/backend, engineering/security | SEC §5.1, §12 #3 | — | SEC §13 #13, #14, #19 | 10 parallel uploads at 4/5 → exactly 1 succeeds |
| T-7.3 | Upload UI: drag-and-drop, progress (Reading → Splitting → Indexing), limits and "don't upload confidential documents" notice | VERIFIED | T-7.1, T-5.2 | design/frontend | SEC §12 #21 | DESIGN.md | Visual check on a phone | Upload works on desktop and mobile |
| T-7.4 | Own uploads searchable only by their owner; "Your upload (unverified)" labels | VERIFIED | T-7.2, T-3.4 | engineering/ai-systems | SEC §12 #10 | DESIGN.md | SEC §13 #4 | User A never sees user B's upload |
| T-7.5 | Cleanup as a **Cloudflare Worker cron** (free; data lives on Cloudflare; Render's free tier has no cron): expire uploads after 7 days; orphan-vector cleanup; "delete my data" endpoint + button | VERIFIED | T-7.2 | engineering/backend | SEC §12 #16 | — | SEC §13 #23 | Deleted text is never found again |
| T-7.6 | OCR for scanned PDFs in the browser (self-hosted tesseract.js; text-less pages only); Ready waits until the upload is searchable; topic guard allows questions about own uploads | VERIFIED | T-7.1 | engineering/frontend | — | — | — | The owner's 4-page image-only PDF uploads, gets its real title, and questions about it are answered with citations right after Ready |
| T-7.7 | Claude/ChatGPT-style chat: centred new-chat box, + to attach PDFs as chips in the question box (only upload point), question bubble, labelled back buttons | VERIFIED | T-7.3 | design/frontend | — | — | — | Upload works from the chat box at 1280/768/375 px; Library and paper pages have back buttons; Agylite design check and Taste lint pass |
| T-7.8 | Tune OCR: extra title pass on page 1 only, 2000 px render | VERIFIED | T-7.6 | engineering/frontend | — | — | — | Measured: owner's 4-page scan 21.8 s -> 14.1 s, reference-word recall 98.0% -> 97.1%, same title and 18 passages |
| T-7.9 | Ready without the Vectorize wait: owner-uploads keyword list added to fusion, finish no longer waits | VERIFIED | T-7.6 | engineering/ai-systems | — | — | — | A question asked 1 s after Ready is answered from the new upload (keyword finds it at 1 s; Vectorize at ~31 s) |
| T-7.10 | Per-page OCR quality warning from tesseract confidence | VERIFIED | T-7.6 | engineering/frontend | — | — | — | A badly read page shows a plain warning on the chip instead of failing silently |
| T-7.11 | Chat-scoped uploads: a PDF added in a chat is searched only in that chat (papers.chat_id, Vectorize metadata index, owner+chat scope in search and D1 re-check, chat created on first upload). **Deleting a chat asks the user** whether to also delete the PDFs uploaded in it | VERIFIED | T-7.9 | engineering/backend | — | — | — | PDF uploaded in chat A is cited in chat A and never retrieved in chat B or by another user (keyword, vector and D1 re-check tests) |
| T-7.12 | Use-the-library toggle per chat: PDFs only / library only / both; proposed default (not yet confirmed by the owner): library off when a PDF is attached, on when none | VERIFIED | T-7.11 | design/frontend | — | — | — | Toggle visible in the chat box; answers follow the chosen sources; setting saved with the chat |
| T-7.13 | Upload button in the Library: personal library PDFs (not tied to a chat), used in any chat with the library on | VERIFIED | T-7.11 | design/frontend | — | — | — | A PDF added from the Library appears there as Your upload and is cited in any chat with the library on |
| T-7.14 | Several PDFs per chat: check and fix multi-file attach (owner saw only one) and per-chat file list | VERIFIED | T-7.11 | engineering/frontend | — | — | — | Picking or dropping 3 PDFs at once attaches all 3; each shows its own progress and is used in that chat |

## P8 · Hardening and demo launch
Status: INTENTIONALLY_DEFERRED · Depends: P4, P6, P7 · Paths: src/worker/security/**, test/security/** · Flags: security, testing · Evidence: —
**Dropped by the owner (2026-11-06, D-019): no separate hardening/demo-launch phase; the project goes straight to production and these items move into P9 (T-9.7).**
Objective: Every [DEMO] item in SECURITY.md done, abuse limits on, full test suite green, live demo link ready for the client.

**Carried in from P4–P6 (owner rule: nothing hard-coded in P8, every limit, key, ID and threshold comes from config/env):**
- Groq free tier: 200,000 tokens/day per model (≈ 40–45 answers/day each) plus 8,000 tokens/min. Read the budgets from config, show "busy" before the quota runs out, and run evals on a separate key so they never use up the demo's quota (P6 evidence).
- Groundedness check on answers (RAG §5.11): the validator proves `[n]` exists, not that it supports the claim (q06 mis-citation, P6 evidence).
- Move remaining constants (production resource IDs in scripts, `RETRIEVAL` settings, cache TTL) into config.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-8.1 | Rate limits (questions, uploads, new IDs): demo on Render (single instance) uses in-memory per-minute limits + D1 daily counters; the production Worker uses the Rate Limiting binding / Durable Objects; global LLM and Workers AI budget guard | INTENTIONALLY_DEFERRED | T-4.7, T-7.2 | engineering/security | SEC §8, §12 #4 | — | SEC §13 #12 | 21st question in a minute → 429 |
| T-8.2 | Cloudflare Turnstile on the first question and on uploads (server-side token check) | INTENTIONALLY_DEFERRED | T-8.1 | engineering/security | SEC §8 | Fits DESIGN.md | Token-missing test | Bots without a token are blocked |
| T-8.3 | Structured JSON logging (no secrets or raw IPs), alerts, `/.well-known/security.txt` | INTENTIONALLY_DEFERRED | T-1.4 | engineering/security | SEC §11, §12 #13, incident response | — | Log-format test | Logs contain no secrets or PII |
| T-8.4 | Full security test suite (SEC §13 #1–23) green in CI | INTENTIONALLY_DEFERRED | T-8.1–T-8.3 | testing/security | All of SEC §13 | — | `agylite verify` | 23/23 pass |
| T-8.5 | Final eval run on production (retrieval + answers) | INTENTIONALLY_DEFERRED | T-8.4 | testing/regression | — | — | `npm run eval -- --remote` | Scores ≥ P3/P4 baselines; recorded |
| T-8.6 | Demo deploy to Render (Render CLI) + smoke test, waking the free instance first (5 golden questions, citations open the right page, upload from a phone, headers, 429) | INTENTIONALLY_DEFERRED | T-8.5 | engineering/release, testing/release-verification | SEC §14 demo checklist | — | Smoke checklist | Every [DEMO] item ticked |
| T-8.7 | Demo hand-off: short walkthrough video and a one-page "how it works" for the client | INTENTIONALLY_DEFERRED | T-8.6 | media/demo | No private data in the video | DESIGN.md | Review by the owner | Link + video sent before the Google Meet |

## Production plan (P9–P17), from the blueprint and the client call

**Sources:** [real rag/SUSTAINIQ_PRODUCTION_BLUEPRINT.md](../real%20rag/SUSTAINIQ_PRODUCTION_BLUEPRINT.md) (cited as **BP §n**) and the 2026-11-06 call with Prof. Prabakaran Ravichandran (asked for a 5-user pilot, now removed by the owner, D-025; about $20/month self-funded, 5–10 GB of PDFs/PPT/DOCX to start, **with no upper limit** (owner, D-028), answers only from the library, shared library plus private storage, category/year folders, weekly student uploads, confidentiality).
**Shape (owner, 2026-11-06; changed 2026-11-15, D-025):** audit first → clean up the demo → **full production launch** (no pilot stage, no user cap, production-grade security and scale from day one) → the rest of the blueprint once the client and his management are on board. Every phase ends at an owner gate; nothing after P9 starts until the audit decisions are approved (BP §17.6).
**Replaces the old P9 tasks:** T-9.1 hosting → T-9.12 / P15 · T-9.2 LLM → T-9.11 · T-9.3 login → P11 · T-9.4 big PDFs → P12 · T-9.5 Python parser → T-9.4 (RAGFlow) · T-9.6 LangGraph agent → P17 (BP §12: no agents before source fidelity) · T-9.7 tracing/privacy → P15 · T-9.8 OCR → T-12.5. P8 items (rate limits, Turnstile, logging, security suite) → P15.
**Rules for every phase:** owner rule, nothing hard-coded (limits, keys, IDs, thresholds come from config/env); BP §12 "must not do" list; existing citation, tenant-isolation and rejection tests are kept or replaced by stronger ones (BP §18.1).
**Security gap review (2026-11-15):** the code was checked against a list of 20 common web attacks (SEC §12b). The demo code covers every one that applies today. **The one gap in the live demo: no rate limiting** (SEC §8 is written but not built, and PP §12 wrongly listed it as done). This is now T-10.5. Production adds logins and Office files, which bring more of these attacks into scope. They are planned as T-11.8 (account security), T-12.10 (Office file safety), T-15.1 (trusted client IP) and T-15.10 (edge hardening if we move to a VM), with tests SEC §13 #24–33.

## P9 · Audit and technical decisions (BP Phase 0)
Status: PLANNED · Depends: P7 · Paths: docs/audit/** · Flags: security, testing · Evidence: docs/audit/AUDIT_REPORT.md
Objective: Audit the current SustainIQ code and seven outside projects on one public benchmark corpus, then get the owner's written decisions for every major component before any production code. No client documents are used (BP §17).

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-9.1 | Benchmark corpus: public, licensed files covering green chemistry, biopolymers, packaging and biomaterials, plus a two-column PDF, a poor scan, a thesis, a PPTX with tables/images, a DOCX, a CSV/XLSX and an image with a chart (BP §17.1). Write `BENCHMARK_CORPUS_MANIFEST.csv` | PLANNED | — | research/web | No client material | — | — | Every file has source URL, licence, category, year, format and test purpose |
| T-9.2 | Audit question set on the corpus: 30 answerable, 10 unanswerable, 10 wrong-paper/page/collection/permission traps, 5 comparison tables, 5 follow-ups (BP §8) | PLANNED | T-9.1 | testing/strategy | Permission-leak traps | — | — | 60 questions with expected sources and pages |
| T-9.3 | Audit the current SustainIQ repo: what works, and a **keep / change / delete list** for every file, route, table, script and test (anonymous ID, 7-day expiry, browser parsing, Render host, demo papers, Groq free-tier logic) | PLANNED | — | codebase/repository-understanding | — | — | Run the existing suite and evals as the baseline | Every tracked file is on the list; P10 uses it as is |
| T-9.4 | Audit **RAGFlow**: parsing, OCR, layout and tables, chunk inspection, citations; run it in Docker on the corpus against the current parser | PLANNED | T-9.1 | engineering/ai-systems | Where content goes; licence | — | Same corpus, same scoring | Scored 0–5 on the BP §17.4 rubric with evidence; integrate via adapter, use as a pattern only, or reject |
| T-9.5 | Audit **Infinity** against the current D1 FTS5 + Vectorize: filtered hybrid search (category, year, library, user), ranking, Docker ops, backups, cost | PLANNED | T-9.1, T-9.2 | engineering/architecture | Filters are not authorisation (BP §18.3) | — | Recall, citation validity, filter correctness | Rubric score; keep the current store or move behind `RetrievalIndex` |
| T-9.6 | Audit **Open WebUI** and **AnythingLLM**: answer quality on the question set, local versus cloud model switching, multi-user workspaces, usability | PLANNED | T-9.2 | engineering/ai-systems | Access isolation tests | Usability notes | Same 60 questions | Rubric scores; patterns to borrow listed; neither becomes the client UI (BP §18.4–18.5) |
| T-9.7 | Audit **Onyx** (= "UniX" in the call, owner confirmed): connector lifecycle, permission-aware search; community versus enterprise licence boundaries | PLANNED | — | engineering/architecture | Licence and feature gates | — | — | Rubric score; `SourceConnector` contract sketched for P17 |
| T-9.8 | Audit **Dify** (export workflows) and **React Flow** (admin ingestion diagram) | PLANNED | — | engineering/architecture | — | Admin trace mock | — | Rubric scores; Dify kept out of the answer path (BP §18.7) |
| T-9.9 | Licence and security pass on everything we might use: exact commit, licence, attribution, auth, tenant isolation, file validation, secrets (BP §17.3) | PLANNED | T-9.4–T-9.8 | engineering/security | BP §17.3 items 8–9 | — | — | One table per project; nothing copied without a recorded licence check |
| T-9.10 | Server-side extraction options for PDF/DOCX/PPTX/XLSX and scanned pages (current pdf.js, RAGFlow, Docling or similar, PaddleOCR, Google Document AI / Azure Read; D-018), measured on the corpus | PLANNED | T-9.1 | engineering/backend | Which services receive content | — | Page-anchor and reading-order checks | `DocumentExtractionProvider` choice and a fallback parser |
| T-9.11 | **Model choice: cheapest model that meets the quality bar** (owner, 2026-11-06). Run the 60 questions on low-cost cloud models (e.g. Gemini Flash-class, GPT mini-class, Groq-hosted gpt-oss-120b from the demo) and on **self-hosted Qwen as the backup**. Measure faithfulness, citation validity, decline accuracy, latency and **cost per answer and per month at 5, 25 and 100 users**. Also cost levers: small model for rewrite/guard, answer cache, prompt caching, short context from reranking, cheap embeddings | PLANNED | T-9.2 | engineering/ai-systems | What leaves the server (BP §9) | — | Eval vs the demo baseline | Quality bar set before the run (e.g. ≥ demo baseline faithfulness, 10/10 declines); the cheapest model that passes is the main one; Qwen fallback measured; average and worst-case monthly cost in INR |
| T-9.12 | Hosting, storage, backup and cost. **Decided (D-021): Cloudflare Workers Paid + own domain + R2 + Queues from the start**; a VM only if an audited tool (RAGFlow/Infinity) cannot run on Cloudflare and the owner approves it. Monthly cost at 5, 25 and 100 users and at 10, 50 and 200 GB stored (no upper limit, D-028); the client quote follows from this | PLANNED | T-9.4, T-9.5, T-9.11 | engineering/release | Data residency | — | — | One-time and monthly cost in INR, with assumptions |
| T-9.14 | **Capacity and overload design** (owner: the server must never overload; no repeat of the Supabase overload seen on the crypto-hunt project). Set targets: concurrent users, questions/min, uploads in flight, GB stored, p95 answer time. Design for them: queue with back-pressure for ingestion, connection limits/pooling on the database, per-user and global rate limits, model budget cap, provider fallback (cloud → Qwen), "busy, try again" instead of crashing; load balancing (built in on Workers; Cloudflare LB or Caddy/nginx in front of ≥ 2 instances on a VM). Write the load-test plan for P15 | PLANNED | T-9.12 | testing/performance, engineering/architecture | Limits from config | — | Baseline load run on the current demo stack | Targets and the overload design approved by the owner; every database/queue/provider limit of the chosen hosting written down with headroom |
| T-9.15 | **Storage with no size limit** (D-028). Cloudflare limits: a D1 database is capped at 10 GB and cannot be raised (1 TB per account); a Vectorize index holds up to 20 million vectors; R2 has no cap. Measure how much D1 space (text + keyword index) and how many vectors 1 GB of the corpus needs, then plan the growth: **100% Cloudflare (D-030)**: add extra D1 databases (split by library or year; 100,000 per account included, USD 0.10/month each after that, 1 TB account storage that can be raised on request) and extra Vectorize indexes when one fills. No Postgres or other outside database | PLANNED | T-9.1, T-9.5 | engineering/architecture | Splitting never mixes libraries or owners | — | Measured on the corpus | Written growth path to at least 200 GB with the point where each limit is hit; owner approves |
| T-9.13 | Write `docs/audit/AUDIT_REPORT.md` and `EVALUATION_RESULTS.csv`; record one decision per component in `docs/PROJECT_DECISIONS.md`; owner exit gate: extraction, retrieval store, model mode, login, storage growth path (T-9.15), storage/backups, category/year method, quotas and retention (BP §17.6) plus the open decisions below | PLANNED | T-9.3–T-9.12 | engineering/architecture | — | — | — | Owner approves each decision in writing; the plan below is updated to the approved choices only |

## P10 · Demo cleanup
Status: PLANNED · Depends: P9, client feedback on the demo · Paths: from the T-9.3 list · Flags: testing · Evidence: —
Objective: Remove what the production build does not need, keep what the next phases reuse. The live demo at sustainiq-demo.onrender.com stays up until the client's feedback is in (owner, 2026-11-06).

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-10.1 | Tag the last demo commit (`demo-final`) so the live demo can be rebuilt; work on a branch | PLANNED | T-9.13 | engineering/release | — | — | — | Tag pushed; the demo still serves from it |
| T-10.2 | Delete the "delete" items from the T-9.3 list (expected: demo-only limits and 7-day expiry, anonymous-ID-only paths, Render-only server pieces, curated demo-paper scripts and data, stray files such as the root PDF and `test pdf/`); keep their tests only where they carry over | PLANNED | T-10.1 | engineering/simplicity | Secrets never committed | — | `agylite verify` | Only approved items removed; tests, types, lint and build pass |
| T-10.3 | Update docs that describe the demo (PRD, TRD, ARCHITECTURE, FEATURES, SECURITY) to point at production | PLANNED | T-10.2 | engineering/documentation | — | — | — | No doc describes deleted behaviour as current |
| T-10.4 | Turn off the Render demo and its free-tier data once production is live (owner runs the commands) | PLANNED | T-15.6 | engineering/release | Delete demo data | — | — | Demo link retired; nothing left on free tiers |
| T-10.5 | **Basic rate limit on the live demo** (gap found 2026-11-15: nothing limits requests today, so a script can drain the Groq quota and Workers AI). Per anonymous ID **and** per client IP on `/api/chat`, uploads and new anonymous IDs, with values from config and a global daily LLM budget. Return `429` with `Retry-After`. Client IP comes only from a header the host sets (SEC §8). Plus **Cloudflare Turnstile** on the first question and on uploads, with the token checked on the server. **Confirmed by the owner (D-023).** Built on Workers with Cloudflare's rate limiting, so it runs right after the hosting move (D-021) | PLANNED | — | engineering/security | SEC §8, §12 #4; SEC §13 #12, #24 | Existing "rate_limited" message | 429 test; spoofed `X-Forwarded-For` test | 21st question in a minute gets 429; a forged IP header does not reset the limit; limits read from env |

## P11 · Production foundation: accounts, libraries, categories (BP Workstream A)
Status: PLANNED · Depends: P10 · Paths: migrations/**, src/worker/security/**, src/worker/routes/** · Flags: security, testing · Evidence: —
Objective: Real users with roles, one shared library plus a private library per user, and admin-run categories with year collections, all enforced on the server.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-11.1 | Schema: organisations, users, roles, groups, libraries, categories (aliases), collections, permissions, audit_events (BP §6, §20) | PLANNED | — | engineering/backend | — | — | Schema tests | Migration applies on dev and prod |
| T-11.2 | Authorisation tests **first**: private, cross-user, cross-library, category and year scope (BP §22 A5) | PLANNED | T-11.1 | testing/security | BP §21 1–2 | — | Failing tests committed first | Tests fail before T-11.3–T-11.5, pass after |
| T-11.3 | **One login page for everyone** (D-026), built into the app with a maintained auth library (D-024; e.g. Better Auth on D1): sign up and sign in with email + password or Google. **Only allowed email domains** (D-027; e.g. the college's `.ac.in` domain, list kept in config and editable by an admin): any other address (Gmail, Hotmail, Yahoo…) is refused on sign-up and sign-in. The email must be proven: a verification link for password sign-up; for Google, `email_verified` plus the domain check. Roles admin, staff and user are stored in our database. After sign-in, everyone lands in the same app; admins also see an Admin section. No separate admin login and no Cloudflare dashboard | PLANNED | T-11.1 | engineering/security | SEC §10; role checked on the server for every admin route, not just hidden in the UI | Login / sign-up screen | Login security tests; a staff/user calling an admin API gets 403; a Gmail or unverified address is refused | One page signs in all roles; admins see Admin, others do not and cannot reach it |
| T-11.4 | Shared versus private libraries; Shared or Private chosen at upload (default from the moderation decision) | PLANNED | T-11.3 | engineering/backend | BP §16.2 | — | T-11.2 tests | A private paper is never retrieved by another user |
| T-11.5 | Category admin: create, rename, alias, archive, merge with preview; year collections built automatically; Unclassified queue (BP §19.1) | PLANNED | T-11.1 | engineering/backend | Admin-only | — | Merge/rename tests | Renaming or merging never orphans documents or vectors |
| T-11.6 | Audit events for upload, delete, share, role and category changes | PLANNED | T-11.1 | engineering/security | BP §16.2 #6 | — | — | Every mutation has actor, time, before and after |
| T-11.7 | Move existing demo content into a clearly named development organisation | PLANNED | T-11.4 | engineering/migration | — | — | — | No demo data visible in the client organisation |
| T-11.8 | **Account-security rules for the login** (SEC §10, §12b): users keyed by the provider's stable subject ID, never by email (OAuth email spoof); emails/usernames canonicalised (NFKC + case-fold) before uniqueness checks and lookups (Unicode lookalikes); opaque server-side sessions, or JWTs with the algorithm pinned on verify (`alg: none` and HS/RS confusion rejected); one-time codes and magic links single-use, short-lived and rate-limited (2FA replay); passwords only if unavoidable, through the auth library with Argon2id and a byte-length cap (bcrypt's 72-byte truncation); session tokens from `crypto.getRandomValues`, compared in constant time | PLANNED | T-11.3 | engineering/security | SEC §10, §12b #2, #4, #6, #8, #13, #14, #20 | — | SEC §13 #25–29 written first, with T-11.2 | All five tests pass; a second account with a lookalike or differently-cased email is refused |

## P12 · Durable ingestion with no size limit (BP Workstream B)
Status: PLANNED · Depends: P11 · Paths: src/worker/ingest/**, migrations/** · Flags: security, testing · Evidence: —
Objective: Server-side, queued ingestion of PDF, DOCX, PPTX, XLSX/CSV and TXT with OCR, page/slide anchors, duplicate detection and visible status, so a student can add papers every Friday and the client's archive (5–10 GB to start, growing without a limit, D-028) can be bulk-imported.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-12.1 | Private object storage for originals and derivatives; document versions | PLANNED | — | engineering/backend | Signed short-lived URLs (BP §21 3–4) | — | — | Originals never public |
| T-12.2 | Job queue with durable states queued → extracting → ocr → chunking → embedding → ready / warning / failed / deleted; status API; safe retry | PLANNED | T-12.1 | engineering/backend | — | — | Refresh/retry tests | A job survives a browser close and a worker restart |
| T-12.3 | Upload checks: extension, MIME, file signature, size, malware scan, page/slide count, quota, hash duplicate | PLANNED | T-12.1 | engineering/security | BP §19.2, SEC §5.1 | — | Spoofed/oversized file tests | Bad files rejected with a next-step message |
| T-12.4 | `DocumentExtractionProvider` with the approved extractor + tested fallback: PDF (two-column order, page anchors), DOCX, PPTX (slides, notes, images), XLSX/CSV (sheet/row anchors), TXT/Markdown | PLANNED | T-12.2, T-9.10 | engineering/ai-systems | Document text is untrusted (BP §21 6) | — | Corpus fixtures per format | Each format reaches Ready with correct anchors |
| T-12.5 | Server-side OCR for scanned pages with confidence and a low-confidence warning (replaces browser OCR, D-018) | PLANNED | T-12.4 | engineering/backend | Provider disclosure | — | Bad-scan fixture | Scans show OCR status and warnings |
| T-12.6 | Section-aware chunking reusing `src/shared/chunker.ts`; chunks carry library, categories, year, page/slide range, version | PLANNED | T-12.4 | engineering/ai-systems | Chunks never cross access boundaries | — | Existing chunker tests | Every chunk has full metadata |
| T-12.7 | Upload metadata: title, authors, year, DOI, type, categories, tags, PhD student, visibility, sharing declaration; auto-fill from the document, user corrects | PLANNED | T-12.4 | engineering/backend | — | — | — | Shared documents always have a category and a year |
| T-12.8 | Duplicate handling: same hash blocked, likely DOI/title duplicates flagged for the admin | PLANNED | T-12.3 | engineering/backend | — | — | Same-file-twice test | One copy per paper in the shared library |
| T-12.9 | Bulk import for the client's existing archive (folder upload or admin script), throttled, resumable | PLANNED | T-12.2 | engineering/backend | — | — | 1 GB dry run, then 20 GB | The whole archive imports without manual babysitting; speed per GB recorded |
| T-12.10 | **Office and server-side parsing safety** (DOCX/PPTX/XLSX are zipped XML; parsing moves from the browser to the server): XML parser with DTDs and external entities turned off (XXE); zip-bomb caps on entry count, total uncompressed size and compression ratio; external links and remote images in documents are never fetched (SSRF); macro formats (`.docm/.pptm/.xlsm`) rejected; extraction runs in a sandboxed job with time and memory limits; regexes run on server-side document text are linear and their input is length-capped first (ReDoS) | PLANNED | T-12.4 | engineering/security | SEC §12 #7, #14, #15; SEC §12b #7, #18 | — | SEC §13 #30–32 fixtures | XXE, zip-bomb and external-link fixtures are rejected or neutralised; a hostile file never stalls the queue for others |

## P13 · Retrieval, evidence and answers (BP Workstream C)
Status: PLANNED · Depends: P12 · Paths: src/worker/rag/** · Flags: security, testing · Evidence: —
Objective: Keep the demo's hybrid search and citation checks, add scope filters before retrieval, full citation details, honest decline and the first export, measured on the client's own question set.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-13.1 | `RetrievalIndex` adapter over the approved store; organisation, library, category, year and type filters applied **before** search, permissions re-checked after (BP §18.3, §21 1–2) | PLANNED | — | engineering/ai-systems | Prompt never sees out-of-scope text | — | Scope tests (BP §19.1 acceptance) | A Packaging/2024 question never cites another category or year |
| T-13.2 | Model gateway (D-022: any provider: Groq, OpenAI, Claude, Gemini, Workers AI…). Today one key and one URL serve every model, and Groq-only request fields are hard-coded in `src/worker/llm.ts`; move both to per-model config so the fallback chain can mix providers. `GenerationProvider` / `EmbeddingProvider` with the approved cheap cloud model first and **self-hosted Qwen as the fallback** (timeouts, circuit breaker when a provider fails or the budget cap is hit); per-answer cost logged; config only, branded "SustainIQ" | PLANNED | T-9.11 | engineering/ai-systems | Keys server-side only | — | llm tests incl. provider-down | Switching provider is a config change; with the cloud provider down, answers come from Qwen |
| T-13.3 | Citations from stored retrieval IDs with title, authors, year, page/slide, section, passage, DOI and library/collection; groundedness check (RAG §5.11, carried from P8) | PLANNED | T-13.1 | engineering/ai-systems | — | — | Citation validity on the question set | Every citation opens the right passage and page |
| T-13.4 | Evidence limitations, source disagreements and the approved decline message; no model-memory answers | PLANNED | T-13.3 | engineering/ai-systems | — | — | Unanswerable set | All 10 unanswerable questions decline |
| T-13.5 | Evidence-linked Excel/CSV export (comparison table and literature matrix with a Sources sheet), BP §19.5 first priority | PLANNED | T-13.3 | engineering/backend | Export respects permissions | — | Export keeps source IDs | Exported rows keep their citations |
| T-13.6 | Prompt-injection and cross-user tests, including instructions hidden in a PDF (BP §21 12) | PLANNED | T-13.1 | testing/security | BP §23 security tests | — | — | User A never gets user B's text by ID, search, cache, export or injection |
| T-13.7 | Client question set (BP §8) built with the professor once his first papers are in; baseline metrics recorded; runs on a schedule | PLANNED | T-13.4 | testing/regression | — | — | `npm run eval` | Recall, citation validity, faithfulness, decline accuracy and latency recorded |

## P14 · Production UI and admin, in the owner's colours
Status: PLANNED · Depends: P11, owner's palette · Paths: src/web/**, DESIGN.md · Flags: design, testing · Evidence: —
Objective: A simple, user-friendly SustainIQ for researchers, students and the admin, built in the colours the owner provides. Screens follow the APIs from P11–P13.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-14.1 | Apply the owner's colours: update DESIGN.md tokens (light and dark), contrast checked | PLANNED | owner palette | design/design-system | — | DESIGN.md | WCAG AA check | Owner approves the palette on real screens |
| T-14.2 | Chat: visible scope (Shared Library › Biopolymers › 2024), filter chips, citation panel with full details, Library evidence / AI synthesis labels, export button | PLANNED | T-13.3, T-14.1 | design/frontend | Safe markdown only | DESIGN.md | Browser check 1440/768/390 | Scope always visible before sending |
| T-14.3 | Library: categories with document counts, year filters, search, shared/private label, processing status; document detail page | PLANNED | T-12.2, T-14.1 | design/frontend | — | DESIGN.md | Browser check | A student finds a paper by category and year |
| T-14.4 | Upload flow with the metadata form, Shared/Private choice and live job status | PLANNED | T-12.7, T-14.1 | design/frontend | — | DESIGN.md | Browser check | Friday upload done without developer help |
| T-14.5 | Admin section inside the same app, shown only to admins (D-026). **First: users**: add a user by email, remove a user, change their role (admin / staff / user); the last admin cannot be removed. Then: categories, categories, ingestion queue and failures, duplicates, Unclassified queue, storage and model usage, audit log | PLANNED | T-11.5, T-12.2 | design/frontend | Admin-only routes | DESIGN.md | Browser check | Admin diagnoses a failed job without database access |
| T-14.6 | React Flow ingestion trace per document (fixed states, times, warnings, retry), admin only (BP §18.8) | PLANNED | T-14.5, T-9.8 | design/frontend | — | DESIGN.md | Browser check | Each state shows time and errors; retry works |

## P15 · Production hardening and launch
Status: PLANNED · Depends: P13, P14 · Paths: src/worker/security/**, test/security/** · Flags: security, testing · Evidence: —
Objective: The old P8 hardening, privacy and backups, the BP §13 acceptance checklist, then production goes live with the client's corpus.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-15.1 | Rate limits and model budget guard (from T-8.1, building on T-10.5), quotas from config; per user, per IP and global; client IP read only from the header the host guarantees (`CF-Connecting-IP` on Workers), never from `X-Forwarded-For` or `X-Real-IP` sent by the client | PLANNED | — | engineering/security | SEC §8; SEC §12b #11 | — | 429 test; spoofed-IP-header test (SEC §13 #24) | Limits read from config; a forged IP header cannot dodge or shift a limit |
| T-15.2 | Structured logging without secrets or document text, alerts, `security.txt` (from T-8.3), tracing | PLANNED | — | engineering/security | SEC §11 | — | Log-format test | Logs hold no secrets or PII |
| T-15.3 | Privacy notice that matches the deployed setup: which provider sees documents, prompts, embeddings and OCR | PLANNED | T-13.2 | engineering/security | BP §9, §21 11 | DESIGN.md | — | Client reads and accepts it |
| T-15.4 | Backups, restore test, deletion and retention rules documented and tested | PLANNED | T-12.1 | engineering/release | BP §21 10 | — | Restore drill | A restore from backup works |
| T-15.7 | Overload protection as designed in T-9.14: load balancing, connection pooling/limits, ingestion back-pressure, rate limits, budget cap, health checks, graceful "busy" responses | PLANNED | T-15.1, T-9.14 | engineering/backend, engineering/performance | — | — | Unit tests per guard | Every limit from config; no unbounded queue, pool or retry |
| T-15.8 | **Load tests** (e.g. k6) on a staging copy: normal load, 2× and 5× the T-9.14 targets (spike), a 2-hour soak, a 20 GB bulk import while users ask questions, and failure drills (model provider down, database slow) | PLANNED | T-15.7 | testing/performance | No real client data in staging | — | Method, environment and repeat count recorded | At target load p95 within the T-9.14 target and 0 errors; at 5× the server sheds load with "busy" and recovers by itself, never crashes or loses a job |
| T-15.9 | Test plan for the whole production release: unit, integration (every format, duplicates, reclassify, delete), security (BP §23), end-to-end browser flows for the BP §23 client demo, evals and load tests in CI or on a schedule | PLANNED | T-15.8 | testing/strategy | BP §23 | — | `agylite verify` | Every BP §23 test exists and passes |
| T-15.10 | **Edge and transport hardening**, needed only if T-9.12 picks a VM or Docker host instead of Workers: Cloudflare proxy in front, with the origin accepting only Cloudflare's IP ranges or a tunnel (HTTP/2 Rapid Reset, request smuggling); one proxy layer with consistent `Content-Length`/`Transfer-Encoding` handling; proxy and Node kept patched; CDN cache rules exclude `/api/*` and signed file URLs, and cache keys never use unkeyed headers (cache poisoning); any WebSocket checks `Origin` and the session cookie on the upgrade (WebSocket hijack) | PLANNED | T-9.12 | engineering/security, engineering/release | SEC §2, §12b #1, #9, #10, #19 | — | SEC §13 #21, #33 on the staging host | Origin unreachable except through the proxy; `/api/*` never served from cache |
| T-15.5 | Full security suite, load tests and the BP §13 checklist green | PLANNED | T-15.1–T-15.4, T-15.7–T-15.10 | testing/security | SEC §13 | — | `agylite verify` | Every BP §13 item ticked with evidence |
| T-15.6 | Production deploy (owner runs commands), invite the client's users, import the corpus, review the evaluation report with the client | PLANNED | T-15.5 | engineering/release, testing/release-verification | — | — | Smoke test | Client signs off the launch |

## P16 · Research outputs and growth (BP Phase 2, after a successful launch)
Status: PLANNED · Depends: P15, client go-ahead · Paths: — · Flags: design, testing · Evidence: —
Objective: The ChatGPT-style outputs the client asked for, always built from cited evidence.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-16.1 | Word/PDF cited report from one shared report format; no citation dropped | PLANNED | T-13.5 | engineering/backend | Fixed templates; user and model text inserted as data, never compiled as a template (SEC §12b #17) | DESIGN.md | Citation-count test | Report keeps every citation |
| T-16.2 | PPT: evidence outline → source check → slides with citations → user preview and edit (BP §19.5) | PLANNED | T-16.1 | engineering/backend | — | DESIGN.md | — | Draft deck reviewed before final |
| T-16.3 | Figures and images: extract with page and caption, image-aware search, cite figures (BP §19.3) | PLANNED | T-12.4 | engineering/ai-systems | — | — | Figure fixtures | A figure question cites its page |
| T-16.4 | Generated visuals from an evidence brief only, labelled "Generated from SustainIQ evidence" | PLANNED | T-16.3 | engineering/ai-systems | Only the brief leaves the server | DESIGN.md | Label test | Generated images are always labelled |
| T-16.5 | Scheduled weekly ingestion from chosen open sites, metadata templates, better OCR/tables from real failures | PLANNED | T-12.9 | engineering/backend | Licence of fetched papers | — | — | New open-access papers arrive without manual upload |

## P17 · Institution rollout (BP Phase 3, after management approves)
Status: PLANNED · Depends: P16, university approval · Paths: — · Flags: security · Evidence: —
Objective: Move from one lab to the whole college on **hosting we rent and run** (not the college's own server, D-029): bigger plan, SSO, connectors and an optional self-hosted model.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-17.1 | SSO and groups; finer permissions and audit reports | PLANNED | — | engineering/security | SAML/OIDC only through a maintained library; signed assertion required, audience and expiry checked, users keyed by stable subject ID (SEC §12b #3, #4) | — | — | College sign-in works |
| T-17.2 | Scale up on our rented hosting (D-029): bigger Cloudflare plan or limits, more storage and, only if confidentiality requires it, a rented GPU server for a self-hosted model | PLANNED | T-9.11 | engineering/release | Documents stay on our hosting | — | Eval vs production | Same evaluation scores on the scaled setup |
| T-17.3 | Connectors through `SourceConnector` (Onyx pattern): Drive, SharePoint and others as needed | PLANNED | T-9.7 | engineering/backend | Permission mirroring proven by tests | — | — | Synced sources obey source permissions |
| T-17.4 | Optional, clearly labelled web search, never mixed silently with library evidence (BP §5 rule 7) | PLANNED | — | engineering/ai-systems | — | DESIGN.md | — | Web results always labelled and off by default |
| T-17.5 | Optional multi-paper research agent (old T-9.6) and Dify export workflows outside the answer path | PLANNED | T-13.7 | engineering/ai-systems | Tool allowlist, budgets | — | Agent evals | Agent answers pass the same evaluation |
| T-17.6 | Separate environments, monitoring, disaster recovery, cost controls | PLANNED | — | engineering/release | — | — | DR drill | Runbooks written and tested |

**Open decisions for the owner and client (BP §24; asked, not assumed):**
- **Confidentiality versus cloud.** The professor repeatedly asked that documents stay private; a cloud model means documents and prompts go to the provider. Decided at T-9.13 and stated in the quote and privacy notice.
- Initial category list (blueprint suggests Biopolymers, Green Chemistry, Packaging, Biomaterials) and whether one document can have several.
- Shared uploads: publish immediately or after admin approval.
- ~~Sign-up~~: decided, only allowed college email domains, with the email verified (D-027). Still to confirm with the client: the exact domain list.
- Retention and deletion for shared and private material; storage and upload quotas.
- ~~Login method and hosting location~~: decided, auth library in the app (D-024) and Cloudflare Workers Paid plus own domain (D-021).
- Which exports count as official (Excel first; Word/PDF/PPT later), and the wording for generated images.
- Web search: the professor asked for it; the blueprint keeps it out until it is explicit and labelled (P17).
- Carried from the demo: "Use the library" default; what the chat-delete prompt does with PDFs.
- Design: the owner will provide the colours (T-14.1).

---

## Production stack (D-021, D-022, D-024, D-028, D-029)

Everything runs on hosting we pay for. No free tiers, no college server.

| Part | What we use | Notes |
|---|---|---|
| Domain, DNS, SSL, DDoS, firewall | Our own domain on **Cloudflare** | Geo/IP firewall and WAF rules come with it |
| Frontend (website) | **React 19 + Vite + Tailwind**, served as **Cloudflare Workers static assets** | Same code as the demo |
| Backend API | **Hono** (TypeScript) on **Cloudflare Workers Paid** (USD 5/month base) | Replaces Render |
| Database | **Cloudflare D1** (SQLite + FTS5 keyword search) | 10 GB per database; extra D1 databases when needed (T-9.15, D-030) |
| Meaning search | **Cloudflare Vectorize** | Up to 20 million vectors per index |
| Original files | **Cloudflare R2** | No size cap; private, short-lived signed links |
| Background jobs (ingestion, OCR) | **Cloudflare Queues / Workflows** | Survive restarts; retry safely |
| Embeddings and reranking | **Cloudflare Workers AI** | Same as the demo; re-checked in P9 |
| Answer model (LLM) | **Any provider by config**: Groq, OpenAI, Claude, Gemini, Workers AI… | Cheapest model that passes the quality bar (T-9.11) |
| PDF/Office reading and OCR | Server-side extractor chosen in T-9.10 | Replaces browser parsing |
| Cache | **Cloudflare KV** | Answer cache |
| Login | **Better Auth** (or similar library) on D1, email + password or Google, allowed college domains only | One login page; admin section by role (D-026, D-027) |
| Sign-up emails | An email-sending service (chosen in P11) | For verification and password-reset links |
| Rate limits and bots | **Cloudflare Rate Limiting** + **Turnstile** | T-10.5 |
| Logs and monitoring | **Workers Observability** (+ tracing tool chosen in T-15.2) | No secrets or document text in logs |
| Code and CI | **GitHub** (private repo) | `agylite verify` before every deploy |

## Phase order and timing (production)

```
P9 Audit ──► P10 Cleanup ──► P11 Accounts ──► P12 Ingestion ──► P13 Retrieval ──► P15 Launch ──► P16 Outputs ──► P17 Rollout
                                  └──────────► P14 UI (owner's colours) ──────────────┘
```

| Phase | Estimate |
|---|---|
| P9 Audit and decisions | ~1 week (BP §11) |
| P10 Demo cleanup | 1–2 days |
| P11–P15 Production launch | 4–6 weeks (no pilot stage, so production hardening is in scope from the start) |
| P16 Outputs | 4–6 weeks, after the launch |
| P17 Rollout | after university approval |

**Gates (owner decides):** end of P9 (all audit decisions) · start of P10 (client feedback in) · T-14.1 (palette) · T-15.6 (launch sign-off) · start of P16 (client go-ahead) · start of P17 (management approval).

## Phase order and timing (demo)

```
P1 ──► P2 ──► P3 ──► P4 ──┐
 └───► P5 (UI, against a mocked API) ──► P6 ──► P7 ──► P8
```

| Phase | Est. working days |
|---|---|
| P1 Foundations and platform check ✅ | 1 |
| P2 Paper ingestion ✅ (incl. Render move) | 2 |
| P3 Retrieval and evaluation | 1.5 |
| P4 Answer generation | 1.5–2 |
| P5 UI foundation and chat | 2 |
| P6 Library and history | 1 |
| P7 PDF uploads | 1–1.5 |
| P8 Hardening and launch | 1–1.5 |
| **Total** | **≈ 10.5–12.5 days** |

**Decision gates (owner decides):** after T-1.7 ✅ (option B: no LangGraph) · after P2 ✅ (demo on Render) · after T-2.5 ✅ (pdf.js for the demo; better table parser in P9) · after T-3.7 (accept retrieval quality) · after T-8.7 (send the demo).

## Change history

| Date | Change |
|---|---|
| 2026-11-05 | Plan created |
| 2026-11-05 | Phases P1–P9 written from PROJECT_PLAN.md, SECURITY.md and RAG_PRODUCTION_GUIDE.md |
| 2026-11-05 | T-1.7 result: LangGraph over the free CPU limit; owner chose option B (plain functions in the demo, LangGraph in P9) |
| 2026-11-05 | P2: ingestion exceeded the Workers free CPU limit; per the owner's rule the demo moved to Render (D-012). Demo deploys (T-8.6) go to Render via the Render CLI; production stays on Cloudflare |
| 2026-11-05 | P2 verified: 20 papers / 881 chunks / 881 vectors; T-2.8 (Render host) added; T-3.6, T-7.5, T-8.1, T-8.6 updated for Render |
| 2026-11-05 | T-1.7: PLANNED → BLOCKED |
| 2026-11-05 | P1: PLANNED → IN_PROGRESS (roll-up from T-1.7) |
| 2026-11-05 | P1: IN_PROGRESS → PARTIALLY_COMPLETE |
| 2026-11-05 | T-1.1: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-1.1: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-1.1: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | T-1.2: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-1.2: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-1.2: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | T-1.3: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-1.3: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-1.3: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | T-1.4: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-1.4: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-1.4: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | T-1.5: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-1.5: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-1.5: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | T-1.6: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-1.6: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-1.6: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | T-1.8: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-1.8: IN_PROGRESS → PARTIALLY_COMPLETE |
| 2026-11-05 | T-1.7: BLOCKED → IN_PROGRESS |
| 2026-11-05 | T-1.7: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-1.7: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | T-1.8: PARTIALLY_COMPLETE → READY_FOR_VERIFICATION |
| 2026-11-05 | T-1.8: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | P1: PARTIALLY_COMPLETE → VERIFIED (roll-up from T-1.8) |
| 2026-11-05 | P1: VERIFIED → IN_PROGRESS |
| 2026-11-05 | P1: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | P1: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P1.md) |
| 2026-11-05 | T-2.2: PLANNED → IN_PROGRESS |
| 2026-11-05 | P2: PLANNED → IN_PROGRESS (roll-up from T-2.2) |
| 2026-11-05 | T-2.2: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-2.2: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P2.md) |
| 2026-11-05 | T-2.3: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-2.3: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-2.3: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P2.md) |
| 2026-11-05 | T-2.4: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-2.4: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-2.4: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P2.md) |
| 2026-11-05 | T-2.5: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-2.5: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-2.5: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P2.md) |
| 2026-11-05 | T-2.6: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-2.6: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-2.6: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P2.md) |
| 2026-11-05 | T-2.7: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-2.7: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-2.7: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P2.md) |
| 2026-11-05 | T-2.1: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-2.1: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-2.1: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P2.md) |
| 2026-11-05 | P2: IN_PROGRESS → VERIFIED (roll-up from T-2.1) |
| 2026-11-05 | T-2.8 added to P2 Paper ingestion: Move the demo host to Render (D-012): same Hono app on Node, Cloudflare D1/Vectorize/Workers AI/KV via REST, Render CLI deploy (phase reopened) |
| 2026-11-05 | T-2.8: PLANNED → IN_PROGRESS |
| 2026-11-05 | T-2.8: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-05 | T-2.8: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P2.md) |
| 2026-11-05 | P2: IN_PROGRESS → VERIFIED (roll-up from T-2.8) |
| 2026-11-06 | T-6.2: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P6.md) |
| 2026-11-06 | T-6.4: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P6.md) |
| 2026-11-06 | P6: READY_FOR_VERIFICATION → VERIFIED (roll-up from T-6.4) |
| 2026-11-06 | T-7.1: PLANNED → IN_PROGRESS |
| 2026-11-06 | P7: PLANNED → IN_PROGRESS (roll-up from T-7.1) |
| 2026-11-06 | T-7.1: IN_PROGRESS → READY_FOR_VERIFICATION (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.2: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.2: IN_PROGRESS → READY_FOR_VERIFICATION (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.3: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.3: IN_PROGRESS → READY_FOR_VERIFICATION (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.4: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.4: IN_PROGRESS → READY_FOR_VERIFICATION (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.5: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.5: IN_PROGRESS → READY_FOR_VERIFICATION (evidence: docs/evidence/P7.md) |
| 2026-11-06 | P7: IN_PROGRESS → READY_FOR_VERIFICATION (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.1: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.2: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.3: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.4: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.5: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | P7: READY_FOR_VERIFICATION → VERIFIED (roll-up from T-7.5) |
| 2026-11-06 | T-7.6 added to P7 PDF uploads: OCR for scanned PDFs in the browser (self-hosted tesseract.js; text-less pages only); Ready waits until the upload is searchable; topic guard allows questions about own uploads (phase reopened) |
| 2026-11-06 | T-7.7 added to P7 PDF uploads: Claude/ChatGPT-style chat: centred new-chat box, + to attach PDFs as chips in the question box (only upload point), question bubble, labelled back buttons |
| 2026-11-06 | T-7.6: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.6: IN_PROGRESS → READY_FOR_VERIFICATION (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.7: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.7: IN_PROGRESS → READY_FOR_VERIFICATION (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.8 added to P7 PDF uploads: Tune OCR: extra title pass on page 1 only, 2000 px render |
| 2026-11-06 | T-7.9 added to P7 PDF uploads: Ready without the Vectorize wait: owner-uploads keyword list added to fusion, finish no longer waits |
| 2026-11-06 | T-7.10 added to P7 PDF uploads: Per-page OCR quality warning from tesseract confidence |
| 2026-11-06 | T-9.8 added to P9 Paid MVP (after the deal): Production OCR: self-hosted PaddleOCR or Google Document AI / Azure Read for scanned pages, tesseract.js fallback, background job (Queues/Workflows); benchmark first (D-018) |
| 2026-11-06 | T-7.6: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-9.8: PLANNED → INTENTIONALLY_DEFERRED |
| 2026-11-06 | T-7.11 added to P7 PDF uploads: Chat-scoped uploads: a PDF added in a chat is searched only in that chat (papers.chat_id, Vectorize metadata index, owner+chat scope in search and D1 re-check, chat created on first upload, deleted with the chat) |
| 2026-11-06 | T-7.12 added to P7 PDF uploads: Use-the-library toggle per chat: PDFs only / library only / both; default: library off when a PDF is attached, on when none |
| 2026-11-06 | T-7.13 added to P7 PDF uploads: Upload button in the Library: personal library PDFs (not tied to a chat), used in any chat with the library on |
| 2026-11-06 | T-7.14 added to P7 PDF uploads: Several PDFs per chat: check and fix multi-file attach (owner saw only one) and per-chat file list |
| 2026-11-06 | T-7.8: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.8: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-06 | T-7.9: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.9: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-06 | T-7.11: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.12: PLANNED → IN_PROGRESS |
| 2026-11-06 | T-7.11: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-06 | T-7.12: IN_PROGRESS → READY_FOR_VERIFICATION |
| 2026-11-06 | T-7.8: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.9: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.11: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-06 | T-7.12: READY_FOR_VERIFICATION → VERIFIED (evidence: docs/evidence/P7.md) |
| 2026-11-15 | Owner: no upper storage limit (D-028, T-9.15 added); later rollout on hosting we rent, not the college's server (D-029); production stack table added |
| 2026-11-15 | Owner: pilot stage removed, straight to a full production launch (D-025); login by auth library (D-024); Workers Paid + own domain (D-021); any LLM provider (D-022); rate limits + Turnstile required (D-023); security tasks T-10.5, T-11.8, T-12.10, T-15.10 added |
| 2026-11-06 | Old P9 replaced by the production plan P9–P17 (audit of SustainIQ, RAGFlow, Infinity, Open WebUI, AnythingLLM, Onyx, Dify, React Flow → demo cleanup → 5-user pilot → blueprint), from real rag/SUSTAINIQ_PRODUCTION_BLUEPRINT.md and the client call; owner chose pilot-first and keeping the demo live until client feedback |
| 2026-11-06 | Owner: cheapest model that meets the quality bar, self-hosted Qwen as backup (T-9.11, T-13.2); capacity and overload design T-9.14; overload protection, load tests and the full test plan T-15.7–T-15.9 |
