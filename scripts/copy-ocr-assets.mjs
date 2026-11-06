/* global console */
// Self-host the OCR engine (tesseract.js) for scanned PDFs, so uploads never fetch code or data from a CDN.
// Runs before every build; the copies in public/ocr are not committed.
import { copyFileSync, mkdirSync } from "node:fs";

const out = "public/ocr";
mkdirSync(out, { recursive: true });
const files = {
  "node_modules/tesseract.js/dist/worker.min.js": "worker.min.js",
  // LSTM-only cores (we run OEM 1); tesseract picks one by the browser's SIMD support.
  "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js": "tesseract-core-lstm.wasm.js",
  "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js": "tesseract-core-simd-lstm.wasm.js",
  "node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js":
    "tesseract-core-relaxedsimd-lstm.wasm.js",
  // English, "best_int" model: ~3 MB, accurate enough for printed papers.
  "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz": "eng.traineddata.gz",
};
for (const [from, to] of Object.entries(files)) copyFileSync(from, `${out}/${to}`);
console.log(`OCR assets copied to ${out}`);
