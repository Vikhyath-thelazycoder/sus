/**
 * Retrieval evaluation on data/golden.json (T-3.6, RAG §9.2).
 *
 *   npm run eval                     run the pipeline here, on production data over the Cloudflare REST API
 *   npm run eval -- --remote         call the Render demo's admin search endpoint (records REST latency)
 *   options: --modes vector,keyword,hybrid,rerank  --searchK 30  --fuseTop 10  --rerankTop 10  --out file.json
 *   npm run eval -- --answers        answer evaluation (T-4.8): full pipeline + Groq + LLM judge, see eval-answers.ts
 *
 * A hit is correct when it is from the gold paper and section and its pages overlap the gold pages.
 */
import { readFile, writeFile } from "node:fs/promises";
import { RestAi, RestD1, RestVectorize } from "../src/server/cloudflare-rest";
import { RETRIEVAL, retrieve, type Mode } from "../src/worker/rag/search";
import { paperIdFor } from "../src/worker/routes/admin-papers";
import { runAnswerEval } from "./eval-answers";

const PROD_URL = "https://sustainiq-demo.onrender.com";
// Production resource IDs (render.yaml); not secret.
const PROD = { accountId: "e9233209373a92669b3057d4159652ff", d1: "804411b1-e5eb-4d0e-bcc1-2dddfa035841", index: "sustainiq-chunks" };

export interface Gold {
  id: string;
  question: string;
  doi: string;
  section: string;
  pages: [number, number];
  style: string;
  answer: string;
}
interface RankedHit {
  id: string;
  paper_id: string;
  section: string;
  page_start: number;
  page_end: number;
  score: number;
  rerankScore?: number;
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string) => (opt(name) ? Number(opt(name)) : undefined);

export const recallAt = (rank: number, k: number) => (rank > 0 && rank <= k ? 1 : 0);
export const reciprocal = (rank: number) => (rank > 0 ? 1 / rank : 0);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
/** Best cross-encoder score in the result: the signal P4 will use to decline (RAG §5.7 histogram). */
const topRerank = (hits: RankedHit[]) => (hits.length && hits[0]!.rerankScore !== undefined ? Math.max(...hits.map((h) => h.rerankScore!)) : null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Search = (query: string, mode: Mode) => Promise<{ hits: RankedHit[]; timings: Record<string, number> }>;

async function searcher(remote: boolean): Promise<Search> {
  const sizes = { searchK: num("searchK"), fuseTop: num("fuseTop"), rerankTop: num("rerankTop") ?? num("fuseTop") ?? RETRIEVAL.fuseTop }; // rank the whole pool
  if (remote) {
    const token = JSON.parse(await readFile(".secrets/production.json", "utf8")).ADMIN_INGEST_TOKEN;
    return async (query: string, mode: Mode) => {
      const t0 = Date.now();
      const res = await fetch(`${PROD_URL}/api/admin/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, mode, ...sizes }),
      });
      if (!res.ok) throw new Error(`search ${res.status}`);
      const out = (await res.json()) as { hits: RankedHit[]; timings: Record<string, number> };
      return { hits: out.hits, timings: { ...out.timings, roundTrip: Date.now() - t0 } };
    };
  }
  const env = await localEnv();
  return async (query: string, mode: Mode) => {
    const t0 = Date.now();
    const r = await retrieve(env, query, "admin-eval", { mode, ...sizes, rankingOnly: true });
    return { hits: r.hits as RankedHit[], timings: { ...r.timings, total: Date.now() - t0 } };
  };
}

/** Production data over REST plus the LLM settings from wrangler.toml and the key in .dev.vars (git-ignored). */
async function localEnv(): Promise<Env> {
  const apiToken = (await readFile(".secrets/cloudflare.env", "utf8")).match(/CLOUDFLARE_API_TOKEN=(\S+)/)?.[1];
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN missing from .secrets/cloudflare.env");
  const toml = await readFile("wrangler.toml", "utf8");
  const tomlVar = (k: string) => toml.match(new RegExp(`^${k} = "([^"]*)"`, "m"))?.[1] ?? "";
  const llmKey = (await readFile(".dev.vars", "utf8").catch(() => "")).match(/^LLM_API_KEY=(\S+)/m)?.[1] ?? "";
  const cf = { accountId: PROD.accountId, apiToken };
  return {
    DB: new RestD1(cf, PROD.d1),
    VECTORIZE: new RestVectorize(cf, PROD.index),
    AI: new RestAi(cf),
    LLM_API_KEY: llmKey,
    LLM_BASE_URL: tomlVar("LLM_BASE_URL"),
    LLM_MODELS: tomlVar("LLM_MODELS"),
    LLM_SMALL_MODEL: tomlVar("LLM_SMALL_MODEL"),
  } as unknown as Env;
}

/** Run `fn` over items with at most `n` in flight (Workers AI and D1 REST limits). */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function main() {
  const golden = JSON.parse(await readFile("data/golden.json", "utf8")) as { questions: Gold[]; unanswerable: { id: string; question: string }[] };
  if (args.includes("--answers")) {
    const out = opt("out");
    const report = await runAnswerEval(await localEnv(), golden, opt("only")?.split(","));
    if (out) await writeFile(out, JSON.stringify(report, null, 2));
    return;
  }
  const remote = args.includes("--remote");
  const modes = (opt("modes") ?? "vector,keyword,hybrid,rerank").split(",") as Mode[];
  const search = await searcher(remote);
  const paperOf = new Map(await Promise.all(golden.questions.map(async (q) => [q.doi, await paperIdFor("public", q.doi)] as const)));

  const report: Record<string, unknown> = { at: new Date().toISOString(), host: remote ? PROD_URL : "local (REST)", args };
  console.log(`Golden set: ${golden.questions.length} answerable + ${golden.unanswerable.length} unanswerable · ${report.host}\n`);
  console.log("mode     recall@1 recall@6 recall@10  MRR   p50 ms  p95 ms");

  for (const mode of modes) {
    const rows = await pool(golden.questions, 4, async (q) => {
      const { hits, timings } = await search(q.question, mode);
      const paperId = paperOf.get(q.doi);
      const rank =
        hits.findIndex((h) => h.paper_id === paperId && h.section === q.section && h.page_start <= q.pages[1] && h.page_end >= q.pages[0]) + 1;
      return { id: q.id, style: q.style, rank, top: topRerank(hits), ms: timings.roundTrip ?? timings.total ?? 0, timings };
    });
    const neg = await pool(golden.unanswerable, 4, async (q) => {
      const { hits } = await search(q.question, mode);
      return { id: q.id, top: topRerank(hits) };
    });
    const ranks = rows.map((r) => r.rank);
    const ms = rows.map((r) => r.ms);
    const summary = {
      recall1: mean(ranks.map((r) => recallAt(r, 1))),
      recall6: mean(ranks.map((r) => recallAt(r, 6))),
      recall10: mean(ranks.map((r) => recallAt(r, 10))),
      mrr: mean(ranks.map(reciprocal)),
      p50: pct(ms, 0.5),
      p95: pct(ms, 0.95),
    };
    report[mode] = { summary, rows, unanswerable: neg };
    const f = (x: number) => x.toFixed(3).padStart(8);
    console.log(`${mode.padEnd(8)}${f(summary.recall1)}${f(summary.recall6)}${f(summary.recall10)}${f(summary.mrr)}${String(summary.p50).padStart(8)}${String(summary.p95).padStart(8)}`);
    const misses = rows.filter((r) => r.rank === 0 || r.rank > 6).map((r) => `${r.id}${r.rank ? `@${r.rank}` : ""}`);
    if (misses.length) console.log(`         missed@6: ${misses.join(" ")}`);
    if (mode === "rerank") {
      const fmt = (xs: (number | null)[]) => xs.map((x) => (x === null ? "-" : x.toFixed(3))).join(" ");
      console.log(`         top rerank score, answerable & found@1: ${fmt(rows.filter((r) => r.rank === 1).map((r) => r.top).sort())}`);
      console.log(`         top rerank score, answerable & missed@1: ${fmt(rows.filter((r) => r.rank !== 1).map((r) => r.top).sort())}`);
      console.log(`         top rerank score, unanswerable:       ${fmt(neg.map((r) => r.top).sort())}`);
    }
  }
  const out = opt("out");
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
