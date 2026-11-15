import { execFileSync } from "node:child_process";
import { KnowledgeDB } from "./db.js";
import { claimDigestOf } from "./support-baselines.js";

/**
 * M2 B4 (план 20+21 v3 §7): обнаружение кандидатов на expiry — единый
 * проверяемый module. scripts/report-journals.mjs остаётся тонким adapter
 * (рендер), правил здесь ровно одни.
 *
 * Исправления исходника:
 * - R11: опоры кандидата считаются ИСХОДЯЩИЕ живые informed_by с живыми
 *   целями (старый скрипт считал входящие — направление опор перепутано);
 * - R11: база открывается вызывающим через безопасный readonly-путь
 *   KnowledgeDB (query_only = ON), а не «обещаем только SELECT» поверх сырого
 *   RW libsql; module принимает соединение и сам ничего не пишет;
 * - R09/R14 (§7 B4.5): дата, номер версии или тег в claim — ПРИЗНАК
 *   кандидата. Существующий git tag НЕ доказывает влитость конкретного PR:
 *   расхождение «тег есть, саммари говорит „не влито"» остаётся
 *   диагностическим признаком (candidate-sign only), автоматического
 *   опровержения и авто-простановки срока не существует;
 * - §7 B4.8: пустой скан — успешный пустой результат; нечитаемая база,
 *   неполный скан или ошибка git — явная ошибка, а не «кандидатов нет».
 *
 * Кандидат — только признак: report.candidates[*].expire = false; человек
 * просматривает отчёт и явно разрешает строки (expire: true) либо передаёт
 * id напрямую. Сгенерированные кандидаты expire не включают (§7 B4.6).
 */

/** Формат версионного отчёта (B5): версии существенных полей у кандидатов. */
export const SCAN_REPORT_FORMAT_VERSION = 2;

/**
 * Виды, попадающие в скан. digest — серверная сводка (пересобирается
 * digest-командой, её срок не решение владельца), task — досочный вид со
 * своей ротацией; остальные живые kinds сканируются, включая journal и
 * прежний набор (decision/feature/module).
 */
const SCAN_EXCLUDED_KINDS = new Set(["digest", "task"]);

/** Признаки журнального/состоянийого саммари (2.1.12 F5). */
export const JOURNAL_MARKERS: Array<[string, RegExp]> = [
  ["дата", /\b\d{4}-\d{2}-\d{2}\b/],
  ["PR", /\b#\d+\b|\bPR\s+#?\d+/i],
  ["релиз", /\b\d+\.\d+\.\d+\b/],
  ["не начато", /не начат|not started/i],
  ["не влито", /не влит|not merged/i],
  ["влито", /влит|смержен|merged/i],
  ["закрыто", /закрыт|closed/i],
  ["открыто", /открыт|opened/i],
];

/** Утверждения о состоянии — им положен valid_until (2.1.12 F1). */
const STATE_CLAIM =
  /влит|смержен|merged|не начат|not started|закрыт|closed|открыт|opened|вышел|shipped|релиз/i;
const NEGATION = /не влит|не открыт|не начат|not merged|not started/i;
/** Версия/тег в саммари: v1.2.3 или 1.2.3. */
const VERSION_RE = /\b\d+\.\d+\.\d+\b/g;

export interface ScanCandidate {
  id: string;
  kind: string;
  /** Версия формулировки (claim) на момент скана — проверяется при apply (B5). */
  claim_digest: string;
  /** Lifecycle на момент скана. */
  status: string;
  removed_at: string | null;
  /** Прежний expiry на момент скана. */
  valid_until: string | null;
  created_at: string | null;
  /** Признаки журнала, найденные в саммари. */
  markers: string[];
  /** R11: ИСХОДЯЩИЕ живые informed_by с живыми (не удалёнными) целями. */
  outgoing_live_supports: number;
  /** Диагностика владельцу; не основание авто-действий. */
  contradictions: string[];
  /** Человекочитаемый вердикт-признак. */
  verdict: string;
  /** Candidate-sign only: скан никогда не разрешает применение сам. */
  expire: boolean;
}

export interface ScanReport {
  format_version: number;
  /** Время снимка (ISO UTC). */
  generated_at: string;
  /** Идентичность источника — путь базы. */
  source_db: string;
  /** Предложенная конкретная дата (прошедший срок); фиксируется при скане и не подменяется при apply. */
  proposed_until: string;
  complete: boolean;
  candidates: ScanCandidate[];
}

/** Ошибка скана: нечитаемая база/ошибка git — не «кандидатов нет» (§7 B4.8). */
export class ScanError extends Error {}

interface ScanOptions {
  /** Каталог git-репозитория для диагностической сверки тегов (не авторитет). */
  repoPath?: string;
  /** Управляемое время (тесты); по умолчанию — текущий момент UTC. */
  now?: Date;
}

function repoTags(repoPath: string): string[] {
  let tags: string;
  try {
    tags = execFileSync("git", ["tag", "--list"], { cwd: repoPath, encoding: "utf-8" });
  } catch (err) {
    // §7 B4.8: ошибка git — явная ошибка, не «кандидатов нет».
    throw new ScanError(
      `--scan: git недоступен или "${repoPath}" не репозиторий ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Скан не завершён — это не пустой результат; убери --repo или почини путь.`
    );
  }
  return tags.split("\n");
}

/**
 * Обойти живые узлы и собрать кандидатов. Только чтение: соединение даёт
 * вызывающий (для CLI — readonly KnowledgeDB); module не выполняет записей.
 */
export function scanExpiryCandidates(db: KnowledgeDB, opts: ScanOptions = {}): ScanReport {
  const now = opts.now ?? new Date();
  const rows = db.execSqlAll(
    `SELECT id, kind, summary, valid_until, status, removed_at, created_at
     FROM nodes
     WHERE removed_at IS NULL
     ORDER BY created_at, id`
  ) as Array<{
    id: string;
    kind: string;
    summary: string | null;
    valid_until: string | null;
    status: string | null;
    removed_at: string | null;
    created_at: string | null;
  }>;

  // Исходящие живые informed_by с живыми целями — один запрос, счёт в JS
  // (R11: направление опор; старый скрипт считал входящие).
  const supportRows = db.execSqlAll(
    `SELECT e.from_id AS from_id, e.to_id AS to_id
     FROM edges e
     JOIN nodes nd ON nd.id = e.to_id
     WHERE e.relation = 'informed_by' AND e.removed_at IS NULL AND nd.removed_at IS NULL`
  ) as Array<{ from_id: string; to_id: string }>;
  const outgoingSupports = new Map<string, number>();
  for (const row of supportRows) {
    outgoingSupports.set(row.from_id, (outgoingSupports.get(row.from_id) ?? 0) + 1);
  }

  const tags = opts.repoPath ? repoTags(opts.repoPath) : null;

  const candidates: ScanCandidate[] = [];
  for (const node of rows) {
    if (SCAN_EXCLUDED_KINDS.has(node.kind)) continue;
    const summary = node.summary ?? "";
    const markers = JOURNAL_MARKERS.filter(([, re]) => re.test(summary)).map(([name]) => name);
    if (markers.length === 0) continue;

    const contradictions: string[] = [];
    if (STATE_CLAIM.test(summary) && !node.valid_until) {
      contradictions.push("нет valid_until при утверждении о состоянии");
    }
    if (NEGATION.test(summary) && tags) {
      const versions = [...summary.matchAll(VERSION_RE)].map((m) => `v${m[0]}`);
      for (const v of versions) {
        if (tags.includes(v)) {
          // R09/§7 B4.5: признак кандидата, не доказательство — тег не
          // доказывает влитость конкретного PR и не опровергает саммари сам.
          contradictions.push(
            `тег ${v} существует при саммари «не влито» — признак кандидата, ` +
              `тег не доказывает влитость конкретного PR; решает владелец`
          );
          break;
        }
      }
    }

    candidates.push({
      id: node.id,
      kind: node.kind,
      claim_digest: claimDigestOf(summary),
      status: node.status ?? "active",
      removed_at: node.removed_at ?? null,
      valid_until: node.valid_until ?? null,
      created_at: node.created_at ?? null,
      markers,
      outgoing_live_supports: outgoingSupports.get(node.id) ?? 0,
      contradictions,
      verdict:
        contradictions.length > 0
          ? `журнальные признаки (${markers.join(", ")}); противоречия: ${contradictions.join("; ")}`
          : `журнальные признаки (${markers.join(", ")})`,
      expire: false,
    });
  }

  return {
    format_version: SCAN_REPORT_FORMAT_VERSION,
    generated_at: now.toISOString(),
    source_db: db.dbPath,
    // B5: «past» разрешается в конкретный timestamp при построении отчёта.
    proposed_until: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    complete: true,
    candidates,
  };
}

/**
 * Текстовый просмотр (2.1.12 F5): та же колонка «опоры», но теперь исходящие
 * живые опоры с живыми целями. Рендер — только представление, правила в
 * scanExpiryCandidates.
 */
export function renderScanText(report: ScanReport): string {
  if (report.candidates.length === 0) {
    return "Журнальных узлов не найдено. Скан ничего не менял: по каждой строке решает владелец.";
  }
  const rows = report.candidates.map((c) => ({
    id: c.id,
    kind: c.kind,
    created: (c.created_at ?? "").slice(0, 10),
    supports: String(c.outgoing_live_supports),
    valid_until: c.valid_until ?? "—",
    journal: c.markers.join(", "),
    contradictions: c.contradictions.join("; ") || "—",
  }));
  const cols = ["id", "kind", "created", "supports", "valid_until", "journal", "contradictions"] as const;
  const width: Record<string, number> = {};
  for (const c of cols) width[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  const line = (cells: string[]) => cells.map((c) => c.padEnd(width[c])).join("  ");
  const out: string[] = [line(cols as unknown as string[]), cols.map((c) => "-".repeat(width[c])).join("  ")];
  for (const r of rows) out.push(line(cols.map((c) => r[c])));
  out.push("");
  out.push(
    `Итого: ${rows.length} кандидата(ов). Скан ничего не менял (readonly):`,
    "по каждой строке решает владелец — valid_until в прошлом (узел выпадет из выдачи),",
    "superseded/refuted или удаление. Применение: просмотри отчёт, разреши выбранные строки",
    "(expire: true) и передай файл в `megamemory expire --report <json> --apply`,",
    "либо передай явно выбранные id через `--ids`. Автоприменения из скана нет."
  );
  return out.join("\n");
}
