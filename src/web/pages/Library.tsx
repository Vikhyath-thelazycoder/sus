import { useEffect, useMemo, useState } from "react";
import { doiUrl, getPaper, listPapers, type Paper, type PaperDetail } from "../api";
import { Badge, Icon, Skeleton } from "../ui";

/** Library (T-6.2): curated papers and the viewer's own uploads, with search and topic filters, and a detail view. */

const TOPICS = [
  { id: "all", label: "All" },
  { id: "biopolymers", label: "Biopolymers" },
  { id: "green-chemistry", label: "Green chemistry" },
  { id: "packaging", label: "Packaging" },
  { id: "biomaterials", label: "Biomaterials" },
  { id: "uploads", label: "Your uploads" },
] as const;
type TopicId = (typeof TOPICS)[number]["id"];

const topicLabel = (t: string | null) => TOPICS.find((x) => x.id === t)?.label ?? null;
const authorLine = (a: string[]) => (a.length > 3 ? `${a.slice(0, 3).join(", ")} et al.` : a.join(", "));

export function matches(p: Paper, query: string, topic: TopicId): boolean {
  if (topic === "uploads" ? !p.upload : topic !== "all" && p.topic !== topic) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [p.title, p.journal ?? "", p.authors.join(" "), topicLabel(p.topic) ?? "", String(p.year ?? "")]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<TopicId>("all");

  const load = () => listPapers().then(setPapers, () => setFailed(true));
  useEffect(() => void load(), []);
  const retry = () => {
    setFailed(false);
    void load();
  };

  const shown = useMemo(() => (papers ?? []).filter((p) => matches(p, query, topic)), [papers, query, topic]);
  const hasUploads = papers?.some((p) => p.upload);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-(--spacing-column) px-4 py-8 md:px-6">
        <h1 className="text-h2 font-semibold">Library</h1>
        <p className="mt-1 text-muted">
          The open-access papers answers come from{hasUploads ? ", plus your uploads" : ""}.
        </p>

        <label htmlFor="library-search" className="sr-only">
          Search papers
        </label>
        <input
          id="library-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, author, journal or year"
          className="mt-6 min-h-(--spacing-touch) w-full rounded-(--radius-card) border border-control bg-surface px-4 leading-ui outline-none placeholder:text-muted focus-visible:border-accent"
        />
        <div role="group" aria-label="Filter by topic" className="mt-3 flex flex-wrap gap-2">
          {TOPICS.filter((t) => t.id !== "uploads" || hasUploads).map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={topic === t.id}
              onClick={() => setTopic(t.id)}
              className="min-h-(--spacing-touch) rounded-full border border-control px-4 text-small hover:border-accent focus-visible:outline-2 focus-visible:outline-accent aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:font-medium md:min-h-9"
            >
              {t.label}
            </button>
          ))}
        </div>

        <p className="sr-only" aria-live="polite">
          {papers ? `${shown.length} papers` : ""}
        </p>

        {failed ? (
          <div role="alert" className="mt-8 rounded-(--radius-card) bg-surface p-4">
            <p>The library couldn't be loaded. Please try again.</p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 min-h-(--spacing-touch) rounded-control border border-control px-4 text-small font-medium hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              Try again
            </button>
          </div>
        ) : !papers ? (
          <div className="mt-8 space-y-3" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className="mt-8 text-muted">No papers match. Try another word or topic.</p>
        ) : (
          <ul className="mt-6 space-y-3">
            {shown.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpen(p.id)}
                  className="w-full rounded-(--radius-card) bg-surface p-4 text-left transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className="block font-serif text-h3 leading-snug">{p.title}</span>
                  <span className="mt-1 block text-small text-muted">
                    {[authorLine(p.authors), p.year].filter(Boolean).join(" · ")}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-2">
                    {p.upload ? <Badge tone="muted">Your upload · unverified</Badge> : <Badge>Curated</Badge>}
                    {topicLabel(p.topic) && <Badge tone="muted">{topicLabel(p.topic)}</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function PaperView({
  id,
  onBack,
  onAsk,
}: {
  id: string;
  onBack: () => void;
  onAsk: (question: string) => void;
}) {
  const [detail, setDetail] = useState<PaperDetail | null>(null);
  const [failed, setFailed] = useState(false);
  // The parent keys this view by paper ID, so state starts fresh for each paper.
  useEffect(() => {
    getPaper(id).then(setDetail, () => setFailed(true));
  }, [id]);

  const p = detail?.paper;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto w-full max-w-(--spacing-column) px-4 py-6 md:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 inline-flex min-h-(--spacing-touch) items-center gap-1 rounded-control px-2 text-small text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          ← Library
        </button>
        {failed ? (
          <p role="alert" className="mt-6">
            This paper isn't available.
          </p>
        ) : !p ? (
          <div className="mt-6 space-y-3" aria-hidden="true">
            <Skeleton className="h-8 w-10/12" />
            <Skeleton className="h-4 w-6/12" />
            <Skeleton className="mt-6 h-32 w-full" />
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2">
              {p.upload ? <Badge tone="muted">Your upload · unverified</Badge> : <Badge>Curated</Badge>}
              {topicLabel(p.topic) && <Badge tone="muted">{topicLabel(p.topic)}</Badge>}
            </div>
            <h1 className="mt-3 font-serif text-h2 leading-snug">{p.title}</h1>
            <p className="mt-2 text-muted">{p.authors.join(", ")}</p>
            <p className="mt-1 text-small text-muted">
              {[p.journal, p.year, p.pages ? `${p.pages} pages` : null, p.license?.toUpperCase()]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-5">
              {p.doi && (
                <a
                  href={doiUrl(p.doi)}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex min-h-(--spacing-touch) items-center gap-1 text-small underline decoration-accent underline-offset-2 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  doi.org/{p.doi}
                  <Icon name="external" className="size-4" />
                </a>
              )}
              {p.sourceUrl && (
                <a
                  href={p.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex min-h-(--spacing-touch) items-center gap-1 text-small underline decoration-accent underline-offset-2 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Open the PDF
                  <Icon name="external" className="size-4" />
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={() => onAsk(`What are the main findings of "${p.title}"?`)}
              className="mt-4 inline-flex min-h-(--spacing-touch) items-center gap-2 rounded-control border border-accent bg-accent-soft px-4 font-medium hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Icon name="chat" className="size-4" />
              Ask about this paper
            </button>

            {detail.summary && (
              <section className="mt-8">
                <h2 className="text-h3 font-semibold">
                  {detail.summary.name === "Front matter" ? "Opening" : detail.summary.name}
                </h2>
                <p className="mt-2 leading-answer whitespace-pre-line">{detail.summary.text}</p>
              </section>
            )}
            {detail.sections.length > 1 && (
              <section className="mt-8">
                <h2 className="text-h3 font-semibold">Sections</h2>
                <ol className="mt-2 space-y-1">
                  {detail.sections.map((s, i) => (
                    <li key={i} className="flex justify-between gap-4 text-small">
                      <span>{s.name}</span>
                      <span className="shrink-0 text-muted">
                        {s.pageStart === s.pageEnd ? `p. ${s.pageStart}` : `pp. ${s.pageStart}–${s.pageEnd}`}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </article>
    </div>
  );
}
