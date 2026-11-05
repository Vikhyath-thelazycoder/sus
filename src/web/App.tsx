import { useCallback, useEffect, useRef, useState } from "react";
import { ChatHttpError, askQuestion, sendFeedback, type ChatEvent, type Source } from "./api";
import { CitationPanel } from "./CitationPanel";
import { Conversation, type Turn } from "./Conversation";
import { Icon, IconButton } from "./ui";

interface Chat {
  localId: string;
  /** Server chat ID, known after the first answer. */
  chatId?: string;
  title: string;
  turns: Turn[];
}

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

const DRAWER =
  "motion-drawer fixed inset-y-0 left-0 z-40 flex w-[min(85vw,var(--spacing-sidebar))] flex-col bg-surface shadow-sm lg:hidden"; // taste-skill-ignore: a real overlay

const newChat = (): Chat => ({ localId: crypto.randomUUID(), title: "New chat", turns: [] });

/**
 * App shell (T-5.2): history sidebar (full ≥ 1024 px, icon rail 768–1023 px, drawer on phones), header, answer column
 * and the citation panel. Saved history from earlier visits arrives in P6; this session's chats are listed here.
 */
export function App() {
  const [chats, setChats] = useState<Chat[]>(() => [newChat()]);
  const [activeId, setActiveId] = useState(() => chats[0]!.localId);
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
      title: c.turns.length ? c.title : question.slice(0, 60),
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

  const startNewChat = () => {
    setCitation(null);
    setDrawer(false);
    if (!active.turns.length) return;
    const c = newChat();
    setChats((cs) => [c, ...cs]);
    setActiveId(c.localId);
  };
  const openChat = (localId: string) => {
    setActiveId(localId);
    setCitation(null);
    setDrawer(false);
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

  const history = chats.filter((c) => c.turns.length);
  const historyList = (
    <nav aria-label="Chat history" className="min-h-0 flex-1 overflow-y-auto px-2">
      {history.length === 0 ? (
        <p className="px-2 py-2 text-small text-muted">Your chats from this visit appear here.</p>
      ) : (
        <ul className="space-y-0.5">
          {history.map((c) => (
            <li key={c.localId}>
              <button
                type="button"
                onClick={() => openChat(c.localId)}
                aria-current={c.localId === activeId ? "page" : undefined}
                className="flex min-h-10 w-full items-center rounded-control px-2 text-left text-small hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:bg-accent-soft aria-[current=page]:font-medium"
              >
                <span className="truncate">{c.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
  const newChatButton = (
    <button
      type="button"
      onClick={startNewChat}
      className="mx-2 mb-3 flex min-h-(--spacing-touch) items-center gap-2 rounded-control border border-control bg-surface px-3 text-small font-medium hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Icon name="plus" className="size-4" />
      New chat
    </button>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-text">
      {/* Full sidebar ≥ 1024 px */}
      <aside className="hidden w-(--spacing-sidebar) shrink-0 flex-col bg-surface lg:flex">
        <p className="px-4 pt-5 pb-4 font-semibold tracking-tight">SustainIQ</p>
        {newChatButton}
        {historyList}
      </aside>
      {/* Icon rail 768–1023 px */}
      <aside className="hidden w-(--spacing-rail) shrink-0 flex-col items-center gap-1 bg-surface pt-3 md:flex lg:hidden">
        <IconButton ref={railMenu} label="Open chat history" icon="menu" onClick={() => setDrawer(true)} />
        <IconButton label="New chat" icon="plus" onClick={startNewChat} />
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
            {newChatButton}
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
            <span className="hidden md:inline">
              {active.turns.length ? active.title : "Research assistant for sustainable materials"}
            </span>
          </p>
          <IconButton label="New chat" icon="plus" className="md:hidden" onClick={startNewChat} />
          <IconButton
            label={`Switch to ${effectiveTheme() === "dark" ? "light" : "dark"} theme`}
            icon={effectiveTheme() === "dark" ? "sun" : "moon"}
            onClick={toggleTheme}
          />
        </header>
        <main className="flex min-h-0 flex-1 flex-col">
          <Conversation
            turns={active.turns}
            busy={busy}
            onAsk={(q) => void ask(q)}
            onRetry={retry}
            onCite={openCitation}
            onFeedback={feedback}
          />
        </main>
      </div>

      {citation && <CitationPanel source={citation} onClose={closeCitation} />}
    </div>
  );
}
