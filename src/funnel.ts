import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import {
  SESSION_GAP_MINUTES,
  parseTimelineTs,
  sessionize,
  selectTimelineWindow,
  type TimelineRow,
} from "./sessions.js";

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
 * Этап A (план 20+21 v3 §6.A3): сам алгоритм сессиизации вынесен в общий
 * module sessions.ts — один и тот же для funnel и health; вызов БЕЗ новых
 * аргументов сохраняет старый режим all и legacy-семантику.
 */

// Re-export: существующие потребители импортируют константу из funnel.
export { SESSION_GAP_MINUTES };

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
 *
 * Этап A (§6.A3): опциональное окно [from, to) (epoch ms; from=null — без
 * нижней границы) задаёт одинаковое окно для всех секций stats; вызов без
 * opts — прежний режим all. Границы сессий, пересекающих окно,
 * восстанавливаются ограниченным обходом до реального разрыва (sessions.ts);
 * события считаются только по записям внутри окна.
 */
export function computeFunnel(
  db: KnowledgeDB,
  opts?: { window?: { from: number | null; to: number } }
): FunnelReport {
  const allRows = db.execSqlAll(
    "SELECT seq, timestamp, tool, params, is_write, is_error, affected_ids FROM timeline ORDER BY seq ASC"
  ) as TimelineRow[];

  let rows: TimelineRow[];
  let windowRows: TimelineRow[];
  if (opts?.window) {
    const { from, to } = opts.window;
    rows = selectTimelineWindow(db, { from, to });
    const inW = (ts: number): boolean =>
      !Number.isNaN(ts) && (from === null || ts >= from) && ts < to;
    windowRows = rows.filter((r) => inW(parseTimelineTs(r.timestamp)));
  } else {
    rows = allRows;
    windowRows = rows;
  }

  // ---- сессиизация (общий модуль) ----
  // Внешние записи восстанавливают принадлежность к сессии, но не входят
  // в метрики окна (включая первый вызов, средние и must_read).
  const windowSeqs = new Set(windowRows.map((r) => r.seq));
  const sessions = sessionize(rows)
    .map((s) => ({ ...s, entries: s.entries.filter((e) => windowSeqs.has(e.seq)) }))
    .filter((s) => s.entries.length > 0);

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
      first: windowRows[0]?.timestamp,
      last: windowRows[windowRows.length - 1]?.timestamp,
      entries: windowRows.length,
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
      // Этап A (§15.J0): legacy-название сохранено с явным описанием —
      // считает get_concept-вызовы, не чтение файлов агентом.
      `${report.must_read_opened} opened via get_concept (legacy: не чтение файлов)`
    )
  );
  return lines;
}
