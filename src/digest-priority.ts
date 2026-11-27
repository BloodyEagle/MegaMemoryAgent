/**
 * P4.3 (план 20+21 v3 §13): приоритет генерации дайджестов по явной
 * полезности.
 *
 * Ключевые решения:
 * - НЕ опираться на per-node статистику getUsageStats — её не существует
 *   (R20): getUsageStats агрегирует запросы/оценки токенов по дням, а не
 *   использование каждого узла. Частота выводится из ЯВНЫХ событий журнала
 *   (timeline: get_concept, confirm_supports, create_concept с evidence,
 *   link) и opt-in телеметрии J0 (issued_nodes understand), где включена.
 * - Три РАЗНЫХ счётчика, ни один не выдаётся за другое:
 *   issued — «попал в выдачу» (из телеметрии understand; без телеметрии —
 *   unavailable, не ноль);
 *   opened — «открыт» (успешный get_concept с id области; ошибки — отдельный
 *   счётчик opened_error: точный исход операции для новых данных);
 *   used — «явно использован» (узел области фигурирует в confirm_supports,
 *   в evidence/edges созданной записи, в link).
 * - Приоритет влияет на ПОРЯДОК/ограниченную очередь и не исключает области:
 *   остаток очереди возвращается явно (queued).
 * - Отсутствие достаточных событий — стабильный fallback (прежний порядок
 *   скана) с явной пометкой недостатка данных.
 * - Расчёт только читает: план дайджестов не пишет ни узлов, ни журнала.
 *   Счётчики выводятся из существующих событий на момент генерации —
 *   обновление счётчиков при каждом чтении дайджеста не требуется (нулевая
 *   цена записи на чтение; оценка цены — в отчёте M6).
 *
 * Этот модуль — только счётчики и признаки устаревания; порядок очереди
 * строит digest.ts на общем scanDigestCandidates (правила количества детей
 * не размножаются).
 */

import fs from "node:fs";
import type { KnowledgeDB } from "./db.js";
import { digestEligibleChildren, digestSourceChildren, existingDigestId } from "./digest-sources.js";

export interface DigestUseCounters {
  /** Успешные открытия get_concept узлов области (узел области + дети). */
  opened: number;
  /** Ошибочные get_concept — точный исход, отдельным счётчиком. */
  opened_error: number;
  /** Явное использование: confirm_supports / evidence при создании / link. */
  used: number;
  /** «Попал в выдачу» (issued_nodes understand из телеметрии J0); без
   * телеметрии — unavailable, не ноль. */
  issued: number | "unavailable";
}

export interface DigestUseOpts {
  /** Путь opt-in JSONL-телеметрии J0 (обычно из MEGAMEMORY_TELEMETRY_PATH). */
  telemetry_path?: string | null;
}

interface TimelineEventRow {
  tool: string;
  params: string;
  is_error: number;
  affected_ids: string;
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseParams(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** issued_ids событий understand из телеметрии J0; файл не задан/недоступен — null (issued unavailable). */
function loadIssuedEvents(telemetryPath: string | null | undefined): Array<Set<string>> | null {
  if (!telemetryPath) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(telemetryPath, "utf8");
  } catch {
    return null;
  }
  const events: Array<Set<string>> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        tool?: unknown;
        outcome?: unknown;
        issued_nodes?: unknown;
      };
      if (parsed.tool !== "understand" || parsed.outcome !== "ok") continue;
      const nodes = Array.isArray(parsed.issued_nodes) ? parsed.issued_nodes : null;
      if (!nodes) continue;
      const ids = new Set<string>();
      for (const n of nodes) {
        if (typeof n === "object" && n !== null && typeof (n as { id?: unknown }).id === "string") {
          ids.add((n as { id: string }).id);
        }
      }
      if (ids.size > 0) events.push(ids);
    } catch {
      // Битая строка телеметрии не ломает расчёт.
    }
  }
  return events;
}

/**
 * Счётчики полезности для области (набор id): ОДИН проход по журналу на весь
 * расчёт плана, а не на каждого кандидата.
 */
export function computeUseCounters(
  db: KnowledgeDB,
  areaIds: string[],
  opts: DigestUseOpts = {}
): DigestUseCounters {
  const area = new Set(areaIds);
  const counters: DigestUseCounters = { opened: 0, opened_error: 0, used: 0, issued: "unavailable" };
  if (area.size === 0) return counters;

  const rows = db.execSqlAll(
    `SELECT tool, params, is_error, affected_ids FROM timeline
     WHERE tool IN ('get_concept', 'confirm_supports', 'create_concept', 'link')`
  ) as TimelineEventRow[];
  for (const row of rows) {
    const params = parseParams(row.params);
    if (row.tool === "get_concept") {
      const ids = new Set<string>(parseJsonArray(row.affected_ids));
      if (params) {
        if (typeof params.id === "string") ids.add(params.id);
        if (Array.isArray(params.ids)) {
          for (const id of params.ids) if (typeof id === "string") ids.add(id);
        }
      }
      let hit = false;
      for (const id of ids) {
        if (area.has(id)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        if (row.is_error) counters.opened_error += 1;
        else counters.opened += 1;
      }
      continue;
    }
    // used — только успешные операции: ошибка не является использованием.
    if (row.is_error) continue;
    let hit = false;
    if (row.tool === "confirm_supports" && params) {
      if (typeof params.decision_id === "string" && area.has(params.decision_id)) hit = true;
      if (!hit && Array.isArray(params.items)) {
        for (const item of params.items) {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as { support_id?: unknown }).support_id === "string" &&
            area.has((item as { support_id: string }).support_id)
          ) {
            hit = true;
            break;
          }
        }
      }
    } else if (row.tool === "link" && params) {
      if (typeof params.from === "string" && area.has(params.from)) hit = true;
      if (!hit && typeof params.to === "string" && area.has(params.to)) hit = true;
    } else if (row.tool === "create_concept" && params) {
      if (Array.isArray(params.evidence)) {
        for (const e of params.evidence) {
          if (
            typeof e === "object" &&
            e !== null &&
            typeof (e as { node?: unknown }).node === "string" &&
            area.has((e as { node: string }).node)
          ) {
            hit = true;
            break;
          }
        }
      }
      if (!hit && Array.isArray(params.edges)) {
        for (const e of params.edges) {
          if (typeof e !== "object" || e === null) continue;
          const from = (e as { from?: unknown }).from;
          const to = (e as { to?: unknown }).to;
          if ((typeof from === "string" && area.has(from)) || (typeof to === "string" && area.has(to))) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) counters.used += 1;
  }

  const issuedEvents = loadIssuedEvents(opts.telemetry_path);
  if (issuedEvents !== null) {
    let issued = 0;
    for (const ids of issuedEvents) {
      for (const id of ids) {
        if (area.has(id)) {
          issued += 1;
          break;
        }
      }
    }
    counters.issued = issued;
  }
  return counters;
}

export interface DigestPriorityInfo {
  counters: DigestUseCounters;
  /** Существующий дайджест расходится с записанным составом источников. */
  stale_existing: boolean;
}

/**
 * Приоритетная информация одной области-кандидата: счётчики полезности по
 * (родитель + существующий дайджест + eligible дети области) и признак
 * устаревания существующего дайджеста (content-derived, тот же механизм
 * K-08 digestSourceChildren).
 */
export function computeDigestPriority(
  db: KnowledgeDB,
  moduleId: string,
  opts: DigestUseOpts = {}
): DigestPriorityInfo {
  const areaIds = [moduleId, ...digestEligibleChildren(db, moduleId).map((c) => c.id)];
  const existing = existingDigestId(db, moduleId);
  let stale_existing = false;
  if (existing) {
    try {
      stale_existing = digestSourceChildren(db, existing).stale;
    } catch {
      stale_existing = false;
    }
  }
  return { counters: computeUseCounters(db, areaIds, opts), stale_existing };
}
