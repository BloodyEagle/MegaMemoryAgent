import { exec, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { KnowledgeDB } from "./db.js";
import { estimateTokens, understand } from "./tools.js";
import { parseRef } from "./refs.js";
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
export type BenchQuality = "pass" | "fail" | "unknown";
export type BenchCompleteness = "complete" | "truncated" | "unknown";
export interface QualityState {
  quality: BenchQuality;
  completeness: BenchCompleteness;
  measurement: "live" | "preset" | "not_measured";
  reasons: string[];
}
export interface QualityContract {
  adapter: "ts_search" | "py_search" | "har_search" | "generic_json";
}

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
  /** Extra roots for relative file_refs (plan 2.1.6 F3); overrides the run-level --ref-root. */
  ref_roots?: string[];
  expected_outcome?: "match" | "no_match";
  quality_contract?: QualityContract;
  expected_te_refs?: string[];
  expected_te_symbols?: string[];
  expected_te_edges?: string[];
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
    if (obj.expected_outcome !== undefined && !["match", "no_match"].includes(String(obj.expected_outcome))) {
      throw new Error(`questions file, line ${i + 1}: invalid expected_outcome`);
    }
    if (obj.quality_contract !== undefined && (
      !obj.quality_contract || typeof obj.quality_contract !== "object" ||
      !["ts_search", "py_search", "har_search", "generic_json"].includes(String((obj.quality_contract as QualityContract).adapter))
    )) throw new Error(`questions file, line ${i + 1}: invalid quality_contract.adapter`);
    for (const key of ["expected_te_refs", "expected_te_symbols", "expected_te_edges"]) {
      if (obj[key] !== undefined && (!Array.isArray(obj[key]) || !(obj[key] as unknown[]).every((v) => typeof v === "string" && v !== ""))) {
        throw new Error(`questions file, line ${i + 1}: ${key} must be an array of nonempty strings`);
      }
    }
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
      expected_outcome: obj.expected_outcome as BenchQuestion["expected_outcome"],
      quality_contract: obj.quality_contract as QualityContract | undefined,
      expected_te_refs: obj.expected_te_refs as string[] | undefined,
      expected_te_symbols: obj.expected_te_symbols as string[] | undefined,
      expected_te_edges: obj.expected_te_edges as string[] | undefined,
      ref_roots: Array.isArray(obj.ref_roots)
        ? (obj.ref_roots as unknown[]).filter((r): r is string => typeof r === "string" && r !== "")
        : undefined,
    });
  }
  return questions;
}

export class BenchError extends Error {}

export interface TeRunResult {
  stdout: string;
  durationMs: number;
  stderr?: string;
  exitCode?: number | null;
  error?: string;
  stdoutBytes?: number;
  stdoutCapturedBytes?: number;
  stdoutTruncated?: boolean;
  stderrBytes?: number;
  stderrTruncated?: boolean;
  completeness?: "complete" | "truncated" | "unknown";
}

/**
 * C-06 (plan 05): the structured query→runner boundary. The query travels as
 * ONE literal argv entry — no shell, no quoting, no %-expansion on Windows.
 */
export interface TeRunnerSpec {
  /** Program to run, executed directly (no shell). */
  executable: string;
  /**
   * Argv prefix; the entry containing the {query} placeholder receives the
   * literal query in its place. At least one entry must contain {query}.
   */
  args: string[];
}

export interface BenchOptions {
  baseline: BenchBaselineMode;
  /** Run-level te command template with {query}; required in te/both mode unless every question carries te_cmd or a preset. */
  teCmd?: string;
  /**
   * Structured runner (C-06, plan 05) — the default boundary for the query:
   * executable + literal argv, spawned without a shell. Takes precedence
   * over teCmd and per-question te_cmd.
   */
  teRunner?: TeRunnerSpec;
  fileLimitBytes?: number;
  /** Root for resolving relative file_refs (default: process.cwd()). */
  root?: string;
  /** Extra roots for relative file_refs (plan 2.1.6 F3), repeatable, in order. Tried before the cwd. */
  refRoots?: string[];
  /** Files baseline over the first N unique files in output order (plan 2.1.6 F4); 0 = all, the 2.1.5 behavior. */
  filesTopN?: number;
  /**
   * Injectable te runner for tests — counts invocations, skips the shell.
   * Default: child_process.exec with a 60 s cap per command.
   */
  runTeCommand?: (cmd: string) => Promise<TeRunResult>;
  /**
   * Injectable structured runner for tests. Default: spawn without a shell,
   * 60 s cap, timeout kills only this runner's own process tree.
   */
  runTeProgram?: (executable: string, args: string[]) => Promise<TeRunResult>;
  /**
   * Injectable git root lookup (plan 2.1.6 F3). Default: `git rev-parse --show-toplevel`
   * run from the cwd; null when git is absent or the cwd is not a repository.
   */
  resolveGitRoot?: (cwd: string) => string | null | Promise<string | null>;
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
  /** baseline over the first filesTopN unique files in output order (null when filesTopN = 0) */
  baseline_files_top_tokens: number | null;
  baseline_te_tokens: number | null;
  ratio_files: number | null;
  ratio_files_top: number | null;
  ratio_te: number | null;
  /** any file over the limit in this question (counted by size) */
  estimated: boolean;
  missing_files: number;
  /** refs of this question carrying a :line or :line-line suffix (plan 2.1.6 F2) */
  line_refs: number;
  /** null = the question carries no expect_nodes */
  hit: boolean | null;
  /**
   * 1-based position of the best (first) expected node in the output; null
   * when absent or missed (plan 2.1.6 F1). 2.1.7 F3: rank over the union —
   * a support folded under its decision (2.1.7 F2) ranks at the decision's
   * position, it is still in the answer.
   */
  expected_rank: number | null;
  /**
   * ids in the output order, up to the top_k — top level first, then the
   * folded (nested) supports; which of them came nested is marked in
   * nested_ids.
   */
  top_ids: string[];
  /** 2.1.7 F3: subset of top_ids that travelled nested under their decisions. */
  nested_ids: string[];
  /** found nodes whose support_check.state = changed */
  stale_hits: number;
  /** ids of those found nodes (plan 2.1.6 F5) */
  stale_ids: string[];
  /** found decisions with no confirmed snapshot (none at all or never checked) */
  unknown_supports: number;
  /** ids of those decisions (plan 2.1.6 F5) */
  unknown_support_ids: string[];
  time_to_graph_ms: number;
  time_to_baseline_ms: number | null;
  time_to_te_ms: number | null;
  /** true when baseline_te_tokens came from the questions file, not a run */
  te_used_preset: boolean;
  graph_quality: QualityState;
  te_quality: QualityState;
  comparison_te: "eligible" | "not_comparable";
  comparison_te_reasons: string[];
  quality_ratio_te: number | null;
  te_stdout_bytes: number | null;
  te_stdout_captured_bytes: number | null;
  te_stdout_truncated: boolean;
  te_captured_prefix_tokens: number | null;
  te_exit_code: number | null;
  te_error: string | null;
}

export interface ModeSummary {
  graph_tokens: number;
  baseline_tokens: number;
  /** median over questions with a defined ratio */
  median_ratio: number | null;
  /** files mode only: totals and median for the --files-top baseline (plan 2.1.6 F4) */
  baseline_top_tokens?: number;
  median_ratio_top?: number | null;
  /** questions where the graph lost: ratio < 1 */
  lost: number;
  /** questions with a defined ratio (0-graph-token questions excluded) */
  compared: number;
}

/** How a relative file_ref was rooted this run (plan 2.1.6 F3). */
export type RefRootLabel = "question" | "--ref-root" | "git-root" | "cwd" | "absolute";

export interface RefsSummary {
  /** unique refs seen this run */
  total: number;
  resolved: number;
  /** resolved refs per root label, first hit wins */
  roots: Partial<Record<RefRootLabel, number>>;
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
  /** the --files-top N the run was made with (0 = off) */
  files_top_n: number;
  /** unique file_refs resolution stats (plan 2.1.6 F3); null in te-only mode */
  refs: RefsSummary | null;
  /** share of questions where an expect_node surfaced in the top-10 */
  hit_rate: number | null;
  /** share where the best expected node ranked first (plan 2.1.6 F1); ≤ hit_rate */
  hit_rate_at_1: number | null;
  hits: number;
  hits_at_1: number;
  expected_total: number;
  stale_hits: number;
  /** union of per-question stale ids */
  stale_ids: string[];
  unknown_supports: number;
  /** union of per-question unknown-support ids */
  unknown_support_ids: string[];
  /** true when the first question paid a model load (plan 2.1.6 F6) */
  cold_start: boolean;
  warmup_ms: number | null;
  median_time_wo_warmup_ms: number | null;
  per_lang: LangSummary[];
  disclaimer: string;
  graph_metric: "retrieval_wire_without_instructions";
  instructions_scope: "excluded";
  economy_status: "not_measured";
  quality_summary: {
    total: number;
    graph: Record<BenchQuality, number>;
    te: Record<BenchQuality, number>;
    eligible_te: number;
    errors_te: number;
    truncated_te: number;
    preset_te: number;
    median_quality_ratio_te: number | null;
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Split a locator suffix off a file ref (plan 2.1.6 F2; 2.1.13 F2 — реализация
 * одна, в src/refs.ts). Формы: path, path:12, path:12-30, path#L12,
 * path#L12-L30. Git-схемы не режутся вовсе: «git:tag:2026» — это тег «2026»,
 * а не путь «git:tag» с локатором. Windows не задет: буква диска (C:\…, двоеточие
 * на индексе 1) и двоеточие внутри имени («a:b.ts» — хвост не цифры) остаются.
 * Пустой суффикс («src/db.ts:») — не суффикс: ссылка остаётся целой и резолвится
 * как missing.
 */
export function splitRefSuffix(ref: string): { path: string; suffix: string } {
  const parsed = parseRef(ref);
  return { path: parsed.path, suffix: parsed.locator ?? "" };
}

/**
 * Cold start of a run (plan 2.1.6 F6): the first question paid a model load.
 * The first time is never silently dropped — the report prints the warmup
 * duration next to the median of the remaining questions.
 */
export interface ColdStartInfo {
  cold: boolean;
  warmupMs: number | null;
  medianWithoutWarmupMs: number | null;
}

export function detectColdStart(times: number[]): ColdStartInfo {
  if (times.length < 2) return { cold: false, warmupMs: null, medianWithoutWarmupMs: null };
  const [first, ...rest] = times;
  const restMedian = median(rest);
  const cold = restMedian !== null && first > 5 * restMedian;
  return {
    cold,
    warmupMs: cold ? first : null,
    medianWithoutWarmupMs: cold ? restMedian : null,
  };
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
 *
 * C-06 (plan 05): this quoting is inherently lossy (%VAR% expands even in
 * cmd.exe quotes) — shell templates are the explicitly trusted mode; the
 * default boundary is TeRunnerSpec + runTeProgram, which quotes nothing.
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

const TE_PROGRAM_TIMEOUT_MS = 60_000;
const TE_PROGRAM_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * C-06 (plan 05): the default structured runner — argv goes to the child
 * literally (no shell on any platform), so %VARS%, quotes, ampersands,
 * backslashes and unicode stay data. On timeout only this runner's own
 * process tree is killed: taskkill /T on Windows, the process group on
 * POSIX (SIGTERM, then SIGKILL). Failures carry the exit status and a
 * bounded stderr tail.
 */
export interface TeProgramOptions {
  /** Test seams: tiny byte caps and fake child streams, never a large load. */
  maxBufferBytes?: number;
  timeoutMs?: number;
  spawnProgram?: typeof spawn;
}

export async function defaultRunTeProgram(
  executable: string, args: string[], options: TeProgramOptions = {}
): Promise<TeRunResult> {
  const t0 = performance.now();
  const cap = options.maxBufferBytes ?? TE_PROGRAM_MAX_BUFFER;
  const timeoutMs = options.timeoutMs ?? TE_PROGRAM_TIMEOUT_MS;
  if (!Number.isSafeInteger(cap) || cap < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new BenchError("invalid te runner byte cap or timeout");
  }
  return new Promise<TeRunResult>((resolve) => {
    const child = (options.spawnProgram ?? spawn)(executable, args, {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      detached: process.platform !== "win32",
    });
    const output = () => ({ bytes: 0, retained: 0, text: "", decoder: new StringDecoder("utf8") });
    const stdout = output();
    const stderr = output();
    let settled = false;
    let killedByTimeout = false;
    const collect = (stream: ReturnType<typeof output>, chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      stream.bytes += bytes.length;
      const prefix = bytes.subarray(0, Math.max(0, cap - stream.retained));
      stream.retained += prefix.length;
      stream.text += stream.decoder.write(prefix);
    };
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) { child.kill(signal); return; }
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore",
        });
        killer.on("error", () => child.kill(signal));
      } else {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      }
    };
    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalateTimer);
      // Do not flush a decoder's incomplete final code point into U+FFFD.
      const stdoutTruncated = stdout.bytes > cap;
      const stderrTruncated = stderr.bytes > cap;
      const stdoutCapturedBytes = Buffer.byteLength(stdout.text, "utf8");
      if (!stdoutTruncated && stdoutCapturedBytes !== stdout.retained) error ??= "incomplete UTF-8 stdout";
      resolve({
        stdout: stdout.text, stderr: stderr.text, exitCode, error,
        durationMs: performance.now() - t0,
        stdoutBytes: stdout.bytes, stdoutCapturedBytes: Buffer.byteLength(stdout.text, "utf8"),
        stdoutTruncated, stderrBytes: stderr.bytes, stderrTruncated,
        completeness: stdoutTruncated ? "truncated" : error ? "unknown" : "complete",
      });
    };
    const timer = setTimeout(() => {
      killedByTimeout = true;
      killTree("SIGTERM");
    }, timeoutMs);
    const escalateTimer = setTimeout(() => {
      if (!settled && killedByTimeout) killTree("SIGKILL");
    }, timeoutMs + 5_000);
    child.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (err: Error) => finish(null, `could not start ${executable}: ${err.message}`));
    child.on("close", (code, signal) => {
      const error = killedByTimeout ? `timeout after ${timeoutMs} ms (own process tree terminated)`
        : signal !== null ? `terminated by ${signal}`
        : code !== 0 && code !== 1 ? `exit code ${code}` : undefined;
      finish(code, error);
    });
  });
}

/** F3: git root of the cwd, or null when git is absent or the cwd is not a repository. */
async function defaultResolveGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", {
      cwd,
      timeout: 5_000,
    });
    const p = stdout.trim();
    return p !== "" ? p : null;
  } catch {
    return null;
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

function qualityState(
  quality: BenchQuality, completeness: BenchCompleteness,
  measurement: QualityState["measurement"], ...reasons: string[]
): QualityState { return { quality, completeness, measurement, reasons }; }

/** Explicit source adapters: a successful process is not a payload oracle. */
function teQuality(q: BenchQuestion, run: TeRunResult | null, preset: boolean): QualityState {
  if (preset) return qualityState("unknown", "unknown", "preset", "preset_not_live");
  if (!run) return qualityState("unknown", "unknown", "not_measured", "not_measured");
  if (run.stdoutTruncated || run.completeness === "truncated") {
    return qualityState("unknown", "truncated", "live", "stdout_truncated");
  }
  if (run.error || run.completeness === "unknown") return qualityState("fail", "unknown", "live", "runner_error");
  const adapter = q.quality_contract?.adapter;
  if (!adapter) return qualityState("unknown", "unknown", "live", "adapter_missing");
  const refs: string[] = [], symbols: string[] = [], edges: string[] = [];
  let count = 0;
  let completeness: BenchCompleteness = "complete";
  const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  try {
    if (adapter === "py_search") {
      const text = run.stdout.trim();
      const negative = text.match(/^«([\s\S]*)»: совпадений нет \((\d+) файлов просмотрено\)$/);
      if (negative) {
        if (negative[1] !== q.query) throw new Error("wrong negative query");
      } else {
        const lines = text.split(/\r?\n/);
        const footer = lines.pop()?.match(/^-- совпадений: (\d+), файлов: (\d+)(?:, показано (\d+))?$/);
        if (!footer) throw new Error("missing text footer");
        count = Number(footer[1]);
        let file = "", shown = 0;
        for (const line of lines) {
          const match = line.match(/^\s+(\d+): (.*)$/);
          if (match && file) { refs.push(file, `${file}:${match[1]}`); shown++; }
          else if (line && !/^\s/.test(line)) file = line;
          else throw new Error("malformed text row");
        }
        if (count === 0 || shown > count || (footer[3] !== undefined && Number(footer[3]) !== shown)) throw new Error("invalid text count");
        if (shown < count) completeness = "truncated";
      }
    } else {
      const payload = JSON.parse(run.stdout);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || "error" in payload || payload.isError) throw new Error("error payload");
      if (adapter === "ts_search") {
        if (!integer(payload.count) || !Array.isArray(payload.matches) || payload.matches.length > payload.count) throw new Error("invalid search payload");
        count = payload.count;
        for (const item of payload.matches) {
          if (!item || typeof item.file !== "string" || !integer(item.line) || item.line < 1 || typeof item.text !== "string") throw new Error("invalid search row");
          refs.push(item.file, `${item.file}:${item.line}`);
        }
        if (count > payload.matches.length || payload.truncated === true) completeness = "truncated";
      } else if (adapter === "har_search") {
        if (payload.command !== "search" || !integer(payload.total) || !integer(payload.shown) || !integer(payload.omitted) ||
          typeof payload.truncated !== "boolean" || !Array.isArray(payload.items) || payload.shown !== payload.items.length ||
          payload.total !== payload.shown + payload.omitted) throw new Error("invalid HAR payload");
        count = payload.total;
        for (const item of payload.items) {
          if (!item || typeof item.url !== "string" || !integer(item.index)) throw new Error("invalid HAR row");
          refs.push(item.url);
        }
        if (payload.truncated || payload.omitted > 0) completeness = "truncated";
      } else {
        if (!Array.isArray(payload.results) || typeof payload.complete !== "boolean") throw new Error("invalid generic payload");
        count = payload.results.length;
        for (const item of payload.results) {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid generic row");
          for (const [key, target] of [["refs", refs], ["symbols", symbols], ["edges", edges]] as const) {
            if (item[key] !== undefined) {
              if (!strings(item[key])) throw new Error("invalid generic oracle fields");
              target.push(...item[key]);
            }
          }
        }
        if (!payload.complete) completeness = "truncated";
      }
    }
  } catch {
    return qualityState("fail", "unknown", "live", "invalid_payload");
  }
  const exit = run.exitCode ?? 0;
  const harNegative = adapter === "har_search" && count === 0 && completeness === "complete" && exit === 1 && !(run.stderr ?? "").trim();
  if (exit !== 0 && !harNegative) return qualityState("fail", completeness, "live", "exit_error");
  if (completeness !== "complete") return qualityState("unknown", completeness, "live", "adapter_truncated");
  if (!q.expected_outcome) return qualityState("unknown", completeness, "live", "outcome_missing");
  if (q.expected_outcome === "no_match") return qualityState(count === 0 ? "pass" : "fail", completeness, "live", ...(count ? ["unexpected_match"] : []));
  const expected = [q.expected_te_refs ?? [], q.expected_te_symbols ?? [], q.expected_te_edges ?? []];
  if (!expected.some((items) => items.length)) return qualityState("unknown", completeness, "live", "te_oracle_missing");
  const passed = count > 0 && expected.every((items, i) => items.every((item) => [refs, symbols, edges][i].includes(item)));
  return qualityState(passed ? "pass" : "fail", completeness, "live", ...(passed ? [] : ["te_oracle_mismatch"]));
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
 * hit_rate contract — and the default 1500-token budget. The estimator wraps
 * retrieval as MCP content but excludes runtime instructions metadata; this is
 * not exactly the default MCP response or a whole-task cost measurement.
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
  const runTeProgram = opts.runTeProgram ?? defaultRunTeProgram;
  const mode = opts.baseline;
  const filesTopN = opts.filesTopN ?? 0;

  // F3: the git root is one lookup per run, not per question.
  const resolveGitRoot = opts.resolveGitRoot ?? defaultResolveGitRoot;
  const gitRoot = await resolveGitRoot(root);
  // F3, уточнено планом 06 (C-05): (цепочка корней, ref) → разрешённый
  // абсолютный путь, кэш на весь прогон. Ключ включает ЦЕПОЧКУ корней
  // вопроса: один и тот же ref в разных проектах обязан разрешаться
  // по-разному (1/100 в прямом и обратном порядке вопросов), а miss по
  // одной цепочке не отравляет следующий вопрос с другой цепочкой.
  const refCache = new Map<string, { abs: string | null; label: RefRootLabel }>();

  const results: QuestionResult[] = [];

  for (const q of questions) {
    // Retrieval wire estimator without the MCP instructions metadata.
    const t0 = performance.now();
    let graphError: string | null = null;
    let r: Awaited<ReturnType<typeof understand>>;
    try { r = await understand(db, { query: q.query, top_k: 10 }); }
    catch (err) {
      graphError = err instanceof Error ? err.message : String(err);
      r = { matches: [], compact: [] };
    }
    const timeToGraphMs = performance.now() - t0;
    const graphTokens = r.meta?.tokens_estimated ?? 0;
    const matches = r.compact ?? [];
    // План 06 (K-03): tokens_estimated честный — пустой ответ стоит конверт.
    // «Граф-ответа нет» теперь значит «в выдаче нет узлов», не «ноль токенов».
    const hasGraphAnswer =
      matches.length > 0 || (r.refuted?.length ?? 0) > 0 || (r.matches?.length ?? 0) > 0;
    const ids = matches.map((m) => m.id);
    // 2.1.7 F3: nested supports are part of the answer — the rank space is
    // the union: top level in output order, a folded support at its
    // decision's rank. top_ids carries both (nested marked in nested_ids).
    const nestedIds = matches.flatMap((m) => (m.supports ?? []).map((s) => s.id));
    const rankOf = new Map<string, number>();
    ids.forEach((id, i) => rankOf.set(id, i + 1));
    for (const m of matches) {
      const hostRank = rankOf.get(m.id);
      if (hostRank === undefined) continue;
      for (const s of m.supports ?? []) {
        if (!rankOf.has(s.id)) rankOf.set(s.id, hostRank);
      }
    }
    const allIds = [...ids, ...nestedIds];
    // F1: 1-based position of the best expected node in the output order
    const expectedRank = (() => {
      if (!q.expect_nodes || q.expect_nodes.length === 0) return null;
      let best: number | null = null;
      for (const n of q.expect_nodes) {
        const at = rankOf.get(n);
        if (at !== undefined && (best === null || at < best)) best = at;
      }
      return best;
    })();

    // 2a. files baseline: the files you would have read instead
    let baselineFiles: number | null = null;
    let baselineFilesTop: number | null = null;
    let timeToBaselineMs: number | null = null;
    let estimated = false;
    let missing = 0;
    let lineRefs = 0;
    if (mode === "files" || mode === "both") {
      // missing refs contribute 0, not null — the ratio stays defined (lost), as in 2.1.5
      baselineFiles = 0;
      const t1 = performance.now();
      const chain: { label: RefRootLabel; dir: string }[] = [];
      for (const dir of q.ref_roots ?? []) chain.push({ label: "question", dir });
      for (const dir of opts.refRoots ?? []) chain.push({ label: "--ref-root", dir });
      if (gitRoot) chain.push({ label: "git-root", dir: gitRoot });
      chain.push({ label: "cwd", dir: root });

      // unique refs in output order: nodes in top_ids order, refs as stored
      const refOrder: string[] = [];
      const refSeen = new Set<string>();
      for (const m of matches) {
        for (const ref of m.file_refs ?? []) {
          if (!refSeen.has(ref)) {
            refSeen.add(ref);
            refOrder.push(ref);
          }
        }
      }

      // F2: split the :line suffix, then F3: resolve against the root chain.
      // План 06 (C-05): ключ кэша — вся цепочка корней этого вопроса плюс
      // ref; baseline инвариантен к порядку вопросов.
      const chainKey = chain.map((entry) => entry.dir).join("::");
      const resolved: { ref: string; clean: string; abs: string | null }[] = [];
      for (const ref of refOrder) {
        const { path: clean, suffix } = splitRefSuffix(ref);
        if (suffix) lineRefs += 1;
        const cacheKey = `${chainKey}::${ref}`;
        const cached = refCache.get(cacheKey);
        if (cached) {
          resolved.push({ ref, clean, abs: cached.abs });
          continue;
        }
        let abs: string | null = null;
        for (const rootEntry of chain) {
          const candidate = path.resolve(rootEntry.dir, clean);
          try {
            fs.statSync(candidate);
            abs = candidate;
            refCache.set(cacheKey, { abs, label: rootEntry.label });
            break;
          } catch {
            // try the next root
          }
        }
        if (abs === null) refCache.set(cacheKey, { abs: null, label: "cwd" });
        resolved.push({ ref, clean, abs });
      }

      // unique files in output order (missing refs keep their raw ref as key)
      const fileKeys = new Set<string>();
      const orderedFiles: { tokens: number }[] = [];
      for (const res of resolved) {
        const key = res.abs ?? `missing:${res.ref}`;
        if (fileKeys.has(key)) continue;
        fileKeys.add(key);
        if (res.abs === null) {
          missing += 1;
          continue;
        }
        const stat = countFile(res.clean, res.abs, fileLimitBytes);
        if (stat.missing) {
          missing += 1;
          continue;
        }
        if (stat.estimated) estimated = true;
        baselineFiles = (baselineFiles ?? 0) + stat.tokens;
        orderedFiles.push({ tokens: stat.tokens });
      }

      // F4: the top-of-output subset — what a live agent would actually read
      if (filesTopN > 0) {
        let taken = 0;
        let topTokens = 0;
        for (const f of orderedFiles) {
          if (taken >= filesTopN) break;
          topTokens += f.tokens;
          taken += 1;
        }
        baselineFilesTop = topTokens;
      }
      timeToBaselineMs = performance.now() - t1;
    }

    // 2b. te baseline: an external structural tool, or the preset from the file
    let baselineTe: number | null = null;
    let timeToTeMs: number | null = null;
    let usedPreset = false;
    let teRun: TeRunResult | null = null;
    if (mode === "te" || mode === "both") {
      if (q.baseline_te_tokens !== undefined) {
        // recorded beforehand — the external command is not run at all
        baselineTe = q.baseline_te_tokens;
        usedPreset = true;
        timeToTeMs = 0;
      } else {
        // C-06 (plan 05): the structured executable+argv runner is the
        // default boundary and takes precedence; a shell template (--te-cmd /
        // per-question te_cmd) is the explicitly trusted mode — the user
        // vouched for the whole string, shell semantics included.
        if (opts.teRunner) {
          if (!opts.teRunner.args.some((a) => a.includes("{query}"))) {
            throw new BenchError(
              `Question "${q.id}": the structured te runner needs one argv entry containing {query}, got: ` +
                JSON.stringify(opts.teRunner.args)
            );
          }
          const args = opts.teRunner.args.map((a) => a.split("{query}").join(q.query));
          try { teRun = await runTeProgram(opts.teRunner.executable, args); }
          catch (err) { teRun = { stdout: "", durationMs: 0, error: err instanceof Error ? err.message : String(err), completeness: "unknown" }; }
        } else {
          const template = q.te_cmd ?? opts.teCmd;
          if (!template) {
            throw new BenchError(
              `Question "${q.id}": --baseline te needs a command template with {query} — ` +
                'pass --te-exec/--te-arg (no shell) or --te-cmd "tool path {query}" (trusted shell) for the run, ' +
                'or "te_cmd" for this question.'
            );
          }
          if (!template.includes("{query}")) {
            throw new BenchError(
              `Question "${q.id}": the te command template must contain {query}, got: ${template}`
            );
          }
          try { teRun = await runTe(substituteQuery(template, q.query)); }
          catch (err) { teRun = { stdout: "", durationMs: 0, error: err instanceof Error ? err.message : String(err), completeness: "unknown" }; }
        }
      }
    }

    if (teRun) {
      timeToTeMs = teRun.durationMs;
      const acceptedExit = (teRun.exitCode ?? 0) === 0 || q.quality_contract?.adapter === "har_search";
      if (!teRun.error && acceptedExit && !teRun.stdoutTruncated && teRun.completeness !== "truncated" && teRun.completeness !== "unknown") {
        baselineTe = estimateTokens(teRun.stdout);
      }
    }
    const graphComplete: BenchCompleteness = graphError || !r.meta ? "unknown"
      : r.meta.truncated || r.meta.dropped > 0 ? "truncated" : "complete";
    const graphPassed = q.expected_outcome === "no_match" ? !hasGraphAnswer
      : (q.expect_nodes?.length ?? 0) > 0 && q.expect_nodes!.every((id) => allIds.includes(id));
    const graphQuality = graphError ? qualityState("fail", "unknown", "not_measured", "graph_error")
      : !q.expected_outcome || (q.expected_outcome === "match" && !q.expect_nodes?.length)
        ? qualityState("unknown", graphComplete, "live", "graph_oracle_missing")
        : qualityState(graphPassed ? "pass" : "fail", graphComplete, "live", ...(graphPassed ? [] : ["graph_oracle_mismatch"]));
    const externalQuality = teQuality(q, teRun, usedPreset);
    const comparisonReasons: string[] = [];
    if (graphQuality.quality !== "pass") comparisonReasons.push("graph_quality_not_pass");
    if (externalQuality.quality !== "pass") comparisonReasons.push("te_quality_not_pass");
    if (graphQuality.completeness !== "complete" || externalQuality.completeness !== "complete") comparisonReasons.push("incomplete");
    if (graphQuality.measurement !== "live" || externalQuality.measurement !== "live") comparisonReasons.push("not_live");
    if (!(graphTokens > 0 && Number.isFinite(graphTokens) && baselineTe !== null && baselineTe > 0 && Number.isFinite(baselineTe))) comparisonReasons.push("nonpositive_or_unmeasured_cost");
    const eligibleTe = comparisonReasons.length === 0;

    // 3. provenance bookkeeping over the found nodes — the union, not just
    // the top level: a nested support is still in the answer (2.1.7 F3), so
    // its check still feeds stale_hits/unknown_supports.
    let staleHits = 0;
    let unknownSupports = 0;
    const staleIds: string[] = [];
    const unknownIds: string[] = [];
    for (const id of allIds) {
      const node = db.getNode(id);
      if (!node) continue;
      const check = computeSupportCheck(
        db,
        id,
        new CheckBudget(DEFAULT_MAX_CHECK_EDGES, DEFAULT_MAX_CHECK_BYTES)
      );
      if (check?.state === "changed") {
        staleHits += 1;
        staleIds.push(id);
      }
      if (node.kind === "decision" && (check === null || check.state === "unknown")) {
        unknownSupports += 1;
        unknownIds.push(id);
      }
    }

    results.push({
      id: q.id,
      query: q.query,
      lang: q.lang,
      graph_tokens: graphTokens,
      baseline_files_tokens: baselineFiles,
      baseline_files_top_tokens: baselineFilesTop,
      baseline_te_tokens: baselineTe,
      ratio_files:
        hasGraphAnswer && baselineFiles !== null ? ratio(baselineFiles, graphTokens) : null,
      ratio_files_top:
        hasGraphAnswer && baselineFilesTop !== null
          ? ratio(baselineFilesTop, graphTokens)
          : null,
      ratio_te:
        hasGraphAnswer && baselineTe !== null ? ratio(baselineTe, graphTokens) : null,
      estimated,
      missing_files: missing,
      line_refs: lineRefs,
      hit:
        q.expect_nodes && q.expect_nodes.length > 0
          ? q.expect_nodes.some((n) => rankOf.has(n))
          : null,
      expected_rank: expectedRank,
      top_ids: allIds,
      nested_ids: nestedIds,
      stale_hits: staleHits,
      stale_ids: staleIds,
      unknown_supports: unknownSupports,
      unknown_support_ids: unknownIds,
      time_to_graph_ms: timeToGraphMs,
      time_to_baseline_ms: timeToBaselineMs,
      time_to_te_ms: timeToTeMs,
      te_used_preset: usedPreset,
      graph_quality: graphQuality,
      te_quality: externalQuality,
      comparison_te: eligibleTe ? "eligible" : "not_comparable",
      comparison_te_reasons: comparisonReasons,
      quality_ratio_te: eligibleTe ? baselineTe! / graphTokens : null,
      te_stdout_bytes: teRun ? teRun.stdoutBytes ?? Buffer.byteLength(teRun.stdout, "utf8") : null,
      te_stdout_captured_bytes: teRun ? teRun.stdoutCapturedBytes ?? Buffer.byteLength(teRun.stdout, "utf8") : null,
      te_stdout_truncated: teRun?.stdoutTruncated ?? teRun?.completeness === "truncated",
      te_captured_prefix_tokens: teRun?.stdoutTruncated || teRun?.completeness === "truncated" ? estimateTokens(teRun.stdout) : null,
      te_exit_code: teRun ? teRun.exitCode ?? 0 : null,
      te_error: teRun?.error ?? ((teRun?.exitCode ?? 0) !== 0 && externalQuality.quality !== "pass" ? `exit code ${teRun!.exitCode}` : null),
    });
  }

  const withExpect = results.filter((q) => q.hit !== null);
  const hits = withExpect.filter((q) => q.hit === true).length;
  const hitsAt1 = withExpect.filter((q) => q.expected_rank === 1).length;

  // F3: refs resolution stats over the whole run
  let refsSummary: RefsSummary | null = null;
  if (mode === "files" || mode === "both") {
    const roots: Partial<Record<RefRootLabel, number>> = {};
    let resolvedCount = 0;
    for (const entry of refCache.values()) {
      if (entry.abs !== null) {
        resolvedCount += 1;
        roots[entry.label] = (roots[entry.label] ?? 0) + 1;
      }
    }
    refsSummary = { total: refCache.size, resolved: resolvedCount, roots };
  }

  // F6: the first question paying a model load is reported, never dropped silently
  const cold = detectColdStart(results.map((q) => q.time_to_graph_ms));

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

  const filesSummary =
    mode === "files" || mode === "both"
      ? summarize(results, (q) => ({ baseline: q.baseline_files_tokens, ratio: q.ratio_files }))
      : null;
  if (filesSummary && filesTopN > 0) {
    const tops = results
      .map((q) => q.ratio_files_top)
      .filter((v): v is number => v !== null);
    filesSummary.baseline_top_tokens = results.reduce(
      (s, q) => s + (q.baseline_files_top_tokens ?? 0),
      0
    );
    filesSummary.median_ratio_top = median(tops);
  }

  const staleIdsUnion = [...new Set(results.flatMap((q) => q.stale_ids))];
  const unknownIdsUnion = [...new Set(results.flatMap((q) => q.unknown_support_ids))];

  return {
    mode,
    questions: results,
    files: filesSummary,
    te:
      mode === "te" || mode === "both"
        ? summarize(results, (q) => ({ baseline: q.baseline_te_tokens, ratio: q.ratio_te }))
        : null,
    files_top_n: filesTopN,
    refs: refsSummary,
    hit_rate: withExpect.length > 0 ? hits / withExpect.length : null,
    hit_rate_at_1: withExpect.length > 0 ? hitsAt1 / withExpect.length : null,
    hits,
    hits_at_1: hitsAt1,
    expected_total: withExpect.length,
    stale_hits: results.reduce((s, q) => s + q.stale_hits, 0),
    stale_ids: staleIdsUnion,
    unknown_supports: results.reduce((s, q) => s + q.unknown_supports, 0),
    unknown_support_ids: unknownIdsUnion,
    cold_start: cold.cold,
    warmup_ms: cold.warmupMs,
    median_time_wo_warmup_ms: cold.medianWithoutWarmupMs,
    per_lang: perLang,
    disclaimer: BENCH_DISCLAIMER,
    graph_metric: "retrieval_wire_without_instructions",
    instructions_scope: "excluded",
    economy_status: "not_measured",
    quality_summary: {
      total: results.length,
      graph: {
        pass: results.filter((q) => q.graph_quality.quality === "pass").length,
        fail: results.filter((q) => q.graph_quality.quality === "fail").length,
        unknown: results.filter((q) => q.graph_quality.quality === "unknown").length,
      },
      te: {
        pass: results.filter((q) => q.te_quality.quality === "pass").length,
        fail: results.filter((q) => q.te_quality.quality === "fail").length,
        unknown: results.filter((q) => q.te_quality.quality === "unknown").length,
      },
      eligible_te: results.filter((q) => q.comparison_te === "eligible").length,
      errors_te: results.filter((q) => q.te_error !== null).length,
      truncated_te: results.filter((q) => q.te_quality.completeness === "truncated").length,
      preset_te: results.filter((q) => q.te_used_preset).length,
      median_quality_ratio_te: median(results.map((q) => q.quality_ratio_te).filter((v): v is number => v !== null)),
    },
  };
}
