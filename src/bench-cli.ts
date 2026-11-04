import fs from "node:fs";
import pc from "picocolors";
import { errorBold, info } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";
import { KnowledgeDB } from "./db.js";
import {
  BenchError,
  DEFAULT_FILE_LIMIT_BYTES,
  type BenchBaselineMode,
  type BenchQuestion,
  type BenchReport,
  type QuestionResult,
  type RefRootLabel,
  loadQuestions,
  runBench,
} from "./bench.js";

/**
 * `megamemory bench --db <база> --questions q.jsonl [--baseline files|te|both]
 *                 [--te-cmd "tool path {query}"] [--file-limit KB]
 *                 [--ref-root PATH]... [--files-top N]`
 *
 * Печатает таблицу по вопросам и итог: медиана отношения, суммарные токены,
 * число вопросов, где граф проиграл (ratio < 1), hit_rate и hit_rate@1 рядом с
 * каждым отношением — и честную оговорку (plan 2.1.5 F3, plan 2.1.6 F1–F6).
 */

function usage(): string {
  return [
    "Usage: megamemory bench --db <knowledge.db> --questions <file.jsonl>",
    "                        [--baseline files|te|both] [--te-cmd \"tool path {query}\"]",
    "                        [--file-limit KB] [--ref-root PATH]... [--files-top N]",
  ].join("\n");
}

function parseBaseline(value: string | undefined): BenchBaselineMode | null {
  return value === "files" || value === "te" || value === "both" ? value : null;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US").replace(/,/g, " ");
}

function fmtRatio(r: number | null): string {
  return r === null ? "n/a" : r.toFixed(2);
}

function fmtMs(ms: number | null): string {
  return ms === null ? "-" : `${Math.round(ms)}ms`;
}

function fmtDur(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Список id для итоговой строки: до 10 штук, дальше «+N». */
export function formatIdList(ids: string[]): string {
  if (ids.length === 0) return "";
  const head = ids.slice(0, 10).join(", ");
  return ids.length > 10 ? ` (ids: ${head} +${ids.length - 10})` : ` (ids: ${head})`;
}

/**
 * Заметки строки вопроса (plan 2.1.6 F2/F5/F6). `cold-start` получает только
 * первая строка отчёта — решение внутри, CLI передаёт отчёт как есть.
 */
export function questionNotes(
  q: QuestionResult,
  report: Pick<BenchReport, "cold_start" | "questions">
): string[] {
  const notes: string[] = [];
  if (q.estimated) notes.push("estimated");
  if (q.missing_files > 0) notes.push(`missing:${q.missing_files}`);
  if (q.line_refs > 0) notes.push("refs:line");
  if (q.te_used_preset) notes.push("te:preset");
  if (q.stale_ids.length > 0) notes.push(`st:${q.stale_ids.length}`);
  if (q.unknown_support_ids.length > 0) notes.push(`unk:${q.unknown_support_ids.length}`);
  if (report.cold_start && report.questions[0]?.id === q.id) notes.push("cold-start");
  return notes;
}

/** Строка warmup (plan 2.1.6 F6): обе цифры — warmup и медиана без него. */
export function formatWarmupLine(
  warmupMs: number | null,
  medianWithoutWarmupMs: number | null
): string | null {
  if (warmupMs === null || medianWithoutWarmupMs === null) return null;
  return (
    `  warmup: ${fmtDur(warmupMs)} (model load, excluded from median time) · ` +
    `median t(graph) w/o warmup: ${fmtMs(medianWithoutWarmupMs)}`
  );
}

const ROOT_ORDER: RefRootLabel[] = ["cwd", "git-root", "--ref-root", "question", "absolute"];

/** Строка refs (plan 2.1.6 F3): сколько рефов нашлось и в каких корнях. */
export function formatRefsLine(
  refs: NonNullable<BenchReport["refs"]>
): string {
  const roots = ROOT_ORDER.filter((l) => (refs.roots[l] ?? 0) > 0)
    .map((l) => `${l} ${refs.roots[l]}`)
    .join(", ");
  return `  refs: resolved ${refs.resolved}/${refs.total}` + (roots ? ` (roots: ${roots})` : "");
}

function printTable(report: BenchReport): void {
  const { mode } = report;
  const showFiles = mode === "files" || mode === "both";
  const showTe = mode === "te" || mode === "both";
  const showTop = showFiles && report.files_top_n > 0;

  const header = [
    "id".padEnd(10),
    "lang".padEnd(6),
    "graph".padStart(7),
    ...(showFiles
      ? ["files".padStart(8), "r(files)".padStart(9)]
      : []),
    ...(showTop ? ["files(top)".padStart(10)] : []),
    ...(showFiles
      ? ["t(graph)".padStart(9), "t(files)".padStart(9)]
      : []),
    ...(showTe
      ? ["te".padStart(8), "r(te)".padStart(8), "t(te)".padStart(9)]
      : []),
    "rank".padStart(5),
    "hit".padStart(4),
    "notes",
  ].join(" ");
  console.log(pc.dim(header));

  for (const q of report.questions) {
    const notes = questionNotes(q, report);

    const cells = [
      q.id.slice(0, 10).padEnd(10),
      (q.lang ?? "-").padEnd(6),
      fmtNum(q.graph_tokens).padStart(7),
      ...(showFiles
        ? [
            fmtNum(q.baseline_files_tokens ?? 0).padStart(8),
            fmtRatio(q.ratio_files).padStart(9),
          ]
        : []),
      ...(showTop ? [fmtNum(q.baseline_files_top_tokens ?? 0).padStart(10)] : []),
      ...(showFiles
        ? [fmtMs(q.time_to_graph_ms).padStart(9), fmtMs(q.time_to_baseline_ms).padStart(9)]
        : []),
      ...(showTe
        ? [
            fmtNum(q.baseline_te_tokens ?? 0).padStart(8),
            fmtRatio(q.ratio_te).padStart(8),
            fmtMs(q.time_to_te_ms).padStart(9),
          ]
        : []),
      (q.expected_rank === null ? "-" : String(q.expected_rank)).padStart(5),
      (q.hit === null ? "-" : q.hit ? "yes" : "NO").padStart(4),
      notes.join(" "),
    ];
    console.log(cells.join(" "));
  }
}

function printSummary(report: BenchReport): void {
  const lines: string[] = [];
  if (report.files) {
    lines.push(
      `  files : median r ${fmtRatio(report.files.median_ratio)}` +
        (report.files_top_n > 0
          ? ` · median r(top) ${fmtRatio(report.files.median_ratio_top ?? null)}`
          : "") +
        ` · graph ${fmtNum(report.files.graph_tokens)} tok vs ${fmtNum(report.files.baseline_tokens)} tok` +
        (report.files.baseline_top_tokens !== undefined
          ? ` (top: ${fmtNum(report.files.baseline_top_tokens)} tok)`
          : "") +
        ` · lost (r<1): ${report.files.lost}/${report.files.compared}`
    );
  }
  if (report.te) {
    lines.push(
      `  te    : median r ${fmtRatio(report.te.median_ratio)} · graph ${fmtNum(report.te.graph_tokens)} tok vs ${fmtNum(report.te.baseline_tokens)} tok · lost (r<1): ${report.te.lost}/${report.te.compared}`
    );
  }
  console.log(pc.bold("  summary"));
  for (const line of lines) console.log(line);
  if (report.refs) console.log(formatRefsLine(report.refs));

  const hitRate =
    report.hit_rate === null ? "n/a" : `${report.hit_rate.toFixed(2)} (${report.hits}/${report.expected_total})`;
  const hitRateAt1 =
    report.hit_rate_at_1 === null
      ? "n/a"
      : `${report.hit_rate_at_1.toFixed(2)} (${report.hits_at_1}/${report.expected_total})`;
  console.log(`  hit_rate: ${hitRate} · hit_rate@1: ${hitRateAt1}`);
  console.log(
    `  stale_hits: ${report.stale_hits}${formatIdList(report.stale_ids)}` +
      ` · unknown_supports: ${report.unknown_supports}${formatIdList(report.unknown_support_ids)}`
  );
  const warmup = formatWarmupLine(report.warmup_ms, report.median_time_wo_warmup_ms);
  if (warmup) console.log(warmup);
  for (const l of report.per_lang) {
    console.log(
      `  lang ${l.lang} (${l.questions}): median r(files) ${fmtRatio(l.median_ratio_files)}` +
        (report.te ? ` · median r(te) ${fmtRatio(l.median_ratio_te)}` : "")
    );
  }
  console.log(pc.yellow(`  NOTE: ${report.disclaimer}`));
}

export async function runBenchCli(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const questionsFile = flag("--questions");
  const baselineRaw = flag("--baseline");
  const teCmd = flag("--te-cmd");
  const fileLimitRaw = flag("--file-limit");
  const filesTopRaw = flag("--files-top");
  // --ref-root повторяемый: собираем все значения по порядку
  const refRoots: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ref-root") refRoots.push(args[i + 1] ?? "");
  }

  if (!questionsFile) {
    errorBold(`Флагу --questions нужен путь к файлу вопросов (jsonl).\n${usage()}`);
    process.exit(1);
  }
  const baseline = baselineRaw !== undefined ? parseBaseline(baselineRaw) : "files";
  if (baseline === null) {
    errorBold(`--baseline: неизвестный режим "${baselineRaw}" (допустимо files|te|both).\n${usage()}`);
    process.exit(1);
  }
  let filesTopN = 0;
  if (filesTopRaw !== undefined) {
    const parsed = Number.parseInt(filesTopRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errorBold(`--files-top: ожидалось число файлов (0 = все), получено "${filesTopRaw}".`);
      process.exit(1);
    }
    filesTopN = parsed;
  }
  if (refRoots.some((r) => r === "" || r === undefined)) {
    errorBold(`--ref-root: каждому флагу нужен путь.\n${usage()}`);
    process.exit(1);
  }
  let fileLimitBytes = DEFAULT_FILE_LIMIT_BYTES;
  if (fileLimitRaw !== undefined) {
    const parsed = Number.parseInt(fileLimitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errorBold(`--file-limit: ожидался размер в КБ, получено "${fileLimitRaw}".`);
      process.exit(1);
    }
    fileLimitBytes = parsed * 1024;
  }
  if ((baseline === "te" || baseline === "both") && !teCmd) {
    // Ошибка будет для вопросов без te_cmd/preset — но предупреждение раньше ошибки честнее.
    info("--baseline te/both: вопросы без te_cmd и без baseline_te_tokens падают — задай --te-cmd с {query}.");
  }

  let text: string;
  try {
    text = fs.readFileSync(questionsFile, "utf8");
  } catch (err) {
    errorBold(`Не удалось прочитать файл вопросов ${questionsFile}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let questions: BenchQuestion[];
  try {
    questions = loadQuestions(text);
  } catch (err) {
    errorBold(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const dbPath = resolveDbPathOrExit(args);
  const db = new KnowledgeDB(dbPath);
  try {
    const report = await runBench(db, questions!, {
      baseline,
      teCmd,
      fileLimitBytes,
      refRoots,
      filesTopN,
    });
    console.log(
      `  megamemory bench — ${questions!.length} questions, baseline: ${baseline}` +
        (filesTopN > 0 ? `, files-top: ${filesTopN}` : "")
    );
    console.log("");
    printTable(report);
    console.log("");
    printSummary(report);
  } catch (err) {
    if (err instanceof BenchError) {
      errorBold(err.message);
      process.exit(1);
    }
    throw err;
  } finally {
    db.close();
  }
}
