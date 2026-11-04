import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { KnowledgeDB } from "./db.js";
import { estimateTokens, understand } from "./tools.js";
import {
  CheckBudget,
  DEFAULT_MAX_CHECK_BYTES,
  DEFAULT_MAX_CHECK_EDGES,
  computeSupportCheck,
} from "./support-baselines.js";

// ---- `megamemory bench` (plan 2.1.5 F3) ----
//
// Give numbers, not vibes: how many tokens does it cost to ORIENT and answer
// via the graph versus the alternatives. What is measured is the cost of
// orientation, NOT the quality of the answer — that is why hit_rate travels
// with every ratio, and questions where the graph lost (ratio < 1) are
// printed, not hidden.

const execAsync = promisify(exec);

/** Plan F3: files over the size limit are counted by size, not by content. */
export const DEFAULT_FILE_LIMIT_BYTES = 200 * 1024;

export const BENCH_DISCLAIMER =
  "Measures orientation cost, not answer quality — read ratio together with hit_rate: " +
  "a cheap but wrong answer is not savings.";

export type BenchBaselineMode = "files" | "te" | "both";

export interface BenchQuestion {
  id: string;
  query: string;
  /** Node ids that must surface in the top-10 for the hit to count. */
  expect_nodes?: string[];
  /** Reported next to the ratio; drives the per-language breakdown. */
  lang?: string;
  /** Per-question te command template; overrides the run-level --te-cmd. */
  te_cmd?: string;
  /** Pre-recorded te baseline: used as-is, the external command is not run. */
  baseline_te_tokens?: number;
}

/** Parse the questions.jsonl format. Throws on a malformed line. */
export function loadQuestions(text: string): BenchQuestion[] {
  const questions: BenchQuestion[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `questions file, line ${i + 1}: not valid JSON (${err instanceof Error ? err.message : String(err)})`
      );
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`questions file, line ${i + 1}: expected a JSON object`);
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.query !== "string" || obj.query.trim() === "") {
      throw new Error(`questions file, line ${i + 1}: missing required string field "query"`);
    }
    questions.push({
      id: typeof obj.id === "string" && obj.id !== "" ? obj.id : `q${questions.length + 1}`,
      query: obj.query,
      expect_nodes: Array.isArray(obj.expect_nodes)
        ? (obj.expect_nodes as unknown[]).filter((n): n is string => typeof n === "string")
        : undefined,
      lang: typeof obj.lang === "string" ? obj.lang : undefined,
      te_cmd: typeof obj.te_cmd === "string" ? obj.te_cmd : undefined,
      baseline_te_tokens:
        typeof obj.baseline_te_tokens === "number" && obj.baseline_te_tokens >= 0
          ? obj.baseline_te_tokens
          : undefined,
    });
  }
  return questions;
}

export class BenchError extends Error {}

export interface TeRunResult {
  stdout: string;
  durationMs: number;
}

export interface BenchOptions {
  baseline: BenchBaselineMode;
  /** Run-level te command template with {query}; required in te/both mode unless every question carries te_cmd or a preset. */
  teCmd?: string;
  fileLimitBytes?: number;
  /** Root for resolving relative file_refs (default: process.cwd()). */
  root?: string;
  /**
   * Injectable te runner for tests — counts invocations, skips the shell.
   * Default: child_process.exec with a 60 s cap per command.
   */
  runTeCommand?: (cmd: string) => Promise<TeRunResult>;
}

export interface FileStat {
  ref: string;
  tokens: number;
  /** true when the file was over the limit and counted by size, not content. */
  estimated: boolean;
  /** true when the file does not exist (counted as 0, reported honestly). */
  missing: boolean;
}

export interface QuestionResult {
  id: string;
  query: string;
  lang?: string;
  graph_tokens: number;
  baseline_files_tokens: number | null;
  baseline_te_tokens: number | null;
  ratio_files: number | null;
  ratio_te: number | null;
  /** any file over the limit in this question (counted by size) */
  estimated: boolean;
  missing_files: number;
  /** null = the question carries no expect_nodes */
  hit: boolean | null;
  /** found nodes whose support_check.state = changed */
  stale_hits: number;
  /** found decisions with no confirmed snapshot (none at all or never checked) */
  unknown_supports: number;
  time_to_graph_ms: number;
  time_to_baseline_ms: number | null;
  time_to_te_ms: number | null;
  /** true when baseline_te_tokens came from the questions file, not a run */
  te_used_preset: boolean;
}

export interface ModeSummary {
  graph_tokens: number;
  baseline_tokens: number;
  /** median over questions with a defined ratio */
  median_ratio: number | null;
  /** questions where the graph lost: ratio < 1 */
  lost: number;
  /** questions with a defined ratio (0-graph-token questions excluded) */
  compared: number;
}

export interface LangSummary {
  lang: string;
  questions: number;
  median_ratio_files: number | null;
  median_ratio_te: number | null;
}

export interface BenchReport {
  mode: BenchBaselineMode;
  questions: QuestionResult[];
  files: ModeSummary | null;
  te: ModeSummary | null;
  /** share of questions where an expect_node surfaced in the top-10 */
  hit_rate: number | null;
  hits: number;
  expected_total: number;
  stale_hits: number;
  unknown_supports: number;
  per_lang: LangSummary[];
  disclaimer: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ratio(baseline: number, graph: number): number | null {
  // A query that returned nothing has no "graph answer" to compare against:
  // the ratio is undefined, not infinite — the question is reported, the
  // summary median just skips it.
  return graph > 0 ? baseline / graph : null;
}

/**
 * {query} substitution. POSIX: single quotes with the standard quote-dance.
 * Windows: double quotes with MSVCRT-style escaping (\" and \\) — what node
 * and most argv-parsing tools expect via cmd.exe.
 */
export function substituteQuery(template: string, query: string): string {
  const escaped =
    process.platform === "win32"
      ? `"${query.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      : `'${query.replace(/'/g, "'\\''")}'`;
  return template.split("{query}").join(escaped);
}

async function defaultRunTeCommand(cmd: string): Promise<TeRunResult> {
  const t0 = performance.now();
  try {
    const { stdout } = await execAsync(cmd, {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, durationMs: performance.now() - t0 };
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message: string };
    const tail = (e.stderr ?? "").trim().split("\n").slice(-3).join("\n");
    throw new BenchError(
      `the te command failed: ${cmd}` +
        (e.killed ? " (killed by the 60 s timeout)" : "") +
        (tail ? `\n${tail}` : `\n${e.message}`)
    );
  }
}

/** Tokens of one file: by content, or by size when over the limit. */
function countFile(
  ref: string,
  absolutePath: string,
  fileLimitBytes: number
): FileStat {
  let size: number;
  try {
    size = fs.statSync(absolutePath).size;
  } catch {
    return { ref, tokens: 0, estimated: false, missing: true };
  }
  if (size > fileLimitBytes) {
    // estimateTokens is ~3 bytes per token — counting by size keeps the
    // same scale without paying the read.
    return { ref, tokens: Math.ceil(size / 3), estimated: true, missing: false };
  }
  const content = fs.readFileSync(absolutePath, "utf8");
  return { ref, tokens: estimateTokens(content), estimated: false, missing: false };
}

function summarize(
  questions: QuestionResult[],
  pick: (q: QuestionResult) => { baseline: number | null; ratio: number | null }
): ModeSummary {
  const graph = questions.reduce((s, q) => s + q.graph_tokens, 0);
  let baseline = 0;
  const ratios: number[] = [];
  let lost = 0;
  for (const q of questions) {
    const p = pick(q);
    if (p.baseline !== null) baseline += p.baseline;
    if (p.ratio !== null) {
      ratios.push(p.ratio);
      if (p.ratio < 1) lost += 1;
    }
  }
  return {
    graph_tokens: graph,
    baseline_tokens: baseline,
    median_ratio: median(ratios),
    lost,
    compared: ratios.length,
  };
}

/**
 * Run the bench over the questions. Understand is called with top_k 10 — the
 * hit_rate contract — and the default 1500-token budget, exactly what an
 * agent gets from the default compact mode.
 */
export async function runBench(
  db: KnowledgeDB,
  questions: BenchQuestion[],
  opts: BenchOptions
): Promise<BenchReport> {
  if (questions.length === 0) {
    throw new BenchError(
      "No questions to bench: the questions file is empty. " +
        'One JSON object per line: {"id","query","expect_nodes"?,"lang"?,"te_cmd"?,"baseline_te_tokens"?}.'
    );
  }

  const fileLimitBytes = opts.fileLimitBytes ?? DEFAULT_FILE_LIMIT_BYTES;
  const root = opts.root ?? process.cwd();
  const runTe = opts.runTeCommand ?? defaultRunTeCommand;
  const mode = opts.baseline;

  const results: QuestionResult[] = [];

  for (const q of questions) {
    // 1. the graph answer — same call the agent makes
    const t0 = performance.now();
    const r = await understand(db, { query: q.query, top_k: 10 });
    const timeToGraphMs = performance.now() - t0;
    const graphTokens = r.meta?.tokens_estimated ?? 0;
    const matches = r.compact ?? [];
    const ids = matches.map((m) => m.id);

    // 2a. files baseline: the files you would have read instead
    let baselineFiles: number | null = null;
    let timeToBaselineMs: number | null = null;
    let estimated = false;
    let missing = 0;
    if (mode === "files" || mode === "both") {
      const t1 = performance.now();
      const refs = new Set<string>();
      for (const m of matches) {
        for (const ref of m.file_refs ?? []) refs.add(ref);
      }
      let tokens = 0;
      for (const ref of refs) {
        const stat = countFile(ref, path.resolve(root, ref), fileLimitBytes);
        if (stat.missing) missing += 1;
        if (stat.estimated) estimated = true;
        tokens += stat.tokens;
      }
      timeToBaselineMs = performance.now() - t1;
      baselineFiles = tokens;
    }

    // 2b. te baseline: an external structural tool, or the preset from the file
    let baselineTe: number | null = null;
    let timeToTeMs: number | null = null;
    let usedPreset = false;
    if (mode === "te" || mode === "both") {
      if (q.baseline_te_tokens !== undefined) {
        // recorded beforehand — the external command is not run at all
        baselineTe = q.baseline_te_tokens;
        usedPreset = true;
        timeToTeMs = 0;
      } else {
        const template = q.te_cmd ?? opts.teCmd;
        if (!template) {
          throw new BenchError(
            `Question "${q.id}": --baseline te needs a command template with {query} — ` +
              'pass --te-cmd "tool path {query}" for the run or "te_cmd" for this question.'
          );
        }
        if (!template.includes("{query}")) {
          throw new BenchError(
            `Question "${q.id}": the te command template must contain {query}, got: ${template}`
          );
        }
        const run = await runTe(substituteQuery(template, q.query));
        baselineTe = estimateTokens(run.stdout);
        timeToTeMs = run.durationMs;
      }
    }

    // 3. provenance bookkeeping over the found nodes
    let staleHits = 0;
    let unknownSupports = 0;
    for (const id of ids) {
      const node = db.getNode(id);
      if (!node) continue;
      const check = computeSupportCheck(
        db,
        id,
        new CheckBudget(DEFAULT_MAX_CHECK_EDGES, DEFAULT_MAX_CHECK_BYTES)
      );
      if (check?.state === "changed") staleHits += 1;
      if (node.kind === "decision" && (check === null || check.state === "unknown")) {
        unknownSupports += 1;
      }
    }

    results.push({
      id: q.id,
      query: q.query,
      lang: q.lang,
      graph_tokens: graphTokens,
      baseline_files_tokens: baselineFiles,
      baseline_te_tokens: baselineTe,
      ratio_files: baselineFiles !== null ? ratio(baselineFiles, graphTokens) : null,
      ratio_te: baselineTe !== null ? ratio(baselineTe, graphTokens) : null,
      estimated,
      missing_files: missing,
      hit:
        q.expect_nodes && q.expect_nodes.length > 0
          ? q.expect_nodes.some((n) => ids.includes(n))
          : null,
      stale_hits: staleHits,
      unknown_supports: unknownSupports,
      time_to_graph_ms: timeToGraphMs,
      time_to_baseline_ms: timeToBaselineMs,
      time_to_te_ms: timeToTeMs,
      te_used_preset: usedPreset,
    });
  }

  const withExpect = results.filter((q) => q.hit !== null);
  const hits = withExpect.filter((q) => q.hit === true).length;

  // Per-language breakdown: medians per mode so one weak structural graph in
  // one language does not bury the picture for the rest of the repo.
  const langs = new Map<string, QuestionResult[]>();
  for (const q of results) {
    if (!q.lang) continue;
    const bucket = langs.get(q.lang) ?? [];
    bucket.push(q);
    langs.set(q.lang, bucket);
  }
  const perLang: LangSummary[] = [...langs.entries()].map(([lang, bucket]) => ({
    lang,
    questions: bucket.length,
    median_ratio_files: median(
      bucket.map((q) => q.ratio_files).filter((v): v is number => v !== null)
    ),
    median_ratio_te: median(
      bucket.map((q) => q.ratio_te).filter((v): v is number => v !== null)
    ),
  }));

  return {
    mode,
    questions: results,
    files:
      mode === "files" || mode === "both"
        ? summarize(results, (q) => ({ baseline: q.baseline_files_tokens, ratio: q.ratio_files }))
        : null,
    te:
      mode === "te" || mode === "both"
        ? summarize(results, (q) => ({ baseline: q.baseline_te_tokens, ratio: q.ratio_te }))
        : null,
    hit_rate: withExpect.length > 0 ? hits / withExpect.length : null,
    hits,
    expected_total: withExpect.length,
    stale_hits: results.reduce((s, q) => s + q.stale_hits, 0),
    unknown_supports: results.reduce((s, q) => s + q.unknown_supports, 0),
    per_lang: perLang,
    disclaimer: BENCH_DISCLAIMER,
  };
}
