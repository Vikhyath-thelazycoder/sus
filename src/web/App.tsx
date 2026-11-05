import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChatHttpError,
  askQuestion,
  deleteChat,
  getChat,
  listChats,
  renameChat,
  sendFeedback,
  type ChatEvent,
  type ChatSummary,
  type Source,
  type StoredMessage,
} from "./api";
import { CitationPanel } from "./CitationPanel";
import { Conversation, type Turn } from "./Conversation";
import { Library, PaperView } from "./pages/Library";
import { Icon, IconButton } from "./ui";

interface Chat {
  localId: string;
  /** Server chat ID, known after the first answer. */
  chatId?: string;
  title: string;
  turns: Turn[];
  loading?: boolean;
  failed?: boolean;
}

type View = { kind: "chat" } | { kind: "library" } | { kind: "paper"; id: string };
type Theme = "light" | "dark";
const THEME_KEY = "sustainiq-theme"; // UI preference only (SECURITY §9)

function readTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** Hash routes keep the back button working without a router: #/library and #/library/<paper id>. */
export function parseHash(hash: string): View {
  const m = hash.match(/^#\/library(?:\/(p_[0-9a-f]{24}))?$/);
  if (!m) return { kind: "chat" };
  return m[1] ? { kind: "paper", id: m[1] } : { kind: "library" };
}

const DRAWER =
  "motion-drawer fixed inset-y-0 left-0 z-40 flex w-[min(85vw,var(--spacing-sidebar))] flex-col bg-surface shadow-sm lg:hidden"; // taste-skill-ignore: a real overlay

const newChat = (): Chat => ({ localId: crypto.randomUUID(), title: "New chat", turns: [] });
const NOT_FOUND = /couldn['’]t find this in the papers/i;

/** Rebuild view turns from stored messages: each user message starts a turn, the next assistant message completes it. */
export function turnsFromMessages(chatId: string, messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      turns.push({ id: m.id, question: m.content, text: "", step: null, state: "done", feedback: 0 });
      continue;
    }
    const t = turns.at(-1);
    if (!t || t.done) continue;
    const sources = m.sources ?? [];
    t.text = m.content;
    t.feedback = m.feedback;
    if (m.status === "error") Object.assign(t, { state: "error", error: "busy" });
    else
      t.done = {
        chatId,
        messageId: m.id,
        status: m.status,
        notFound: m.status === "unverified" || (!sources.length && NOT_FOUND.test(m.content)),
        cached: false,
        content: m.content,
        sources,
      };
  }
  // A question saved without an answer (e.g. the tab closed mid-stream) shows as a failed turn to retry.
  return turns.map((t) => (t.done || t.state === "error" ? t : { ...t, state: "error", error: "failed" }));
}

/** Today / Yesterday / Previous 7 days / Older, by last activity. */
export function groupByDate(
  items: ChatSummary[],
  now = Date.now(),
): { label: string; items: ChatSummary[] }[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const bucket = (t: number) =>
    t >= +start
      ? "Today"
      : t >= +start - day
        ? "Yesterday"
        : t >= +start - 7 * day
          ? "Previous 7 days"
          : "Older";
  const order = ["Today", "Yesterday", "Previous 7 days", "Older"];
  return order
    .map((label) => ({ label, items: items.filter((i) => bucket(i.updatedAt) === label) }))
    .filter((g) => g.items.length);
}

/**
 * App shell: history sidebar (full ≥ 1024 px, icon rail 768–1023 px, drawer on phones), header, the chat or the
 * library, and the citation panel. History is loaded from the API (T-6.4).
 */
export function App() {
  const [chats, setChats] = useState<Chat[]>(() => [newChat()]);
  const [activeId, setActiveId] = useState(() => chats[0]!.localId);
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => parseHash(location.hash));
  const [citation, setCitation] = useState<Source | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(readTheme);
  const opener = useRef<HTMLElement | null>(null);
  const railMenu = useRef<HTMLButtonElement>(null);
  const headerMenu = useRef<HTMLButtonElement>(null);
  /** Return focus to whichever menu button is visible at this width. */
  const focusMenuButton = () => (railMenu.current?.offsetParent ? railMenu : headerMenu).current?.focus();

  const active = chats.find((c) => c.localId === activeId)!;
  const busy = active.turns.at(-1)?.state === "streaming";

  const refreshHistory = useCallback(() => {
    listChats().then(setHistory, () => {});
  }, []);
  useEffect(refreshHistory, [refreshHistory]);

  useEffect(() => {
    // Back/forward between #/library, #/library/<id> and the chat.
    const on = () => setView(parseHash(window.location.hash));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = (hash: string) => {
    if (window.location.hash !== hash) window.history.pushState(null, "", hash || window.location.pathname);
    setView(parseHash(hash));
    setCitation(null);
    setDrawer(false);
  };

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);

  const effectiveTheme = (): Theme =>
    theme ?? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const toggleTheme = () => {
    const next: Theme = effectiveTheme() === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // private mode: the toggle still works for this visit
    }
  };

  const updateChat = useCallback(
    (localId: string, fn: (c: Chat) => Chat) =>
      setChats((cs) => cs.map((c) => (c.localId === localId ? fn(c) : c))),
    [],
  );
  const updateTurn = useCallback(
    (localId: string, turnId: string, fn: (t: Turn) => Turn) =>
      updateChat(localId, (c) => ({ ...c, turns: c.turns.map((t) => (t.id === turnId ? fn(t) : t)) })),
    [updateChat],
  );

  const ask = async (question: string, chat: Chat = active) => {
    const turn: Turn = {
      id: crypto.randomUUID(),
      question,
      text: "",
      step: "searching",
      state: "streaming",
      feedback: 0,
    };
    updateChat(chat.localId, (c) => ({
      ...c,
      title: c.turns.length ? c.title : question.slice(0, 80),
      turns: [...c.turns, turn],
    }));
    const on = (e: ChatEvent) =>
      updateTurn(chat.localId, turn.id, (t) => {
        switch (e.type) {
          case "status":
            return { ...t, step: e.step };
          case "token":
            return { ...t, text: t.text + e.text };
          case "replace":
            return { ...t, text: e.text };
          case "error":
            return { ...t, state: "error", error: "failed" };
          case "done":
            if (e.status === "error") return { ...t, state: "error", error: "busy" };
            return { ...t, state: "done", step: null, text: e.content, done: e };
        }
      });
    try {
      let chatId = chat.chatId;
      await askQuestion({ question, ...(chatId ? { chatId } : {}) }, (e) => {
        if (e.type === "done" && !chatId) {
          chatId = e.chatId;
          updateChat(chat.localId, (c) => ({ ...c, chatId: e.chatId }));
        }
        on(e);
      });
      // A stream that ends without "done" (connection dropped) is a failure.
      updateTurn(chat.localId, turn.id, (t) =>
        t.state === "streaming" ? { ...t, state: "error", error: "failed" } : t,
      );
    } catch (err) {
      const error =
        err instanceof ChatHttpError && err.status === 429
          ? "rate_limited"
          : err instanceof ChatHttpError && err.status === 503
            ? "busy"
            : "failed";
      updateTurn(chat.localId, turn.id, (t) => ({ ...t, state: "error", error }));
    }
    refreshHistory();
  };

  const retry = (turn: Turn) => {
    updateChat(active.localId, (c) => ({ ...c, turns: c.turns.filter((t) => t.id !== turn.id) }));
    void ask(turn.question);
  };

  const feedback = (turn: Turn, value: 1 | -1 | 0) => {
    if (!turn.done) return;
    updateTurn(active.localId, turn.id, (t) => ({ ...t, feedback: value }));
    void sendFeedback(turn.done.messageId, value).catch(() => {});
  };

  const openCitation = (source: Source, el: HTMLElement) => {
    opener.current = el;
    setCitation(source);
  };
  const closeCitation = useCallback(() => {
    setCitation(null);
    opener.current?.focus();
  }, []);

  /** Switch to an empty chat (reusing the current one if it is already empty). Returns it so callers can ask in it. */
  const startNewChat = (): Chat => {
    go("");
    if (!active.turns.length && !active.chatId) return active;
    const c = newChat();
    setChats((cs) => [c, ...cs]);
    setActiveId(c.localId);
    return c;
  };

  const openSaved = (summary: ChatSummary) => {
    go("");
    const known = chats.find((c) => c.chatId === summary.id);
    if (known) return setActiveId(known.localId);
    const c: Chat = {
      localId: crypto.randomUUID(),
      chatId: summary.id,
      title: summary.title,
      turns: [],
      loading: true,
    };
    setChats((cs) => [c, ...cs]);
    setActiveId(c.localId);
    getChat(summary.id).then(
      (r) =>
        updateChat(c.localId, (x) => ({
          ...x,
          title: r.chat.title,
          turns: turnsFromMessages(summary.id, r.messages),
          loading: false,
        })),
      () => updateChat(c.localId, (x) => ({ ...x, loading: false, failed: true })),
    );
  };

  const rename = async (summary: ChatSummary, title: string) => {
    setRenaming(null);
    const t = title.trim();
    if (!t || t === summary.title) return;
    setHistory((h) => h.map((x) => (x.id === summary.id ? { ...x, title: t } : x)));
    setChats((cs) => cs.map((c) => (c.chatId === summary.id ? { ...c, title: t } : c)));
    await renameChat(summary.id, t).catch(refreshHistory);
  };

  const remove = async (summary: ChatSummary) => {
    if (!window.confirm(`Delete "${summary.title}"? This can't be undone.`)) return;
    await deleteChat(summary.id).catch(() => {});
    setHistory((h) => h.filter((x) => x.id !== summary.id));
    if (active.chatId === summary.id) {
      const c = newChat();
      setChats((cs) => [c, ...cs.filter((x) => x.chatId !== summary.id)]);
      setActiveId(c.localId);
    } else setChats((cs) => cs.filter((x) => x.chatId !== summary.id));
  };

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawer(false);
        focusMenuButton();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // The open chat may not be in the server list yet (first answer still streaming).
  const pending =
    !active.chatId && active.turns.length
      ? [{ id: "", title: active.title, createdAt: 0, updatedAt: Number.POSITIVE_INFINITY }]
      : [];
  const groups = groupByDate([...pending, ...history]);
  const itemClass =
    "flex min-h-10 min-w-0 flex-1 items-center rounded-control px-2 text-left text-small hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent";

  const historyList = (
    <nav aria-label="Chat history" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      {groups.length === 0 ? (
        <p className="px-2 py-2 text-small text-muted">Your chats appear here.</p>
      ) : (
        groups.map((g) => (
          <div key={g.label} className="mb-3">
            <h2 className="px-2 pb-1 text-caption font-medium text-muted">{g.label}</h2>
            <ul className="space-y-0.5">
              {g.items.map((s) => {
                const current = view.kind === "chat" && (s.id ? active.chatId === s.id : !active.chatId);
                return (
                  <li
                    key={s.id || "pending"}
                    className={`flex items-center gap-0.5 rounded-control ${current ? "bg-accent-soft" : ""}`}
                  >
                    {renaming === s.id ? (
                      <input
                        aria-label="Chat title"
                        defaultValue={s.title}
                        maxLength={80}
                        autoFocus
                        onBlur={(e) => void rename(s, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void rename(s, e.currentTarget.value);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        className="min-h-10 min-w-0 flex-1 rounded-control border border-accent bg-surface px-2 text-small outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => s.id && openSaved(s)}
                        aria-current={current ? "page" : undefined}
                        className={`${itemClass} ${current ? "font-medium" : ""}`}
                      >
                        <span className="truncate">{s.title}</span>
                      </button>
                    )}
                    {current && s.id && renaming !== s.id && (
                      <>
                        <IconButton
                          label="Rename chat"
                          icon="edit"
                          className="size-9"
                          onClick={() => setRenaming(s.id)}
                        />
                        <IconButton
                          label="Delete chat"
                          icon="trash"
                          className="size-9"
                          onClick={() => void remove(s)}
                        />
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </nav>
  );

  const navButtons = (
    <div className="mx-2 mb-4 space-y-1">
      <button
        type="button"
        onClick={() => startNewChat()}
        className="flex min-h-(--spacing-touch) w-full items-center gap-2 rounded-control border border-control bg-surface px-3 text-small font-medium hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Icon name="plus" className="size-4" />
        New chat
      </button>
      <button
        type="button"
        onClick={() => go("#/library")}
        aria-current={view.kind !== "chat" ? "page" : undefined}
        className="flex min-h-(--spacing-touch) w-full items-center gap-2 rounded-control px-3 text-small hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:bg-accent-soft aria-[current=page]:font-medium"
      >
        <Icon name="library" className="size-4" />
        Library
      </button>
    </div>
  );

  const headerTitle =
    view.kind === "library"
      ? "Library"
      : view.kind === "paper"
        ? "Paper"
        : active.turns.length
          ? active.title
          : "Research assistant for sustainable materials";

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-text">
      {/* Full sidebar ≥ 1024 px */}
      <aside className="hidden w-(--spacing-sidebar) shrink-0 flex-col bg-surface lg:flex">
        <p className="px-4 pt-5 pb-4 font-semibold tracking-tight">SustainIQ</p>
        {navButtons}
        {historyList}
      </aside>
      {/* Icon rail 768–1023 px */}
      <aside className="hidden w-(--spacing-rail) shrink-0 flex-col items-center gap-1 bg-surface pt-3 md:flex lg:hidden">
        <IconButton ref={railMenu} label="Open chat history" icon="menu" onClick={() => setDrawer(true)} />
        <IconButton label="New chat" icon="plus" onClick={() => startNewChat()} />
        <IconButton
          label="Library"
          icon="library"
          aria-current={view.kind !== "chat" ? "page" : undefined}
          onClick={() => go("#/library")}
        />
      </aside>
      {/* Drawer below 1024 px */}
      {drawer && (
        <>
          <div
            className="motion-fade fixed inset-0 z-30 bg-text/20 lg:hidden"
            onClick={() => setDrawer(false)}
            aria-hidden="true"
          />
          <aside role="dialog" aria-modal="true" aria-label="Chat history" className={DRAWER}>
            <div className="flex items-center justify-between px-2 pt-2 pb-2">
              <p className="px-2 font-semibold tracking-tight">SustainIQ</p>
              <IconButton
                label="Close chat history"
                icon="close"
                autoFocus
                onClick={() => {
                  setDrawer(false);
                  focusMenuButton();
                }}
              />
            </div>
            {navButtons}
            {historyList}
          </aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-1 px-2 md:px-4">
          <IconButton
            ref={headerMenu}
            label="Open chat history"
            icon="menu"
            className="md:hidden"
            onClick={() => setDrawer(true)}
          />
          <p className="flex-1 truncate px-1 text-small text-muted">
            <span className="font-semibold text-text md:hidden">SustainIQ</span>
            <span className="hidden md:inline">{headerTitle}</span>
          </p>
          <IconButton label="Library" icon="library" className="md:hidden" onClick={() => go("#/library")} />
          <IconButton label="New chat" icon="plus" className="md:hidden" onClick={() => startNewChat()} />
          <IconButton
            label={`Switch to ${effectiveTheme() === "dark" ? "light" : "dark"} theme`}
            icon={effectiveTheme() === "dark" ? "sun" : "moon"}
            onClick={toggleTheme}
          />
        </header>
        <main className="flex min-h-0 flex-1 flex-col">
          {view.kind === "library" ? (
            <Library onOpen={(id) => go(`#/library/${id}`)} />
          ) : view.kind === "paper" ? (
            <PaperView
              key={view.id}
              id={view.id}
              onBack={() => go("#/library")}
              onAsk={(q) => {
                const c = startNewChat();
                void ask(q, c);
              }}
            />
          ) : active.loading ? (
            <p className="m-auto text-muted" role="status">
              Opening chat…
            </p>
          ) : active.failed ? (
            <p className="m-auto" role="alert">
              This chat couldn't be opened.
            </p>
          ) : (
            <Conversation
              turns={active.turns}
              busy={busy}
              onAsk={(q) => void ask(q)}
              onRetry={retry}
              onCite={openCitation}
              onFeedback={feedback}
            />
          )}
        </main>
      </div>

      {citation && <CitationPanel source={citation} onClose={closeCitation} />}
    </div>
  );
}
