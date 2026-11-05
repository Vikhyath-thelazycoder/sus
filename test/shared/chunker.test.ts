import { describe, expect, it } from "vitest";
import { CHUNK, chunkPaper, contextHeader, splitSentences } from "../../src/shared/chunker";
import type { Section } from "../../src/shared/pdf/types";

const sentence = (i: number) => `Sentence ${i} explains how polylactic acid films degrade under industrial composting conditions.`;
const section = (name: string, sentences: number, page = 1): Section => ({
  name,
  pageStart: page,
  pageEnd: page,
  paragraphs: [{ text: Array.from({ length: sentences }, (_, i) => sentence(i)).join(" "), pageStart: page, pageEnd: page }],
});

describe("splitSentences", () => {
  it("does not split after abbreviations or initials", () => {
    expect(splitSentences("As shown by Smith et al. 2020 in Fig. 3, it works. J. Doe agreed. Next one.")).toEqual([
      "As shown by Smith et al. 2020 in Fig. 3, it works.",
      "J. Doe agreed.",
      "Next one.",
    ]);
  });
});

describe("chunkPaper (RAG §4.3, §4.4)", () => {
  const chunks = chunkPaper([section("Introduction", 60), section("Results", 30, 4)], "PLA in Compost", 2023);

  it("keeps chunks near the target size and never over the limit", () => {
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK.maxChars + 300);
    const bodies = chunks.slice(0, -1).map((c) => c.text.split("\n").slice(1).join("\n").length);
    expect(Math.min(...bodies)).toBeGreaterThan(CHUNK.targetChars * 0.6);
  });

  it("overlaps neighbouring chunks within a section", () => {
    const [a, b] = chunks;
    const lastSentence = splitSentences(a!.text.split("\n")[1]!).at(-1)!;
    expect(b!.text).toContain(lastSentence);
  });

  it("never crosses a section boundary", () => {
    for (const c of chunks) {
      const intro = c.text.includes("Section: Introduction.");
      expect(intro ? c.sectionIdx === 0 : c.sectionIdx === 1).toBe(true);
      expect(c.pageStart).toBe(intro ? 1 : 4);
    }
  });

  it("prepends the contextual header and numbers chunks across the paper", () => {
    expect(chunks[0]!.text.startsWith("Paper: PLA in Compost (2023). Section: Introduction.\n")).toBe(true);
    expect(chunks.map((c) => c.idx)).toEqual(chunks.map((_, i) => i));
  });

  it("merges a tiny tail into the previous chunk", () => {
    const tail = chunkPaper([section("Short", 17)], "T").at(-1)!;
    expect(tail.text.length).toBeGreaterThan(CHUNK.minTailChars);
  });

  it("hard-splits a run-on block such as a flattened table", () => {
    const table = { name: "Table", pageStart: 2, pageEnd: 2, paragraphs: [{ text: "cell ".repeat(1500), pageStart: 2, pageEnd: 2 }] };
    for (const c of chunkPaper([table], "T")) expect(c.text.length).toBeLessThanOrEqual(CHUNK.maxChars + 100);
  });

  it("truncates very long titles in the header", () => {
    expect(contextHeader("x".repeat(400), 2020, "S").length).toBeLessThan(260);
  });
});
