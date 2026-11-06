/**
 * Upload limits (SECURITY §3.1, §5.1, §9), shared by the browser checks and the server re-validation so the two can
 * never drift. One place to change them.
 */
export const UPLOAD = {
  /** Pages per PDF (browser parsing safety). No per-user cap on PDFs or total pages (owner, 2026-11-06). */
  maxPages: 100,
  maxFileBytes: 25 * 1024 * 1024,
  /** ≈100 pages of chunks (SECURITY §3.1). */
  maxChunks: 600,
  /** Extracted characters per file; stops text bombs before chunking. */
  maxChars: 1_500_000,
  chunksPerBatch: 32,
  /** Stored section text is only the preview shown on the paper page; chunks carry the searchable text. */
  sectionPreviewChars: 2400,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  /** An upload that never finished is cleaned up after this long. */
  staleMs: 60 * 60 * 1000,
  parseTimeoutMs: 60_000,
} as const;
