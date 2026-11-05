import type { PDFDocumentProxy } from "pdfjs-dist";
import type { RawItem, RawPage } from "./types";

/**
 * Pull positioned text out of a pdf.js document. Works with the browser and the Node (legacy) builds.
 * Rotated text (e.g. arXiv side stamps) is dropped; coordinates are made relative to the page's view box.
 */
export async function readPages(doc: PDFDocumentProxy, maxPages = 100): Promise<RawPage[]> {
  const pages: RawPage[] = [];
  const count = Math.min(doc.numPages, maxPages);
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n);
    const [vx0 = 0, vy0 = 0, vx1 = 0, vy1 = 0] = page.view;
    const content = await page.getTextContent();
    const items: RawItem[] = [];
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      const [a = 0, b = 0, , , e = 0, f = 0] = it.transform as number[];
      if (Math.abs(b) > Math.abs(a) * 0.2) continue; // rotated or vertical text
      const size = Math.hypot(a, b) || it.height;
      items.push({ str: it.str, x: e - vx0, y: f - vy0, width: it.width, size: Math.round(size * 10) / 10 });
    }
    pages.push({ number: n, width: vx1 - vx0, height: vy1 - vy0, items });
    page.cleanup();
  }
  return pages;
}
