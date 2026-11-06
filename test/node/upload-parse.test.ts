import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { checkBytes, parseUpload, titleFromName, UploadError } from "../../src/web/upload/parse";
import { UPLOAD } from "../../src/shared/limits";

/** A small, valid text PDF with `pages` pages, built by hand so the tests need no fixtures. */
function makePdf(
  pages: number,
  line = (p: number, i: number) =>
    `Page ${p} line ${i}: polyhydroxyalkanoate films degrade in soil and compost.`,
) {
  const objs: string[] = [];
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageIds.forEach((id, p) => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `BT /F1 10 Tf 50 ${760 - i * 22} Td (${line(p + 1, i)}) Tj ET`,
    ).join("\n");
    objs[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objs[id + 1] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("")}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof UploadError ? e.code : String(e);
  }
};

describe("browser PDF parsing (T-7.1)", () => {
  it("parses a text PDF into sections and chunks the server will accept", async () => {
    const steps: string[] = [];
    const r = await parseUpload(makePdf(3), "C:\\Users\\me\\Desktop\\pha_notes.pdf", getDocument, (s) =>
      steps.push(s),
    );
    expect(steps).toEqual(["reading", "splitting"]);
    expect(r.pages).toBe(3);
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(
      r.chunks.every((c) => c.text.length <= 4000 && c.pageEnd <= 3 && c.sectionIdx < r.sections.length),
    ).toBe(true);
    expect(r.sections.every((s) => s.text.length <= UPLOAD.sectionPreviewChars && s.name.length > 0)).toBe(
      true,
    );
    expect(r.title).not.toContain("Users"); // never a path
  });

  it("rejects a non-PDF renamed .pdf, an oversized file and a 101-page PDF (SECURITY §13 #13)", async () => {
    expect(await code(parseUpload(new TextEncoder().encode("hello, not a pdf"), "x.pdf", getDocument))).toBe(
      "not-pdf",
    );
    const big = new Uint8Array(UPLOAD.maxFileBytes + 1);
    big.set(new TextEncoder().encode("%PDF-1.4"));
    expect(() => checkBytes(big)).toThrow(UploadError);
    expect(
      await code(
        parseUpload(
          makePdf(101, () => "x"),
          "long.pdf",
          getDocument,
        ),
      ),
    ).toBe("too-many-pages");
  });

  it("rejects a PDF with no text layer and a broken file", async () => {
    expect(
      await code(
        parseUpload(
          makePdf(2, () => ""),
          "scan.pdf",
          getDocument,
        ),
      ),
    ).toBe("scanned");
    expect(
      await code(parseUpload(new TextEncoder().encode("%PDF-1.4\ngarbage"), "broken.pdf", getDocument)),
    ).toMatch(/unreadable|scanned/);
  });

  it("titles from the file name never keep a path", () => {
    expect(titleFromName("/home/me/secret dir/My_Paper.PDF")).toBe("My Paper");
    expect(titleFromName("C:\\x\\.pdf")).toBe("Untitled PDF");
  });

  const real = "data/papers/p-a0d98ceeaed6.pdf";
  it.skipIf(!existsSync(real))("a real curated paper parses within the limits", async () => {
    const r = await parseUpload(new Uint8Array(readFileSync(real)), "paper.pdf", getDocument);
    expect(r.chunks.length).toBeLessThanOrEqual(UPLOAD.maxChunks);
    expect(r.sections.length).toBeGreaterThan(3);
  });
});
