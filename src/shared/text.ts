/** Soft hyphen, zero-width characters, bidi overrides/isolates, BOM and Unicode tag characters (SECURITY §6.8). */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** NFKC turns PDF ligatures (ﬁ, ﬂ) and full-width forms into plain letters; then strip hidden characters. */
export function cleanText(s: string): string {
  return s.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROL, "");
}

/** Rough token count for English (RAG guide rule of thumb: ~4 characters per token). */
export const approxTokens = (s: string): number => Math.ceil(s.length / 4);
