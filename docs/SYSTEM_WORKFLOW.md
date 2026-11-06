# System Workflow — SustainIQ

What the system does for each user action (spec §20.4).

---

## 1. User asks a question

### User action
Types a question in the chat (or taps a suggestion) and presses send.

### Backend behavior
1. `POST /api/chat { chatId?, question, turnstileToken? }`; zod validation (question ≤ 2,000 characters).
2. Verify the signed anonymous cookie → `ownerId` (issue a new one if missing).
3. Rate limit (20/min, 200/day per owner + IP); Turnstile check on the first question of a session.
4. Strip invisible characters; run the RAG pipeline; stream events over SSE.

### Data flow
Read: `messages` (last 10 turns, by `chatId` + `ownerId`) → Vectorize + `chunks_fts` → `chunks`/`papers` (owner re-check) → KV cache lookup (public scope only).
Write: `chats` (new chat), `messages` (user turn, then assistant turn with `citations_json`), `usage` counters, KV cache (public-only answers).

### AI flow
`guard` (keywords → small model when unsure) → decline **or** `rewrite` (small model, only if history) → `embed` (bge-m3) → hybrid search → RRF → `rerank` (bge-reranker-base) → `generate` (70B, streamed; fallback chain) → `validate` citations (retry once on failure) → `save`.

### External API flow
Groq streaming call (timeout ≈ 30 s; abort on client disconnect). Turnstile verify. No retries on Groq except the fallback chain; no retries on a user-visible stream once it has started.

### State changes
Chat: `none → created`. Message: `user saved → assistant streaming → saved (ok | unverified-citations | declined | error)`.

### Verification
Graph path tests (decline / ok / retry), SEC §13 #7–10, #12, #15, #18, #22; eval script for quality.

---

## 2. User opens a citation

### User action
Clicks or taps `[n]` in an answer.

### Backend behavior
Citation chunk IDs are already in the stored message; the client asks `GET /api/chats/:id` (or uses the cached message) and the chunk text endpoint, owner-scoped.

### Data flow
Read `messages.citations_json` → `chunks` + `papers` (owner-scoped).

### AI flow
None. The panel shows stored text, never model output.

### External API flow
None (the DOI link opens doi.org in a new tab).

### State changes
None.

### Verification
Component test; SEC §13 #1 (other owners' chunk → 404).

---

## 3. User uploads a PDF

### User action
Drops a PDF on the Upload screen.

### Backend behavior
1. Browser: magic-byte, size (≤ 25 MB) and page (≤ 100) checks → pdf.js in a Web Worker (scripting off) → shared chunker.
2. `POST /api/upload` in batches: zod re-validation, Turnstile, **atomic** quota check (5 PDFs / 100 pages per owner).
3. Server assigns `paper_id`/`chunk_id`, embeds with bge-m3, writes D1 + FTS + Vectorize (`owner_id = ownerId`), `expires_at = now + 7 days`.

### Data flow
Write `papers` (status `processing → ready | failed`), `sections`, `chunks`, `chunks_fts`, Vectorize vectors, `usage`.

### AI flow
Embeddings only.

### External API flow
None beyond Workers AI.

### State changes
Paper: `processing → ready` or `failed` (partial batches rolled back by `paper_id`).

### Verification
SEC §13 #13, #14, #19, #4; fixture PDFs; phone upload in the P8 smoke test.

---

## 4. User browses the library

### User action
Opens Library, filters by topic, opens a paper.

### Backend behavior / data flow
`GET /api/papers?topic=&q=` → D1 `papers` where `owner_id IN ('public', ownerId)`; `GET /api/papers/:id` → `sections`.

### AI flow / external API flow
None.

### State changes
None.

### Verification
API tests incl. owner isolation; component tests.

---

## 5. User reopens or deletes history / data

### User action
Clicks a past chat; renames or deletes it; or "Delete my data".

### Backend behavior / data flow
`GET/PATCH/DELETE /api/chats/:id` scoped by `owner_id`. `POST /api/me/delete` deletes the owner's `messages`, `chats`, `chunks`, `sections`, `papers`, Vectorize IDs and KV entries.

### AI flow / external API flow
None.

### State changes
Chat: `active → deleted`. Owner data: `present → purged`.

### Verification
SEC §13 #1, #23.

---

## 6. Scheduled jobs (cron, daily)

- Delete uploads where `expires_at < now`, and unfinished uploads older than an hour (D1 rows + Vectorize IDs).
- Retry `vector_tombstones`: vector IDs written in the same batch that deleted their D1 rows, cleared once Vectorize confirms. (Vectorize can't be listed cheaply, so orphans are tracked at delete time instead of searched for; search re-checks every hit against D1 anyway.)
- Verification: SEC §13 #23; a cron test with a fixed clock.

## 7. Curated ingestion (developer, local)

`npm run ingest [-- --remote]` → parse each PDF in `data/papers` → Crossref metadata → `POST /api/admin/ingest` (admin token) → embed + store with `owner_id = 'public'`. Idempotent by DOI. Verified by reading parsed text (T-2.2) and by the eval (P3).
