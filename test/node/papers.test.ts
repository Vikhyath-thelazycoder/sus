import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePdfFile } from "../../scripts/lib/pdf-node";
import { chunkPaper } from "../../src/shared/chunker";

/** Fixture tests on real curated papers (T-2.2). PDFs aren't in git: download them via data/papers/metadata.json. */
const pdf = (name: string) => `data/papers/${name}`;
const has = (name: string) => existsSync(pdf(name));

describe("real papers", () => {
  it.skipIf(!has("p-a0d98ceeaed6.pdf"))("two-column Frontiers paper reads in column order, sidebar removed", async () => {
    const parsed = await parsePdfFile(pdf("p-a0d98ceeaed6.pdf"));
    const intro = parsed.sections.find((s) => s.name === "INTRODUCTION")!;
    expect(intro.paragraphs[0]!.text).toMatch(
      /^Within a few decades, plastic has become the biggest form of pollution in the world’s oceans \(80% of marine litter consists of plastic\)/,
    );
    expect(intro.paragraphs[0]!.text).not.toContain("Front. Microbiol.");
  });

  it.skipIf(!has("p-9dce230f623b.pdf"))("single-column review: wrapped headings joined, all sections found", async () => {
    const parsed = await parsePdfFile(pdf("p-9dce230f623b.pdf"));
    const names = parsed.sections.map((s) => s.name);
    expect(names).toContain("Modifications strategies for promoting the biodegradability of polylactic acid");
    expect(names).toContain("Impact of polylactic acid microplastics on aquatic biota");
    expect(names.at(-1)).toBe("Conclusion");
  });

  it.skipIf(!has("p-1d7dfb6c8ce1.pdf"))("a table column titled References does not end the paper early", async () => {
    const parsed = await parsePdfFile(pdf("p-1d7dfb6c8ce1.pdf"));
    expect(parsed.sections.at(-1)!.pageEnd).toBeGreaterThanOrEqual(19);
    const chunks = chunkPaper(parsed.sections, "Smart packaging", 2022);
    expect(chunks.length).toBeGreaterThan(60);
  });
});
