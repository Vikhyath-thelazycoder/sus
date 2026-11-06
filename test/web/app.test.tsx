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

/** Mock /api/chat with a list of SSE events (or an HTTP status), and record every call. History starts empty. */
function mockApi(reply: object[] | number, extra: Record<string, unknown> = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const created: object[] = []; // chats the "server" created, as /api/chats would list them
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/feedback") || method === "PATCH" || method === "DELETE")
        return new Response(null, { status: 204 });
      if (url in extra) return Response.json(extra[url]);
      if (url === "/api/chats") return Response.json({ chats: created });
      if (url === "/api/chat") {
        const body = JSON.parse(String(init!.body)) as { question: string; chatId?: string };
        if (!body.chatId)
          created.push({
            id: "11111111-1111-4111-8111-111111111111",
            title: body.question.slice(0, 80),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
      }
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
  window.history.replaceState(null, "", "/");
});

describe("chat view (T-5.3, T-5.5)", () => {
  it("shows suggestions when empty and asks one on click", async () => {
    const calls = mockApi([done()]);
    const user = userEvent.setup();
    render(<App />);
    const list = screen.getByRole("list", { name: "Suggested questions" });
    await user.click(within(list).getAllByRole("button")[0]!);
    await screen.findByText(/Nanoplastics peak/);
    expect(calls.find((c) => c.url === "/api/chat")!.body).toMatchObject({
      question: expect.stringContaining("gut enzymes"),
    });
  });

  it("streams tokens, then shows citations, the sources row, actions and the disclaimer", async () => {
    mockApi([
      { type: "status", step: "searching" },
      { type: "status", step: "writing" },
      { type: "token", text: "Nanoplastics peak " },
      { type: "token", text: "after about two hours [1]." },
      done(),
    ]);
    await askQuestion();
    expect(await screen.findByRole("button", { name: "Source 1" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Sources" }).textContent).toContain(
      "Oligomer nanoparticle release from PLA",
    );
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeTruthy();
    expect(screen.getByText("AI answers can be wrong. Check the cited sources.")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Chat history" }).textContent).toContain(
      "How fast do gut enzymes break PLA?",
    );
    expect(screen.getByRole("navigation", { name: "Chat history" }).textContent).toContain("Today");
  });

  it("sends the chat ID with follow-up questions", async () => {
    const calls = mockApi([done()]);
    const user = await askQuestion();
    await screen.findByRole("button", { name: "Source 1" });
    await user.type(screen.getByLabelText("Your question"), "And at home?{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/chat")).toHaveLength(2));
    expect(calls.filter((c) => c.url === "/api/chat")[1]!.body).toEqual({
      question: "And at home?",
      chatId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("replaces a rejected draft", async () => {
    mockApi([
      { type: "token", text: "Bad draft [9]" },
      { type: "replace", text: "" },
      { type: "token", text: "Good [1]." },
      done({ content: "Good [1]." }),
    ]);
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

const SAVED = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "PLA in the gut",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
const OLD = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Old chitin chat",
  createdAt: 0,
  updatedAt: Date.now() - 30 * 24 * 3600 * 1000,
};
const savedChat = {
  chat: { id: SAVED.id, title: SAVED.title },
  messages: [
    {
      id: "m1",
      role: "user",
      content: "Does PLA break down in the gut?",
      status: "ok",
      feedback: 0,
      createdAt: 1,
    },
    {
      id: "m2",
      role: "assistant",
      content: "Yes, within hours [1].",
      status: "ok",
      feedback: -1,
      createdAt: 2,
      sources: [source(1)],
    },
  ],
};

describe("saved history (T-6.4)", () => {
  it("lists saved chats by date and reopens one with its citations and feedback", async () => {
    mockApi([], { "/api/chats": { chats: [SAVED, OLD] }, [`/api/chats/${SAVED.id}`]: savedChat });
    const user = userEvent.setup();
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Chat history" });
    await within(nav).findByText("PLA in the gut");
    expect(
      within(nav)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Today", "Older"]);
    await user.click(within(nav).getByRole("button", { name: "PLA in the gut" }));
    expect(await screen.findByText("Does PLA break down in the gut?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not helpful" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Source 1" }));
    expect(
      within(await screen.findByRole("dialog")).getByText(
        "Peak PLA nanoplastics formation after only two hours.",
      ),
    ).toBeTruthy();
  });

  it("follow-ups in a reopened chat continue the same server chat", async () => {
    const calls = mockApi([done({ chatId: SAVED.id })], {
      "/api/chats": { chats: [SAVED] },
      [`/api/chats/${SAVED.id}`]: savedChat,
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "PLA in the gut" }));
    await screen.findByText("Does PLA break down in the gut?");
    await user.type(screen.getByLabelText("Your question"), "And PBAT?{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/api/chat")?.body).toEqual({
        question: "And PBAT?",
        chatId: SAVED.id,
      }),
    );
  });

  it("renames and deletes the open chat", async () => {
    const calls = mockApi([], { "/api/chats": { chats: [SAVED] }, [`/api/chats/${SAVED.id}`]: savedChat });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "PLA in the gut" }));
    await user.click(await screen.findByRole("button", { name: "Rename chat" }));
    const input = screen.getByRole("textbox", { name: "Chat title" });
    await user.clear(input);
    await user.type(input, "Gut enzymes{Enter}");
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
      url: `/api/chats/${SAVED.id}`,
      body: { title: "Gut enzymes" },
    });
    expect(screen.getByRole("button", { name: "Gut enzymes" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe(`/api/chats/${SAVED.id}`));
    expect(screen.queryByRole("button", { name: "Gut enzymes" })).toBeNull();
    expect(screen.getByRole("heading", { name: "What would you like to research?" })).toBeTruthy();
  });

  it("deleting a chat with PDFs asks whether to delete them too (T-7.11)", async () => {
    for (const [keep, url] of [
      [false, `/api/chats/${SAVED.id}?pdfs=delete`],
      [true, `/api/chats/${SAVED.id}`],
    ] as const) {
      const calls = mockApi([], {
        "/api/chats": { chats: [{ ...SAVED, pdfs: 2 }] },
        [`/api/chats/${SAVED.id}`]: savedChat,
      });
      const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(!keep);
      vi.stubGlobal("confirm", confirm);
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "PLA in the gut" }));
      await user.click(await screen.findByRole("button", { name: "Delete chat" }));
      await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe(url));
      expect(confirm.mock.calls[1]![0]).toMatch(/Also delete the 2 PDFs uploaded in this chat\?/);
      cleanup();
    }
  });

  it("sends the library choice with the question once the user sets it (T-7.12)", async () => {
    const calls = mockApi([done()]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("switch", { name: "Use the library" }));
    await user.type(screen.getByLabelText("Your question"), "Only my PDFs{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/api/chat")?.body).toEqual({ question: "Only my PDFs", useLibrary: false }),
    );
  });
});

const papers = [
  {
    id: "p_" + "1".repeat(24),
    title: "Bacterial Cellulose as a Raw Material for Food Packaging",
    authors: ["H. Azeredo"],
    year: 2019,
    journal: "Front. Sustain. Food Syst.",
    doi: "10.3389/fsufs.2019.00007",
    license: "cc-by",
    sourceUrl: "https://example.org/bc.pdf",
    topic: "packaging",
    pages: 14,
    upload: false,
    verified: true,
  },
  {
    id: "p_" + "2".repeat(24),
    title: "Pseudomonas Species as Producers of PHA",
    authors: ["J. Mozejko"],
    year: 2019,
    journal: "J. Polym. Environ.",
    doi: "10.1007/x",
    license: "cc-by",
    sourceUrl: null,
    topic: "biopolymers",
    pages: 16,
    upload: false,
    verified: true,
  },
  {
    id: "p_" + "3".repeat(24),
    title: "<img src=x onerror=alert(1)> my notes",
    authors: [],
    year: null,
    journal: null,
    doi: null,
    license: null,
    sourceUrl: null,
    topic: null,
    pages: 3,
    upload: true,
    verified: false,
  },
];

describe("library (T-6.2)", () => {
  const detail = {
    paper: papers[0],
    summary: { name: "Abstract", text: "BC is a promising packaging material." },
    sections: [
      { name: "Abstract", pageStart: 1, pageEnd: 1 },
      { name: "Results", pageStart: 2, pageEnd: 9 },
    ],
  };
  const open = async () => {
    const calls = mockApi([done()], { "/api/papers": { papers }, [`/api/papers/${papers[0]!.id}`]: detail });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getAllByRole("button", { name: "Library" })[0]!);
    await screen.findByText("Pseudomonas Species as Producers of PHA");
    return { user, calls };
  };

  it("searches and filters by topic, and labels uploads (hostile titles stay text)", async () => {
    const { user } = await open();
    const list = () => screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(list()).toHaveLength(3);
    expect(document.querySelector("main img")).toBeNull();
    await user.type(screen.getByRole("searchbox", { name: "Search papers" }), "cellulose 2019");
    expect(list()).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox", { name: "Search papers" }));
    await user.click(screen.getByRole("button", { name: "Biopolymers" }));
    expect(list().map((t) => t.slice(0, 20))).toEqual(["Pseudomonas Species "]);
    await user.click(screen.getByRole("button", { name: "Your uploads" }));
    expect(list()[0]).toContain("Your upload · unverified");
    expect(list()[0]).toContain("<img src=x onerror=alert(1)> my notes");
  });

  it("opens paper detail with abstract, sections and links, and asks about the paper", async () => {
    const { user, calls } = await open();
    await user.click(screen.getByRole("button", { name: /Bacterial Cellulose/ }));
    expect(await screen.findByText("BC is a promising packaging material.")).toBeTruthy();
    expect(window.location.hash).toBe(`#/library/${papers[0]!.id}`);
    expect(screen.getByRole("link", { name: /doi.org/ }).getAttribute("href")).toBe(
      "https://doi.org/10.3389/fsufs.2019.00007",
    );
    expect(screen.getByRole("link", { name: /Open the PDF/ }).getAttribute("rel")).toBe(
      "noopener noreferrer nofollow",
    );
    expect(screen.getByText("pp. 2–9")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ask about this paper" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/api/chat")?.body).toEqual({
        question: 'What are the main findings of "Bacterial Cellulose as a Raw Material for Food Packaging"?',
      }),
    );
    expect(await screen.findByText(/Nanoplastics peak/)).toBeTruthy();
  });
});
