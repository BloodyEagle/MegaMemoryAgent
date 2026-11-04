import fs from "node:fs";
import pc from "picocolors";
import { errorBold, info } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";
import { KnowledgeDB } from "./db.js";
import {
  BenchError,
  DEFAULT_FILE_LIMIT_BYTES,
  type BenchBaselineMode,
  type BenchReport,
  loadQuestions,
  runBench,
} from "./bench.js";

/**
 * `megamemory bench --db <база> --questions q.jsonl [--baseline files|te|both]
 *                 [--te-cmd "tool path {query}"] [--file-limit KB]`
 *
 * Печатает таблицу по вопросам и итог: медиана отношения, суммарные токены,
 * число вопросов, где граф проиграл (ratio < 1), hit_rate рядом с каждым
 * отношением — и честную оговорку (plan 2.1.5 F3).
 */

function usage(): string {
  return [
    "Usage: megamemory bench --db <knowledge.db> --questions <file.jsonl>",
    "                        [--baseline files|te|both] [--te-cmd \"tool path {query}\"]",
    "                        [--file-limit KB]",
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

function printTable(report: BenchReport): void {
  const { mode } = report;
  const showFiles = mode === "files" || mode === "both";
  const showTe = mode === "te" || mode === "both";

  const header = [
    "id".padEnd(10),
    "lang".padEnd(6),
    "graph".padStart(7),
    ...(showFiles
      ? ["files".padStart(8), "r(files)".padStart(9), "t(graph)".padStart(9), "t(files)".padStart(9)]
      : []),
    ...(showTe
      ? ["te".padStart(8), "r(te)".padStart(8), "t(te)".padStart(9)]
      : []),
    "hit".padStart(4),
    "notes",
  ].join(" ");
  console.log(pc.dim(header));

  for (const q of report.questions) {
    const notes: string[] = [];
    if (q.estimated) notes.push("estimated");
    if (q.missing_files > 0) notes.push(`missing:${q.missing_files}`);
    if (q.te_used_preset) notes.push("te:preset");

    const cells = [
      q.id.slice(0, 10).padEnd(10),
      (q.lang ?? "-").padEnd(6),
      fmtNum(q.graph_tokens).padStart(7),
      ...(showFiles
        ? [
            fmtNum(q.baseline_files_tokens ?? 0).padStart(8),
            fmtRatio(q.ratio_files).padStart(9),
            fmtMs(q.time_to_graph_ms).padStart(9),
            fmtMs(q.time_to_baseline_ms).padStart(9),
          ]
        : []),
      ...(showTe
        ? [
            fmtNum(q.baseline_te_tokens ?? 0).padStart(8),
            fmtRatio(q.ratio_te).padStart(8),
            fmtMs(q.time_to_te_ms).padStart(9),
          ]
        : []),
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
      `  files : median r ${fmtRatio(report.files.median_ratio)} · graph ${fmtNum(report.files.graph_tokens)} tok vs ${fmtNum(report.files.baseline_tokens)} tok · lost (r<1): ${report.files.lost}/${report.files.compared}`
    );
  }
  if (report.te) {
    lines.push(
      `  te    : median r ${fmtRatio(report.te.median_ratio)} · graph ${fmtNum(report.te.graph_tokens)} tok vs ${fmtNum(report.te.baseline_tokens)} tok · lost (r<1): ${report.te.lost}/${report.te.compared}`
    );
  }
  console.log(pc.bold("  summary"));
  for (const line of lines) console.log(line);

  const hitRate =
    report.hit_rate === null ? "n/a" : `${report.hit_rate.toFixed(2)} (${report.hits}/${report.expected_total})`;
  console.log(`  hit_rate: ${hitRate} · stale_hits: ${report.stale_hits} · unknown_supports: ${report.unknown_supports}`);
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

  if (!questionsFile) {
    errorBold(`Флагу --questions нужен путь к файлу вопросов (jsonl).\n${usage()}`);
    process.exit(1);
  }
  const baseline = baselineRaw !== undefined ? parseBaseline(baselineRaw) : "files";
  if (baseline === null) {
    errorBold(`--baseline: неизвестный режим "${baselineRaw}" (допустимо files|te|both).\n${usage()}`);
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

  let questions;
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
    });
    console.log(
      `  megamemory bench — ${questions!.length} questions, baseline: ${baseline}`
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
