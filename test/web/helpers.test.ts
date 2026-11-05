import { describe, expect, it } from "vitest";
import { groupByDate, parseHash, turnsFromMessages } from "../../src/web/App";
import { matches } from "../../src/web/pages/Library";
import type { Paper, StoredMessage } from "../../src/web/api";

describe("routing and history helpers", () => {
  it("parses only known hash routes", () => {
    expect(parseHash("")).toEqual({ kind: "chat" });
    expect(parseHash("#/library")).toEqual({ kind: "library" });
    expect(parseHash(`#/library/p_${"a".repeat(24)}`)).toEqual({ kind: "paper", id: `p_${"a".repeat(24)}` });
    expect(parseHash("#/library/../../etc")).toEqual({ kind: "chat" });
  });

  it("groups chats into Today, Yesterday, Previous 7 days and Older", () => {
    const now = new Date(2026, 10, 6, 12).getTime();
    const h = 3600 * 1000;
    const item = (id: string, ago: number) => ({ id, title: id, createdAt: 0, updatedAt: now - ago });
    const groups = groupByDate(
      [item("a", h), item("b", 20 * h), item("c", 5 * 24 * h), item("d", 40 * 24 * h)],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["Previous 7 days", ["c"]],
      ["Older", ["d"]],
    ]);
  });

  it("rebuilds turns from stored messages, including couldn't-find and unanswered questions", () => {
    const m = (
      id: string,
      role: "user" | "assistant",
      content: string,
      extra: Partial<StoredMessage> = {},
    ): StoredMessage => ({ id, role, content, status: "ok", feedback: 0, createdAt: 0, ...extra });
    const turns = turnsFromMessages("c", [
      m("1", "user", "Q1"),
      m("2", "assistant", "I couldn't find this in the papers.", { sources: [] }),
      m("3", "user", "Q2"),
      m("4", "assistant", "busy", { status: "error" }),
      m("5", "user", "Q3"),
    ]);
    expect(turns.map((t) => [t.question, t.state, t.done?.notFound ?? null, t.error ?? null])).toEqual([
      ["Q1", "done", true, null],
      ["Q2", "error", null, "busy"],
      ["Q3", "error", null, "failed"],
    ]);
  });

  it("matches library search words across title, authors, journal, topic and year", () => {
    const p = {
      title: "PLA review",
      authors: ["W. Ali"],
      journal: "Env Chem Lett",
      topic: "biopolymers",
      year: 2023,
      upload: false,
    } as Paper;
    expect(matches(p, "ali 2023", "all")).toBe(true);
    expect(matches(p, "biopolymers", "all")).toBe(true);
    expect(matches(p, "", "packaging")).toBe(false);
    expect(matches(p, "", "uploads")).toBe(false);
    expect(matches(p, "pla pbat", "all")).toBe(false);
  });
});
