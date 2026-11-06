import { useRef, useState, type DragEvent } from "react";
import { UPLOAD } from "../../shared/limits";
import { Icon } from "../ui";
import {
  FAILURE_COPY,
  parseInWorker,
  sendUpload,
  UploadFailed,
  type UploadFailure,
  type UploadStep,
} from "./client";

/** Upload UI (T-7.3): drag-and-drop or pick a PDF, limits and the confidentiality notice, Reading → Splitting → Indexing. */
type State =
  | { kind: "idle" }
  | { kind: "busy"; step: UploadStep; done: number; total: number; name: string }
  | { kind: "error"; reason: UploadFailure }
  | { kind: "added"; title: string; paperId: string };

const STEPS: { id: UploadStep; label: string }[] = [
  { id: "reading", label: "Reading" },
  { id: "splitting", label: "Splitting" },
  { id: "indexing", label: "Indexing" },
];

export function UploadPanel({
  used,
  onUploaded,
  onOpen,
  upload = { parse: parseInWorker, send: sendUpload },
}: {
  used: { pdfs: number; pages: number };
  onUploaded: () => void;
  onOpen: (paperId: string) => void;
  /** Injected in tests. */
  upload?: { parse: typeof parseInWorker; send: typeof sendUpload };
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = state.kind === "busy";
  const full = used.pdfs >= UPLOAD.maxPdfs || used.pages >= UPLOAD.maxPages;

  async function start(file: File | undefined) {
    if (!file || busy) return;
    if (input.current) input.current.value = "";
    const fail = (reason: UploadFailure) => setState({ kind: "error", reason });
    // Client-side checks first (SECURITY §9); the server checks all of them again.
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return fail("type");
    if (file.size > UPLOAD.maxFileBytes) return fail("too-big");
    if (full) return fail("quota");
    const progress = (step: UploadStep, done = 0, total = 0) =>
      setState({ kind: "busy", step, done, total, name: file.name });
    progress("reading");
    try {
      const parsed = await upload.parse(file, (s) => progress(s));
      if (used.pages + parsed.pages > UPLOAD.maxPages) return fail("quota");
      progress("indexing", 0, parsed.chunks.length);
      const paperId = await upload.send(parsed, (d, t) => progress("indexing", d, t));
      setState({ kind: "added", title: parsed.title, paperId });
      onUploaded();
    } catch (err) {
      fail(err instanceof UploadFailed ? err.reason : "network");
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void start(e.dataTransfer.files[0]);
  };

  return (
    <section aria-labelledby="upload-heading" className="mt-6 rounded-(--radius-card) bg-surface p-4 md:p-5">
      <h2 id="upload-heading" className="text-h3 font-semibold">
        Add your own PDF
      </h2>
      <p className="mt-1 text-small text-muted">
        Only you can see your uploads. They're labelled unverified and deleted after 7 days. Up to{" "}
        {UPLOAD.maxPdfs} PDFs and {UPLOAD.maxPages} pages in total.{" "}
        <strong className="font-medium text-text">Don't upload confidential documents to this demo.</strong>
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`mt-4 flex flex-col items-center gap-2 rounded-(--radius-card) border border-dashed px-4 py-6 text-center transition-colors ${over ? "border-accent bg-accent-soft" : "border-control"}`}
      >
        <input
          ref={input}
          id="upload-input"
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          disabled={busy || full}
          onChange={(e) => void start(e.target.files?.[0])}
        />
        <label
          htmlFor="upload-input"
          aria-disabled={busy || full}
          className="inline-flex min-h-(--spacing-touch) cursor-pointer items-center gap-2 rounded-control border border-accent bg-accent-soft px-4 font-medium hover:bg-bg aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [input:focus-visible+&]:outline-2 [input:focus-visible+&]:outline-offset-2 [input:focus-visible+&]:outline-accent"
        >
          <Icon name="plus" className="size-4" />
          Choose a PDF
        </label>
        <p className="text-small text-muted">
          or drop it here · up to {UPLOAD.maxFileBytes / 1024 / 1024} MB
        </p>
        <p className="text-caption text-muted">
          {used.pdfs} of {UPLOAD.maxPdfs} PDFs · {used.pages} of {UPLOAD.maxPages} pages used
        </p>
      </div>

      <div aria-live="polite" className="mt-3">
        {state.kind === "busy" && (
          <div>
            <p className="truncate text-small font-medium">{state.name}</p>
            <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small" aria-label="Upload progress">
              {STEPS.map((s, i) => {
                const at = STEPS.findIndex((x) => x.id === state.step);
                const status = i < at ? "done" : i === at ? "current" : "todo";
                return (
                  <li
                    key={s.id}
                    aria-current={status === "current" ? "step" : undefined}
                    className={status === "todo" ? "text-muted" : ""}
                  >
                    {status === "done" ? "✓ " : ""}
                    {s.label}
                    {s.id === "indexing" && status === "current" && state.total
                      ? ` ${state.done} of ${state.total} passages`
                      : ""}
                    {status === "current" && "…"}
                  </li>
                );
              })}
            </ol>
            {state.step === "indexing" && state.total > 0 && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${Math.round((100 * state.done) / state.total)}%` }}
                />
              </div>
            )}
          </div>
        )}
        {state.kind === "error" && (
          <p role="alert" className="text-small">
            {FAILURE_COPY[state.reason] ?? FAILURE_COPY.unreadable}
          </p>
        )}
        {state.kind === "added" && (
          <p className="text-small">
            Added “{state.title}”. It's now part of your answers.{" "}
            <button
              type="button"
              onClick={() => onOpen(state.paperId)}
              className="min-h-(--spacing-touch) font-medium underline decoration-accent underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
            >
              Open it
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
