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
