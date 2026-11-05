import type { Line, RawPage } from "./types";

/**
 * Group items into lines. Items on the same baseline are split into separate segments when the gap between
 * them is wider than ~1 em, so the two columns of a two-column paper never merge into one line.
 */
export function buildLines(page: RawPage): Line[] {
  const items = [...page.items].sort((p, q) => q.y - p.y || p.x - q.x);
  const rows: (typeof items)[] = [];
  for (const it of items) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0]!.y - it.y) < 0.4 * Math.max(it.size, row[0]!.size)) row.push(it);
    else rows.push([it]);
  }

  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((p, q) => p.x - q.x);
    let cur: Line | null = null;
    for (const it of row) {
      const gap = cur ? it.x - cur.x1 : 0;
      if (!cur || gap > Math.max(it.size, cur.size) * 1.0) {
        if (cur) lines.push(cur);
        cur = { page: page.number, text: it.str, x0: it.x, x1: it.x + it.width, y: it.y, size: it.size };
        continue;
      }
      const needsSpace = gap > 0.15 * it.size && !cur.text.endsWith(" ") && !it.str.startsWith(" ");
      cur.text += (needsSpace ? " " : "") + it.str;
      cur.x1 = Math.max(cur.x1, it.x + it.width);
      cur.size = Math.max(cur.size, it.size);
    }
    if (cur) lines.push(cur);
  }
  for (const l of lines) l.text = l.text.replace(/\s+/g, " ").trim();
  return lines.filter((l) => l.text);
}

/**
 * Find the gutter of a two-column page: the x position (searched in the middle 60% of the page) crossed by the
 * fewest lines. Works for asymmetric layouts too, e.g. a narrow metadata sidebar beside a wide body column.
 */
export function findGutter(lines: Line[], pageWidth: number): number | null {
  if (lines.length < 10) return null;
  const xs: { x: number; crossings: number }[] = [];
  for (let x = pageWidth * 0.2; x <= pageWidth * 0.8; x += 1) {
    xs.push({ x, crossings: lines.filter((l) => l.x0 < x && l.x1 > x).length });
  }
  const min = Math.min(...xs.map((p) => p.crossings));
  if (min > lines.length * 0.35) return null; // full-width figures/tables cross the gutter
  // Centre of the widest run of x positions at the minimum: the middle of the white space between columns.
  let run: number[] = [];
  let widest: number[] = [];
  for (const p of xs) {
    if (p.crossings === min) run.push(p.x);
    else run = [];
    if (run.length > widest.length) widest = [...run];
  }
  const best = { x: (widest[0]! + widest.at(-1)!) / 2 };
  const left = lines.filter((l) => l.x1 <= best!.x).reduce((n, l) => n + l.text.length, 0);
  const right = lines.filter((l) => l.x0 >= best!.x).reduce((n, l) => n + l.text.length, 0);
  const total = left + right || 1;
  const leftLines = lines.filter((l) => l.x1 <= best!.x).length;
  const rightLines = lines.filter((l) => l.x0 >= best!.x).length;
  return left / total >= 0.1 && right / total >= 0.1 && leftLines >= 5 && rightLines >= 5 ? best.x : null;
}

/**
 * Reading order. Single-column pages read top to bottom. Two-column pages are read in bands: full-width lines
 * (titles, wide figures) split the page into bands, and inside each band the left column comes before the right.
 */
export function orderLines(lines: Line[], pageWidth: number): Line[] {
  const byTop = [...lines].sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const gutter = findGutter(lines, pageWidth);
  if (gutter === null) return byTop;
  const side = (l: Line) => (l.x1 <= gutter + 1 ? "L" : l.x0 >= gutter - 1 ? "R" : "F");

  const out: Line[] = [];
  let left: Line[] = [];
  let right: Line[] = [];
  const flush = () => {
    out.push(...left, ...right);
    left = [];
    right = [];
  };
  for (const l of byTop) {
    const s = side(l);
    if (s === "F") {
      flush();
      out.push(l);
    } else (s === "L" ? left : right).push(l);
  }
  flush();
  return out;
}

const marginKey = (t: string) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/**
 * Remove running headers/footers (text in the top or bottom 8% that repeats on many pages), page numbers,
 * and line-number gutters of preprints.
 */
export function removeHeadersFooters(pages: { page: RawPage; lines: Line[] }[]): Line[][] {
  const inMargin = (l: Line, p: RawPage) => l.y > p.height * 0.92 || l.y < p.height * 0.08;
  const seen = new Map<string, Set<number>>();
  for (const { page, lines } of pages) {
    for (const l of lines) {
      if (!inMargin(l, page)) continue;
      const k = marginKey(l.text);
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k)!.add(page.number);
    }
  }
  const minRepeats = Math.max(3, Math.ceil(pages.length * 0.3));
  return pages.map(({ page, lines }) =>
    lines.filter((l) => {
      const numeric = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text);
      const gutter = numeric && (l.x1 < page.width * 0.15 || l.x0 > page.width * 0.85); // manuscript line numbers
      if (gutter) return false;
      if (!inMargin(l, page)) return true;
      if (numeric) return false;
      return (seen.get(marginKey(l.text))?.size ?? 0) < minRepeats;
    }),
  );
}
