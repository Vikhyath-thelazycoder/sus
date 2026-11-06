/// <reference lib="webworker" />
import { getDocument } from "pdfjs-dist";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs";
import { parseUpload, UploadError } from "./parse";

// We are already off the main thread, so pdf.js runs its worker code right here (its "fake worker" mode) instead of
// starting a second worker. Killing this one worker (the timeout) stops everything. Importing it also wires pdf.js's
// own handler to this worker's port (it posts a "ready" message), so our messages carry a `sustainiq` tag.
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;

const reply = (m: object) => postMessage({ sustainiq: true, ...m });

self.onmessage = async (e: MessageEvent<{ sustainiq?: true; data: ArrayBuffer; name: string }>) => {
  if (!e.data?.sustainiq) return; // pdf.js protocol traffic
  try {
    const result = await parseUpload(new Uint8Array(e.data.data), e.data.name, getDocument, (step) =>
      reply({ type: "step", step }),
    );
    reply({ type: "done", result });
  } catch (err) {
    reply({ type: "error", code: err instanceof UploadError ? err.code : "unreadable" });
  }
};
