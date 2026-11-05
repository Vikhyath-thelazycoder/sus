/**
 * Curated paper ingestion (PROJECT_PLAN §5.1, T-2.7).
 *
 *   npm run ingest -- --preview            parse every PDF and write data/parsed/<file>.md for review (no upload)
 *   npm run ingest -- --remote             upload to production (token from .secrets/production.json)
 *   npm run ingest -- --url http://localhost:5173 --token <t>    upload to a local dev server
 *   add --only p-abc123.pdf to process one file
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePdfFile } from "./lib/pdf-node";
import { chunkPaper } from "../src/shared/chunker";
import { approxTokens } from "../src/shared/text";

interface PaperMeta {
  file: string;
  doi: string;
  title: string;
  year: number;
  authors: string[];
  journal: string | null;
  license: string;
  source_url: string;
  landing_url: string | null;
  topic: string;
  pages: number;
}

const DIR = "data/papers";
const PROD_URL = "https://sustainiq.sustainiq.workers.dev";
const BATCH = 6; // ~1.2 ms CPU per chunk: keeps each request near the free plan's 10 ms limit

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const all: PaperMeta[] = JSON.parse(await readFile(join(DIR, "metadata.json"), "utf8"));
  const only = opt("only");
  const papers = only ? all.filter((p) => p.file === only) : all;
  if (!papers.length) throw new Error("No papers selected");

  const preview = flag("preview");
  const baseUrl = flag("remote") ? PROD_URL : opt("url");
  const token = flag("remote")
    ? JSON.parse(await readFile(".secrets/production.json", "utf8")).ADMIN_INGEST_TOKEN
    : opt("token");
  if (!preview && (!baseUrl || !token)) throw new Error("Use --preview, --remote, or --url <u> --token <t>");

  if (!preview) {
    const ping = await api(baseUrl!, token, "GET", "/api/admin/ping");
    if (!ping.ok) throw new Error(`Token check failed: ${ping.status}`);
  }
  if (preview) await mkdir("data/parsed", { recursive: true });

  let totalChunks = 0;
  for (const meta of papers) {
    const parsed = await parsePdfFile(join(DIR, meta.file));
    if (parsed.scanned) {
      console.warn(`! ${meta.file}: looks scanned (too little text), skipped`);
      continue;
    }
    const chunks = chunkPaper(parsed.sections, meta.title, meta.year);
    totalChunks += chunks.length;
    const tokens = chunks.map((c) => approxTokens(c.text));
    const avg = Math.round(tokens.reduce((a, b) => a + b, 0) / Math.max(tokens.length, 1));
    console.log(
      `${meta.file}  ${parsed.pages}p  sections=${parsed.sections.length}  chunks=${chunks.length}  avg≈${avg} tok  ${meta.title.slice(0, 60)}`,
    );

    if (preview) {
      const md = [
        `# ${meta.title}`,
        `DOI ${meta.doi} · ${meta.license} · parsed title guess: ${parsed.title ?? "—"}`,
        ...parsed.sections.map(
          (s) => `\n## ${s.name} (p.${s.pageStart}–${s.pageEnd})\n\n${s.paragraphs.map((p) => p.text).join("\n\n")}`,
        ),
        `\n---\n# Chunks (${chunks.length})\n`,
        ...chunks.map((c) => `\n### #${c.idx} · section ${c.sectionIdx} · p.${c.pageStart}–${c.pageEnd} · ≈${approxTokens(c.text)} tok\n${c.text}`),
      ].join("\n");
      await writeFile(join("data/parsed", meta.file.replace(/\.pdf$/, ".md")), md);
      continue;
    }

    const created = await api(baseUrl!, token, "POST", "/api/admin/papers", {
      paper: {
        doi: meta.doi,
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        journal: meta.journal,
        license: meta.license,
        sourceUrl: meta.landing_url ?? meta.source_url,
        topic: meta.topic,
        pages: parsed.pages,
      },
      sections: parsed.sections.map((s) => ({
        name: s.name,
        text: s.paragraphs.map((p) => p.text).join("\n\n"),
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
      })),
    });
    if (!created.ok) throw new Error(`${meta.file}: create failed ${created.status} ${await created.text()}`);
    const { paperId } = (await created.json()) as { paperId: string };

    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      let res = await api(baseUrl!, token, "POST", `/api/admin/papers/${paperId}/chunks`, { chunks: batch });
      if (!res.ok && res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000));
        res = await api(baseUrl!, token, "POST", `/api/admin/papers/${paperId}/chunks`, { chunks: batch }); // upsert: safe to retry
      }
      if (!res.ok) throw new Error(`${meta.file}: chunks ${i} failed ${res.status} ${await res.text()}`);
    }
  }
  console.log(`done: ${papers.length} papers, ${totalChunks} chunks${preview ? " (preview written to data/parsed/)" : ""}`);
}

function api(base: string, token: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
