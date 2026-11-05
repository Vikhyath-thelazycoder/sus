import type { Section } from "./pdf/types";

/** RAG §4.3: children of ~350 tokens (≈1,400 characters) with ~15% overlap, never crossing a section. */
export const CHUNK = { targetChars: 1400, maxChars: 2000, overlapChars: 210, minTailChars: 300 } as const;

export interface Chunk {
  sectionIdx: number;
  idx: number;
  /** Contextual header + body (RAG §4.4). This is what gets embedded and keyword-indexed. */
  text: string;
  pageStart: number;
  pageEnd: number;
}

interface Sentence {
  text: string;
  page: number;
  paraStart: boolean;
}

const ABBREVIATIONS = new Set(
  ["al", "e.g", "i.e", "fig", "figs", "eq", "eqs", "ref", "refs", "vs", "approx", "ca", "no", "vol", "dr", "wt", "mol", "resp", "etc", "cf", "sect", "tab"],
);

/** Split on sentence ends, but not after "et al.", "Fig.", "e.g." or initials such as "J.". */
export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9("“[])/);
  const out: string[] = [];
  for (const part of parts) {
    const prev = out.at(-1);
    const lastWord = prev?.match(/(\S+)\.$/)?.[1]?.toLowerCase() ?? "";
    if (prev && (ABBREVIATIONS.has(lastWord) || /^[A-Z]$/i.test(lastWord))) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Hard-split a run-on "sentence" (tables, lists) at word boundaries. */
function splitLong(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(" ")) {
    if (cur && cur.length + w.length + 1 > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

export function contextHeader(title: string, year: number | null | undefined, section: string): string {
  const t = title.length > 200 ? `${title.slice(0, 197)}...` : title;
  return `Paper: ${t}${year ? ` (${year})` : ""}. Section: ${section}.`;
}

export function chunkSection(section: Section, sectionIdx: number, header: string, startIdx: number): Chunk[] {
  const sentences: Sentence[] = section.paragraphs.flatMap((p) =>
    splitSentences(p.text)
      .flatMap((s) => splitLong(s, CHUNK.maxChars))
      .map((text, i) => ({ text, page: p.pageStart, paraStart: i === 0 })),
  );

  const groups: Sentence[][] = [];
  let cur: Sentence[] = [];
  let len = 0;
  for (const s of sentences) {
    if (cur.length && len + s.text.length > CHUNK.targetChars) {
      groups.push(cur);
      // Overlap: carry the last sentences (up to ~15%) into the next chunk.
      const carry: Sentence[] = [];
      let carried = 0;
      for (let i = cur.length - 1; i >= 0 && carried + cur[i]!.text.length <= CHUNK.overlapChars; i--) {
        carry.unshift(cur[i]!);
        carried += cur[i]!.text.length;
      }
      cur = [...carry];
      len = carried;
    }
    cur.push(s);
    len += s.text.length + 1;
  }
  if (cur.length) {
    const tail = cur.map((s) => s.text).join(" ");
    const last = groups.at(-1);
    const lastLen = last ? last.reduce((n, s) => n + s.text.length + 1, 0) : 0;
    if (last && tail.length < CHUNK.minTailChars && lastLen + tail.length <= CHUNK.maxChars) {
      last.push(...cur.filter((s) => !last.includes(s)));
    } else groups.push(cur);
  }

  return groups.map((g, i) => ({
    sectionIdx,
    idx: startIdx + i,
    text: `${header}\n${g.map((s, j) => (j > 0 && s.paraStart ? `\n${s.text}` : s.text)).join(" ").replace(/ \n/g, "\n")}`,
    pageStart: Math.min(...g.map((s) => s.page)),
    pageEnd: Math.max(...g.map((s) => s.page)),
  }));
}

/** Chunk every section of a paper; chunk indexes run across the whole paper. */
export function chunkPaper(sections: Section[], title: string, year?: number | null): Chunk[] {
  const chunks: Chunk[] = [];
  sections.forEach((section, i) => {
    chunks.push(...chunkSection(section, i, contextHeader(title, year, section.name), chunks.length));
  });
  return chunks;
}
