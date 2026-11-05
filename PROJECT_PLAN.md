# SustainIQ: Project Plan

## 1. What we're building

**SustainIQ** is an AI research assistant for **sustainable materials, biomaterials, green chemistry and sustainable packaging**. Users ask questions in plain English and get answers written **only from research papers**, with numbered citations that open the exact passage, paper, page and DOI. If the papers don't contain the answer, it says so instead of guessing.

**Who it's for:** a client in Bangalore. The MVP must have an AI chatbot, scientific paper/PDF analysis, RAG retrieval, cited answers and a mobile-friendly web app.

**Two stages:**
1. **Demo (now, free):** a working SustainIQ at **https://sustainiq-demo.onrender.com** to show the client before the Google Meet. Free AI models (Groq), no login.
2. **Paid MVP (after the deal):** Cloudflare Workers Paid, OpenAI, real login and production hardening.

Related docs: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) (phases and task status) · [RAG_PRODUCTION_GUIDE.md](RAG_PRODUCTION_GUIDE.md) (RAG rules) · [SECURITY.md](SECURITY.md) (security rules and tests) · [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md) (decision log) · [docs/evidence/](docs/evidence/) (proof for each phase).

---

## 2. Status (updated 2026-11-05)

| Phase | Status | Result |
|---|---|---|
| P1 Foundations and platform check | ✅ Verified | Secure app shell; Cloudflare D1 (FTS5), Vectorize, Workers AI and KV for dev + production; security headers, signed anonymous cookie, CSRF guard, admin token; Groq checked (models updated). [Evidence](docs/evidence/P1.md) |
| P2 Paper ingestion | ✅ Verified | **20 curated CC BY papers → 881 chunks → 881 vectors** (5 papers per topic); demo moved to Render. [Evidence](docs/evidence/P2.md) |
| P3 Retrieval and evaluation | ⏳ Next | Hybrid search + RRF + reranker, measured on a golden set |
| P4 Answer generation | Planned | Streaming cited answers, citation validation, "I couldn't find this" |
| P5 UI and chat | Planned | Calm sage-green design, citation panel / bottom sheet |
| P6 Library and history | Planned | |
| P7 PDF uploads | Planned | |
| P8 Hardening and demo launch | Planned | |
| P9 Paid MVP | On hold until the deal | |

**Live:**
- **Demo:** https://sustainiq-demo.onrender.com (Render free, Singapore). Sleeps after 15 min idle; the first visit then takes 30–60 s.
- **Production path:** https://sustainiq.sustainiq.workers.dev (Cloudflare Worker, same code, kept deployed for the MVP).
- **Code:** https://github.com/Vikhyath-thelazycoder/sus (public; consider making it private, since this is client work).
- **Quality gate:** `agylite verify` passes; 72 tests (Workers runtime + Node).

**Changes from the original plan (all recorded in the decision log):**
1. **LangGraph is not in the demo** (D-010). It fit on size (502 KB) but used 14 ms median / 82 ms p90 CPU per request against the Workers free plan's 10 ms. The pipeline runs as plain functions; LangGraph returns in the MVP for agents.
2. **Groq models changed** (D-011). Groq retired Llama 3.3 70B and 3.1 8B; the chain is now `gpt-oss-120b → qwen3.8-27b → gpt-oss-20b`.
3. **The demo runs on Render** (D-012). Paper loading used 10–30 ms CPU per request on the Workers free plan, so per the owner's rule the demo moved to Render's free tier. Same Hono app on Node; the data stays on Cloudflare (D1, Vectorize, Workers AI, KV) through the REST API. Production stays on Cloudflare Workers Paid.

---

## 3. Decisions made

| Area | Decision |
|---|---|
| Hosting: demo | **Render free web service** `sustainiq-demo` (Singapore), deployed with the Render CLI from GitHub `main` (auto-deploys on push). Same Hono app on Node (`src/server/node.ts`); D1, Vectorize, Workers AI and KV over Cloudflare's REST API (`src/server/cloudflare-rest.ts`). (D-012) |
| Hosting: production | **Cloudflare Workers Paid ($5/month + usage) only.** |
| Caching | **Workers KV** for the answer cache (reached over REST from Render). No Redis. |
| Counters / rate limits | Demo on Render (single instance): in-memory per-minute limits + D1 daily counters. Production on Workers: Rate Limiting binding / Durable Objects. |
| Scheduled cleanup | A **Cloudflare Worker cron** (free) deletes expired uploads and orphan vectors, since the data lives on Cloudflare. Render's free tier has no cron. |
| Big PDFs | Demo: parsed in the browser (5 PDFs × 100 pages). Production: processed on the server with **Cloudflare Queues**. |
| PDF parsing | **pdf.js** (shared code for the browser and the ingest script). Tables keep their values but lose rows/columns (T-2.5); a Python parser (Docling/GROBID) or `toMarkdown` is an MVP option. |
| Database | **D1 (SQLite + FTS5) + Vectorize.** Supabase considered and not chosen. |
| Answer AI | **Groq** `openai/gpt-oss-120b → qwen/qwen3.8-27b → openai/gpt-oss-20b`; small helper model `openai/gpt-oss-20b`. Switching to OpenAI is config only. (D-011) |
| Orchestration | **Demo: plain TypeScript functions.** **MVP: LangGraph** on the paid plan for agents. (D-010) |
| RAG engine | Our own: Workers AI `bge-m3` → **Vectorize** (meaning) + **D1 FTS5** (keyword/BM25) → **RRF** → Workers AI `bge-reranker-base`. |
| Papers | **20 curated open-access CC BY papers** (OpenAlex), plus user uploads. |
| Uploads | Parsed in the browser (pdf.js). 5 PDFs × 100 pages per user, private to the uploader, deleted after 7 days. |
| Look | Minimal, calm: **warm off-white + sage green**, dark mode. Desktop-first, fully mobile-friendly. |
| Citations UI | Click `[n]` → **side panel** (desktop) / **bottom sheet** (mobile) with passage, title, authors, year, page, DOI. |
| Screens | Chat with cited answers · Paper library · Upload PDF · Chat history sidebar. |
| Login | **None in the demo.** Signed anonymous cookie; chat history in D1. |
| Off-topic | Polite decline with a suggested on-topic question. |

---

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | One language for web, server and scripts |
| Frontend | **React + Vite**, Tailwind CSS | Simple SPA; served by Render (demo) or the Worker (production) |
| Markdown | `react-markdown` (raw HTML off, images dropped) | Safe rendering of AI output (SECURITY §7.3) |
| PDF parsing | **pdf.js 6** (`pdfjs-dist`) | Free, keeps page numbers, same code in the browser and Node |
| API | **Hono** | Runs on Node (Render demo, via `@hono/node-server`) and on Workers (production) unchanged |
| Validation | `zod` | Strict schemas at every trust boundary (SECURITY §3.1) |
| Database | **Cloudflare D1** (SQLite + FTS5) | Papers, sections, chunks, chats, quotas; keyword search |
| Vector search | **Cloudflare Vectorize** (1024 dims, cosine, `owner_id` metadata index) | Meaning search |
| Embeddings / reranker | Workers AI `@cf/baai/bge-m3` / `@cf/baai/bge-reranker-base` | Free tier |
| LLM | Groq (OpenAI-compatible, via the `openai` SDK) | Free; same code as OpenAI |
| Answer cache | **Workers KV** | Built in, free tier |
| Bot protection | Cloudflare **Turnstile** | Free |
| Tests | **Vitest** with `@cloudflare/vitest-plugin` (Workers runtime) + a Node project (pdf.js, Render server) | 72 tests |
| Ingestion | `scripts/ingest.ts` (local Mac) → admin endpoint on Render | No CPU limit; batches of 20 with retries |
| Deploy | **Render CLI** (demo), **wrangler** (production Worker, D1 migrations) | |

### Free-tier budget (measured on our accounts where marked)

| Resource | Free limit | Our use / meaning |
|---|---|---|
| Render web service | 0.1 CPU, 512 MB, 750 h/month, sleeps after 15 min | One service runs all month; no per-request CPU cap |
| Workers | 100k requests/day, **10 ms CPU** (measured: ingestion 10–30 ms, LangGraph 14 ms p50) | Why the demo moved to Render |
| Workers AI | 10,000 neurons/day | Embeddings + reranking; P2 ingestion fit comfortably |
| Vectorize | 5M stored dimensions (≈ 4,880 chunks) | **881 chunks used (18%)**; room for uploads, with the 7-day expiry |
| Groq | **Measured:** 1,000 requests/day and **8,000 tokens/min per model** | ≈ 2 full answers/min per model (~6/min across the chain) |

> **Honest note:** Groq's free tokens-per-minute limit is tight: fine for showing one client, not for public traffic. The fallback chain keeps the demo working when one model is busy.

---

## 5. Architecture

```
                 ┌──────────────── Browser (React app) ─────────────────┐
                 │  Chat · Library · Upload · History · Citation panel   │
                 │  pdf.js Web Worker: PDF → pages → sections → chunks   │
                 └───────────────┬───────────────────────────────────────┘
                                 │ HTTPS (same origin, signed __Host- cookie)
   DEMO  ┌───────────────────────▼──── Render (Node, Singapore) ──────────────┐
         │ src/server/node.ts → same Hono app as the Worker                    │
         │ security headers · zod · CSRF guard · rate limits · Turnstile       │
         │ /api/chat → RAG pipeline (§7) → Groq (stream)                       │
         │ /api/upload, /api/papers, /api/chats, /api/me/delete, /api/admin/*  │
         └──┬──────────────────────── Cloudflare REST API (scoped token) ──────┘
            │            (PRODUCTION: the Cloudflare Worker uses direct bindings instead)
   ┌────────▼───┐ ┌─────────────┐ ┌─────────────┐ ┌──────────┐ ┌──────────┐
   │ D1 (SQLite)│ │  Vectorize  │ │ Workers AI  │ │ Workers  │ │  Groq    │
   │ papers,    │ │ 881 chunk   │ │ bge-m3      │ │ KV cache │ │ gpt-oss  │
   │ chunks,FTS5│ │ vectors     │ │ reranker    │ │          │ │ 120B     │
   └────────────┘ └─────────────┘ └─────────────┘ └──────────┘ └──────────┘
   Cloudflare Worker cron (free): expire uploads (7 d) · clean orphan vectors
   Local Mac: scripts/ingest.ts → parse curated PDFs → chunk → admin endpoint on Render
```

---

## 6. Paper and PDF analysis (ingestion)

### 6.1 Two paths, one parser and chunker
- **Curated papers (done in P2):** `scripts/ingest.ts` on this Mac parses each PDF with pdf.js, chunks it, and sends it to the Render admin endpoints: `POST /api/admin/papers` (paper + sections), then `POST /api/admin/papers/:id/chunks` in batches of 20. The server embeds, then writes D1 and Vectorize with `owner_id = 'public'`. IDs come from the DOI, so re-running replaces a paper instead of duplicating it. Metadata (title, authors, year, journal, DOI, licence) comes from **OpenAlex** and is stored in `data/papers/metadata.json`.
- **User uploads (P7):** the same parser and chunker run in the browser's Web Worker; the server re-validates everything (SECURITY §5.1).

### 6.2 Parsing scientific papers (as built)
1. pdf.js extracts text with **page number**, font size and position; rotated text (side stamps) is dropped.
2. **Columns:** the gutter is the centre of the widest gap crossed by the fewest lines. This handles two-column papers and asymmetric layouts (e.g. a narrow sidebar beside the body). Full-width lines split the page into bands; left column before right inside each band.
3. Remove running headers/footers (repeated text in the top/bottom 8%), page numbers and manuscript line numbers.
4. **Headings:** standard names (Abstract, Introduction, Methods, Results…), numbered headings and larger-font lines. Rejected: wrapped sentences, list items, citation fragments, table rows, author lists on page 1. Wrapped headings are joined.
5. **Bibliography:** reading stops at "References" only if real entries follow (review tables often have a "References" column). Acknowledgements, funding, conflicts and similar boilerplate sections are skipped.
6. **Paragraphs:** breaks from line spacing relative to the section's normal spacing (works for double-spaced manuscripts) and font changes (captions); hyphenation fixed; ligatures normalised; invisible characters stripped (SECURITY §6.8).
7. **Scanned PDFs** (too little text per page) are flagged; no OCR in the demo.

**Known limits (tell the client):** tables keep their values but lose rows/columns; charts and equations aren't read; a few section labels come from figure text; superscripts can be dropped.

### 6.3 Chunking (RAG_PRODUCTION_GUIDE §4.3–4.4)
- **Parent = a section**, stored in D1, not embedded. **Child ≈ 350 tokens** (≈ 1,400 characters), split on sentences inside a section, **~15% overlap**, never crossing a section; tiny tails merge into the previous chunk; run-on blocks (flattened tables) are hard-split.
- **Contextual header** on every child (free, no LLM call): `Paper: {title} ({year}). Section: {section}.`
- **Result:** 881 chunks, average ≈ 330 tokens.

### 6.4 Data model (D1, `migrations/0001_init.sql`)
```
papers   (id, owner_id, title, authors, year, journal, doi, license, source_url, topic,
          verified, pages, status, created_at, expires_at)     -- UNIQUE (owner_id, doi)
sections (id, paper_id, idx, name, text, page_start, page_end)  -- parents
chunks   (seq, id, paper_id, section_id, owner_id, idx, text, page_start, page_end)
chunks_fts (FTS5 over chunks.text; owner_id deliberately NOT indexed)   -- BM25
chats    (id, owner_id, title, created_at, updated_at)
messages (id, chat_id, owner_id, role, content, citations_json, status, model, created_at)
usage    (owner_id, day, questions, uploads)
```
Vectorize vector ID = `chunks.id` (`p_<hash>:c<idx>`); metadata `{ owner_id, paper_id }`.

---

## 7. How a question is answered (query pipeline: P3–P4)

```
guard ──off-topic / hazardous──→ decline
  │
  ▼
rewrite → retrieve (hybrid + RRF) → rerank → generate → validate ──ok──→ save
  ▲                                                       │
  └────────────── bad citations (retry once) ─────────────┘
```
Each step is a plain TypeScript function with its own tests; a small runner calls them in order and handles the one retry.

1. **Check:** cookie identity → rate limit → Turnstile (first question) → validate → strip invisible characters.
2. **Guard:** off-topic and hazardous-chemistry questions get the polite decline (SECURITY §12 #11). Groq's `llama-prompt-guard-2-86m` is a candidate injection detector.
3. **Rewrite** (only with earlier turns; history from D1, never from the client) with `openai/gpt-oss-20b`.
4. **Hybrid search, in parallel:** `bge-m3` → Vectorize top 30, filtered to `owner_id ∈ {public, me}`; D1 FTS5 BM25 top 30 with the escaped query (catches PLA, PBAT, ASTM D6400, CAS numbers).
5. **RRF** (k = 60) → top 20 → owners re-checked in D1.
6. **Rerank** with `bge-reranker-base` → best 6; add the neighbouring chunk when it fits; best first.
7. **Prompt** (≈ 3,000 tokens of sources): answer only from the numbered sources, cite `[n]` after every claim, "I couldn't find this in the papers" otherwise; sources fenced as data; not certification advice. gpt-oss models reason first, so reasoning effort is set low and reasoning tokens are counted in the budget.
8. **Generate** with Groq, streamed (SSE); temperature 0.2; max 800 output tokens; fallback chain on 429/5xx.
9. **Validate citations:** every `[n]` must be a source we sent; retry once, else mark the answer.
10. **Save** the message and cited chunk IDs; the citation panel shows the **stored** passage, never model text.

**Measuring accuracy (P3/P4):** golden set of 30 questions with the correct paper and page + 5 unanswerable; `npm run eval` reports recall@6, MRR, faithfulness (LLM judge, spot-checked by hand) and "I don't know" accuracy. We promise measured, cited answers, not zero errors.

---

## 8. UI and UX (P5–P7)

**Feel:** calm, minimal, focused (in the spirit of Perplexity, Claude and Elicit, without copying them). Full spec: [docs/DESIGN.md](docs/DESIGN.md).

| Token | Light | Dark |
|---|---|---|
| Background | `#FAF8F3` | `#161815` |
| Surface | `#FFFFFF` | `#1E211D` |
| Text | `#2B2B28` | `#E8E6DF` |
| Muted | `#6B6B63` | `#9A988F` |
| Accent (sage) | `#5E7F62` | `#8DB290` |
| Border | `#E7E3D9` | `#2C302B` |

**Desktop:** history sidebar · answer column (≤ 720 px) · citation side panel. **Mobile:** history drawer, citation bottom sheet, input fixed at the bottom, 44 px touch targets.

**Screens:** Home (greeting + suggested questions) · Chat (streaming answer, `[n]`, sources row, copy, thumbs) · Citation panel (highlighted passage, paper details, DOI, Curated / Your upload badge) · Library (search, topic filters, paper detail) · Upload (drag and drop, progress, limits) · all empty/loading/error/rate-limited states.

---

## 9. Project structure (current)
```
sustainIQ/
├─ PROJECT_PLAN.md · SECURITY.md · RAG_PRODUCTION_GUIDE.md · render.yaml · wrangler.toml
├─ docs/                     PRD, TRD, ARCHITECTURE, SYSTEM_WORKFLOW, DESIGN, FEATURES, SECURITY,
│                            PROJECT_DECISIONS, IMPLEMENTATION_PLAN, evidence/P1.md, evidence/P2.md
├─ src/worker/               Hono app: index.ts, llm.ts, platform.ts, routes/admin-papers.ts,
│                            security/ (headers, request-guard, identity, admin, errors)
├─ src/server/               Render demo host: node.ts, cloudflare-rest.ts
├─ src/shared/               text.ts, chunker.ts, pdf/ (read, layout, structure, types)
├─ src/web/                  React app (P1 shell; full UI in P5)
├─ public/_headers           security headers for static files
├─ migrations/0001_init.sql  D1 schema
├─ scripts/ingest.ts         curated paper ingestion (lib/pdf-node.ts)
├─ data/papers/metadata.json 20 curated papers (PDFs re-downloadable, not committed)
└─ test/                     Workers-runtime tests + test/node (real PDFs, Render server)
```

---

## 10. Run, deploy and launch

**Local**
```bash
npm run dev                         # Vite + Worker locally
npm test                            # all tests (Workers runtime + Node)
npm run ingest -- --preview         # parse papers to data/parsed/*.md for review
```

**Demo on Render** (Render CLI, key in `.secrets/render.env`)
```bash
git push                                             # Render auto-deploys main
render deploys create srv-dbmbm408v5cc73e52frg --wait --confirm   # manual deploy
render logs --resources srv-dbmbm408v5cc73e52frg --limit 100      # logs
npm run ingest -- --remote                           # (re)load curated papers via Render
```
Secrets live in the Render dashboard (service → Environment): `CLOUDFLARE_API_TOKEN`, `LLM_API_KEY`, `ANON_ID_SECRET`, `ANON_ID_SECRET_PREV`, `ADMIN_INGEST_TOKEN`. Non-secret settings are in `render.yaml`.

**Production on Cloudflare** (for the MVP)
```bash
npm run db:migrate:prod             # D1 migrations
npm run deploy                      # build + wrangler deploy → sustainiq.sustainiq.workers.dev
```

**Before the client demo:** open the Render link a minute early (wake-up); ask 5 golden questions; check citations open the right page; upload a PDF from a phone; confirm headers and rate limiting.

---

## 11. After the deal: MVP changes
- **Cloudflare Workers Paid ($5)**; the same app with direct bindings; custom domain, WAF, backups.
- **OpenAI** first in the fallback chain (optionally OpenAI embeddings, which means re-embedding everything).
- **Login** (magic link / Google) replaces the anonymous ID (SECURITY §10).
- **Big PDFs** (300–400 pages) processed server-side with **Cloudflare Queues**.
- **Better tables:** Docling/GROBID or `toMarkdown`, tested on the table-heavy papers.
- **LangGraph agents** for multi-paper research questions.
- Tracing (Langfuse), privacy notice; extras only if asked: paper comparison, property-table extraction, BibTeX export, live OpenAlex / Semantic Scholar search.

---

## 12. Risks and open items

| Risk | Plan |
|---|---|
| Render free tier sleeps after 15 min (30–60 s first load) | Open the link before the demo, or a free uptime ping every 10 min |
| Groq free limit (8,000 tokens/min per model) | Fallback chain, ~3,000-token source budget, answer cache; tell the client it's a demo limit |
| Tables lose structure (T-2.5) | Known demo limit; better parser in the MVP |
| Render → Cloudflare REST adds latency (Singapore ↔ Cloudflare) | Parallel search calls; measure in P3/P4 |
| Workers free CPU limit (10 ms) | Resolved for the demo by Render; production uses Workers Paid |
| Cloudflare API token on Render can edit D1/Vectorize/KV | Scoped to this account's resources; rotate if leaked (SECURITY incident steps) |
| Free Vectorize space fills up | 881 of ~4,880 used; upload caps, 7-day expiry, orphan cleanup |
| "Zero errors" expectation | Promise measured accuracy, citations and "I don't know", not perfection |
| Public GitHub repo for client work | Make it private (Render needs repo access re-granted if so) |
| ~~LangGraph over the free limits~~ | Resolved: not in the demo (D-010) |
| ~~Rate-limiting binding not on the free plan~~ | Demo on Render uses in-memory + D1 counters |
