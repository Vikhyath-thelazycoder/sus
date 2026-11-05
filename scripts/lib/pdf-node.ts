import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPages } from "../../src/shared/pdf/read";
import { parsePaper } from "../../src/shared/pdf/structure";
import type { ParsedPaper } from "../../src/shared/pdf/types";

/** Parse a local PDF with the same shared code the browser uses (pdf.js; XFA off; no fonts loaded). */
export async function parsePdfFile(path: string, maxPages = 100): Promise<ParsedPaper> {
  const data = new Uint8Array(await readFile(path));
  if (String.fromCharCode(...data.slice(0, 5)) !== "%PDF-") throw new Error(`${path} is not a PDF`);
  const task = getDocument({ data, enableXfa: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    return parsePaper(await readPages(await task.promise, maxPages));
  } finally {
    await task.destroy();
  }
}
