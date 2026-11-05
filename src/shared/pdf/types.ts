/** One run of text from pdf.js, in page coordinates (origin bottom-left, y = baseline). */
export interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

export interface RawPage {
  number: number;
  width: number;
  height: number;
  items: RawItem[];
}

/** A visual line (or one column's part of it) after grouping items. */
export interface Line {
  page: number;
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
}

export interface Paragraph {
  text: string;
  pageStart: number;
  pageEnd: number;
}

export interface Section {
  name: string;
  paragraphs: Paragraph[];
  pageStart: number;
  pageEnd: number;
}

export interface ParsedPaper {
  /** Best guess from the first page's largest text; curated metadata wins when present. */
  title: string | null;
  pages: number;
  /** Too little text per page: probably a scanned image PDF (no OCR in the demo). */
  scanned: boolean;
  sections: Section[];
}
