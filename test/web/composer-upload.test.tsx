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
};
const pdf = (name = "scan.pdf", type = "application/pdf") => new File(["%PDF-1.7"], name, { type });

afterEach(cleanup);

const CHAT = "c0c0c0c0-0000-4000-8000-000000000000";

function setup(over: Partial<UploadDeps> = {}, useLibrary?: boolean) {
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

  it("explains failures in plain words: not a PDF, no text, quota", async () => {
    const { user, input } = setup({ parse: async () => Promise.reject(new UploadFailed("scanned")) });
    await user.upload(input, pdf("notes.txt", "text/plain"));
    await screen.findByText("That file isn't a PDF.");
    await user.upload(input, pdf());
    await screen.findByText(/No readable text was found/);
    cleanup();
    const s = setup({ send: async () => Promise.reject(new UploadFailed("quota")) });
    await s.user.upload(s.input, pdf());
    await screen.findByText(/demo limit/);
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

  it("an explicit choice wins over the default", () => {
    setup({}, false);
    expect(screen.getByRole("switch", { name: "Use the library" }).getAttribute("aria-checked")).toBe("false");
  });
});
