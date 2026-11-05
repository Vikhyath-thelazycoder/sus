import { describe, expect, it } from "vitest";
import { frontMatterProse, parsePaper, toParagraphs, withoutContactDetails } from "../../src/shared/pdf/structure";
import { cleanText } from "../../src/shared/text";
import type { Line, RawItem, RawPage } from "../../src/shared/pdf/types";

const W = 600;
const H = 800;

/** Build a single-column paper from [text, size] rows; 30 rows per page. */
function paper(rows: [string, number?][]): RawPage[] {
  const pages: RawPage[] = [];
  rows.forEach(([text, size = 10], i) => {
    const n = Math.floor(i / 30) + 1;
    if (!pages[n - 1]) pages[n - 1] = { number: n, width: W, height: H, items: [] };
    const item: RawItem = { str: text, x: 60, y: 740 - (i % 30) * 20, width: Math.min(text.length * 5, 480), size };
    pages[n - 1]!.items.push(item);
  });
  return pages;
}

const body = (s: string) => [s, 10] as [string, number];
const filler = (n: number) => Array.from({ length: n }, (_, i) => body(`This is body sentence number ${i} about polylactic acid films and their properties.`));

describe("parsePaper", () => {
  it("finds standard and numbered headings; a title-and-authors front matter is not indexed", () => {
    const pages = paper([
      ["A Study of Polylactic Acid Degradation in Compost", 18],
      body("Jane Doe, John Roe"),
      ["Abstract", 12],
      ...filler(3),
      ["1. Introduction", 12],
      ...filler(4),
      ["2.1 Materials and sample preparation", 10],
      ...filler(4),
      ["3 Results and Discussion", 12],
      ...filler(4),
    ]);
    const parsed = parsePaper(pages);
    // The title and author line hold no prose, so front matter is dropped (the title is still detected below).
    expect(parsed.sections.map((s) => s.name)).toEqual([
      "Abstract",
      "Introduction",
      "Materials and sample preparation",
      "Results and Discussion",
    ]);
    expect(parsed.title).toBe("A Study of Polylactic Acid Degradation in Compost");
  });

  it("joins a heading that wraps onto a second line", () => {
    const parsed = parsePaper(
      paper([body("x"), ["Abstract", 12], ...filler(2), ["Modification strategies for promoting the", 12], ["biodegradability of PLA", 12], ...filler(3)]),
    );
    expect(parsed.sections.map((s) => s.name)).toContain("Modification strategies for promoting the biodegradability of PLA");
  });

  it("does not treat a wrapped sentence or a table row as a heading", () => {
    const parsed = parsePaper(
      paper([
        ["Abstract", 12],
        ...filler(2),
        body("Together with an increase in exuded EPS clearly visible on"),
        body("the surface, the biofilm grew thicker over time."),
        body("3 PLA 45 12 0.8"),
        ...filler(2),
      ]),
    );
    expect(parsed.sections.map((s) => s.name)).toEqual(["Abstract"]);
  });

  it("stops at a real bibliography but not at a table column called References", () => {
    const parsed = parsePaper(
      paper([
        ["Introduction", 12],
        ...filler(2),
        ["References", 12], // table column header: followed by table cells, not entries
        body("Adilah et al. (2018)"),
        body("Han et al. (2018b)"),
        ["Conclusions", 12],
        ...filler(2),
        ["References", 12],
        body("Smith, J. A., Doe, R. (2020). Biodegradable films. J. Polym. 12, 1–9."),
        body("Aam BB, Heggset EB, Norberg AL (2010) Production of chitooligosaccharides."),
        body("Shaw, M. H., Twilton, J. Photoredox catalysis in organic chemistry."),
        ["Appendix", 12],
        body("This appendix text should not be indexed at all."),
      ]),
    );
    const names = parsed.sections.map((s) => s.name);
    expect(names).toEqual(["Introduction", "Conclusions"]);
    expect(JSON.stringify(parsed.sections)).not.toContain("appendix text");
    expect(JSON.stringify(parsed.sections)).toContain("Adilah et al."); // table content kept
  });

  it("skips boilerplate sections such as Acknowledgements and Funding", () => {
    const parsed = parsePaper(paper([["Results", 12], ...filler(2), ["Acknowledgements", 12], body("We thank everyone."), ["Funding", 12], body("Grant 123.")]));
    expect(parsed.sections.map((s) => s.name)).toEqual(["Results"]);
  });

  it("flags scanned PDFs that have almost no text", () => {
    const pages: RawPage[] = [1, 2, 3].map((n) => ({ number: n, width: W, height: H, items: [{ str: "x", x: 60, y: 400, width: 5, size: 10 }] }));
    expect(parsePaper(pages).scanned).toBe(true);
  });
});

describe("toParagraphs", () => {
  const line = (text: string, y: number, extra: Partial<Line> = {}): Line => ({ page: 1, text, x0: 60, x1: 540, y, size: 10, ...extra });

  it("fixes words hyphenated across lines, but keeps real hyphens", () => {
    const [p] = toParagraphs([line("The film is fully biodegrad-", 700), line("able in compost and PLA-", 688), line("Based blends too.", 676)]);
    expect(p!.text).toBe("The film is fully biodegradable in compost and PLA- Based blends too.");
  });

  it("starts a new paragraph at a figure caption in a smaller font", () => {
    const paras = toParagraphs([line("Body text continues here and", 700), line("Fig. 2 A caption in small type.", 688, { size: 8 })]);
    expect(paras).toHaveLength(2);
  });

  it("does not split double-spaced manuscripts into one paragraph per line", () => {
    const paras = toParagraphs([line("First line of a double", 700), line("spaced manuscript keeps", 676), line("going as one paragraph.", 652)]);
    expect(paras).toHaveLength(1);
  });
});

describe("cleanText (SECURITY §6.8)", () => {
  it("turns ligatures into letters and strips invisible characters", () => {
    expect(cleanText("ﬁlm ﬂow")).toBe("film flow");
    expect(cleanText("ig\u200Bnore\u202E rules\u{E0041}\u00AD")).toBe("ignore rules");
  });
});

describe("front matter and contact details (P5 finding: boilerplate in retrieval)", () => {
  const para = (text: string) => ({ text, pageStart: 1, pageEnd: 1 });
  const ABSTRACT =
    "Stabilization of reactive intermediates is an enabling concept in biomass fractionation and depolymerization. Deep eutectic solvents are green reaction media for biomass processing.";

  it("keeps abstract prose and drops editor lists, emails, licences, dates and affiliations", () => {
    const out = frontMatterProse([
      para("Edited by: Miguel Cerqueira, INL, Portugal Reviewed by: Someone, University of X. *Correspondence: Henriette Azeredo henriette.azeredo@embrapa.br"),
      para("1 Department of Cell Biology, School of Basic Medical Sciences, Southern Medical University, Guangzhou, China."),
      para("This is an open access article distributed under the terms of the Creative Commons Attribution License."),
      para("Received: 14 December 2017 / Accepted: 26 June 2018 / Published online: 10 August 2018"),
      para(ABSTRACT),
    ]);
    expect(out.map((p) => p.text)).toEqual([ABSTRACT]);
  });

  it("removes only the boilerplate sentence when the PDF glues it to prose", () => {
    const [p] = frontMatterProse([para(`Received: 2 October 2019. ${ABSTRACT}`)]);
    expect(p!.text).toBe(ABSTRACT);
  });

  it("strips contact footnotes from any section but keeps chemistry notation such as CNF@MOF", () => {
    const out = withoutContactDetails([
      para("*Correspondence: lizj@mail.buct.edu.cn"),
      para("CNF@Al-MIL-53 nanofibers were prepared as previously reported. They were freeze-dried."),
      para("The aerogel was tested at 25 °C. Contact: e-mail: juho.sirvio@oulu.fi for samples."),
    ]);
    expect(out.map((p) => p.text)).toEqual(["CNF@Al-MIL-53 nanofibers were prepared as previously reported. They were freeze-dried.", "The aerogel was tested at 25 °C."]);
  });
});
