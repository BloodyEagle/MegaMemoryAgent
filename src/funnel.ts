import pc from "picocolors";
import { KnowledgeDB } from "./db.js";

/**
 * План 13 §2.3: воронка «understand → follow-up → запись» по реальному
 * журналу timeline — не по догадкам и не по самоотчёту агента.
 *
 * Запрос по timeline живёт ЗДЕСЬ (группа C владеет этим файлом), прямым SQL
 * через публичный db.execSqlAll — методы в db.ts не добавляются (там владелец
 * план 13.1).
 *
 * Правила сессиизации сверены 1:1 с эталоном
 * plan-13-runs/funnel-baseline.mjs: на его данных (timeline-copy.db, 147
 * записей) computeFunnel обязан давать те же числа — это кросс-проверка.
 */

/** Разрыв между соседними записями больше этого числа минут = новая сессия. */
export const SESSION_GAP_MINUTES = 30;

// В тексте плана §2.3 среди follow-up инструментов упомянут «search» —
// инструмента с таким именем в сервере нет. Набор ниже фиксирует
// договорённость группы и совпадает с эталоном funnel-baseline.mjs.
const FOLLOW_UP_TOOLS = new Set([
  "get_concept",
  "provenance_trace",
  "provenance_history",
  "provenance_audit",
  "check_artifacts",
  "board",
  "list_roots",
  "slot_get",
  "slot_list",
  "trail_get",
]);

interface TimelineRow {
  seq: number;
  timestamp: string;
  tool: string;
  params: string;
  is_write: number;
  is_error: number;
  affected_ids: string;
}

interface Session {
  start: number;
  end: number;
  entries: TimelineRow[];
}

export interface FunnelReport {
  /** Разрешённый путь базы (db.dbPath). */
  db: string;
  window: { first: string | undefined; last: string | undefined; entries: number };
  session_gap_minutes: number;
  sessions_total: number;
  understand_sessions: number;
  started_with_understand: number;
  with_follow_up: number;
  with_record: number;
  avg_calls_per_understand_session: number;
  must_read_issued: number;
  must_read_opened: number;
  shares: { follow_up_pct: number; record_pct: number };
}

/** Timestamps timeline — «YYYY-MM-DD HH:MM:SS» в UTC (SQLite datetime('now')). */
const parseTs = (s: string): number => new Date(s.replace(" ", "T") + "Z").getTime();

const parseIds = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Посчитать воронку по журналу timeline.
 *
 * Сессия — последовательность записей timeline, где соседние записи разнесены
 * не больше чем на SESSION_GAP_MINUTES минут. understand-сессия — сессия,
 * содержащая хотя бы одну запись tool='understand' (в том числе с is_error).
 */
export function computeFunnel(db: KnowledgeDB): FunnelReport {
  const rows = db.execSqlAll(
    "SELECT seq, timestamp, tool, params, is_write, is_error, affected_ids FROM timeline ORDER BY seq ASC"
  ) as TimelineRow[];

  // ---- сессиизация ----
  const sessions: Session[] = [];
  for (const r of rows) {
    const ts = parseTs(r.timestamp);
    const last = sessions[sessions.length - 1];
    if (!last || ts - last.end > SESSION_GAP_MINUTES * 60_000) {
      sessions.push({ start: ts, end: ts, entries: [r] });
    } else {
      last.end = ts;
      last.entries.push(r);
    }
  }

  // ---- метрики ----
  const understandSessions = sessions.filter((s) =>
    s.entries.some((e) => e.tool === "understand")
  );
  const startedWithUnderstand = understandSessions.filter(
    (s) => s.entries[0].tool === "understand"
  );

  let sessionsWithFollowUp = 0;
  let sessionsWithRecord = 0;
  let mustReadIssued = 0;
  let mustReadOpened = 0;

  for (const s of understandSessions) {
    const firstU = s.entries.findIndex((e) => e.tool === "understand");
    const after = s.entries.slice(firstU + 1);
    if (after.some((e) => FOLLOW_UP_TOOLS.has(e.tool) && !e.is_error)) {
      sessionsWithFollowUp += 1;
    }
    if (after.some((e) => e.is_write === 1 && !e.is_error)) {
      sessionsWithRecord += 1;
    }
    for (let i = 0; i < s.entries.length; i += 1) {
      const e = s.entries[i];
      if (e.tool !== "understand") continue;
      let p: Record<string, unknown> = {};
      try {
        p = JSON.parse(e.params);
      } catch {
        // Старые/битые записи без разборного params — must_read нет, это 0.
      }
      const ids = Array.isArray(p.must_read_ids) ? p.must_read_ids : [];
      mustReadIssued += Array.isArray(p.must_read) ? p.must_read.length : 0;
      // B-07 (аудит 2026-11-12): открытие должно быть ПОСЛЕ конкретной
      // выдачи рекомендации. Поиск по всей сессии засчитывал чтение,
      // случившееся до understand; timestamps секундные, поэтому порядок —
      // по позиции записи в журнале (seq), не по времени. Каждая выдача
      // ищет своё чтение только среди последующих записей; повторные
      // выдачи считаются независимо. Без фильтра is_error — как в эталоне.
      for (const id of ids) {
        const opened = s.entries
          .slice(i + 1)
          .some((o) => o.tool === "get_concept" && parseIds(o.affected_ids).includes(String(id)));
        if (opened) mustReadOpened += 1;
      }
    }
  }

  const totalCallsInU = understandSessions.reduce((n, s) => n + s.entries.length, 0);

  return {
    db: db.dbPath,
    window: {
      first: rows[0]?.timestamp,
      last: rows[rows.length - 1]?.timestamp,
      entries: rows.length,
    },
    session_gap_minutes: SESSION_GAP_MINUTES,
    sessions_total: sessions.length,
    understand_sessions: understandSessions.length,
    started_with_understand: startedWithUnderstand.length,
    with_follow_up: sessionsWithFollowUp,
    with_record: sessionsWithRecord,
    avg_calls_per_understand_session: understandSessions.length
      ? Number((totalCallsInU / understandSessions.length).toFixed(2))
      : 0,
    must_read_issued: mustReadIssued,
    must_read_opened: mustReadOpened,
    shares: {
      follow_up_pct: understandSessions.length
        ? Number(((sessionsWithFollowUp / understandSessions.length) * 100).toFixed(1))
        : 0,
      record_pct: understandSessions.length
        ? Number(((sessionsWithRecord / understandSessions.length) * 100).toFixed(1))
        : 0,
    },
  };
}

function funnelRow(label: string, value: string, detail?: string): string {
  const prefix = `    ${pc.cyan(`${label}:`.padEnd(16))}${pc.green(value)}`;
  return detail ? `${prefix} ${pc.dim(detail)}` : prefix;
}

/**
 * Человекочитаемая секция в стиле stats.ts (printRow) — для
 * `stats --funnel` без `--json`.
 */
export function formatFunnel(report: FunnelReport): string[] {
  const lines: string[] = [];
  lines.push(`  ${pc.bold("Funnel (understand → follow-up → record)")}`);
  const { first, last, entries } = report.window;
  lines.push(funnelRow("Window", `${first ?? "—"} … ${last ?? "—"}`, `${entries} entries`));
  lines.push(
    funnelRow("Sessions", String(report.sessions_total), `gap > ${report.session_gap_minutes} min`)
  );
  lines.push(
    funnelRow(
      "Understand sessions",
      String(report.understand_sessions),
      `${report.started_with_understand} started with understand`
    )
  );
  lines.push(
    funnelRow(
      "Follow-up",
      String(report.with_follow_up),
      `${report.shares.follow_up_pct}% of understand sessions`
    )
  );
  lines.push(
    funnelRow(
      "Record",
      String(report.with_record),
      `${report.shares.record_pct}% of understand sessions`
    )
  );
  lines.push(
    funnelRow(
      "Avg calls",
      String(report.avg_calls_per_understand_session),
      "per understand session"
    )
  );
  lines.push(
    funnelRow(
      "must_read",
      `${report.must_read_issued} issued`,
      `${report.must_read_opened} opened via get_concept`
    )
  );
  return lines;
}
