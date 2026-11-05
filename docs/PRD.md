# Product Requirements — SustainIQ

What we are building and why (spec §20.1).

## Problem

Researchers and companies working on sustainable materials must read many long papers to answer specific questions ("How fast does PHA degrade in seawater?"). General chatbots answer from memory, invent facts and can't show sources. The client asked for an AI research assistant that answers **from papers, with references and citations**.

## Target users

- **Primary:** materials researchers, R&D teams and sustainability consultants working on biomaterials, green chemistry and sustainable packaging.
- **Secondary:** students and product teams evaluating sustainable alternatives.
- **For the demo:** the client, evaluating whether to hire us.

## Goals

**Demo (P1–P8):**
1. Every factual answer cites the passage, paper, page and DOI it came from.
2. Says "I couldn't find this in the papers" when the papers don't cover the question.
3. Retrieval recall@6 and answer faithfulness are measured on a golden set and shown to the client (targets set after the P3/P4 baselines).
4. Works well on desktop (main focus) and on phones.
5. Runs at $0 on free tiers.

## Non-goals

- Zero errors (not achievable; see RAG_PRODUCTION_GUIDE.md). We aim for errors that are measured, minimized and declined instead of invented.
- Login, payments and teams in the demo.
- Reading charts/figures, OCR of scanned PDFs, PDFs over 100 pages in the demo.
- General chat outside sustainable materials.
- Certification or regulatory advice.

## Features

Chat with cited answers · Citation panel · Paper library · PDF upload · Chat history. Details: [FEATURES.md](FEATURES.md).

## Workflows

1. **Ask:** open the app → type a question (or tap a suggestion) → the answer streams with [n] citations → click [n] → the passage opens beside the answer (desktop) or as a bottom sheet (mobile).
2. **Follow up:** ask "what about its cost?" → the app understands the context from the chat.
3. **Browse:** Library → filter by topic → open a paper → see its sections.
4. **Upload:** Upload → drop a PDF → watch progress → ask about it; only the uploader can see it.
5. **Return:** open a past chat from the history sidebar.

System behaviour: [SYSTEM_WORKFLOW.md](SYSTEM_WORKFLOW.md).

## Constraints

- Demo hosting: Cloudflare Workers **free** plan; production: **Cloudflare Workers Paid only**.
- No OpenAI key yet; the demo uses Groq's free tier. OpenAI comes in the MVP.
- One freelancer working with Claude; demo in about 2–2.5 weeks.
- Only open-access papers are preloaded (copyright).

## Success criteria

- The client says yes after the demo and the Google Meet.
- All golden-set scores recorded and presented; correct "I don't know" on ≥ 90% of unanswerable questions (target).
- Every [DEMO] item in SECURITY.md done; 23/23 security tests pass.

## Assumptions

- Free-tier limits (Groq, Workers AI, Vectorize) are as researched (to be verified in T-1.8).
- pdf.js extracts the chosen papers well enough (checked in T-2.5).
- ~~LangGraph fits the free Worker limits~~ Checked in T-1.7: it doesn't fit the free CPU limit, so the demo uses plain functions (owner decision).
- The client's users mostly read English-language papers.

## Open questions

- Who are the client's real users, and how many at launch? (ask on the Google Meet)
- Where do the client's papers come from: their own collection, user uploads, or live databases (OpenAlex / Semantic Scholar)?
- Private libraries per user, or a shared team knowledge base?
- Extras wanted: paper comparison, property-table extraction, BibTeX export?
- Who owns the code and IP, and whose accounts host it?
