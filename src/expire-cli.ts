import pc from "picocolors";
import fs from "node:fs";
import { KnowledgeDB } from "./db.js";
import { resolveDbPathOrExit } from "./db-path.js";
import { claimDigestOf } from "./support-baselines.js";
import { scanExpiryCandidates, renderScanText, type ScanReport } from "./scan-expiry.js";

/**
 * 2.1.13 F5: `megamemory expire` — проставить valid_until журнальным узлам
 * и «вечным» утверждениям о состоянии. Сервер срок сам не ставит; эта команда
 * — ручной инструмент владельца. По умолчанию dry-run: таблица
 * «id | kind | было | станет» и ноль записей; --apply применяет.
 *
 * Источники id: --ids a,b или --report <json>. Взаимоисключающие. Один
 * неизвестный id — отказ всей команды: ноль записей, никакой частичной
 * уборки. Каждое применение пишет запись в timeline (tool=expire).
 *
 * M2 B4 (план 20+21 v3 §7): `--scan` — обнаружение кандидатов через единый
 * module src/scan-expiry.ts на безопасном readonly-открытии. --scan никогда
 * не пишет: dry-run по определению; `--scan --apply` запрещён — применение
 * идёт по явно выбранным id (--ids) или по просмотренному отчёту (--report,
 * строки с expire: true расставляет человек). --json печатает версионный
 * отчёт (format_version 2), совместимый с --report.
 *
 * M2 B5: версионный отчёт несёт время снимка, предложенную конкретную дату и
 * версии существенных полей кандидатов (id, claim, kind, lifecycle, прежний
 * expiry). Перед применением весь выбранный набор проверяется в одной
 * транзакции; изменение summary/kind/status/expiry или исчезновение любого
 * участника отменяет весь batch с version_conflict. «past» разрешается в
 * конкретный timestamp при построении отчёта и не подменяется при apply.
 * Старый формат отчёта (без версий) — документированный путь совместимости
 * с явным предупреждением; deprecation — отдельное решение владельца.
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
      `--until: "${value}" не разбирается как дата и не является "past".`
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

/** Версии существенных полей кандидата, зафиксированные отчётом (B5). */
export interface ExpirePin {
  kind: string;
  status: string;
  claim_digest: string;
  valid_until: string | null;
  removed_at: string | null;
}

/** Собрать pin-версии из версионного отчёта скана (format_version 2). */
export function expirePinsFromReport(
  report: {
    candidates?: Array<{
      id?: unknown;
      kind?: unknown;
      status?: unknown;
      claim_digest?: unknown;
      valid_until?: unknown;
      removed_at?: unknown;
      expire?: unknown;
    }>;
  }
): Map<string, ExpirePin> {
  const pins = new Map<string, ExpirePin>();
  const seen = new Set<string>();
  for (const c of report.candidates ?? []) {
    if (typeof c?.id !== "string" || c.id.trim() === "" || c.id !== c.id.trim()) {
      throw new Error("--report: версионный кандидат без корректного id.");
    }
    if (seen.has(c.id)) {
      throw new Error(`--report: повторяющийся id "${c.id}" — дубликат кандидата.`);
    }
    seen.add(c.id);
    if (c.expire !== undefined && typeof c.expire !== "boolean") {
      throw new Error(`--report: поле expire кандидата "${c.id}" не boolean.`);
    }
    if (c.expire !== true) continue;
    if (
      typeof c.kind !== "string" || c.kind.trim() === "" ||
      typeof c.status !== "string" || c.status.trim() === "" ||
      typeof c.claim_digest !== "string" || !/^[a-f0-9]{64}$/i.test(c.claim_digest) ||
      !(c.valid_until === null || (typeof c.valid_until === "string" && Number.isFinite(Date.parse(c.valid_until)))) ||
      !(c.removed_at === null || (typeof c.removed_at === "string" && Number.isFinite(Date.parse(c.removed_at))))
    ) {
      throw new Error(`--report: выбранный id "${c.id}" без полного валидного pin версии (kind, status, claim_digest, valid_until, removed_at).`);
    }
    pins.set(c.id, {
      kind: c.kind,
      status: c.status,
      claim_digest: c.claim_digest,
      valid_until: c.valid_until,
      removed_at: c.removed_at,
    });
  }
  return pins;
}

export interface ReadReportResult {
  ids: string[];
  verdicts: Map<string, string>;
  /** Версионный отчёт (format_version 2): предложенная дата и pin-версии. */
  versioned?: {
    format_version: number;
    proposed_until: string;
    pins: Map<string, ExpirePin>;
  };
}

/**
 * Прочитать JSON-отчёт; применяются только кандидаты с expire: true.
 * Версионный формат (format_version 2) дополнительно переносит предложенную
 * дату и pin-версии; старый формат остаётся читаемым (legacy-совместимость).
 */
export function readReport(filePath: string): ReadReportResult {
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
  const rawFormat = (parsed as { format_version?: unknown })?.format_version;
  if (rawFormat !== undefined && typeof rawFormat !== "number") {
    throw new Error(`--report: format_version в "${filePath}" не число.`);
  }
  if (typeof rawFormat === "number" && rawFormat > 2) {
    throw new Error(
      `--report: отчёт "${filePath}" создан более новым форматом (format_version ${rawFormat}, этот билд понимает 2).`
    );
  }

  const ids: string[] = [];
  const verdicts = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of candidates as ReportCandidate[]) {
    if (typeof c?.id !== "string" || c.id === "") {
      if (rawFormat === 2 || c?.expire === true) {
        throw new Error("--report: выбранный или версионный кандидат без корректного id.");
      }
      continue;
    }
    if (seen.has(c.id)) {
      throw new Error(`--report: повторяющийся id "${c.id}" — дубликат кандидата.`);
    }
    seen.add(c.id);
    if (c.expire === true) {
      ids.push(c.id);
      if (typeof c.verdict === "string") verdicts.set(c.id, c.verdict);
    }
  }

  const result: ReadReportResult = { ids, verdicts };
  if (rawFormat === 2) {
    const proposed = (parsed as { proposed_until?: unknown })?.proposed_until;
    if (typeof proposed !== "string" || proposed === "" || Number.isNaN(Date.parse(proposed))) {
      throw new Error(
        `--report: версионный отчёт "${filePath}" без корректной proposed_until — дату снимка подменять нельзя.`
      );
    }
    result.versioned = {
      format_version: 2,
      proposed_until: proposed,
      pins: expirePinsFromReport({
        candidates: candidates as Array<Record<string, unknown>>,
      }),
    };
  }
  return result;
}

/** Прочитать JSON-отчёт; применяются только кандидаты с expire: true. */
export function readReportIds(filePath: string): { ids: string[]; verdicts: Map<string, string> } {
  const read = readReport(filePath);
  if (read.ids.length === 0) {
    throw new Error(`--report: в "${filePath}" нет кандидатов с expire: true — нечего применять.`);
  }
  return { ids: read.ids, verdicts: read.verdicts };
}

/**
 * Ядро команды: проверка id до единой записи; --apply проставляет срок и
 * пишет timeline (tool=expire). Неизвестный id — отказ, ноль записей.
 *
 * pins (B5, версионный отчёт): перед применением весь набор проверяется
 * внутри одной транзакции — kind, lifecycle-статус, отсутствие удаления,
 * версия формулировки (claim) и прежний expiry должны совпасть с отчётом;
 * любое расхождение или исчезновение участника отменяет весь batch с
 * version_conflict. Без pins действует прежняя защита B-08 — проверка
 * «было» внутри одного вызова apply.
 */
export function expireNodes(
  db: KnowledgeDB,
  ids: string[],
  untilIso: string,
  apply: boolean,
  pins?: Map<string, ExpirePin>
): ExpireResult {
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))];
  if (unique.length === 0) {
    throw new Error("expire: пустой список id — нечего просрочивать.");
  }
  if (pins !== undefined) {
    if (unique.length !== ids.length) {
      throw new Error("expire: версионный список id содержит дубликаты или пустые значения.");
    }
    if (pins.size !== unique.length || unique.some((id) => !pins.has(id))) {
      throw new Error("expire: выбранные ids не совпадают с pin-версиями — legacy-fallback запрещён.");
    }
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
  // B5: с pin-версиями отчёта проверяется весь существенный набор — любая
  // подмена отменяет весь batch, частичной записи не бывает.
  db.runInTransaction(() => {
    for (let i = 0; i < unique.length; i += 1) {
      const id = unique[i];
      const node = db.getNode(id);
      if (!node) {
        throw new Error(
          `expire: узел "${id}" исчез между проверкой и применением (удалён) — batch отменён.`
        );
      }
      if (node.removed_at) {
        throw new Error(
          `version_conflict: узел "${id}" удалён (tombstone) после построения отчёта — batch отменён.`
        );
      }
      const pin = pins?.get(id);
      if (pins !== undefined && !pin) {
        throw new Error(`expire: для выбранного id "${id}" нет pin версии — batch отменён.`);
      }
      if (pin) {
        if ((node.removed_at ?? null) !== pin.removed_at) {
          throw new Error(`version_conflict: состояние удаления узла "${id}" изменилось после построения отчёта — batch отменён.`);
        }
        if (node.kind !== pin.kind) {
          throw new Error(
            `version_conflict: kind узла "${id}" изменился после построения отчёта ` +
              `(${pin.kind} → ${node.kind}) — batch отменён.`
          );
        }
        if ((node.status ?? "active") !== pin.status) {
          throw new Error(
            `version_conflict: lifecycle узла "${id}" изменился после построения отчёта ` +
              `(${pin.status} → ${node.status ?? "active"}) — batch отменён.`
          );
        }
        if (claimDigestOf(node.summary ?? "") !== pin.claim_digest) {
          throw new Error(
            `version_conflict: формулировка (claim) узла "${id}" изменилась после построения отчёта — batch отменён.`
          );
        }
        if ((node.valid_until ?? null) !== pin.valid_until) {
          throw new Error(
            `version_conflict: срок узла "${id}" изменился после построения отчёта ` +
              `(${pin.valid_until ?? "—"} → ${node.valid_until ?? "—"}) — batch отменён.`
          );
        }
      } else if ((node.valid_until ?? null) !== rows[i].was) {
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

const LEGACY_REPORT_WARNING =
  "Предупреждение: отчёт без версий существующих полей (старый формат) — защита от " +
  "устаревания (version_conflict) на него не действует: применяй только свежепроверенный " +
  "отчёт. Deprecation старого формата — отдельное решение владельца.";

function parseRepoArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") return argv[i + 1];
    if (argv[i].startsWith("--repo=")) return argv[i].slice("--repo=".length);
  }
  return undefined;
}

export async function runExpire(argv: string[]): Promise<void> {
  let idsArg: string | undefined;
  let reportArg: string | undefined;
  let untilArg: string | undefined;
  let apply = false;
  let scan = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--apply") {
      apply = true;
    } else if (token === "--scan") {
      scan = true;
    } else if (token === "--json") {
      json = true;
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

  if (scan) {
    // B4.6/B4.7: --scan — только просмотр. Прямое применение автоматически
    // выбранных непросмотренных кандидатов не существует ни в каком режиме.
    if (apply) {
      throw new Error(
        "expire: --scan не применяет изменения — прямой «--scan --apply» на автоматически " +
          "выбранный непросмотренный набор запрещён. Просмотри отчёт, разреши выбранные строки " +
          "(expire: true) и примени через --report, либо передай явно выбранные id через --ids."
      );
    }
    if (idsArg || reportArg || untilArg) {
      throw new Error(
        "expire: --scan — только просмотр; --ids/--report/--until к нему не относятся."
      );
    }
    const dbPath = resolveDbPathOrExit(argv, { requireExisting: true });
    const repoPath = parseRepoArg(argv);
    const db = new KnowledgeDB(dbPath, { readonly: true });
    try {
      const report = scanExpiryCandidates(db, { repoPath });
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderScanText(report));
      }
      console.log(
        pc.dim(
          "  Скан dry-run: база не менялась, кандидаты expire не включают. " +
            "Просмотри отчёт, разреши строки (expire: true) и примени: megamemory expire --report <json> --apply."
        )
      );
    } finally {
      db.close();
    }
    return;
  }

  if (idsArg && reportArg) {
    throw new Error("expire: «--ids» и «--report» взаимоисключающие — выбери один источник.");
  }
  if (!idsArg && !reportArg) {
    throw new Error("expire: нужен источник id — --ids a,b или --report <json> (обзор: --scan).");
  }

  let ids: string[];
  let verdicts: Map<string, string> | undefined;
  let pins: Map<string, ExpirePin> | undefined;
  if (reportArg) {
    const report = readReport(reportArg);
    ids = report.ids;
    verdicts = report.verdicts;
    if (report.versioned) {
      // B5: дата отчёта — конкретный timestamp снимка. Отсутствие --until
      // значит «применить как просмотрено»; расходящийся --until — отказ,
      // подмена датой apply запрещена.
      const proposed = report.versioned.proposed_until;
      if (untilArg === undefined) {
        untilArg = proposed;
      } else {
        const given = resolveUntil(untilArg);
        if (Date.parse(given) !== Date.parse(proposed)) {
          throw new Error(
            `expire: --until "${untilArg}" расходится с датой отчёта (${proposed}). ` +
              `Отчёт фиксирует дату снимка; примени его без --until либо перегенерируй скан.`
          );
        }
        untilArg = given;
      }
      pins = report.versioned.pins;
    } else if (apply) {
      // Старый формат не защищён от устаревания — говорим это явно, не молча.
      console.log(pc.yellow(LEGACY_REPORT_WARNING));
    }
  } else {
    ids = (idsArg ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  }

  if (!untilArg) {
    throw new Error("expire: нужен срок — --until <дата, принимаемая Date.parse> или --until past (вчера).");
  }
  const untilIso = resolveUntil(untilArg);

  const dbPath = resolveDbPathOrExit(argv, { requireExisting: true });
  const db = new KnowledgeDB(dbPath, { readonly: !apply });
  try {
    const result = expireNodes(db, ids, untilIso, apply, pins);
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
