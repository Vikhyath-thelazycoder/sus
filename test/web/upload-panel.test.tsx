import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UploadPanel } from "../../src/web/upload/UploadPanel";
import { UploadFailed } from "../../src/web/upload/client";
import type { ParsedUpload } from "../../src/web/upload/parse";

const parsed: ParsedUpload = {
  title: "My PHA notes",
  pages: 4,
  sections: [{ name: "Body", text: "x", pageStart: 1, pageEnd: 4 }],
  chunks: Array.from({ length: 40 }, (_, idx) => ({
    sectionIdx: 0,
    idx,
    text: "t",
    pageStart: 1,
    pageEnd: 1,
  })),
};
const pdf = (name = "notes.pdf", type = "application/pdf") => new File(["%PDF-1.4"], name, { type });

afterEach(cleanup);

function setup(over: Partial<{ parse: unknown; send: unknown; used: { pdfs: number; pages: number } }> = {}) {
  const onUploaded = vi.fn();
  const onOpen = vi.fn();
  const upload = {
    parse: (over.parse ??
      (async (_f: File, step: (s: string) => void) => (step("splitting"), parsed))) as never,
    send: (over.send ??
      (async (_p: ParsedUpload, progress: (d: number, t: number) => void) => (
        progress(32, 40),
        progress(40, 40),
        "p_" + "a".repeat(24)
      ))) as never,
  };
  render(
    <UploadPanel
      used={over.used ?? { pdfs: 1, pages: 10 }}
      onUploaded={onUploaded}
      onOpen={onOpen}
      upload={upload}
    />,
  );
  return { onUploaded, onOpen, input: screen.getByLabelText("Choose a PDF") as HTMLInputElement };
}

describe("upload panel (T-7.3)", () => {
  it("shows the limits, usage and the 'don't upload confidential documents' notice", () => {
    setup();
    expect(screen.getByText(/Don't upload confidential documents/)).toBeTruthy();
    expect(screen.getByText("1 of 5 PDFs · 10 of 100 pages used")).toBeTruthy();
  });

  it("uploads a PDF and reports success with a link to the paper", async () => {
    const { input, onUploaded, onOpen } = setup();
    await userEvent.upload(input, pdf());
    await screen.findByText(/Added “My PHA notes”/);
    expect(onUploaded).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Open it" }));
    expect(onOpen).toHaveBeenCalledWith("p_" + "a".repeat(24));
  });

  it("shows Reading → Splitting → Indexing with passage counts while it works", async () => {
    let finish!: (id: string) => void;
    const { input } = setup({
      send: (_p: ParsedUpload, progress: (d: number, t: number) => void) => {
        progress(32, 40);
        return new Promise<string>((r) => (finish = r));
      },
    });
    await userEvent.upload(input, pdf());
    const steps = await screen.findByRole("list", { name: "Upload progress" });
    expect(steps.textContent).toContain("✓ Reading");
    expect(steps.textContent).toContain("✓ Splitting");
    expect(steps.textContent).toContain("Indexing 32 of 40 passages…");
    finish("p_" + "b".repeat(24));
    await screen.findByText(/Added/);
  });

  it("rejects a non-PDF before parsing, and refuses when the quota is used up", async () => {
    const parse = vi.fn();
    const { input } = setup({ parse });
    await userEvent.upload(input, pdf("notes.txt", "text/plain"), { applyAccept: false });
    expect((await screen.findByRole("alert")).textContent).toBe("That file isn't a PDF.");
    expect(parse).not.toHaveBeenCalled();
    cleanup();
    setup({ used: { pdfs: 2, pages: 98 } }); // 98 + 4 pages > 100
    await userEvent.upload(screen.getByLabelText("Choose a PDF"), pdf());
    expect((await screen.findByRole("alert")).textContent).toMatch(/demo limit \(5 PDFs, 100 pages/);
  });

  it("explains parser and server failures in plain words", async () => {
    const { input } = setup({ parse: async () => Promise.reject(new UploadFailed("scanned")) });
    await userEvent.upload(input, pdf());
    expect((await screen.findByRole("alert")).textContent).toMatch(/looks like a scan/);
    cleanup();
    setup({ send: async () => Promise.reject(new UploadFailed("quota")) });
    await userEvent.upload(screen.getByLabelText("Choose a PDF"), pdf());
    expect((await screen.findByRole("alert")).textContent).toMatch(/demo limit/);
  });

  it("disables the picker when 5 PDFs are stored", async () => {
    const { input } = setup({ used: { pdfs: 5, pages: 20 } });
    await waitFor(() => expect(input.disabled).toBe(true));
  });
});
