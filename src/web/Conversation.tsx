import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { UPLOAD } from "../shared/limits";
import type { Done, Source } from "./api";
import { AnswerText } from "./AnswerText";
import { Icon, IconButton, Skeleton } from "./ui";
import { FAILURE_COPY } from "./upload/client";
import { useAttachments, type Attachment, type UploadDeps } from "./upload/useAttachments";

export type TurnError = "rate_limited" | "busy" | "failed";
export interface Turn {
  id: string;
  question: string;
  /** The answer as streamed so far, then the final validated text. */
  text: string;
  step: "searching" | "writing" | null;
  state: "streaming" | "done" | "error";
  error?: TurnError;
  done?: Done;
  feedback: 1 | -1 | 0;
  /** Titles of PDFs attached with this question (shown on the question; not stored with saved chats). */
  attachments?: string[];
}

export const SUGGESTIONS = [
  "How fast do gut enzymes break PLA microplastics into nanoplastics?",
  "Which green solvents help extract antioxidants from orange peel?",
  "Can bacterial cellulose be used in food packaging?",
  "Why do some mycelium composites absorb more water than others?",
];

const ERROR_COPY: Record<TurnError, string> = {
  rate_limited: "You've asked a lot quickly. Try again in a minute.",
  busy: "The service is busy right now. Please try again in a minute.",
  failed: "Something went wrong while answering. Please try again.",
};

interface Props {
  turns: Turn[];
  busy: boolean;
  onAsk: (question: string, attachments?: string[]) => void;
  onRetry: (turn: Turn) => void;
  onCite: (source: Source, opener: HTMLElement) => void;
  onFeedback: (turn: Turn, value: 1 | -1 | 0) => void;
  /** The chat's server ID, creating the chat on the first attached PDF (T-7.11). */
  chatId: () => Promise<string>;
  /** "Use the library" as the user set it; undefined = default (T-7.12). */
  useLibrary?: boolean;
  /** Titles of the PDFs already in this chat (sent with earlier questions or saved). */
  files?: string[];
  onUseLibrary: (on: boolean) => void;
  /** Injected in tests. */
  uploadDeps?: UploadDeps;
}

export function Conversation({
  turns,
  busy,
  onAsk,
  onRetry,
  onCite,
  onFeedback,
  chatId,
  useLibrary,
  files = [],
  onUseLibrary,
  uploadDeps,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments(chatId, uploadDeps);
  // Proposed default (not yet confirmed by the owner, same rule as the server): off when the chat has a PDF.
  const library = useLibrary ?? !(files.length || attachments.items.some((a) => a.state !== "error"));
  const last = turns.at(-1);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, last?.state]);

  const status = !last
    ? ""
    : last.state === "streaming"
      ? last.step === "writing"
        ? "Writing…"
        : "Searching papers…"
      : last.state === "error"
        ? ERROR_COPY[last.error ?? "failed"]
        : "Answer ready.";

  const composer = (
    <Composer
      busy={busy}
      onAsk={onAsk}
      attachments={attachments}
      files={files}
      library={library}
      onLibrary={onUseLibrary}
    />
  );

  // A new chat looks like Claude/ChatGPT: greeting and the question box in the middle, suggestions under it.
  if (turns.length === 0) return <Empty onAsk={onAsk}>{composer}</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-(--spacing-column) px-4 py-8 md:px-6">
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} {...{ onRetry, onCite, onFeedback }} />
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {status}
      </p>
      <div className="bg-bg px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">{composer}</div>
    </div>
  );
}

function Empty({ onAsk, children }: { onAsk: (q: string) => void; children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="motion-fade mx-auto flex min-h-full w-full max-w-(--spacing-column) flex-col justify-center px-4 py-8 md:px-6">
        <h1 className="text-center text-h1 leading-tight font-semibold">What would you like to research?</h1>
        <p className="mt-2 text-center text-muted">
          Answers from curated papers on sustainable materials, with every source cited. Add your own PDF with
          +.
        </p>
        <div className="mt-8">{children}</div>
        <ul className="mt-6 grid gap-2 sm:grid-cols-2" aria-label="Suggested questions">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => onAsk(s)}
                className="min-h-(--spacing-touch) w-full rounded-(--radius-card) border border-border bg-surface px-4 py-3 text-left leading-ui transition-colors hover:border-control focus-visible:outline-2 focus-visible:outline-accent"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function TurnView({
  turn,
  onRetry,
  onCite,
  onFeedback,
}: { turn: Turn } & Pick<Props, "onRetry" | "onCite" | "onFeedback">) {
  const sources = turn.done?.sources ?? [];
  const byN = new Map(sources.map((s) => [s.n, s]));
  const notFound = turn.done && (turn.done.notFound || turn.done.status === "unverified");
  const declined = turn.done?.status === "declined";

  return (
    <article className="motion-fade pb-12 last:pb-4">
      {/* The question as a soft bubble on the right; the answer stays plain document text (DESIGN.md). */}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-(--radius-card) bg-accent-soft px-4 py-2.5">
          {turn.attachments?.length ? (
            <ul className="mb-2 flex flex-wrap justify-end gap-1.5" aria-label="Attached PDFs">
              {turn.attachments.map((t, i) => (
                <li
                  key={i}
                  className="flex max-w-full items-center gap-1.5 rounded-control bg-surface px-2 py-1 text-caption"
                >
                  <Icon name="file" className="size-3.5 shrink-0 text-muted" />
                  <span className="truncate">{t}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <h2 className="text-body leading-ui break-words whitespace-pre-wrap">{turn.question}</h2>
        </div>
      </div>
      <div className="mt-5">
        {turn.state === "error" ? (
          <div role="alert" className="rounded-(--radius-card) border border-border bg-surface p-4">
            <p className={turn.error === "failed" ? "text-danger" : undefined}>
              {ERROR_COPY[turn.error ?? "failed"]}
            </p>
            <button
              type="button"
              onClick={() => onRetry(turn)}
              className="mt-3 min-h-(--spacing-touch) rounded-control border border-control px-4 text-small font-medium hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              Try again
            </button>
          </div>
        ) : turn.state === "streaming" && !turn.text ? (
          <div aria-hidden="true">
            <p className="mb-3 text-small text-muted">
              {turn.step === "writing" ? "Writing…" : "Searching papers…"}
            </p>
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="mt-2 h-4 w-10/12" />
            <Skeleton className="mt-2 h-4 w-7/12" />
          </div>
        ) : notFound ? (
          <div className="rounded-(--radius-card) border border-border bg-surface p-4">
            <p>I couldn't find this in the papers.</p>
            <p className="mt-1 text-small text-muted">
              Try rephrasing the question or asking about a specific material or method.
            </p>
          </div>
        ) : (
          <div className={declined ? "text-muted" : undefined}>
            <AnswerText
              text={turn.text}
              sourceNumbers={new Set(byN.keys())}
              onCite={(n, el) => onCite(byN.get(n)!, el)}
            />
          </div>
        )}
      </div>

      {turn.state === "done" && !declined && !notFound && (
        <>
          {sources.length > 0 && (
            <ul className="mt-5 flex flex-wrap gap-2" aria-label="Sources">
              {sources.map((s) => (
                <li key={s.n}>
                  <button
                    type="button"
                    onClick={(e) => onCite(s, e.currentTarget)}
                    className="flex min-h-(--spacing-touch) max-w-full items-center gap-2 rounded-control border border-control bg-surface px-3 text-left text-small hover:border-accent focus-visible:outline-2 focus-visible:outline-accent md:min-h-9"
                  >
                    <span className="rounded-control bg-accent-soft px-1.5 text-caption font-medium">
                      {s.n}
                    </span>
                    <span className="max-w-[16rem] truncate">{s.title}</span>
                    <span className="shrink-0 text-muted">p. {s.pageStart}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Actions turn={turn} onFeedback={onFeedback} />
          <p className="mt-2 text-caption text-muted">AI answers can be wrong. Check the cited sources.</p>
        </>
      )}
    </article>
  );
}

function Actions({ turn, onFeedback }: { turn: Turn; onFeedback: Props["onFeedback"] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked: nothing useful to show
    }
  };
  return (
    <div className="mt-3 -ml-2 flex items-center">
      <IconButton label={copied ? "Copied" : "Copy answer"} icon={copied ? "check" : "copy"} onClick={copy} />
      <IconButton
        label="Helpful"
        icon="up"
        aria-pressed={turn.feedback === 1}
        className={turn.feedback === 1 ? "text-accent" : ""}
        onClick={() => onFeedback(turn, turn.feedback === 1 ? 0 : 1)}
      />
      <IconButton
        label="Not helpful"
        icon="down"
        aria-pressed={turn.feedback === -1}
        className={turn.feedback === -1 ? "text-accent" : ""}
        onClick={() => onFeedback(turn, turn.feedback === -1 ? 0 : -1)}
      />
    </div>
  );
}

const STEP_COPY: Record<string, string> = {
  waiting: "Waiting",
  reading: "Reading",
  ocr: "Reading text from page images",
  splitting: "Splitting",
  indexing: "Indexing",
};

/** T-7.10: a badly read scan gets a plain warning instead of quietly giving worse answers. */
export const unclearCopy = (pages: number[]) =>
  `${pages.length === 1 ? "Page" : "Pages"} ${pages.join(", ")} may be misread (unclear scan).`;

function chipStatus(a: Attachment): string {
  if (a.state === "ready") return `Ready · ${a.pages} ${a.pages === 1 ? "page" : "pages"}`;
  if (a.state === "error") return FAILURE_COPY[a.reason] ?? FAILURE_COPY.unreadable;
  if (a.step === "indexing" && a.total && a.done >= a.total) return "Making it searchable…";
  const count = a.total ? ` ${a.done} of ${a.total}` : "";
  return `${STEP_COPY[a.step]}${count}…`;
}

export function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const pct = a.state === "working" && a.total ? Math.round((100 * a.done) / a.total) : null;
  return (
    <li className="flex max-w-full min-w-0 items-center gap-2 rounded-control border border-border bg-bg py-1.5 pr-1 pl-2.5 sm:max-w-[20rem]">
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-control ${a.state === "error" ? "text-danger" : "bg-accent-soft"}`}
      >
        <Icon name={a.state === "ready" ? "check" : "file"} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-small font-medium">
          {a.state === "ready" ? a.title : a.name}
        </span>
        <span className={`block truncate text-caption ${a.state === "error" ? "text-danger" : "text-muted"}`}>
          {chipStatus(a)}
        </span>
        {a.state === "ready" && a.unclearPages.length > 0 && (
          <span className="block text-caption text-danger">{unclearCopy(a.unclearPages)}</span>
        )}
        {pct !== null && (
          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-border" aria-hidden="true">
            <span className="block h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      <IconButton
        label={
          a.state === "working" ? `Cancel ${a.name}` : `Remove ${a.state === "ready" ? a.title : a.name}`
        }
        icon="close"
        className="size-9"
        onClick={onRemove}
      />
    </li>
  );
}

function Composer({
  busy,
  onAsk,
  attachments,
  files,
  library,
  onLibrary,
}: {
  busy: boolean;
  onAsk: Props["onAsk"];
  attachments: ReturnType<typeof useAttachments>;
  files: string[];
  library: boolean;
  onLibrary: (on: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { items, add, remove, take, working } = attachments;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = value.trim();
    if (!q || busy || working) return;
    const titles = take();
    onAsk(q, titles.length ? titles : undefined);
    setValue("");
  };
  const addFiles = (files: FileList | null | undefined) => {
    for (const f of Array.from(files ?? [])) void add(f);
    if (fileInput.current) fileInput.current.value = "";
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <form
      onSubmit={submit}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className="mx-auto w-full max-w-(--spacing-column)"
    >
      {files.length > 0 && (
        <ul aria-label="PDFs in this chat" className="mb-2 flex flex-wrap gap-1.5">
          {files.map((t, i) => (
            <li
              key={i}
              className="flex max-w-full items-center gap-1.5 rounded-control bg-accent-soft px-2 py-1 text-caption sm:max-w-[16rem]"
            >
              <Icon name="file" className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{t}</span>
            </li>
          ))}
        </ul>
      )}
      <div
        className={`rounded-(--radius-card) border bg-surface transition-colors focus-within:border-accent ${over ? "border-accent bg-accent-soft" : "border-control"}`}
      >
        {items.length > 0 && (
          <ul aria-label="Attached PDFs" aria-live="polite" className="flex flex-wrap gap-2 px-2.5 pt-2.5">
            {items.map((a) => (
              <AttachmentChip key={a.id} a={a} onRemove={() => remove(a)} />
            ))}
          </ul>
        )}
        <label htmlFor="question" className="sr-only">
          Your question
        </label>
        <textarea
          id="question"
          rows={1}
          maxLength={1000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
          placeholder={
            items.length || files.length
              ? library
                ? "Ask about your PDF or the library…"
                : "Ask about your PDF…"
              : "Ask about biopolymers, green chemistry, packaging…"
          }
          className="field-sizing-content block max-h-48 min-h-14 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 leading-ui outline-none placeholder:text-muted"
        />
        <div className="flex items-center justify-between gap-2 p-1.5">
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => addFiles(e.target.files)}
          />
          <div className="flex items-center gap-1">
            <IconButton label="Add a PDF" icon="plus" onClick={() => fileInput.current?.click()} />
            <button
              type="button"
              role="switch"
              aria-checked={library}
              onClick={() => onLibrary(!library)}
              title="Answer from the curated library as well as this chat's PDFs"
              className="inline-flex min-h-(--spacing-touch) items-center gap-2 rounded-control px-2 text-small text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span
                aria-hidden="true"
                className={`relative inline-block h-5 w-9 rounded-full transition-colors ${library ? "bg-accent" : "bg-border"}`}
              >
                <span
                  className={`absolute top-0.5 left-0 size-4 rounded-full bg-surface transition-transform ${library ? "translate-x-4.5" : "translate-x-0.5"}`}
                />
              </span>
              Use the library
            </button>
          </div>
          <button
            type="submit"
            aria-label="Send question"
            disabled={busy || working || !value.trim()}
            title={working ? "Wait for your PDF to finish indexing" : undefined}
            className="inline-flex size-(--spacing-touch) shrink-0 items-center justify-center rounded-control bg-accent text-on-accent transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
      {items.length > 0 && (
        <p className="mt-2 text-center text-caption text-muted">
          Only you can see your PDFs, and only in this chat; they're deleted after 7 days (up to {UPLOAD.maxPages} pages
          per PDF). Don't upload confidential documents.
        </p>
      )}
    </form>
  );
}
