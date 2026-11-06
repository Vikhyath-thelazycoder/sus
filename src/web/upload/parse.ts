import type { getDocument as GetDocument, PDFPageProxy } from "pdfjs-dist";
import { chunkPaper, type Chunk } from "../../shared/chunker";
import { UPLOAD } from "../../shared/limits";
import { readPages } from "../../shared/pdf/read";
import { parsePaper } from "../../shared/pdf/structure";
import { cleanText } from "../../shared/text";
import type { RawItem } from "../../shared/pdf/types";

/**
 * Browser parsing of a user's PDF (T-7.1, SECURITY §9, §12 #15), with the same reader, structure and chunker as
 * curated ingestion. pdf.js is passed in so the Web Worker uses the browser build and tests use the Node build.
 */
export type UploadErrorCode =
  "not-pdf" | "too-big" | "too-many-pages" | "scanned" | "too-much-text" | "unreadable";

export class UploadError extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(code);
  }
}

export interface ParsedUpload {
  title: string;
  pages: number;
  sections: { name: string; text: string; pageStart: number; pageEnd: number }[];
  chunks: Chunk[];
  /** OCR'd pages tesseract read with low confidence: shown as a warning on the chip (T-7.10). */
  unclearPages: number[];
}

export type ParseStep = "reading" | "ocr" | "splitting";

/** Pages with less text than this are treated as images and sent to OCR (scans, or scanned pages in a mixed PDF). */
export const OCR_MIN_CHARS = 20;
/**
 * Below this mean word confidence (tesseract, 0-100) an OCR'd page is flagged as possibly misread.
 * shortcut: not measured on bad scans yet; tune on real examples if it warns too often or too rarely.
 */
export const OCR_UNCLEAR_CONFIDENCE = 60;

export interface ParseOptions {
  onStep?: (step: ParseStep, done?: number, total?: number) => void;
  maxPages?: number;
  /** Reads the text out of a page image; without it, image-only PDFs are rejected as "scanned". */
  /** OCR one page: its words plus tesseract's mean confidence for the page (0-100). */
  ocr?: (page: PDFPageProxy) => Promise<{ items: RawItem[]; confidence: number }>;
  /** Extra getDocument options (the browser worker passes an OffscreenCanvas factory for OCR rendering). */
  docOptions?: Record<string, unknown>;
}

/** Cheap checks before pdf.js ever sees the bytes: size cap and the `%PDF-` magic bytes. */
export function checkBytes(data: Uint8Array): void {
  if (data.byteLength > UPLOAD.maxFileBytes) throw new UploadError("too-big");
  if (String.fromCharCode(...data.subarray(0, 5)) !== "%PDF-") throw new UploadError("not-pdf");
}

/** File names give the fallback title; never keep a path (SECURITY §5.1). */
export const titleFromName = (name: string) =>
  cleanText(
    name
      .split(/[\\/]/)
      .pop()!
      .replace(/\.pdf$/i, "")
      .replace(/[_]+/g, " "),
  )
    .trim()
    .slice(0, 300) || "Untitled PDF";

export async function parseUpload(
  data: Uint8Array,
  fileName: string,
  getDocument: typeof GetDocument,
  { onStep = () => {}, maxPages = UPLOAD.maxPages, ocr, docOptions = {} }: ParseOptions = {},
): Promise<ParsedUpload> {
  checkBytes(data);
  onStep("reading");
  // No XFA, no embedded fonts, no system fonts: text only. pdf.js 6 never evaluates PDF JavaScript.
  const task = getDocument({
    data,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    ...docOptions,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch {
      throw new UploadError("unreadable");
    }
    if (doc.numPages > maxPages) throw new UploadError("too-many-pages");
    const raw = await readPages(doc, maxPages);
    const textless = raw.filter((p) => p.items.reduce((n, it) => n + it.str.length, 0) < OCR_MIN_CHARS);
    const unclearPages: number[] = [];
    if (ocr && textless.length) {
      for (const [i, p] of textless.entries()) {
        onStep("ocr", i, textless.length);
        const read = await ocr(await doc.getPage(p.number));
        p.items = read.items;
        if (read.confidence < OCR_UNCLEAR_CONFIDENCE) unclearPages.push(p.number);
      }
      onStep("ocr", textless.length, textless.length);
    }
    const chars = raw.reduce((n, p) => n + p.items.reduce((m, it) => m + it.str.length, 0), 0);
    if (chars > UPLOAD.maxChars) throw new UploadError("too-much-text");

    onStep("splitting");
    const parsed = parsePaper(raw);
    if (parsed.scanned || !parsed.sections.length) throw new UploadError("scanned");
    if (parsed.sections.length > 200) throw new UploadError("unreadable");
    const title = (parsed.title && cleanText(parsed.title).trim().slice(0, 300)) || titleFromName(fileName);
    const chunks = chunkPaper(parsed.sections, title, null);
    if (chunks.length > UPLOAD.maxChunks) throw new UploadError("too-much-text");
    if (chunks.some((c) => c.text.length > 4000)) throw new UploadError("unreadable");
    return {
      title,
      pages: parsed.pages,
      sections: parsed.sections.map((s) => ({
        name: s.name.slice(0, 200),
        text: s.paragraphs
          .map((p) => p.text)
          .join("\n\n")
          .slice(0, UPLOAD.sectionPreviewChars),
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
      })),
      chunks,
      unclearPages,
    };
  } finally {
    await task.destroy();
  }
}
