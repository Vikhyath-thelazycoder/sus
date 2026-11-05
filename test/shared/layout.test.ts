import { describe, expect, it } from "vitest";
import { buildLines, findGutter, orderLines, removeHeadersFooters } from "../../src/shared/pdf/layout";
import type { RawItem, RawPage } from "../../src/shared/pdf/types";

const W = 600;
const H = 800;
const item = (str: string, x: number, y: number, width = str.length * 5, size = 10): RawItem => ({ str, x, y, width, size });
const page = (items: RawItem[], number = 1): RawPage => ({ number, width: W, height: H, items });

/** A two-column page: left column at x=50–290, right at x=310–550, `rows` lines each. */
function twoColumn(rows: number, number = 1, extra: RawItem[] = []) {
  const items: RawItem[] = [...extra];
  for (let i = 0; i < rows; i++) {
    items.push(item(`left line ${i}`, 50, 700 - i * 12, 240));
    items.push(item(`right line ${i}`, 310, 700 - i * 12, 240));
  }
  return page(items, number);
}

describe("buildLines", () => {
  it("never merges the two columns into one line", () => {
    const lines = buildLines(twoColumn(3));
    expect(lines.map((l) => l.text)).toContain("left line 0");
    expect(lines.map((l) => l.text)).toContain("right line 0");
    expect(lines.some((l) => l.text.includes("left") && l.text.includes("right"))).toBe(false);
  });

  it("joins items on one baseline with sensible spacing", () => {
    const lines = buildLines(page([item("Poly", 50, 700, 20), item("lactic", 70, 700, 30), item("acid", 104, 700, 20)]));
    expect(lines.map((l) => l.text)).toEqual(["Polylactic acid"]);
  });
});

describe("orderLines", () => {
  it("reads the whole left column before the right column", () => {
    const p = twoColumn(12);
    const texts = orderLines(buildLines(p), W).map((l) => l.text);
    expect(texts.indexOf("left line 11")).toBeLessThan(texts.indexOf("right line 0"));
  });

  it("keeps full-width titles in place between column bands", () => {
    const p = twoColumn(12, 1, [item("A FULL WIDTH TITLE ACROSS BOTH COLUMNS OF THE PAGE", 50, 760, 500)]);
    const texts = orderLines(buildLines(p), W).map((l) => l.text);
    expect(texts[0]).toBe("A FULL WIDTH TITLE ACROSS BOTH COLUMNS OF THE PAGE");
  });

  it("finds an off-centre gutter (narrow sidebar beside a wide body column)", () => {
    const items: RawItem[] = [];
    for (let i = 0; i < 12; i++) {
      items.push(item(`side ${i}`, 40, 700 - i * 12, 100)); // x 40–140
      items.push(item(`body ${i}`, 180, 700 - i * 12, 370)); // x 180–550
    }
    const lines = buildLines(page(items));
    const g = findGutter(lines, W)!;
    expect(g).toBeGreaterThan(140);
    expect(g).toBeLessThan(180);
    const texts = orderLines(lines, W).map((l) => l.text);
    expect(texts.slice(0, 12).every((t) => t.startsWith("side"))).toBe(true);
  });

  it("treats a single-column page as top-to-bottom", () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`line ${i} of a wide single column paragraph`, 50, 700 - i * 12, 500));
    expect(findGutter(buildLines(page(items)), W)).toBeNull();
  });
});

describe("removeHeadersFooters", () => {
  it("drops running headers, page numbers and manuscript line numbers, keeps body text", () => {
    const pages = [1, 2, 3, 4].map((n) =>
      page(
        [
          item("Journal of Sustainable Things 2024", 50, 780, 300), // running header
          item(String(n), 300, 20, 10), // page number
          item(String(10 + n), 60, 500, 10), // line-number gutter (x < 15% of width)
          item(`Body text on page ${n}`, 100, 500, 300),
        ],
        n,
      ),
    );
    const kept = removeHeadersFooters(pages.map((p) => ({ page: p, lines: buildLines(p) })));
    expect(kept.map((ls) => ls.map((l) => l.text))).toEqual([1, 2, 3, 4].map((n) => [`Body text on page ${n}`]));
  });
});
