import { UPLOAD } from "../../shared/limits";
import { deleteUpload } from "../api";
import type { ParsedUpload, ParseStep, UploadErrorCode } from "./parse";

/** Upload flow (T-7.3): parse in a Web Worker → create (quota) → chunk batches (server embeds) → finish. */
export type UploadStep = ParseStep | "indexing";
export type UploadFailure =
  UploadErrorCode | "type" | "quota" | "paused" | "timeout" | "network" | "rate-limited";

export class UploadFailed extends Error {
  constructor(readonly reason: UploadFailure) {
    super(reason);
  }
}

export const FAILURE_COPY: Record<UploadFailure, string> = {
  type: "That file isn't a PDF.",
  "not-pdf": "That file isn't a PDF.",
  "too-big": `PDFs can be up to ${UPLOAD.maxFileBytes / 1024 / 1024} MB.`,
  "too-many-pages": `PDFs can be up to ${UPLOAD.maxPages} pages.`,
  scanned: "This PDF looks like a scan with no text layer, so it can't be read.",
  "too-much-text": "This PDF has more text than the demo can index.",
  unreadable: "This PDF couldn't be read. Try another file.",
  timeout: "Reading this PDF took too long. Try a smaller file.",
  quota: `You've reached the demo limit (${UPLOAD.maxPdfs} PDFs, ${UPLOAD.maxPages} pages in total). Delete an upload to add another.`,
  paused: "Uploads are paused right now. Please try again later.",
  "rate-limited": "That was a lot of uploading at once. Try again in a minute.",
  network: "The upload didn't finish. Check your connection and try again.",
};

/** Parse off the main thread; the worker is terminated on timeout so a hostile PDF can't hang the tab. */
export function parseInWorker(
  file: File,
  onStep: (s: ParseStep) => void,
  timeoutMs: number = UPLOAD.parseTimeoutMs,
): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
    const done = (fn: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new UploadFailed("timeout"))), timeoutMs);
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { sustainiq?: true } & (
        | { type: "step"; step: ParseStep }
        | { type: "done"; result: ParsedUpload }
        | { type: "error"; code: UploadErrorCode }
      );
      if (!m?.sustainiq) return; // pdf.js's own "ready" message
      if (m.type === "step") onStep(m.step);
      else if (m.type === "done") done(() => resolve(m.result));
      else done(() => reject(new UploadFailed(m.code)));
    };
    worker.onerror = () => done(() => reject(new UploadFailed("unreadable")));
    file.arrayBuffer().then(
      (data) => worker.postMessage({ sustainiq: true, data, name: file.name }, [data]),
      () => done(() => reject(new UploadFailed("unreadable"))),
    );
  });
}

// The CSRF guard wants JSON on every state-changing request, body or not.
const JSON_HEADERS = { "Content-Type": "application/json" };

async function send(path: string, body?: unknown): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch {
      // network error: retry below (every step is an idempotent upsert)
    }
    if (res && res.status < 500) return res;
    if (attempt === 3) throw new UploadFailed("network");
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
}

const failureFor = (status: number): UploadFailure =>
  status === 409 ? "quota" : status === 503 ? "paused" : status === 429 ? "rate-limited" : "network";

export async function sendUpload(
  parsed: ParsedUpload,
  onProgress: (done: number, total: number) => void,
): Promise<string> {
  const created = await send("/api/uploads", {
    title: parsed.title,
    pages: parsed.pages,
    sections: parsed.sections,
  });
  if (created.status !== 201) throw new UploadFailed(failureFor(created.status));
  const { paperId } = (await created.json()) as { paperId: string };
  try {
    const total = parsed.chunks.length;
    for (let i = 0; i < total; i += UPLOAD.chunksPerBatch) {
      const res = await send(`/api/uploads/${paperId}/chunks`, {
        chunks: parsed.chunks.slice(i, i + UPLOAD.chunksPerBatch),
      });
      if (!res.ok) throw new UploadFailed(failureFor(res.status));
      onProgress(Math.min(i + UPLOAD.chunksPerBatch, total), total);
    }
    const fin = await send(`/api/uploads/${paperId}/finish`);
    if (!fin.ok) throw new UploadFailed(failureFor(fin.status));
    return paperId;
  } catch (err) {
    // Give the quota back; if this fails too, the daily cleanup removes the unfinished upload.
    void deleteUpload(paperId).catch(() => {});
    throw err;
  }
}
