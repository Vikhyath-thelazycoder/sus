# Features — SustainIQ

The feature catalogue; each feature links to its plan phase.

## Feature list

| Feature | Description | Phase | Status |
|---|---|---|---|
| Curated paper library | 15–25 open-access papers, parsed and indexed | P2 | PLANNED |
| Hybrid retrieval | Keyword + meaning search, RRF, reranker, owner scoping | P3 | PLANNED |
| Cited answers | Streaming answers from papers with validated [n] citations | P4 | PLANNED |
| Honest decline | "I couldn't find this in the papers" + off-topic/hazard decline | P4 | PLANNED |
| Chat UI | Calm, minimal, desktop-first, mobile-ready chat | P5 | PLANNED |
| Citation panel | Side panel (desktop) / bottom sheet (mobile) with the stored passage | P5 | PLANNED |
| Library browsing | Search, topic filter, paper details | P6 | PLANNED |
| Chat history | Saved conversations in a sidebar (server-stored, owner-scoped) | P6 | PLANNED |
| PDF upload | Private uploads, 5 × 100 pages, auto-deleted after 7 days | P7 | PLANNED |
| Delete my data | One click removes the user's uploads and history | P7 | PLANNED |
| Abuse protection | Rate limits, Turnstile, budget guard | P8 | PLANNED |
| Login, OpenAI, big PDFs, agents | Paid MVP scope | P9 | INTENTIONALLY_DEFERRED |

## Feature details

### Cited answers (P4)
- **Behaviour:** answers only from retrieved passages; [n] after each claim; streamed.
- **Acceptance:** every [n] maps to a retrieved chunk; golden-set faithfulness recorded; validator retries once.
- **Edge cases:** no relevant passage → decline; citation to an unretrieved source → retry → fallback; provider quota exhausted → fallback model → busy message.

### Honest decline (P4)
- **Behaviour:** unanswerable → "I couldn't find this in the papers"; off-topic → polite redirect; hazardous synthesis → refusal.
- **Acceptance:** ≥ 90% correct declines on the 5 unanswerable golden questions (target); SEC §13 #15, #22 pass.

### Citation panel (P5)
- **Behaviour:** shows the stored passage with the matching sentence highlighted, title, authors, year, section, page, DOI, and a Curated / Your upload badge.
- **Acceptance:** works with mouse, touch and keyboard; text comes from D1, not the model.
- **Edge cases:** missing DOI → hide the link; deleted upload → "This source is no longer available".

### PDF upload (P7)
- **Behaviour:** browser parsing with progress; private to the uploader; expires after 7 days.
- **Acceptance:** a 30-page paper is answerable within about a minute; quota enforced atomically.
- **Edge cases:** scanned PDF → "text can't be read"; > 100 pages or 6th PDF → clear limit message; tab closed mid-upload → paper marked `failed` and cleaned up.

### Chat history (P6)
- **Behaviour:** chats saved under the anonymous ID; grouped by date; rename/delete.
- **Acceptance:** survives reloads on the same browser; never visible to others.
- **Edge cases:** cookie cleared → history no longer reachable (expected in the demo; fixed by login in P9).
