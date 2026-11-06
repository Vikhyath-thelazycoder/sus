import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteMyData,
  deleteUpload,
  doiUrl,
  getPaper,
  listPapers,
  type Paper,
  type PaperDetail,
} from "../api";
import { Badge, Icon, Skeleton } from "../ui";
import { UPLOAD } from "../../shared/limits";
import { AttachmentChip } from "../Conversation";
import { useAttachments, type UploadDeps } from "../upload/useAttachments";

/** Library uploads belong to no chat (T-7.13). */
const NO_CHAT = async () => undefined;

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

export function Library({ onOpen, uploadDeps }: { onOpen: (id: string) => void; uploadDeps?: UploadDeps }) {
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<TopicId>("all");

  const load = () => listPapers().then(setPapers, () => setFailed(true));
  useEffect(() => void load(), []);
  const uploads = useAttachments(NO_CHAT, uploadDeps);
  const fileInput = useRef<HTMLInputElement>(null);
  const anyReady = uploads.items.some((a) => a.state === "ready");
  // A finished upload leaves the chips and shows up in the list as "Your upload".
  useEffect(() => {
    if (!anyReady) return;
    uploads.take();
    void load();
  }, [anyReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => {
    setFailed(false);
    void load();
  };

  const shown = useMemo(() => (papers ?? []).filter((p) => matches(p, query, topic)), [papers, query, topic]);
  const hasUploads = papers?.some((p) => p.upload);
  const mine = (papers ?? []).filter((p) => p.upload);
  const used = { pdfs: mine.length, pages: mine.reduce((n, p) => n + (p.pages ?? 0), 0) };
  const [wipe, setWipe] = useState<"idle" | "busy" | "failed">("idle");
  async function wipeAll() {
    if (!window.confirm("Delete all your uploads and chat history? This can't be undone.")) return;
    setWipe("busy");
    try {
      await deleteMyData();
      window.location.reload(); // the history sidebar and open chat go too
    } catch {
      setWipe("failed");
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-(--spacing-column) px-4 py-8 md:px-6">
        <h1 className="text-h2 font-semibold">Library</h1>
        <p className="mt-1 text-muted">
          The open-access papers answers come from{hasUploads ? ", plus your uploads" : ""}.
        </p>

        <p className="mt-3 text-small text-muted">
          {used.pdfs
            ? `Your uploads: ${used.pdfs} of ${UPLOAD.maxPdfs} PDFs, ${used.pages} of ${UPLOAD.maxPages} pages. `
            : ""}
          PDFs uploaded here are used in every chat with "Use the library" on; a PDF added with + in a chat stays in
          that chat. Only you can see them; they're deleted after 7 days. Don't upload confidential documents.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            for (const f of Array.from(e.target.files ?? [])) void uploads.add(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="mt-3 inline-flex min-h-(--spacing-touch) items-center gap-2 rounded-control border border-control px-4 text-small font-medium hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Icon name="plus" className="size-4" />
          Upload a PDF
        </button>
        {uploads.items.length > 0 && (
          <ul aria-label="Uploading PDFs" aria-live="polite" className="mt-3 flex flex-wrap gap-2">
            {uploads.items.map((a) => (
              <AttachmentChip key={a.id} a={a} onRemove={() => uploads.remove(a)} />
            ))}
          </ul>
        )}

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

        <section aria-labelledby="your-data" className="mt-16">
          <h2 id="your-data" className="text-h3 font-semibold">
            Your data
          </h2>
          <p className="mt-1 text-small text-muted">
            Removes every PDF you uploaded and all your saved chats from this demo, straight away.
          </p>
          <button
            type="button"
            onClick={() => void wipeAll()}
            disabled={wipe === "busy"}
            className="mt-3 min-h-(--spacing-touch) rounded-control border border-control px-4 text-small font-medium text-danger hover:border-danger focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {wipe === "busy" ? "Deleting…" : "Delete my uploads and history"}
          </button>
          {wipe === "failed" && (
            <p role="alert" className="mt-2 text-small">
              That didn't work. Please try again.
            </p>
          )}
        </section>
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
  const [deleting, setDeleting] = useState<"idle" | "busy" | "failed">("idle");
  async function remove(title: string) {
    if (!window.confirm(`Delete "${title}"? It will no longer be used in your answers.`)) return;
    setDeleting("busy");
    try {
      await deleteUpload(id);
      onBack();
    } catch {
      setDeleting("failed");
    }
  }
  // The parent keys this view by paper ID, so state starts fresh for each paper.
  useEffect(() => {
    getPaper(id).then(setDetail, () => setFailed(true));
  }, [id]);

  const p = detail?.paper;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto w-full max-w-(--spacing-column) px-4 py-6 md:px-6">
        {failed ? (
          <p role="alert" className="mt-2">
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
            <div className="flex flex-wrap gap-2">
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
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onAsk(`What are the main findings of "${p.title}"?`)}
                className="inline-flex min-h-(--spacing-touch) items-center gap-2 rounded-control border border-accent bg-accent-soft px-4 font-medium hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <Icon name="chat" className="size-4" />
                Ask about this paper
              </button>
              {p.upload && (
                <button
                  type="button"
                  onClick={() => void remove(p.title)}
                  disabled={deleting === "busy"}
                  className="inline-flex min-h-(--spacing-touch) items-center gap-2 rounded-control border border-control px-4 text-small font-medium text-danger hover:border-danger focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  <Icon name="trash" className="size-4" />
                  {deleting === "busy" ? "Deleting…" : "Delete this upload"}
                </button>
              )}
            </div>
            {deleting === "failed" && (
              <p role="alert" className="mt-2 text-small">
                The upload couldn't be deleted. Please try again.
              </p>
            )}

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
