import { cleanText } from "../text";
import type { Line, Paragraph, ParsedPaper, RawPage, Section } from "./types";
import { buildLines, orderLines, removeHeadersFooters } from "./layout";

const NUMBER_PREFIX = String.raw`(?:(?:\d+(?:\.\d+){0,3}|[IVX]+|[A-H])\.?\s+)?`;
const KNOWN_HEADING = new RegExp(
  `^${NUMBER_PREFIX}(abstract|introduction|background|literature review|state of the art|` +
    `materials?(?: and | & )methods?|methods?|methodology|experimental(?: section| procedures?| details)?|` +
    `results(?: and discussion)?|discussion|conclusions?(?: and (?:outlook|perspectives?|future (?:work|directions?)))?|` +
    `summary|outlook|perspectives?|future (?:perspectives?|directions?|work)|acknowledge?ments?|references|` +
    `bibliography|literature cited|funding|author contributions?|conflicts? of interest|competing interests?|` +
    `declaration of competing interest|data availability(?: statement)?|supplementary (?:materials?|information)|` +
    `appendix(?: [a-z])?|abbreviations|keywords|highlights)\\s*:?$`,
  "i",
);
const NUMBERED_HEADING = /^\d+(\.\d+){0,3}\.?\s+[A-Z][^.]{2,80}$/;
/** Everything from here on is bibliography or back matter: not indexed. */
const STOP = /^(references|bibliography|literature cited)$/i;
/** Boilerplate sections that add noise to search. */
const SKIP = /^(acknowledge?ments?|funding|author contributions?|conflicts? of interest|competing interests?|declaration of competing interest|data availability( statement)?|supplementary (materials?|information)|abbreviations|keywords|highlights)$/i;

/** "Smith, J. A.," / "Aam BB, Heggset EB" / "[12] Shaw, M. H." — how bibliography entries start. */
const REFERENCE_ENTRY = /^(\[?\d{1,3}[\].]?\s*)?[A-Z][A-Za-z'’-]+,?\s+([A-Z]\.\s?){1,3}|^(\[?\d{1,3}[\].]?\s*)?[A-Z][A-Za-z'’-]+\s+[A-Z]{1,3},/;

/** A "References" line only starts the bibliography if entries follow (review tables often have a References column). */
export function startsBibliography(lines: Line[], i: number): boolean {
  return lines.slice(i + 1, i + 7).filter((l) => REFERENCE_ENTRY.test(l.text)).length >= 2;
}

const tableLike = (t: string) =>
  (t.match(/[A-Za-z]/g) ?? []).length / Math.max(t.length, 1) < 0.6 || (t.match(/\b\d+(\.\d+)?\b/g)?.length ?? 0) >= 2;

const stripNumber = (t: string) => t.replace(new RegExp(`^${NUMBER_PREFIX}`), "").replace(/:$/, "").trim();

function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) {
    const s = Math.round(l.size * 2) / 2;
    weight.set(s, (weight.get(s) ?? 0) + l.text.length);
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

export function isHeading(line: Line, body: number, next?: Line): boolean {
  const t = line.text;
  const words = t.split(/\s+/).length;
  if (t.length > 90 || words > 12 || /[.,;]$/.test(t)) return false;
  if (KNOWN_HEADING.test(t)) return true;
  // A wrapped sentence continues in lowercase on the next line; a heading doesn't.
  const bodySized = line.size < body * 1.1;
  if (bodySized && next && next.page === line.page && /^[a-z]/.test(next.text) && Math.abs(next.size - line.size) < 0.5) {
    return false;
  }
  if (/et al\.|\)\s*,|,\s*(19|20)\d\d/.test(t)) return false; // citation fragments
  const letters = (t.match(/[A-Za-z]/g) ?? []).length / t.length;
  if (letters < 0.6) return false; // table rows such as "3 PLA 45 12"
  if ((stripNumber(t).match(/\b\d+(\.\d+)?\b/g)?.length ?? 0) >= 2) return false; // table header rows
  if (NUMBERED_HEADING.test(t) && line.size >= body * 0.95) return true;
  return line.size >= body * 1.15 && /^[A-Z0-9]/.test(t);
}

function guessTitle(firstPage: Line[], body: number): string | null {
  const max = Math.max(...firstPage.map((l) => l.size));
  if (!(max >= body * 1.3)) return null;
  const title = firstPage
    .filter((l) => l.size >= max - 0.5)
    .map((l) => l.text)
    .join(" ");
  return title.length >= 10 ? title.slice(0, 300) : null;
}

/** Join lines into paragraphs, fixing words hyphenated across line breaks. */
export function toParagraphs(lines: Line[]): Paragraph[] {
  const widths = lines.map((l) => l.x1 - l.x0).sort((a, b) => a - b);
  const typical = widths[Math.floor(widths.length / 2)] ?? 0;
  // Normal line spacing of this text (double-spaced manuscripts have large gaps between every line).
  const gaps = lines
    .slice(1)
    .map((l, i) => lines[i]!.page === l.page && lines[i]!.y > l.y ? lines[i]!.y - l.y : 0)
    .filter((g) => g > 0)
    .sort((a, b) => a - b);
  const lineGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const paras: Paragraph[] = [];
  let cur: Paragraph | null = null;
  let prev: Line | null = null;
  for (const l of lines) {
    const gap = prev && prev.page === l.page && prev.y > l.y ? prev.y - l.y : 0;
    const gapBreak = gap > Math.max(lineGap * 1.5, 1.3 * Math.max(prev?.size ?? 0, l.size));
    const shortEnd = prev && /[.:?!]$/.test(prev.text) && prev.x1 - prev.x0 < typical * 0.75;
    const fontChange = prev && Math.abs(prev.size - l.size) > 0.8; // e.g. a smaller-font figure caption
    if (!cur || gapBreak || shortEnd || fontChange) {
      if (cur) paras.push(cur);
      cur = { text: l.text, pageStart: l.page, pageEnd: l.page };
    } else {
      cur.text = /[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(l.text) ? cur.text.slice(0, -1) + l.text : `${cur.text} ${l.text}`;
      cur.pageEnd = l.page;
    }
    prev = l;
  }
  if (cur) paras.push(cur);
  return paras.filter((p) => /[A-Za-z]{3}/.test(p.text));
}

/** Full structure pass: lines → reading order → headers/footers removed → sections → paragraphs. */
export function parsePaper(pages: RawPage[]): ParsedPaper {
  const cleaned = pages.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i, str: cleanText(i.str) })) }));
  const perPage = cleaned.map((page) => ({ page, lines: orderLines(buildLines(page), page.width) }));
  const kept = removeHeadersFooters(perPage);
  const all = kept.flat();
  const chars = all.reduce((n, l) => n + l.text.length, 0);
  const body = bodySize(all);

  const firstPage = kept[0] ?? [];
  const titleSize = Math.max(0, ...firstPage.map((l) => l.size));
  const isTitleLine = (l: Line) => l.page === 1 && titleSize >= body * 1.3 && l.size >= titleSize - 0.5;

  const groups: { name: string; lines: Line[] }[] = [{ name: "Front matter", lines: [] }];
  let seenKnown = false; // page-1 author lists and affiliations are often in a larger font
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    const frontMatterOnly = line.page === 1 && !seenKnown && !KNOWN_HEADING.test(line.text);
    if (isTitleLine(line) || frontMatterOnly || !isHeading(line, body, all[i + 1])) {
      groups.at(-1)!.lines.push(line);
      continue;
    }
    // Headings that wrap: join following lines of the same size that are not headings of their own.
    let name = stripNumber(line.text);
    while (
      !KNOWN_HEADING.test(line.text) &&
      all[i + 1] &&
      all[i + 1]!.page === line.page &&
      Math.abs(all[i + 1]!.size - line.size) < 0.3 &&
      line.size >= body * 1.05 &&
      !KNOWN_HEADING.test(all[i + 1]!.text) &&
      !NUMBERED_HEADING.test(all[i + 1]!.text) &&
      all[i + 1]!.text.length <= 60 &&
      !tableLike(all[i + 1]!.text) &&
      !/[.:]$/.test(all[i + 1]!.text) &&
      name.length + all[i + 1]!.text.length < 150
    ) {
      name = `${name} ${all[++i]!.text}`;
    }
    if (STOP.test(name)) {
      if (startsBibliography(all, i)) break;
      groups.at(-1)!.lines.push(line); // e.g. a table column titled "References"
      continue;
    }
    if (KNOWN_HEADING.test(line.text)) seenKnown = true;
    groups.push({ name, lines: [] });
  }

  const sections: Section[] = groups
    .filter((g) => !SKIP.test(g.name))
    .map((g) => ({ name: g.name.slice(0, 120), paragraphs: toParagraphs(g.lines) }))
    .filter((s) => s.paragraphs.length > 0)
    .map((s) => ({ ...s, pageStart: s.paragraphs[0]!.pageStart, pageEnd: s.paragraphs.at(-1)!.pageEnd }));

  return {
    title: guessTitle(firstPage, body),
    pages: pages.length,
    scanned: chars / Math.max(pages.length, 1) < 200,
    sections,
  };
}
