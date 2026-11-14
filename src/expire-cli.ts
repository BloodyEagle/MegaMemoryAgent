import pc from "picocolors";
import fs from "node:fs";
import { KnowledgeDB } from "./db.js";
import { resolveDbPathOrExit } from "./db-path.js";

/**
 * 2.1.13 F5: `megamemory expire` — проставить valid_until журнальным узлам
 * и «вечным» утверждениям о состоянии. Сервер срок сам не ставит; эта команда
 * — ручной инструмент владельца. По умолчанию dry-run: таблица
 * «id | kind | было | станет» и ноль записей; --apply применяет.
 *
 * Источники id: --ids a,b или --report <json> (выкладка report-journals.mjs,
 * применяются только кандидаты с expire: true). Взаимоисключающие. Один
 * неизвестный id — отказ всей команды: ноль записей, никакой частичной
 * уборки. Каждое применение пишет запись в timeline (tool=expire).
 */

export interface ExpireRow {
  id: string;
  kind: string;
  /** Текущий valid_until (null — бессрочно). */
  was: string | null;
  /** Какой срок станет после --apply. */
  becomes: string;
  /** Вердикт из отчёта, если источник --report. */
  verdict?: string;
}

export interface ExpireResult {
  rows: ExpireRow[];
  applied: boolean;
}

/**
 * --until: «past» = вчера (сейчас минус сутки, ISO), иначе строка, которую
 * разбирает Date. Мусор — отказ.
 */
export function resolveUntil(value: string): string {
  const text = value.trim();
  if (text.toLowerCase() === "past") {
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }
  if (text === "" || Number.isNaN(Date.parse(text))) {
    throw new Error(
      `--until: "${value}" не разбирается как дата (ISO-8601) и не является "past".`
    );
  }
  return text;
}

export interface ReportCandidate {
  id: string;
  kind?: string;
  summary?: string;
  verdict?: string;
  expire?: boolean;
}

export interface ExpireReport {
  generated_at?: string;
  source?: string;
  candidates: ReportCandidate[];
}

/** Прочитать JSON-отчёт; применяются только кандидаты с expire: true. */
export function readReportIds(filePath: string): { ids: string[]; verdicts: Map<string, string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(
      `--report: файл "${filePath}" не читается как JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const candidates = (parsed as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error(`--report: в "${filePath}" нет массива candidates.`);
  }
  const ids: string[] = [];
  const verdicts = new Map<string, string>();
  for (const c of candidates as ReportCandidate[]) {
    if (typeof c?.id !== "string" || c.id === "") continue;
    if (c.expire === true) {
      ids.push(c.id);
      if (typeof c.verdict === "string") verdicts.set(c.id, c.verdict);
    }
  }
  if (ids.length === 0) {
    throw new Error(`--report: в "${filePath}" нет кандидатов с expire: true — нечего применять.`);
  }
  return { ids, verdicts };
}

/**
 * Ядро команды: проверка id до единой записи; --apply проставляет срок и
 * пишет timeline (tool=expire). Неизвестный id — отказ, ноль записей.
 */
export function expireNodes(
  db: KnowledgeDB,
  ids: string[],
  untilIso: string,
  apply: boolean
): ExpireResult {
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))];
  if (unique.length === 0) {
    throw new Error("expire: пустой список id — нечего просрочивать.");
  }
  const unknown = unique.filter((id) => !db.getNode(id));
  if (unknown.length > 0) {
    throw new Error(
      `expire: неизвестные id (${unknown.join(", ")}) — запись не выполнена. ` +
        `Проверь список (списки идентификаторов: megamemory stats, guide, узлы в understand).`
    );
  }
  const rows: ExpireRow[] = unique.map((id) => {
    const node = db.getNode(id)!;
    return { id, kind: node.kind, was: node.valid_until ?? null, becomes: untilIso };
  });
  if (!apply) return { rows, applied: false };

  // B-08: проверка участников, UPDATE-ы и строгий append журнала — одна
  // транзакция. Существующий срок можно заменить; здесь проверяется лишь
  // расхождение с первым чтением В ЭТОМ вызове apply, не с отдельным dry-run.
  // createTimelineLogger глотает ошибки, поэтому для batch используем
  // insertTimelineEntry: ошибка записи журнала тоже откатывает все сроки.
  db.runInTransaction(() => {
    for (let i = 0; i < unique.length; i += 1) {
      const id = unique[i];
      const node = db.getNode(id);
      if (!node) {
        throw new Error(
          `expire: узел "${id}" исчез между проверкой и применением (удалён) — batch отменён.`
        );
      }
      if ((node.valid_until ?? null) !== rows[i].was) {
        throw new Error(
          `expire: срок узла "${id}" изменился между проверкой и применением ` +
            `(${rows[i].was} → ${node.valid_until ?? null}) — batch отменён.`
        );
      }
      const updated = db.updateNode(id, { valid_until: untilIso });
      if (!updated) {
        throw new Error(`expire: не удалось проставить срок узлу "${id}".`);
      }
    }
    db.insertTimelineEntry({
      tool: "expire",
      params: JSON.stringify({ until: untilIso, ids: unique }),
      result_summary: `expired ${unique.length} nodes until ${untilIso}`,
      is_write: true,
      is_error: false,
      affected_ids: unique,
    });
  });
  return { rows, applied: true };
}

function printTable(rows: ExpireRow[]): void {
  const verdictCol = rows.some((r) => r.verdict !== undefined);
  const header = verdictCol
    ? "id | kind | было | станет | вердикт"
    : "id | kind | было | станет";
  console.log(pc.dim(header));
  for (const r of rows) {
    const line = [r.id, r.kind, r.was ?? "—", r.becomes, r.verdict ?? ""]
      .filter((cell, i) => (verdictCol ? true : i < 4))
      .join(" | ");
    console.log(`  ${line}`);
  }
}

export async function runExpire(argv: string[]): Promise<void> {
  let idsArg: string | undefined;
  let reportArg: string | undefined;
  let untilArg: string | undefined;
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--apply") {
      apply = true;
    } else if (token === "--ids") {
      idsArg = argv[++i];
    } else if (token.startsWith("--ids=")) {
      idsArg = token.slice("--ids=".length);
    } else if (token === "--report") {
      reportArg = argv[++i];
    } else if (token.startsWith("--report=")) {
      reportArg = token.slice("--report=".length);
    } else if (token === "--until") {
      untilArg = argv[++i];
    } else if (token.startsWith("--until=")) {
      untilArg = token.slice("--until=".length);
    }
  }

  if (idsArg && reportArg) {
    throw new Error("expire: «--ids» и «--report» взаимоисключающие — выбери один источник.");
  }
  if (!idsArg && !reportArg) {
    throw new Error("expire: нужен источник id — --ids a,b или --report <json>.");
  }
  if (!untilArg) {
    throw new Error("expire: нужен срок — --until <ISO-дата> или --until past (вчера).");
  }
  const untilIso = resolveUntil(untilArg);

  let ids: string[];
  let verdicts: Map<string, string> | undefined;
  if (reportArg) {
    const report = readReportIds(reportArg);
    ids = report.ids;
    verdicts = report.verdicts;
  } else {
    ids = (idsArg ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  }

  const dbPath = resolveDbPathOrExit(argv, { requireExisting: true });
  const db = new KnowledgeDB(dbPath, { readonly: !apply });
  try {
    const result = expireNodes(db, ids, untilIso, apply);
    printTable(result.rows.map((r) => ({ ...r, verdict: verdicts?.get(r.id) })));
  console.log();
  if (result.applied) {
    console.log(
      pc.green(`  Просрочено ${result.rows.length} узлов до ${untilIso}.`)
    );
    console.log(pc.dim("  Проверка: megamemory stats (счётчик Expired), megamemory export, understand по теме узлов."));
  } else {
    console.log(pc.dim("  Dry-run: база не менялась. Для применения добавь --apply."));
  }
  } finally {
    db.close();
  }
}
