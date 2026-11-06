/// <reference lib="webworker" />
import { getDocument, type PDFPageProxy } from "pdfjs-dist";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs";
import { createWorker, PSM, type Worker as OcrWorker } from "tesseract.js";
import type { RawItem } from "../../shared/pdf/types";
import { parseUpload, UploadError } from "./parse";

// We are already off the main thread, so pdf.js runs its worker code right here (its "fake worker" mode) instead of
// starting a second worker. Killing this one worker (the timeout) stops everything. Importing it also wires pdf.js's
// own handler to this worker's port (it posts a "ready" message), so our messages carry a `sustainiq` tag.
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;

/** pdf.js draws into OffscreenCanvas here: workers have no `document`. Only used to render pages for OCR. */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  reset(c: { canvas: OffscreenCanvas }, width: number, height: number) {
    c.canvas.width = width;
    c.canvas.height = height;
  }
  getNoAlphaContext(canvas: OffscreenCanvas) {
    return canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  }
  destroy(c: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (c.canvas) c.canvas.width = c.canvas.height = 0;
    c.canvas = null;
    c.context = null;
  }
}

/** OCR width ≈ 240 dpi for an A4/Letter page: measured on the owner's scan, 2400 px read only ~1% more words, much slower. */
const OCR_WIDTH_PX = 2000;
const MIN_LINE_CONFIDENCE = 40;
const MIN_WORD_CONFIDENCE = 30;

let ocrWorker: Promise<OcrWorker> | null = null;
// Self-hosted (public/ocr, copied at build time): no CDN, and the CSP stays 'self' (no blob: workers).
const ocr = () =>
  (ocrWorker ??= createWorker("eng", 1, {
    workerPath: "/ocr/worker.min.js",
    corePath: "/ocr/",
    langPath: "/ocr/",
    workerBlobURL: false,
  }));

/** Render one page and read its words back as positioned text items in PDF coordinates, like pdf.js gives us. */
async function ocrPage(page: PDFPageProxy): Promise<{ items: RawItem[]; confidence: number }> {
  const base = page.getViewport({ scale: 1 });
  const scale = OCR_WIDTH_PX / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  page.cleanup();
  const items: RawItem[] = [];
  const covered: Box[] = [];
  // The main pass's confidence is the page's quality; the title pass below only adds large text.
  const confidence = await readInto(canvas, scale, base.height, items, covered);
  if (page.pageNumber !== 1) return { items, confidence };
  // Tesseract's page layout misses very large text (titles), so on the first page (where the title is) a quick
  // half-size pass in "sparse text" mode adds whatever the first pass left out.
  const half = new OffscreenCanvas(Math.ceil(canvas.width / 2), Math.ceil(canvas.height / 2));
  half.getContext("2d")!.drawImage(canvas, 0, 0, half.width, half.height);
  const w = await ocr();
  await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  try {
    await readInto(half, scale / 2, base.height, items, covered);
  } finally {
    await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  }
  return { items, confidence };
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * OCR one image and add its words as positioned items in PDF coordinates, skipping lines that overlap text we
 * already have. Words, not tesseract's lines: on tight two-column papers tesseract joins lines across the gutter,
 * while our layout code (the same as for text PDFs) splits rows at gaps wider than ~1 em and orders the columns.
 */
async function readInto(
  image: OffscreenCanvas,
  scale: number,
  pageHeight: number,
  items: RawItem[],
  covered: Box[],
) {
  const { data } = await (await ocr()).recognize(image as never, {}, { blocks: true });
  const fresh: Box[] = [];
  for (const block of data.blocks ?? [])
    for (const para of block.paragraphs)
      for (const line of para.lines) {
        if (line.confidence < MIN_LINE_CONFIDENCE) continue;
        const box = {
          x0: line.bbox.x0 / scale,
          y0: line.bbox.y0 / scale,
          x1: line.bbox.x1 / scale,
          y1: line.bbox.y1 / scale,
        };
        if (covered.some((c) => overlaps(c, box))) continue;
        fresh.push(box);
        const heights = line.words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
        const size = Math.round(((heights[heights.length >> 1] ?? 0) / scale) * 10) / 10; // median ≈ font size
        const baseline = (line.baseline.y0 + line.baseline.y1) / 2;
        for (const w of line.words) {
          const str = w.text.trim();
          if (!str || w.confidence < MIN_WORD_CONFIDENCE) continue;
          items.push({
            str,
            x: w.bbox.x0 / scale,
            y: pageHeight - baseline / scale, // pdf.js coordinates: origin bottom-left, y = baseline
            width: (w.bbox.x1 - w.bbox.x0) / scale,
            size,
          });
        }
      }
  covered.push(...fresh);
  return data.confidence;
}

const reply = (m: object) => postMessage({ sustainiq: true, ...m });

self.onmessage = async (e: MessageEvent<{ sustainiq?: true; data: ArrayBuffer; name: string }>) => {
  if (!e.data?.sustainiq) return; // pdf.js protocol traffic
  try {
    const result = await parseUpload(new Uint8Array(e.data.data), e.data.name, getDocument, {
      onStep: (step, done, total) => reply({ type: "step", step, done, total }),
      ocr: ocrPage,
      docOptions: { CanvasFactory: OffscreenCanvasFactory },
    });
    reply({ type: "done", result });
  } catch (err) {
    if (!(err instanceof UploadError)) console.error("PDF parse failed", err); // the user sees a plain message
    reply({ type: "error", code: err instanceof UploadError ? err.code : "unreadable" });
  } finally {
    if (ocrWorker) void (await ocrWorker).terminate();
  }
};
