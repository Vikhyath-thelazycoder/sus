import { useCallback, useRef, useState } from "react";
import { UPLOAD } from "../../shared/limits";
import { deleteUpload } from "../api";
import { parseInWorker, sendUpload, UploadFailed, type UploadFailure, type UploadStep } from "./client";

/** PDFs attached in the chat box (ChatGPT/Claude style): each one is parsed, indexed and then usable in answers. */
export type Attachment = { id: string; name: string } & (
  | { state: "working"; step: UploadStep; done: number; total: number }
  | { state: "ready"; paperId: string; title: string; pages: number }
  | { state: "error"; reason: UploadFailure }
);

export interface UploadDeps {
  parse: typeof parseInWorker;
  send: typeof sendUpload;
  remove: (paperId: string) => Promise<void>;
}
const DEFAULT_DEPS: UploadDeps = { parse: parseInWorker, send: sendUpload, remove: deleteUpload };

/** `chatId` gives the chat the PDFs belong to, creating it on the first attachment (T-7.11). */
export function useAttachments(chatId: () => Promise<string>, deps: UploadDeps = DEFAULT_DEPS) {
  const [items, setItems] = useState<Attachment[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  const set = (id: string, next: Partial<Attachment> & Pick<Attachment, "state">) =>
    setItems((xs) => xs.map((x) => (x.id === id ? ({ ...x, ...next } as Attachment) : x)));

  const add = useCallback(
    async (file: File) => {
      const id = crypto.randomUUID();
      const fail = (reason: UploadFailure) => set(id, { state: "error", reason });
      setItems((xs) => [
        ...xs,
        { id, name: file.name, state: "working", step: "reading", done: 0, total: 0 },
      ]);
      // Client-side checks first (SECURITY §9); the server checks everything again.
      if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return fail("type");
      if (file.size > UPLOAD.maxFileBytes) return fail("too-big");
      const abort = new AbortController();
      aborts.current.set(id, abort);
      const progress = (step: UploadStep, done = 0, total = 0) => {
        if (!abort.signal.aborted) set(id, { state: "working", step, done, total });
      };
      try {
        const parsed = await deps.parse(file, progress, undefined, abort.signal);
        if (abort.signal.aborted) return;
        progress("indexing", 0, parsed.chunks.length);
        const paperId = await deps.send(parsed, (d, t) => progress("indexing", d, t), await chatId());
        // Removed while it was indexing: give the quota back.
        if (abort.signal.aborted) return void deps.remove(paperId).catch(() => {});
        set(id, { state: "ready", paperId, title: parsed.title, pages: parsed.pages });
      } catch (err) {
        if (!abort.signal.aborted) fail(err instanceof UploadFailed ? err.reason : "network");
      } finally {
        aborts.current.delete(id);
      }
    },
    [deps, chatId],
  );

  /** Remove before sending: cancels a running upload, or deletes a finished one (like discarding an attachment). */
  const remove = (a: Attachment) => {
    aborts.current.get(a.id)?.abort();
    if (a.state === "ready") void deps.remove(a.paperId).catch(() => {});
    setItems((xs) => xs.filter((x) => x.id !== a.id));
  };

  /** After a question is sent, finished attachments stay with the chat; the chips leave the composer. */
  const take = () => {
    const ready = items.filter((x): x is Extract<Attachment, { state: "ready" }> => x.state === "ready");
    setItems((xs) => xs.filter((x) => x.state === "working"));
    return ready.map((r) => r.title);
  };

  return { items, add, remove, take, working: items.some((x) => x.state === "working") };
}
