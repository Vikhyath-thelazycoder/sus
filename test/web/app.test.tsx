import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/web/App";
import type { Done, Source } from "../../src/web/api";

const source = (n: number, over: Partial<Source> = {}): Source => ({
  n,
  paperId: "p",
  title: "Oligomer nanoparticle release from PLA",
  year: 2023,
  doi: "10.1038/s41565-023-01329-y",
  authors: ["A. One", "B. Two", "C. Three", "D. Four"],
  section: "Discussion",
  pageStart: 8,
  pageEnd: 8,
  text: "Peak PLA nanoplastics formation after only two hours.",
  upload: false,
  ...over,
});

const sse = (events: object[]) =>
  new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder();
      for (const e of events) ctrl.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(e)}\n\n`));
      ctrl.close();
    },
  });

const done = (over: Partial<Done> = {}) => ({
  type: "done",
  chatId: "11111111-1111-4111-8111-111111111111",
  messageId: "22222222-2222-4222-8222-222222222222",
  status: "ok",
  notFound: false,
  cached: false,
  content: "Nanoplastics peak after about two hours [1].",
  sources: [source(1)],
  ...over,
});

/** Mock /api/chat with a list of SSE events (or an HTTP status), and record feedback calls. */
function mockApi(reply: object[] | number) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/feedback")) return new Response(null, { status: 204 });
      if (typeof reply === "number") return new Response("{}", { status: reply });
      return new Response(sse(reply), { headers: { "Content-Type": "text/event-stream" } });
    }),
  );
  return calls;
}

async function askQuestion(text = "How fast do gut enzymes break PLA?") {
  const user = userEvent.setup();
  render(<App />);
  await user.type(screen.getByLabelText("Your question"), `${text}{Enter}`);
  return user;
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("chat view (T-5.3, T-5.5)", () => {
  it("shows suggestions when empty and asks one on click", async () => {
    const calls = mockApi([done()]);
    const user = userEvent.setup();
    render(<App />);
    const list = screen.getByRole("list", { name: "Suggested questions" });
    await user.click(within(list).getAllByRole("button")[0]!);
    await screen.findByText(/Nanoplastics peak/);
    expect(calls[0]!.body).toMatchObject({ question: expect.stringContaining("gut enzymes") });
  });

  it("streams tokens, then shows citations, the sources row, actions and the disclaimer", async () => {
    mockApi([{ type: "status", step: "searching" }, { type: "status", step: "writing" }, { type: "token", text: "Nanoplastics peak " }, { type: "token", text: "after about two hours [1]." }, done()]);
    await askQuestion();
    expect(await screen.findByRole("button", { name: "Source 1" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Sources" }).textContent).toContain("Oligomer nanoparticle release from PLA");
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeTruthy();
    expect(screen.getByText("AI answers can be wrong. Check the cited sources.")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Chat history" }).textContent).toContain("How fast do gut enzymes break PLA?");
  });

  it("sends the chat ID with follow-up questions", async () => {
    const calls = mockApi([done()]);
    const user = await askQuestion();
    await screen.findByRole("button", { name: "Source 1" });
    await user.type(screen.getByLabelText("Your question"), "And at home?{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/chat")).toHaveLength(2));
    expect(calls[1]!.body).toEqual({ question: "And at home?", chatId: "11111111-1111-4111-8111-111111111111" });
  });

  it("replaces a rejected draft", async () => {
    mockApi([{ type: "token", text: "Bad draft [9]" }, { type: "replace", text: "" }, { type: "token", text: "Good [1]." }, done({ content: "Good [1]." })]);
    await askQuestion();
    await screen.findByText(/Good/);
    expect(screen.queryByText(/Bad draft/)).toBeNull();
  });

  it("couldn't-find state", async () => {
    mockApi([done({ notFound: true, content: "I couldn't find this in the papers.", sources: [] })]);
    await askQuestion();
    expect(await screen.findByText(/Try rephrasing/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Sources" })).toBeNull();
  });

  it("rate-limited (429), busy and failure states with a retry", async () => {
    mockApi(429);
    const user = await askQuestion();
    const alertText = async () => (await screen.findByRole("alert")).textContent;
    expect(await alertText()).toContain("You've asked a lot quickly. Try again in a minute.");
    mockApi([done({ status: "error", content: "busy", sources: [] })]);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(async () => expect(await alertText()).toContain("The service is busy right now."));
    mockApi([{ type: "error", message: "Something went wrong" }]);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(async () => expect(await alertText()).toContain("Something went wrong while answering"));
  });

  it("stores thumbs feedback against the message", async () => {
    const calls = mockApi([done()]);
    const user = await askQuestion();
    const up = await screen.findByRole("button", { name: "Helpful" });
    await user.click(up);
    expect(up.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(calls.find((c) => c.url.includes("/feedback"))?.body).toEqual({ value: 1 }));
  });
});

describe("citation panel (T-5.4)", () => {
  it("opens from [n] with the keyboard, shows stored details, and Esc returns focus", async () => {
    mockApi([done()]);
    const user = await askQuestion();
    const pill = await screen.findByRole("button", { name: "Source 1" });
    pill.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Curated")).toBeTruthy();
    expect(within(dialog).getByText("A. One, B. Two, C. Three et al. · 2023")).toBeTruthy();
    expect(within(dialog).getByText("Discussion · p. 8")).toBeTruthy();
    expect(within(dialog).getByText("Peak PLA nanoplastics formation after only two hours.")).toBeTruthy();
    const link = within(dialog).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://doi.org/10.1038/s41565-023-01329-y");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close source" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  it("opens from the sources row with a click and labels uploads", async () => {
    mockApi([done({ sources: [source(1, { upload: true, doi: null })] })]);
    const user = await askQuestion();
    const row = await screen.findByRole("list", { name: "Sources" });
    await user.click(within(row).getByRole("button"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Your upload · unverified")).toBeTruthy();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("renders a hostile paper title as text (SECURITY §13 #11)", async () => {
    mockApi([done({ sources: [source(1, { title: "<img src=x onerror=alert(1)>" })] })]);
    const user = await askQuestion();
    await user.click(await screen.findByRole("button", { name: "Source 1" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("img")).toBeNull();
    expect(within(dialog).getByRole("heading").textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("theme (T-5.1)", () => {
  it("toggles dark mode and remembers it", async () => {
    mockApi([]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("sustainiq-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
  });
});
