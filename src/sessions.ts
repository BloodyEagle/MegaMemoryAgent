import type { KnowledgeDB } from "./db.js";

/**
 * Единый модуль сессиизации (план 20+21 v3 §6.A3): 30-минутный алгоритм
 * живёт ЗДЕСЬ, а не копируется из funnel в doctor/stats. funnel и health —
 * два потребителя одного interface.
 *
 * Окно (A3): время вычисляется один раз на запуск, UTC; окно — [from, to).
 * Сессии через границу окна обрабатываются явным ОГРАНИЧЕННЫМ обходом назад
 * до реального разрыва (фиксированные +30 минут не гарантируют начало
 * длинной сессии) и вперёд до разрыва (закрытие последней сессии).
 */

/** Разрыв между соседними записями больше этого числа минут = новая сессия. */
export const SESSION_GAP_MINUTES = 30;

/** Строка журнала timeline, достаточная для сессиизации и health-метрик. */
export interface TimelineRow {
  seq: number;
  timestamp: string;
  tool: string;
  params: string;
  is_write: number;
  is_error: number;
  affected_ids: string;
}

export interface Session<T> {
  start: number;
  end: number;
  entries: T[];
}

/** Timestamps timeline — «YYYY-MM-DD HH:MM:SS» в UTC (SQLite datetime('now')). */
export function parseTimelineTs(s: string): number {
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

/** Обратное: epoch ms → формат журнала «YYYY-MM-DD HH:MM:SS» в UTC. */
export function timelineTsString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const GAP_MS = SESSION_GAP_MINUTES * 60_000;

/**
 * Сессиизация: соседние записи с разрывом не больше SESSION_GAP_MINUTES
 * минут — одна сессия. Чистая функция; порядок входа сохраняется.
 */
export function sessionize<T extends { timestamp: string }>(rows: T[]): Array<Session<T>> {
  const sessions: Array<Session<T>> = [];
  for (const r of rows) {
    const ts = parseTimelineTs(r.timestamp);
    const last = sessions[sessions.length - 1];
    if (!last || Number.isNaN(ts) || ts - last.end > GAP_MS) {
      sessions.push({ start: ts, end: ts, entries: [r] });
    } else {
      last.end = ts;
      last.entries.push(r);
    }
  }
  return sessions;
}

const TIMELINE_COLS = "seq, timestamp, tool, params, is_write, is_error, affected_ids";

function fetchRows(db: KnowledgeDB, where: string, ...params: unknown[]): TimelineRow[] {
  return db.execSqlAll(
    `SELECT ${TIMELINE_COLS} FROM timeline ${where} ORDER BY seq ASC`,
    ...params
  ) as TimelineRow[];
}

/** Ближайшая запись ДО данной по времени (timestamp, затем seq — для равных секунд). */
function prevInTime(db: KnowledgeDB, row: TimelineRow): TimelineRow | null {
  const rows = db.execSqlAll(
    `SELECT ${TIMELINE_COLS} FROM timeline
     WHERE (timestamp < ?) OR (timestamp = ? AND seq < ?)
     ORDER BY timestamp DESC, seq DESC LIMIT 1`,
    row.timestamp, row.timestamp, row.seq
  ) as TimelineRow[];
  return rows.length > 0 ? rows[0] : null;
}

/** Ближайшая запись ПОСЛЕ данной по времени (timestamp, затем seq). */
function nextInTime(db: KnowledgeDB, row: TimelineRow): TimelineRow | null {
  const rows = db.execSqlAll(
    `SELECT ${TIMELINE_COLS} FROM timeline
     WHERE (timestamp > ?) OR (timestamp = ? AND seq > ?)
     ORDER BY timestamp ASC, seq ASC LIMIT 1`,
    row.timestamp, row.timestamp, row.seq
  ) as TimelineRow[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Выбрать записи для сессиизации в окне [from, to) (ms; from=null — без
 * нижней границы). К записям окна добавляется:
 * - обход НАЗАД от первой записи окна до реального разрыва (> 30 мин) —
 *   сессия, начавшаяся до окна, восстанавливается целиком, а не обрезается
 *   на «from-30мин»; фиксированные +30 минут начало длинной сессии не
 *   находят;
 * - обход ВПЕРЁД от последней записи окна до реального разрыва — закрытие
 *   пересекающей верхнюю границу сессии наблюдаемо, «текущая» (незакрытая)
 *   сессия отличима от закрытой.
 *
 * Записи за границами окна служат только реконструкции границ сессий;
 * счётчики событий окна обязаны фильтровать по принадлежности к [from, to).
 */
export function selectTimelineWindow(
  db: KnowledgeDB,
  opts: { from: number | null; to: number }
): TimelineRow[] {
  const { from, to } = opts;
  const fromStr = from === null ? null : timelineTsString(from);
  const toStr = timelineTsString(to);

  const inWindow =
    fromStr === null
      ? fetchRows(db, "WHERE timestamp < ?", toStr)
      : fetchRows(db, "WHERE timestamp >= ? AND timestamp < ?", fromStr, toStr);

  const selected = [...inWindow];
  if (inWindow.length === 0) return selected;

  // Обход назад по времени, пока записи цепляются с разрывом ≤ 30 мин.
  let prev = inWindow[0];
  for (;;) {
    const cand = prevInTime(db, prev);
    if (!cand) break; // журнал начался — наблюдаемого начала сессии нет
    const cTs = parseTimelineTs(cand.timestamp);
    const pTs = parseTimelineTs(prev.timestamp);
    if (Number.isNaN(cTs) || Number.isNaN(pTs) || pTs - cTs > GAP_MS) break;
    selected.unshift(cand);
    prev = cand;
  }

  // Обход вперёд по времени: закрытие сессии, пересекающей верхнюю границу.
  let last = inWindow[inWindow.length - 1];
  for (;;) {
    const next = nextInTime(db, last);
    if (!next) break; // журнал кончился — сессия не закрыта
    const fTs = parseTimelineTs(next.timestamp);
    const lTs = parseTimelineTs(last.timestamp);
    if (Number.isNaN(fTs) || Number.isNaN(lTs) || fTs - lTs > GAP_MS) break;
    selected.push(next);
    last = next;
  }

  return selected.sort((a, b) => a.seq - b.seq);
}
