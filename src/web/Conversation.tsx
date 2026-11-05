import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Done, Source } from "./api";
import { AnswerText } from "./AnswerText";
import { Icon, IconButton, Skeleton } from "./ui";

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
  onAsk: (question: string) => void;
  onRetry: (turn: Turn) => void;
  onCite: (source: Source, opener: HTMLElement) => void;
  onFeedback: (turn: Turn, value: 1 | -1 | 0) => void;
}

export function Conversation({ turns, busy, onAsk, onRetry, onCite, onFeedback }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-(--spacing-column) px-4 py-8 md:px-6">
          {turns.length === 0 ? (
            <Empty onAsk={onAsk} />
          ) : (
            turns.map((t) => <TurnView key={t.id} turn={t} {...{ onRetry, onCite, onFeedback }} />)
          )}
          <div ref={endRef} />
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {status}
      </p>
      <Composer busy={busy} onAsk={onAsk} />
    </div>
  );
}

function Empty({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <section className="motion-fade pt-[8vh] md:pt-[14vh]">
      <h1 className="text-h2 font-semibold md:text-h1">What would you like to research?</h1>
      <p className="mt-2 text-muted">
        Answers from curated research papers on sustainable materials, with the sources cited.
      </p>
      <ul className="mt-8 grid gap-2 sm:grid-cols-2" aria-label="Suggested questions">
        {SUGGESTIONS.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onAsk(s)}
              className="min-h-(--spacing-touch) w-full rounded-(--radius-card) border border-control bg-surface px-4 py-3 text-left leading-ui transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </section>
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
      <h2 className="text-body leading-ui text-muted">{turn.question}</h2>
      <div className="mt-3">
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

function Composer({ busy, onAsk }: { busy: boolean; onAsk: (q: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = value.trim();
    if (!q || busy) return;
    onAsk(q);
    setValue("");
  };
  return (
    <form onSubmit={submit} className="bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
      <div className="mx-auto flex max-w-(--spacing-column) items-end gap-2 rounded-(--radius-card) border border-control bg-surface p-1.5 focus-within:border-accent">
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
          placeholder="Ask about biopolymers, green chemistry, packaging…"
          className="field-sizing-content max-h-40 min-h-(--spacing-touch) flex-1 resize-none bg-transparent px-2.5 py-2.5 leading-ui outline-none placeholder:text-muted"
        />
        <button
          type="submit"
          aria-label="Send question"
          disabled={busy || !value.trim()}
          className="inline-flex size-(--spacing-touch) shrink-0 items-center justify-center rounded-control bg-accent text-on-accent transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
        >
          <Icon name="send" />
        </button>
      </div>
    </form>
  );
}
