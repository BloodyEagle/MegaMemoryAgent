import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { loadEvalPairs, runEval } from "./eval.js";
import { errorBold, success, info, heading, warn, openReadonlyOrExplain } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";

/**
 * План 06 (C-03): строгий разбор числовых флагов ДО открытия БД.
 * parseFloat("nope") давал NaN, сравнение `recall < NaN` всегда было false —
 * quality gate молча отключался. Частичный разбор ("0.5junk") запрещён:
 * значение разбирается целиком или команда отказывает.
 */
function strictMin(raw: string | undefined): number {
  const flag = "--min";
  if (raw === undefined || raw.trim() === "") {
    errorBold(`${flag}: требуется числовое значение в [0, 1]`);
    process.exit(1);
  }
  const text = raw.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    errorBold(`${flag}: "${raw}" не разбирается как конечное число`);
    process.exit(1);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    errorBold(`${flag}: ${raw} вне допустимого диапазона [0, 1]`);
    process.exit(1);
  }
  return value;
}

function strictK(raw: string | undefined): number {
  const flag = "--k";
  if (raw === undefined || raw.trim() === "") {
    errorBold(`${flag}: требуется целое положительное значение`);
    process.exit(1);
  }
  const text = raw.trim();
  if (!/^\+?\d+$/.test(text) || !Number.isInteger(Number(text)) || Number(text) < 1) {
    errorBold(`${flag}: "${raw}" — нужно целое положительное число`);
    process.exit(1);
  }
  return Number(text);
}

/** Значение флага в формах `--flag X` и `--flag=X`; null = флага нет. */
function flagValue(args: string[], flag: string): string | null | undefined {
  const eq = `${flag}=`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) return args[i + 1]; // undefined = флаг без значения
    if (typeof args[i] === "string" && args[i].startsWith(eq)) {
      return args[i].slice(eq.length);
    }
  }
  return null;
}

/**
 * `megamemory eval [--file <jsonl>] [--k 10] [--min 0.8]`
 *
 * Measures recall@k of the live search stack against an eval set
 * (fixtures/eval.jsonl by default). Exit 1 below --min — CI-friendly.
 */
export async function runEvalCli(args: string[]): Promise<void> {
  // Числовые флаги валидируются первыми — никакая БД не открывается и
  // никаких файлов не создаётся до того, как argv признан корректным.
  const minRaw = flagValue(args, "--min");
  const kRaw = flagValue(args, "--k");
  const min = minRaw === null ? 0.8 : strictMin(minRaw);
  const k = kRaw === null ? 10 : strictK(kRaw);

  const fileIdx = args.indexOf("--file");
  const file =
    fileIdx !== -1 ? args[fileIdx + 1] : path.join("fixtures", "eval.jsonl");

  if (!fs.existsSync(file)) {
    errorBold(`Eval set not found: ${file}`);
    process.exit(1);
  }
  const p = resolveDbPathOrExit(args);

  // B-06 (аудит 2026-11-12): неполный набор — контролируемый отказ до
  // открытия БД и измерения. Раньше truthy-проверка loadEvalPairs молча
  // пропускала некорректные строки, recall завышался, и quality gate
  // проходил ложно.
  let pairs: ReturnType<typeof loadEvalPairs>;
  try {
    pairs = loadEvalPairs(fs.readFileSync(file, "utf8"));
  } catch (err) {
    errorBold(`Eval set parse failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (pairs.length === 0) {
    errorBold("Eval set is empty.");
    process.exit(1);
  }

  // План 18 (2.4.0): eval только измеряет recall на живом поиске — база
  // открывается readonly. MEGAMEMORY_ALLOW_AUTO_MIGRATE=1 возвращает RW.
  const db = openReadonlyOrExplain(p, "eval");
  try {
    const result = await runEval(db, pairs, { k });

    heading(`  megamemory eval — ${pairs.length} pairs, recall@${k}`);
    const mark = result.recall >= min ? pc.green : pc.red;
    console.log(
      `  overall: ${mark(result.recall.toFixed(3))} (${result.hits}/${result.total})`
    );
    for (const [lang, bucket] of Object.entries(result.perLang)) {
      console.log(
        `    ${lang.padEnd(6)} ${bucket.recall.toFixed(3)} (${bucket.hits}/${bucket.total})`
      );
    }
    if (result.misses.length > 0) {
      for (const miss of result.misses.slice(0, 10)) {
        warn(`miss: "${miss.query}" -> ${miss.expected_id} (${miss.lang})`);
      }
    }

    if (result.recall < min) {
      errorBold(`recall ${result.recall.toFixed(3)} < min ${min}`);
      process.exit(1);
    }
    success(`recall@${k} ${result.recall.toFixed(3)} >= ${min}`);
    info("eval sets live in fixtures/eval.jsonl — extend them as the graph grows.");
  } finally {
    db.close();
  }
}
