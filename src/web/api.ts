/** Client for POST /api/chat (Server-Sent Events over fetch, since EventSource can't POST) and feedback. */

export interface Source {
  n: number;
  paperId: string;
  title: string;
  year: number | null;
  doi: string | null;
  authors: string[];
  section: string;
  pageStart: number;
  pageEnd: number;
  /** Stored passage text from D1, never model text. */
  text: string;
  upload: boolean;
}

export interface Done {
  chatId: string;
  messageId: string;
  status: "ok" | "declined" | "unverified" | "error";
  notFound: boolean;
  cached: boolean;
  content: string;
  sources: Source[];
}

export type ChatEvent =
  | { type: "status"; step: "searching" | "writing" }
  | { type: "token"; text: string }
  | { type: "replace"; text: string }
  | ({ type: "done" } & Done)
  | { type: "error"; message: string };

/** Thrown for HTTP failures before the stream starts; `status` drives the UI state (429 → rate limited). */
export class ChatHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** Incremental SSE parser: feed text chunks, get complete events. Only `data:` lines matter (each holds JSON). */
export function sseParser(onEvent: (e: ChatEvent) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk.replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as ChatEvent);
      } catch {
        // ignore a malformed event rather than breaking the whole answer
      }
    }
  };
}

export async function askQuestion(
  body: { question: string; chatId?: string },
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal,
  });
  if (!res.ok || !res.body) throw new ChatHttpError(res.status);
  const feed = sseParser(onEvent);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    feed(value);
  }
}

export async function sendFeedback(messageId: string, value: 1 | -1 | 0) {
  await fetch(`/api/messages/${encodeURIComponent(messageId)}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
    credentials: "same-origin",
  });
}

/** DOI links are built here from the stored DOI, never taken from model output (SECURITY §7.3). */
export const doiUrl = (doi: string) => `https://doi.org/${encodeURIComponent(doi).replace(/%2F/g, "/")}`;

// ---------------------------------------------------------------- history and library (P6)

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: Done["status"];
  feedback: 1 | -1 | 0;
  createdAt: number;
  sources?: Source[];
}
export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  doi: string | null;
  license: string | null;
  sourceUrl: string | null;
  topic: string | null;
  pages: number | null;
  upload: boolean;
  verified: boolean;
}
export interface PaperDetail {
  paper: Paper;
  summary: { name: string; text: string } | null;
  sections: { name: string; pageStart: number; pageEnd: number }[];
}

/** JSON request; state-changing calls need the JSON content type for the server's CSRF guard. */
async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new ChatHttpError(res.status);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const listChats = () => json<{ chats: ChatSummary[] }>("/api/chats").then((r) => r.chats);
export const getChat = (id: string) =>
  json<{ chat: { id: string; title: string }; messages: StoredMessage[] }>(
    `/api/chats/${encodeURIComponent(id)}`,
  );
export const renameChat = (id: string, title: string) =>
  json<void>(`/api/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
export const deleteChat = (id: string) =>
  json<void>(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
export const listPapers = () => json<{ papers: Paper[] }>("/api/papers").then((r) => r.papers);
export const getPaper = (id: string) => json<PaperDetail>(`/api/papers/${encodeURIComponent(id)}`);
