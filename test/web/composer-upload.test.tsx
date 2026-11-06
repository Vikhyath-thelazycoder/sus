import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Conversation } from "../../src/web/Conversation";
import { UploadFailed } from "../../src/web/upload/client";
import type { ParsedUpload } from "../../src/web/upload/parse";
import type { UploadDeps } from "../../src/web/upload/useAttachments";

/** Upload from the chat box (ChatGPT/Claude style): + → chip with progress → ready → sent with the question. */
const parsed: ParsedUpload = {
  title: "Heart disease prediction with ML",
  pages: 4,
  sections: [{ name: "Body", text: "x", pageStart: 1, pageEnd: 4 }],
  chunks: Array.from({ length: 18 }, (_, idx) => ({
    sectionIdx: 0,
    idx,
    text: "t",
    pageStart: 1,
    pageEnd: 1,
  })),
  unclearPages: [],
};
const pdf = (name = "scan.pdf", type = "application/pdf") => new File(["%PDF-1.7"], name, { type });

afterEach(cleanup);

const CHAT = "c0c0c0c0-0000-4000-8000-000000000000";

function setup(over: Partial<UploadDeps> = {}, useLibrary?: boolean, files?: string[]) {
  const onAsk = vi.fn();
  const chatId = vi.fn(async () => CHAT);
  const onUseLibrary = vi.fn();
  const deps: UploadDeps = {
    parse: async (_f, step) => (step("ocr", 2, 4), parsed),
    send: async (_p, progress) => (progress(18, 18), "p_" + "a".repeat(24)),
    remove: vi.fn(async () => {}),
    ...over,
  };
  render(
    <Conversation
      turns={[]}
      busy={false}
      onAsk={onAsk}
      onRetry={vi.fn()}
      onCite={vi.fn()}
      onFeedback={vi.fn()}
      chatId={chatId}
      useLibrary={useLibrary}
      files={files}
      onUseLibrary={onUseLibrary}
      uploadDeps={deps}
    />,
  );
  const user = userEvent.setup({ applyAccept: false }); // test our own type check, not the picker filter
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  return { onAsk, deps, user, input, chatId, onUseLibrary };
}

describe("upload from the chat box", () => {
  it("a new chat centres the greeting, the question box with a + button, and suggestions", () => {
    setup();
    expect(screen.getByRole("heading", { name: "What would you like to research?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a PDF" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Suggested questions" })).toBeTruthy();
  });

  it("attaches a PDF, shows it ready, and sends its title with the question", async () => {
    const { user, input, onAsk } = setup();
    await user.upload(input, pdf());
    const chips = await screen.findByRole("list", { name: "Attached PDFs" });
    await within(chips).findByText("Ready · 4 pages");
    expect(within(chips).getByText("Heart disease prediction with ML")).toBeTruthy();
    expect(screen.getByText(/Don't upload confidential documents/)).toBeTruthy();
    await user.type(screen.getByLabelText("Your question"), "What accuracy did they get?{Enter}");
    expect(onAsk).toHaveBeenCalledWith("What accuracy did they get?", ["Heart disease prediction with ML"]);
    expect(screen.queryByRole("list", { name: "Attached PDFs" })).toBeNull();
  });

  it("shows OCR progress and blocks sending until the PDF is indexed", async () => {
    let finish!: (id: string) => void;
    const { user, input } = setup({
      send: (_p, progress) => {
        progress(5, 18);
        return new Promise<string>((r) => (finish = r));
      },
    });
    await user.upload(input, pdf());
    await screen.findByText("Indexing 5 of 18…");
    await user.type(screen.getByLabelText("Your question"), "Summarise it");
    expect((screen.getByRole("button", { name: "Send question" }) as HTMLButtonElement).disabled).toBe(true);
    finish("p_" + "b".repeat(24));
    await screen.findByText("Ready · 4 pages");
    expect((screen.getByRole("button", { name: "Send question" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("removing a ready PDF before sending deletes the upload", async () => {
    const { user, input, deps } = setup();
    await user.upload(input, pdf());
    await screen.findByText("Ready · 4 pages");
    await user.click(screen.getByRole("button", { name: "Remove Heart disease prediction with ML" }));
    expect(deps.remove).toHaveBeenCalledWith("p_" + "a".repeat(24));
    expect(screen.queryByRole("list", { name: "Attached PDFs" })).toBeNull();
  });

  it("explains failures in plain words: not a PDF, no text, paused", async () => {
    const { user, input } = setup({ parse: async () => Promise.reject(new UploadFailed("scanned")) });
    await user.upload(input, pdf("notes.txt", "text/plain"));
    await screen.findByText("That file isn't a PDF.");
    await user.upload(input, pdf());
    await screen.findByText(/No readable text was found/);
    cleanup();
    const s = setup({ send: async () => Promise.reject(new UploadFailed("paused")) });
    await s.user.upload(s.input, pdf());
    await screen.findByText(/Uploads are paused/);
  });

  it("uploads into this chat (T-7.11)", async () => {
    const send = vi.fn(async () => "p_" + "a".repeat(24));
    const { user, input, chatId } = setup({ send });
    await user.upload(input, pdf());
    await screen.findByText("Ready · 4 pages");
    expect(chatId).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(parsed, expect.any(Function), CHAT);
  });

  it("'Use the library' is on without a PDF, off once one is attached, and the user can flip it (T-7.12)", async () => {
    const { user, input, onUseLibrary } = setup();
    const toggle = screen.getByRole("switch", { name: "Use the library" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.upload(input, pdf());
    await screen.findByText("Ready · 4 pages");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);
    expect(onUseLibrary).toHaveBeenCalledWith(true);
  });

  it("picking 3 PDFs at once attaches all 3, each with its own progress (T-7.14)", async () => {
    const send = vi.fn(async (p: ParsedUpload) => "p_" + p.title.slice(-1).repeat(24));
    const { user, input } = setup({
      parse: async (f, step) => (step("reading", 0, 0), { ...parsed, title: `Paper ${f.name[0]}` }),
      send,
    });
    await user.upload(input, [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]);
    const chips = await screen.findByRole("list", { name: "Attached PDFs" });
    await within(chips).findByText("Paper c");
    expect(within(chips).getAllByText("Ready · 4 pages")).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("reads several PDFs one at a time; the others wait (T-7.14)", async () => {
    const started: string[] = [];
    const gates: (() => void)[] = [];
    const { user, input } = setup({
      parse: (f) => {
        started.push(f.name);
        return new Promise((r) => gates.push(() => r(parsed)));
      },
    });
    await user.upload(input, [pdf("a.pdf"), pdf("b.pdf")]);
    expect(await screen.findAllByText("Waiting…")).toHaveLength(1);
    expect(started).toEqual(["a.pdf"]);
    gates[0]!();
    await vi.waitFor(() => expect(started).toEqual(["a.pdf", "b.pdf"]));
    gates[1]!();
    await vi.waitFor(() => expect(screen.getAllByText("Ready · 4 pages")).toHaveLength(2));
  });

  it("lists the chat's PDFs above the question box (T-7.14)", () => {
    setup({}, undefined, ["Paper one", "Paper two"]);
    const list = screen.getByRole("list", { name: "PDFs in this chat" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("switch", { name: "Use the library" }).getAttribute("aria-checked")).toBe("false");
  });

  it("warns on the chip when OCR read a page badly (T-7.10)", async () => {
    const { user, input } = setup({ parse: async () => ({ ...parsed, unclearPages: [2, 3] }) });
    await user.upload(input, pdf());
    await screen.findByText("Pages 2, 3 may be misread (unclear scan).");
  });

  it("an explicit choice wins over the default", () => {
    setup({}, false);
    expect(screen.getByRole("switch", { name: "Use the library" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("upload from the Library (T-7.13)", () => {
  it("uploads with no chat, then refreshes the list so it shows as Your upload", async () => {
    const { Library } = await import("../../src/web/pages/Library");
    const mine = { id: "p_" + "a".repeat(24), title: "My PHA notes", authors: [], year: null, journal: null, topic: null, upload: true, pages: 4 };
    let listed: unknown[] = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ papers: listed }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const send = vi.fn(async () => ((listed = [mine]), mine.id));
    render(<Library onOpen={vi.fn()} uploadDeps={{ parse: async () => parsed, send, remove: vi.fn(async () => {}) }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Upload a PDF" }));
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, pdf());
    await screen.findByText("My PHA notes");
    expect(send).toHaveBeenCalledWith(parsed, expect.any(Function), undefined);
    expect(screen.getByText("Your upload · unverified")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
