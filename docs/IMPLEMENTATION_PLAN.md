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

**Scope:** P1–P8 build the **demo** (Render free web service at https://sustainiq-demo.onrender.com with data on Cloudflare, Groq, no login; D-012). P9 is the **paid MVP** on Cloudflare Workers Paid, deferred until the client accepts the deal.

**Progress (2026-11-06):** P1 ✅ verified · P2 ✅ verified (20 papers, 881 chunks, 881 vectors) · P3 ✅ verified (hybrid + fused rerank: recall@6 1.00, MRR 0.944, ~0.85 s server-side) · P4 ✅ verified (35/35 faithful, 5/5 declines, 6/6 injection; first token ~3 s on Render) · P5 ✅ verified (chat UI, citation panel/sheet, AA contrast; design check override D-015) · **next: P6**. Changes from the first draft: no LangGraph in the demo (D-010), Groq models updated (D-011), demo hosted on Render (D-012), gpt-oss-20b removed from the answer chain (D-013).

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
Status: PLANNED · Depends: P4, P5 · Paths: src/worker/routes/papers.ts, src/worker/routes/chats.ts, src/web/pages/** · Flags: security, testing · Evidence: —
Objective: Browse the paper library and return to past conversations, each strictly scoped to its owner.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-6.1 | `GET /api/papers` (public + own), `GET /api/papers/:id` with sections | PLANNED | T-2.6 | engineering/backend | Owner-scoped SQL, 404 for others (SEC §3.2) | — | SEC §13 #1 | Other owners' papers return 404 |
| T-6.2 | Library page: search, topic filters, paper cards, paper detail | PLANNED | T-6.1, T-5.2 | design/frontend | Titles rendered as text | DESIGN.md | Component tests | Filters and search work on mobile and desktop |
| T-6.3 | Chat history API: list, open, rename, delete (D1, owner-scoped) | PLANNED | T-4.7 | engineering/backend | SEC §3.2 | — | SEC §13 #1 | History survives reloads; others' chats return 404 |
| T-6.4 | History sidebar wired to the API; new chat; grouping by date | PLANNED | T-6.3, T-5.2 | design/frontend | — | DESIGN.md | Component tests | Past chats reopen with their citations |

## P7 · PDF uploads
Status: PLANNED · Depends: P2, P6 · Paths: src/web/upload/**, src/worker/routes/upload.ts, src/worker/cron.ts · Flags: security, testing · Evidence: —
Objective: Users upload their own PDFs (5 × 100 pages), parsed in the browser, re-validated on the server, private to them, deleted after 7 days.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-7.1 | Browser parsing in a Web Worker with pdf.js (scripting off, magic-byte check, size/page caps, timeout) using the shared chunker | PLANNED | T-2.4 | engineering/frontend | SEC §9, §12 #15 | — | Fixture tests; malicious-PDF caps | A 30-page paper parses in the browser |
| T-7.2 | `POST /api/upload` in batches: zod re-validation, server IDs and embeddings, **atomic** quota check (5 PDFs / 100 pages) | PLANNED | T-7.1, T-2.6 | engineering/backend, engineering/security | SEC §5.1, §12 #3 | — | SEC §13 #13, #14, #19 | 10 parallel uploads at 4/5 → exactly 1 succeeds |
| T-7.3 | Upload UI: drag-and-drop, progress (Reading → Splitting → Indexing), limits and "don't upload confidential documents" notice | PLANNED | T-7.1, T-5.2 | design/frontend | SEC §12 #21 | DESIGN.md | Visual check on a phone | Upload works on desktop and mobile |
| T-7.4 | Own uploads searchable only by their owner; "Your upload (unverified)" labels | PLANNED | T-7.2, T-3.4 | engineering/ai-systems | SEC §12 #10 | DESIGN.md | SEC §13 #4 | User A never sees user B's upload |
| T-7.5 | Cleanup as a **Cloudflare Worker cron** (free; data lives on Cloudflare; Render's free tier has no cron): expire uploads after 7 days; orphan-vector cleanup; "delete my data" endpoint + button | PLANNED | T-7.2 | engineering/backend | SEC §12 #16 | — | SEC §13 #23 | Deleted text is never found again |

## P8 · Hardening and demo launch
Status: PLANNED · Depends: P4, P6, P7 · Paths: src/worker/security/**, test/security/** · Flags: security, testing · Evidence: —
Objective: Every [DEMO] item in SECURITY.md done, abuse limits on, full test suite green, live demo link ready for the client.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-8.1 | Rate limits (questions, uploads, new IDs): demo on Render (single instance) uses in-memory per-minute limits + D1 daily counters; the production Worker uses the Rate Limiting binding / Durable Objects; global LLM and Workers AI budget guard | PLANNED | T-4.7, T-7.2 | engineering/security | SEC §8, §12 #4 | — | SEC §13 #12 | 21st question in a minute → 429 |
| T-8.2 | Cloudflare Turnstile on the first question and on uploads (server-side token check) | PLANNED | T-8.1 | engineering/security | SEC §8 | Fits DESIGN.md | Token-missing test | Bots without a token are blocked |
| T-8.3 | Structured JSON logging (no secrets or raw IPs), alerts, `/.well-known/security.txt` | PLANNED | T-1.4 | engineering/security | SEC §11, §12 #13, incident response | — | Log-format test | Logs contain no secrets or PII |
| T-8.4 | Full security test suite (SEC §13 #1–23) green in CI | PLANNED | T-8.1–T-8.3 | testing/security | All of SEC §13 | — | `agylite verify` | 23/23 pass |
| T-8.5 | Final eval run on production (retrieval + answers) | PLANNED | T-8.4 | testing/regression | — | — | `npm run eval -- --remote` | Scores ≥ P3/P4 baselines; recorded |
| T-8.6 | Demo deploy to Render (Render CLI) + smoke test, waking the free instance first (5 golden questions, citations open the right page, upload from a phone, headers, 429) | PLANNED | T-8.5 | engineering/release, testing/release-verification | SEC §14 demo checklist | — | Smoke checklist | Every [DEMO] item ticked |
| T-8.7 | Demo hand-off: short walkthrough video and a one-page "how it works" for the client | PLANNED | T-8.6 | media/demo | No private data in the video | DESIGN.md | Review by the owner | Link + video sent before the Google Meet |

## P9 · Paid MVP (after the deal)
Status: INTENTIONALLY_DEFERRED · Depends: P8 · Paths: — · Flags: security, design, testing · Evidence: —
Objective: Turn the demo into the client's production MVP on Cloudflare Workers Paid. Re-planned in detail after the client call; tasks below are the known scope.

| ID | Task | Status | Depends | Capabilities | Security | Design | Testing | Acceptance |
|---|---|---|---|---|---|---|---|---|
| T-9.1 | Move to Cloudflare Workers Paid ($5); custom domain; WAF; D1 backups | INTENTIONALLY_DEFERRED | — | engineering/release | SEC §2 [MVP] | — | — | Client decision |
| T-9.2 | Switch the LLM to OpenAI (first in the fallback chain); re-run all evals | INTENTIONALLY_DEFERRED | — | engineering/ai-systems | Provider data-use check (SEC §11) | — | Eval vs demo baseline | Client decision |
| T-9.3 | Real login (magic link / Google) replacing the anonymous ID | INTENTIONALLY_DEFERRED | — | engineering/security | SEC §10 | DESIGN.md | Login security tests | Client decision |
| T-9.4 | Server-side processing of big PDFs (300–400 pages) with Cloudflare Queues | INTENTIONALLY_DEFERRED | — | engineering/backend | SEC §5.1 | — | Large-PDF tests | Client decision |
| T-9.5 | Optional Python parsing service (Docling/GROBID) if T-2.5 found table problems | INTENTIONALLY_DEFERRED | T-2.5 | engineering/ai-systems | SEC §12 #7 | — | Table fixtures | Only if needed |
| T-9.6 | Reintroduce LangGraph (paid plan) and build an agent for multi-paper research questions | INTENTIONALLY_DEFERRED | — | engineering/ai-systems | Tool allowlist, budgets (RAG §7) | — | Agent evals | Client decision |
| T-9.7 | Tracing (Langfuse), privacy notice, dependency scanning, SEC §14 MVP checklist | INTENTIONALLY_DEFERRED | — | engineering/security | SEC §14 [MVP] | — | — | Client decision |

---

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
