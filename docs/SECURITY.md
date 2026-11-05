# Security — SustainIQ

Project-specific security baseline (spec §20.5, §22). The full rules, threat list and the 23 required tests are in [../SECURITY.md](../SECURITY.md) (**SEC**). This page is the summary.

## Assets and threats

Groq key and free quotas (theft, denial of wallet) · users' uploads and chat history (cross-user access, IDOR) · answer integrity (prompt injection, poisoned papers) · the database (SQL / FTS5 / filter injection) · users' browsers (XSS, image exfiltration, clickjacking). Details: SEC §1, §12.

## Authentication and authorization

- **Demo:** anonymous ID in an HMAC-signed `HttpOnly; Secure; SameSite=Lax` cookie, issued and verified only by the server (SEC §3.2).
- **Authorization:** `owner_id` on every row and every query; other owners' items return 404; search pre-filtered to `public` + own (SEC §3.2, §4.3).
- **Admin:** curated ingestion only with `ADMIN_INGEST_TOKEN` (constant-time compare).
- **MVP:** real login per SEC §10.

## Secrets

`LLM_API_KEY`, `ANON_ID_SECRET` (+ previous, for rotation), `ADMIN_INGEST_TOKEN`, `TURNSTILE_SECRET`: only in `wrangler secret`, never in code, `VITE_*`, logs or errors. Rotation steps in SEC §12 (incident response).

## Data protection

- Stored: papers, chunks, chats, messages under an anonymous ID. Uploads auto-delete after 7 days; "Delete my data" purges everything for the owner.
- Logs: no secrets, cookies, full upload text or raw IPs (hashed for rate limits).
- Users are told not to upload confidential documents in the demo.
- MVP: privacy notice, trace retention ≤ 30 days, DPDP/GDPR deletion (SEC §10–11).

## Third parties

Groq (questions + passages), Workers AI (text for embeddings/rerank), Turnstile (token), Crossref (DOI, script only). No webhooks. Spending caps and alerts at providers (SEC §2). Provider data-use terms checked before the MVP (SEC §11).

## Security decisions

Recorded with `agylite decide add --kind security`; listed in [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md).
