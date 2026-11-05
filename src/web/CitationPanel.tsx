import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { doiUrl, type Source } from "./api";
import { Badge, Icon, IconButton, useMediaQuery } from "./ui";

/**
 * Citation details (T-5.4): a side panel beside the answer at ≥ 1280 px, an overlay panel from 768 px, and a bottom
 * sheet on phones. Shows the stored passage and paper details only. Esc, the close button, the backdrop or a swipe
 * down closes it; focus returns to the citation that opened it.
 */
// The panel is a dialog overlay below 1280 px, so it keeps an edge and a shadow; docked it sits flat.
const PANEL =
  "motion-panel fixed inset-x-0 bottom-0 z-40 flex max-h-[80dvh] flex-col rounded-t-(--radius-card) border-t border-border bg-surface shadow-sm md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-(--spacing-panel) md:rounded-none md:border-t-0 md:border-l xl:sticky xl:top-0 xl:z-auto xl:h-dvh xl:shadow-none"; // taste-skill-ignore

export function CitationPanel({ source, onClose }: { source: Source; onClose: () => void }) {
  const docked = useMediaQuery("(min-width: 1280px)");
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchY = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  /** Keep Tab inside the panel while it covers the page (aria-modal). */
  const trapTab = (e: ReactKeyboardEvent) => {
    if (docked || e.key !== "Tab" || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll<HTMLElement>("a[href], button")];
    const first = items[0];
    const last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source, onClose]);

  const pages =
    source.pageStart === source.pageEnd
      ? `p. ${source.pageStart}`
      : `pp. ${source.pageStart}–${source.pageEnd}`;
  const authors =
    source.authors.length > 3 ? `${source.authors.slice(0, 3).join(", ")} et al.` : source.authors.join(", ");

  return (
    <>
      {!docked && (
        <div className="motion-fade fixed inset-0 z-30 bg-text/20" onClick={onClose} aria-hidden="true" />
      )}
      <aside
        ref={panelRef}
        onKeyDown={trapTab}
        role="dialog"
        aria-modal={!docked}
        aria-labelledby="citation-title"
        className={PANEL}
        onTouchStart={(e) => (touchY.current = e.touches[0]!.clientY)}
        onTouchEnd={(e) => {
          if (touchY.current !== null && e.changedTouches[0]!.clientY - touchY.current > 80) onClose();
          touchY.current = null;
        }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border md:hidden" aria-hidden="true" />
        <header className="flex items-center justify-between gap-2 px-4 pt-2 md:pt-4">
          <p className="text-small font-medium text-muted">Source {source.n}</p>
          <IconButton ref={closeRef} label="Close source" icon="close" onClick={onClose} />
        </header>
        <div className="overflow-y-auto px-4 pb-6">
          <div className="flex flex-wrap gap-2">
            {source.upload ? <Badge tone="muted">Your upload · unverified</Badge> : <Badge>Curated</Badge>}
          </div>
          <h2 id="citation-title" className="mt-3 font-serif text-h3 leading-snug">
            {source.title}
          </h2>
          <p className="mt-2 text-small text-muted">{[authors, source.year].filter(Boolean).join(" · ")}</p>
          <p className="mt-1 text-small text-muted">
            {source.section} · {pages}
          </p>
          {source.doi && (
            <a
              href={doiUrl(source.doi)}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="mt-2 inline-flex min-h-(--spacing-touch) items-center gap-1 text-small underline decoration-accent underline-offset-2 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-accent"
            >
              doi.org/{source.doi}
              <Icon name="external" className="size-4" />
            </a>
          )}
          <blockquote className="mt-4 rounded-(--radius-card) bg-accent-soft p-4 text-small leading-answer whitespace-pre-line">
            {source.text}
          </blockquote>
        </div>
      </aside>
    </>
  );
}
