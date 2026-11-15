import type { KnowledgeDB } from "./db.js";
import { isNodeExpired } from "./db.js";
import { CheckBudget, computeSupportCheck } from "./support-baselines.js";
import {
  SESSION_GAP_MINUTES,
  parseTimelineTs,
  sessionize,
  selectTimelineWindow,
  timelineTsString,
  type TimelineRow,
} from "./sessions.js";
import pc from "picocolors";

/**
 * Этап A (план 20+21 v3 §6): честные health-метрики — ЕДИНЫЙ чистый
 * расчёт, doctor и stats — потребители одного interface (§17 seam 1).
 *
 * A1 — три группы не смешивать:
 * - state_now: состояние сейчас (безопорные решения, снимки) — не окно;
 * - activity_window: активность за окно (записи, сессии, must_read);
 * - экономия НЕ выводится из первых двух — полей экономики здесь нет.
 *
 * A4 — поведение: отсутствие записей никогда не является неисправностью;
 * старая база без колонок/таблиц — честный unavailable, не падение блока
 * и не создание таблиц; расчёт читает только SELECT и не вызывает
 * list_roots/insertUsage (без побочных записей usage).
 */

export type HealthWindowKind = "7d" | "30d" | "all";

export interface HealthOptions {
  /** 7d по умолчанию; all — весь наблюдаемый журнал. */
  window?: HealthWindowKind;
  /** Время один раз на запуск (epoch ms); окно [from, to). */
  now?: number;
}

export type AgentNodesCreated =
  | { available: true; count: number; soft_deleted_included: number; note: string }
  | { available: false; reason: string };

export interface HealthReport {
  db: string;
  generated_at: string;
  window: { requested: HealthWindowKind; from: string | null; to: string };
  completeness: {
    coverage: "full" | "partial" | "unknown";
    reasons: string[];
    first_event: string | null;
    last_event: string | null;
    timeline_entries: number;
    sessionization: `gap_${number}m`;
    sessions_unclosed: number;
    sessions_started_before_window: number;
    unknown_outcomes: number;
  };
  state_now: {
    unavailable: string | false;
    decisions_in_scope: number;
    with_live_support: number;
    unsupported_decisions: number;
    without_live_support_with_snapshot: number;
    snapshot_breakdown: {
      supports_vanished: number;
      claim_changed: number;
      confirmed_empty_set: number;
      check_changed: number;
      check_unknown: number;
      check_incomplete: number;
    };
    snapshot_checked: number;
    snapshot_truncated: boolean;
    excluded: {
      removed: number;
      not_active: number;
      refuted_or_abandoned: number;
      expired: number;
    };
    note: string;
  };
  activity_window: {
    agent_nodes_created: AgentNodesCreated;
    understand_calls: { total: number; successful: number; errored: number };
    writes: {
      knowledge: number;
      confirmation: number;
      maintenance: number;
      no_op: number;
      unknown: number;
      errors: number;
    };
    sessions: { total: number; understand_sessions: number; silent_sessions: number; note: string };
    must_read: { refs_returned: number; opened_legacy: number; legacy_note: string };
  };
}

// ---- категории записей (A2.3): структурные признаки, не текст сообщений ----

const CONFIRMATION_TOOLS = new Set(["confirm_supports"]);
const MAINTENANCE_TOOLS = new Set([
  "remove_concept",
  "check_artifacts",
  "resolve_conflict",
  "trail_save",
  "trail_refresh",
  "trail_extend",
  "slot_set",
  "slot_release",
  "task_add",
  "task_done",
]);
const WRITE_TOOLS = new Set(["create_concept", "update_concept", "link", ...CONFIRMATION_TOOLS, ...MAINTENANCE_TOOLS]);

type WriteCategory = "knowledge" | "confirmation" | "maintenance" | "no_op" | "unknown";

interface ParamsLike {
  must_read?: unknown;
  must_read_ids?: unknown;
  changed_fields?: unknown;
}

function parseParams(raw: string): ParamsLike {
  try {
    const p: unknown = JSON.parse(raw);
    return typeof p === "object" && p !== null ? (p as ParamsLike) : {};
  } catch {
    return {};
  }
}

/**
 * Категория успешной записи по структурным признакам строки журнала.
 * duplicate create (is_write=0) и no-op update (пустой список полей) — не
 * пополнение знаний; неинтерпретируемые записи — unknown; старые события
 * по тексту сообщений НЕ восстанавливаются.
 */
function writeCategory(row: TimelineRow): WriteCategory | null {
  if (row.is_error === 1) return null; // ошибочные попытки считаются отдельно (errors)
  if (row.is_write === 1) {
    if (row.tool === "create_concept") return "knowledge";
    if (row.tool === "update_concept") {
      const changed = parseParams(row.params).changed_fields;
      return Array.isArray(changed) && changed.length === 0 ? "no_op" : "knowledge";
    }
    if (CONFIRMATION_TOOLS.has(row.tool)) return "confirmation";
    if (MAINTENANCE_TOOLS.has(row.tool)) return "maintenance";
    return "unknown";
  }
  // create_concept без записи — отказ дедупликации (duplicate_of).
  if (row.tool === "create_concept") return "no_op";
  return null;
}

function hasTable(db: KnowledgeDB, name: string): boolean {
  return (
    db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
      name
    ) !== undefined
  );
}

function hasColumn(db: KnowledgeDB, table: string, col: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

/** Локальная копия семантики db.envInt (файл db.ts — владение план 13.1). */
function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
}

const STANDING_NOTE =
  "непрерывный журнал доказывает только наличие записанных событий, а не полноту активности клиента (best-effort логирование — не аудит)";
const SILENT_NOTE =
  "информационная метрика: сессии, где «не записывали», а не «память не используется»";
const LEGACY_NOTE =
  "opened_legacy — legacy-название: считает get_concept-вызовы после выдачи, не чтение файлов агентом";
const SCOPE_NOTE =
  "область отчёта health; общий weak_links не сужается (predicates provenance переиспользованы)";
const AGENT_NODES_NOTE =
  "снимочная метрика происхождения/даты строк узлов, не число операций записи: импорт сохраняет атрибуты";

// Бюджет снимков на один запуск расчёта; исчерпание — честный
// check_incomplete + truncate-флаг, а не тихий срез.
function makeBudget(): CheckBudget {
  return new CheckBudget(20_000, 8_000_000);
}

export function computeHealth(db: KnowledgeDB, opts: HealthOptions = {}): HealthReport {
  const now = opts.now ?? Date.now();
  const windowKind = opts.window ?? "7d";
  const windowMs = windowKind === "7d" ? 7 * 86_400_000 : windowKind === "30d" ? 30 * 86_400_000 : null;
  const from = windowMs === null ? null : now - windowMs;
  const generatedAt = timelineTsString(now);
  const toStr = timelineTsString(now);
  const fromStr = from === null ? null : timelineTsString(from);

  const inWindow = (ts: number): boolean =>
    !Number.isNaN(ts) && (from === null || ts >= from) && ts < now;

  // ---- журнал и полнота окна (A3) ----
  const hasTimeline = hasTable(db, "timeline");
  const bounds = hasTimeline
    ? db.getTimelineBounds()
    : { first: null, last: null, count: 0 };

  const selected: TimelineRow[] =
    hasTimeline && bounds.count > 0 ? selectTimelineWindow(db, { from, to: now }) : [];
  const windowRows = selected.filter((r) => inWindow(parseTimelineTs(r.timestamp)));

  const reasons: string[] = [];
  let coverage: "full" | "partial" | "unknown";
  if (!hasTimeline || bounds.count === 0) {
    coverage = "unknown";
    reasons.push("журнал timeline пуст или недоступен — активность за окно не наблюдаема");
  } else {
    if (windowKind === "all") {
      coverage = "partial";
      reasons.push(
        "окно = весь наблюдаемый журнал: события до первой записи могли существовать и быть удалены"
      );
    } else if (bounds.first !== null && bounds.first <= (fromStr as string)) {
      coverage = "full";
    } else {
      coverage = "partial";
      reasons.push(
        `начало окна не покрыто журналом (первая запись ${bounds.first}): события до неё отсутствовали либо удалены`
      );
    }
    const ageDays = envInt("MEGAMEMORY_TIMELINE_RETENTION_DAYS", 90);
    const maxEntries = envInt("MEGAMEMORY_TIMELINE_MAX_ENTRIES", 50_000);
    if (ageDays > 0) {
      reasons.push(`включён возрастной ретеншн (${ageDays} дн.) — старые события могли быть удалены`);
    }
    if (maxEntries > 0) {
      reasons.push(`включён лимит количества (${maxEntries} записей) — самое старое могло быть вытеснено`);
    }
    reasons.push(STANDING_NOTE);
  }

  // ---- сессии (единый модуль сессиизации) ----
  const sessions = sessionize(selected);
  const overlapping = sessions.filter((s) => s.entries.some((e) => inWindow(parseTimelineTs(e.timestamp))));
  const maxSeqRow = hasTimeline && bounds.count > 0
    ? (db.execSqlFirst("SELECT MAX(seq) AS m FROM timeline") as { m: number | null })
    : { m: null };
  const maxSeq = maxSeqRow.m ?? -1;
  const isUnclosed = (s: { entries: TimelineRow[] }): boolean =>
    s.entries.length > 0 && s.entries[s.entries.length - 1].seq === maxSeq;

  // ---- события окна ----
  let understandTotal = 0;
  let understandOk = 0;
  let understandErr = 0;
  const writes = { knowledge: 0, confirmation: 0, maintenance: 0, no_op: 0, unknown: 0, errors: 0 };
  let mustReadRefsReturned = 0;
  let unknownOutcomes = 0;

  for (const r of windowRows) {
    if (r.tool === "understand") {
      understandTotal += 1;
      if (r.is_error === 1) understandErr += 1;
      else understandOk += 1;
    }
    if (r.is_error === 1 && (r.is_write === 1 || WRITE_TOOLS.has(r.tool))) {
      writes.errors += 1;
      continue;
    }
    const cat = writeCategory(r);
    if (cat !== null) {
      writes[cat] += 1;
      if (cat === "unknown") unknownOutcomes += 1;
    }
    if (r.tool === "understand" && r.is_error === 0) {
      const p = parseParams(r.params);
      if (Array.isArray(p.must_read)) mustReadRefsReturned += p.must_read.length;
    }
  }

  // must_read_opened (legacy-семантика: get_concept после выдачи в той же
  // сессии, порядок по позиции журнала — B-07), в границах окна.
  let mustReadOpenedLegacy = 0;
  const issued = new Set<string>();
  for (const s of sessions) {
    issued.clear();
    for (const e of s.entries) {
      if (!inWindow(parseTimelineTs(e.timestamp))) continue;
      if (e.tool === "understand" && e.is_error === 0) {
        const ids = parseParams(e.params).must_read_ids;
        if (Array.isArray(ids)) for (const id of ids) issued.add(String(id));
      } else if (e.tool === "get_concept" && issued.size > 0) {
        try {
          const parsed: unknown = JSON.parse(e.affected_ids);
          if (Array.isArray(parsed) && parsed.some((id) => issued.has(String(id)))) {
            mustReadOpenedLegacy += 1;
          }
        } catch {
          // битый affected_ids — открытие не засчитывается
        }
      }
    }
  }

  const understandSessions = overlapping.filter((s) =>
    s.entries.some(
      (e) => e.tool === "understand" && e.is_error === 0 && inWindow(parseTimelineTs(e.timestamp))
    )
  );
  let silentSessions = 0;
  for (const s of understandSessions) {
    if (isUnclosed(s)) continue; // незавершённая текущая сессия — не нарушение
    const entriesInWindow = s.entries.filter((e) => inWindow(parseTimelineTs(e.timestamp)));
    const firstOkU = entriesInWindow.findIndex((e) => e.tool === "understand" && e.is_error === 0);
    if (firstOkU < 0) continue;
    const after = entriesInWindow.slice(firstOkU + 1);
    const wrote = after.some((e) => e.is_write === 1 && e.is_error === 0);
    if (!wrote) silentSessions += 1;
  }

  // ---- agent_nodes_created (A2.1): снимочная метрика происхождения/даты ----
  let agentNodes: AgentNodesCreated;
  if (!hasColumn(db, "nodes", "created_via") || !hasColumn(db, "nodes", "created_at")) {
    agentNodes = {
      available: false,
      reason: "в базе нет колонок nodes.created_via/created_at (старая схема) — происхождение за окно недоступно",
    };
  } else {
    const where = "FROM nodes WHERE created_via = 'agent' AND created_at IS NOT NULL" +
      (fromStr === null ? " AND created_at < ?" : " AND created_at >= ? AND created_at < ?");
    const total = (
      db.execSqlFirst(
        `SELECT count(*) AS n ${where}`,
        ...(fromStr === null ? [toStr] : [fromStr, toStr])
      ) as { n: number }
    ).n;
    const softDeleted = (
      db.execSqlFirst(
        `SELECT count(*) AS n ${where} AND removed_at IS NOT NULL`,
        ...(fromStr === null ? [toStr] : [fromStr, toStr])
      ) as { n: number }
    ).n;
    agentNodes = { available: true, count: total, soft_deleted_included: softDeleted, note: AGENT_NODES_NOTE };
  }

  // ---- состояние сейчас: безопорные решения (A2.5/A2.6) ----
  const state: HealthReport["state_now"] = {
    unavailable: false,
    decisions_in_scope: 0,
    with_live_support: 0,
    unsupported_decisions: 0,
    without_live_support_with_snapshot: 0,
    snapshot_breakdown: {
      supports_vanished: 0,
      claim_changed: 0,
      confirmed_empty_set: 0,
      check_changed: 0,
      check_unknown: 0,
      check_incomplete: 0,
    },
    snapshot_checked: 0,
    snapshot_truncated: false,
    excluded: { removed: 0, not_active: 0, refuted_or_abandoned: 0, expired: 0 },
    note: SCOPE_NOTE,
  };

  if (!hasTable(db, "edges")) {
    state.unavailable = "в базе нет таблицы edges — живость опор недоступна (старая схема)";
  } else if (!hasTable(db, "support_baselines")) {
    state.unavailable = "в базе нет таблицы support_baselines — подтверждённые снимки недоступны (старая схема)";
  } else {
    const hasStatusCol = hasColumn(db, "nodes", "status");
    const hasEpiCol = hasColumn(db, "nodes", "epistemic_status");
    const hasUntilCol = hasColumn(db, "nodes", "valid_until");
    const rows = db.execSqlAll(
      `SELECT id, removed_at${hasStatusCol ? ", status" : ""}${hasEpiCol ? ", epistemic_status" : ""}${hasUntilCol ? ", valid_until" : ""}
       FROM nodes WHERE kind = 'decision'`
    ) as Array<Record<string, string | null>>;

    const nowDate = new Date(now);
    const scopeIds = new Set<string>();
    for (const r of rows) {
      if (r.removed_at) {
        state.excluded.removed += 1;
        continue;
      }
      const status = hasStatusCol ? (r.status ?? "active") : "active";
      const epi = hasEpiCol ? r.epistemic_status : null;
      const validUntil = hasUntilCol ? r.valid_until : null;
      if (!r.id) {
        // Битая строка без id — не попадает в расчёт ни одной группы.
        continue;
      }
      if (status !== "active") {
        state.excluded.not_active += 1;
      } else if (epi === "refuted" || epi === "abandoned") {
        state.excluded.refuted_or_abandoned += 1;
      } else if (
        isNodeExpired({ status, valid_until: validUntil, removed_at: null }, nowDate)
      ) {
        state.excluded.expired += 1;
      } else {
        scopeIds.add(r.id);
      }
    }
    state.decisions_in_scope = scopeIds.size;

    if (scopeIds.size > 0) {
      const live = db.execSqlAll(
        `SELECT n.id,
           EXISTS (SELECT 1 FROM edges e JOIN nodes t ON t.id = e.to_id AND t.removed_at IS NULL
                   WHERE e.from_id = n.id AND e.relation = 'informed_by' AND e.removed_at IS NULL) AS has_live,
           EXISTS (SELECT 1 FROM support_baselines b WHERE b.decision_id = n.id AND b.superseded_at IS NULL) AS has_active_b,
           EXISTS (SELECT 1 FROM support_baselines b WHERE b.decision_id = n.id AND b.superseded_at IS NOT NULL) AS has_superseded_b
         FROM nodes n WHERE n.removed_at IS NULL AND n.kind = 'decision'`
      ) as Array<{ id: string; has_live: number; has_active_b: number; has_superseded_b: number }>;

      const snapshotIds: Array<{ id: string; activeB: number; supersededB: number }> = [];
      for (const r of live) {
        if (!scopeIds.has(r.id)) continue;
        if (r.has_live === 1) {
          state.with_live_support += 1;
        } else if (r.has_active_b === 1 || r.has_superseded_b === 1) {
          state.without_live_support_with_snapshot += 1;
          snapshotIds.push({ id: r.id, activeB: r.has_active_b, supersededB: r.has_superseded_b });
        } else {
          state.unsupported_decisions += 1;
        }
      }

      // A2.6: наличие claim_digest не делает случай корректным пустым
      // подтверждением — существующий support-check различает случаи.
      const budget = makeBudget();
      snapshotIds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const { id, activeB, supersededB } of snapshotIds) {
        state.snapshot_checked += 1;
        if (budget.exhausted) {
          state.snapshot_breakdown.check_incomplete += 1;
          state.snapshot_truncated = true;
          continue;
        }
        if (activeB === 0 && supersededB > 0) {
          // Явно подтверждённый пустой набор — история признана, не потеря.
          state.snapshot_breakdown.confirmed_empty_set += 1;
          continue;
        }
        const view = computeSupportCheck(db, id, budget);
        if (budget.exhausted) {
          // Бюджет кончился на этом решении — вердикт ненадёжен.
          state.snapshot_breakdown.check_incomplete += 1;
          state.snapshot_truncated = true;
          continue;
        }
        if (view === null) {
          state.snapshot_breakdown.check_unknown += 1;
        } else if (view.incomplete) {
          state.snapshot_breakdown.check_incomplete += 1;
        } else if (view.claim_changed) {
          state.snapshot_breakdown.claim_changed += 1;
        } else if (view.state === "changed") {
          const removedOnly = view.changed?.every((c) => c.reasons.includes("removed"));
          if (removedOnly) state.snapshot_breakdown.supports_vanished += 1;
          else state.snapshot_breakdown.check_changed += 1;
        } else {
          state.snapshot_breakdown.check_unknown += 1;
        }
      }
    }
  }

  return {
    db: db.dbPath,
    generated_at: generatedAt,
    window: { requested: windowKind, from: fromStr, to: toStr },
    completeness: {
      coverage,
      reasons,
      first_event: bounds.first,
      last_event: bounds.last,
      timeline_entries: windowRows.length,
      sessionization: `gap_${SESSION_GAP_MINUTES}m` as const,
      sessions_unclosed: overlapping.filter(isUnclosed).length,
      sessions_started_before_window: from === null
        ? 0
        : overlapping.filter((s) => parseTimelineTs(s.entries[0].timestamp) < (from as number)).length,
      unknown_outcomes: unknownOutcomes,
    },
    state_now: state,
    activity_window: {
      agent_nodes_created: agentNodes,
      understand_calls: { total: understandTotal, successful: understandOk, errored: understandErr },
      writes,
      sessions: {
        total: overlapping.length,
        understand_sessions: understandSessions.length,
        silent_sessions: silentSessions,
        note: SILENT_NOTE,
      },
      must_read: {
        refs_returned: mustReadRefsReturned,
        opened_legacy: mustReadOpenedLegacy,
        legacy_note: LEGACY_NOTE,
      },
    },
  };
}

// ---- человекочитаемые формы ----

function row(label: string, value: string, detail?: string): string {
  const prefix = `    ${pc.cyan(`${label}:`.padEnd(18))}${pc.green(value)}`;
  return detail ? `${prefix} ${pc.dim(detail)}` : prefix;
}

/** Развёрнутая секция для `stats --health`. */
export function formatHealth(report: HealthReport): string[] {
  const lines: string[] = [];
  lines.push(`  ${pc.bold("Health (state / activity / completeness — economy is not derived)")}`);
  lines.push(
    row(
      "Window",
      `${report.window.from ?? "—"} … ${report.window.to}`,
      `[from, to), ${report.window.requested} · generated ${report.generated_at}`
    )
  );
  lines.push(
    row(
      "Completeness",
      report.completeness.coverage,
      report.completeness.reasons.join("; ")
    )
  );
  lines.push(
    row(
      "Journal",
      `${report.completeness.timeline_entries} entries in window`,
      `${report.completeness.first_event ?? "—"} … ${report.completeness.last_event ?? "—"} · sessions: ${report.completeness.sessions_started_before_window} started before window, ${report.completeness.sessions_unclosed} unclosed`
    )
  );
  lines.push("");
  lines.push(`  ${pc.bold("  State now (decisions)")}`);
  if (report.state_now.unavailable) {
    lines.push(row("Unavailable", report.state_now.unavailable));
  } else {
    lines.push(
      row(
        "Decisions",
        `${report.state_now.decisions_in_scope} in scope`,
        `live support ${report.state_now.with_live_support} · unsupported ${report.state_now.unsupported_decisions} · snapshot-only ${report.state_now.without_live_support_with_snapshot}`
      )
    );
    const b = report.state_now.snapshot_breakdown;
    lines.push(
      row(
        "Snapshots",
        `vanished ${b.supports_vanished}, claim changed ${b.claim_changed}, empty confirmed ${b.confirmed_empty_set}`,
        `other changed ${b.check_changed}, unknown ${b.check_unknown}, incomplete ${b.check_incomplete}${report.state_now.snapshot_truncated ? " · TRUNCATED by budget" : ""} (checked ${report.state_now.snapshot_checked})`
      )
    );
    const ex = report.state_now.excluded;
    lines.push(
      row(
        "Excluded",
        `removed ${ex.removed}, not active ${ex.not_active}`,
        `refuted/abandoned ${ex.refuted_or_abandoned}, expired ${ex.expired} — показаны отдельно, не потеряны`
      )
    );
  }
  lines.push("");
  lines.push(`  ${pc.bold("  Activity (window)")}`);
  const created = report.activity_window.agent_nodes_created;
  lines.push(
    created.available
      ? row("Agent nodes", String(created.count), `${created.soft_deleted_included} soft-deleted included · ${created.note}`)
      : row("Agent nodes", "unavailable", created.reason)
  );
  const u = report.activity_window.understand_calls;
  lines.push(
    row("Understand", `${u.successful} ok`, `${u.errored} errored of ${u.total} (ошибки не входят в новые поля)`)
  );
  const w = report.activity_window.writes;
  lines.push(
    row(
      "Writes",
      `knowledge ${w.knowledge}, confirmation ${w.confirmation}, maintenance ${w.maintenance}`,
      `no-op ${w.no_op}, unknown ${w.unknown}, errors ${w.errors}`
    )
  );
  const s = report.activity_window.sessions;
  lines.push(
    row(
      "Sessions",
      `${s.total} in window`,
      `${s.understand_sessions} with understand · silent ${s.silent_sessions} (${s.note})`
    )
  );
  const m = report.activity_window.must_read;
  lines.push(
    row("must_read", `${m.refs_returned} refs returned`, `${m.opened_legacy} opened · ${m.legacy_note}`)
  );
  return lines;
}

/** Одна строка для doctor (A4): информационная, никогда не проблема. */
export function formatHealthSummary(report: HealthReport): string {
  const created = report.activity_window.agent_nodes_created;
  const agentNodes = created.available ? created.count : "n/a";
  const w = report.activity_window.writes;
  const s = report.activity_window.sessions;
  const parts = [
    `coverage=${report.completeness.coverage}`,
    `agent_nodes=${agentNodes}`,
    `knowledge=${w.knowledge}/conf=${w.confirmation}/maint=${w.maintenance}/no-op=${w.no_op}/err=${w.errors}`,
    `silent=${s.silent_sessions}`,
    `unsupported=${report.state_now.unavailable ? "n/a" : report.state_now.unsupported_decisions}`,
  ];
  if (report.state_now.unavailable) parts.push(`state=unavailable(${report.state_now.unavailable})`);
  return parts.join(" · ") + ` · окно ${report.window.from ?? "—"} … ${report.window.to}`;
}
