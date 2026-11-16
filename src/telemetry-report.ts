/**
 * J1 (план 20+21 v3 §15): локальный агрегатор/отчёт поверх J0-телеметрии.
 *
 * Подготовка ИЗМЕРЕНИЯ полной экономии БЕЗ платных прогонов. Агрегатор
 * читает ТОЛЬКО локальный JSONL-журнал телеметрии (src/telemetry.ts, J0);
 * ни БД, ни сеть, ни внешние вызовы. Секреты не выводятся: payload'ы в
 * журнал не писались вовсе, сообщения ошибок зачищены при записи, отчёт
 * печатает только счётчики и агрегаты.
 *
 * Честность (§15.J1, §4.3):
 * - input/output/cached токены и деньги — ТОЛЬКО реально переданный
 *   провайдерский/клиентский usage; сегодня это unavailable — явная пометка,
 *   не нули. Оценочные величины (response_bytes) живут в ОТДЕЛЬНЫХ полях с
 *   отдельной пометкой и никогда не смешиваются с фактическими токенами.
 * - Деньги считаются только при наличии usage И явно указанной тарифной
 *   версии (--tariff-version); cached не учитывается дважды (отдельное поле,
 *   не прибавляется к input/output).
 * - «Время до проверенного ответа» автоматически НЕ вычисляется: проверка
 *   — заранее зафиксированный oracle (plans/new7/j2-experiment-design.md);
 *   агрегатор даёт wall-время сессий и p50/p95 latency.
 * - Полнота данных эксперимента — явные поля: пропуски/ошибки/усечения/
 *   доступность usage. Локальный best-effort журнал не доказывает полноту
 *   активности клиента.
 * - Сессиизация переиспользует общий module sessions.ts (та же константа
 *   разрыва 30 минут), а не копию алгоритма.
 *
 * Формат отчёта версионирован (telemetry-report/1); новые поля добавляются
 * совместимо, переименования — новая версия.
 */

import { sessionize, timelineTsString, SESSION_GAP_MINUTES } from "./sessions.js";
import type { TelemetryOutcome } from "./telemetry.js";

export const TELEMETRY_REPORT_FORMAT = 1;

/** Реально переданный провайдерский usage (v2-события; сервер его не знает). */
interface ProviderUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  /** Стоимость, посчитанная КЛИЕНТОМ по его тарифу; сервер не выдумывает цены. */
  cost?: number;
}

interface RawEvent {
  v?: number;
  ts: string;
  tool?: string;
  outcome?: string;
  write_category?: string | null;
  write_category_unavailable?: boolean;
  response_bytes?: number | "unavailable";
  latency_ms?: number;
  must_read_refs?: string[] | "unavailable";
  issued_nodes?: Array<{ id?: unknown; status?: unknown }> | "unavailable";
  facts?: { cards_opened?: number; confirmations?: number; writes?: number };
  provider_usage?: unknown;
  error?: string;
}

export interface TelemetryReport {
  format: number;
  generated_at: string;
  source: {
    lines_total: number;
    events_parsed: number;
    lines_skipped_malformed: number;
    first_ts: string | null;
    last_ts: string | null;
  };
  calls: {
    total: number;
    by_tool: Record<string, number>;
    by_outcome: { ok: number; "no-op": number; error: number };
    /** Каждое событие = один MCP round trip; клиентские ретраи журнал не видит. */
    sequential_round_trips: number;
    sessions: number;
    note: string;
  };
  latency: {
    overall: { count: number; p50_ms: number; p95_ms: number } | { count: 0 };
    by_tool: Record<string, { count: number; p50_ms: number; p95_ms: number; by_outcome: Record<string, number> }>;
    sessions: {
      count: number;
      wall_ms: number[];
      wall_ms_p50: number | null;
      wall_ms_p95: number | null;
      note: string;
    };
    time_to_verified: { value: "unavailable"; note: string };
  };
  tokens: {
    /** Только реально переданный usage; unavailable — не нули. */
    provider: {
      value: "available" | "partial" | "unavailable";
      input_tokens: number | "unavailable";
      output_tokens: number | "unavailable";
      cached_tokens: number | "unavailable";
      /** Любая валидная ось usage (включая cost); счётчики взаимодополняющие. */
      events_with_usage: number;
      events_without_usage: number;
      /** Denominator каждой оси — все допустимые события отчёта. */
      coverage: Record<"input_tokens" | "output_tokens" | "cached_tokens", {
        events_with_value: number;
        events_without_value: number;
      }>;
      note: string;
    };
    /** Оценочный объём wire-ответов (байты) — ОТДЕЛЬНОЕ поле, не токены. */
    estimated_wire: { response_bytes_total: number; unavailable_events: number; note: string };
  };
  cost:
    | { value: "unavailable"; events_with_cost: number; events_without_cost: number; note: string }
    | { value: "available" | "partial"; total_cost: number; tariff_version: string;
        events_with_cost: number; events_without_cost: number; note: string };
  reads: {
    /** Выданные рекомендации must_read — НЕ факт чтения файла. */
    must_read_issued: {
      calls_with_refs: number;
      refs_total: number;
      distinct_refs: number;
      repeated_refs: number;
    } | null;
    files_actually_read: { value: "unavailable"; note: string };
  };
  memory_writes: {
    by_category: Record<string, number>;
    category_unavailable: number;
    writes_total: number;
    note: string;
  };
  correctness: { computed: false; value: "unavailable"; note: string };
  data_completeness: {
    lines_total: number;
    events_parsed: number;
    lines_skipped_malformed: number;
    events_with_error: number;
    response_bytes_unavailable: number;
    must_read_unavailable: number;
    issued_unavailable: number;
    provider_usage_unavailable: number;
    note: string;
  };
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0] as number;
  if (p === 0.5) {
    const mid = Math.floor(sortedAsc.length / 2);
    return sortedAsc.length % 2 === 1
      ? (sortedAsc[mid] as number)
      : Math.round(((sortedAsc[mid - 1] as number) + (sortedAsc[mid] as number)) / 2);
  }
  // p95: nearest-rank (ceil(p*n)-1) — детерминированное правило.
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx] as number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Строка журнала → событие или null (битая строка считается в completeness). */
function parseEventLine(line: string): RawEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // Один набор допустимых событий для calls, агрегатов и сессий:
    // отсутствующее/невалидное время — malformed, а не потерянный вызов.
    if (!isRecord(parsed) || typeof parsed.ts !== "string" || !Number.isFinite(Date.parse(parsed.ts))) {
      return null;
    }
    return parsed as unknown as RawEvent;
  } catch {
    return null;
  }
}

function parseUsage(v: unknown): ProviderUsage | null {
  if (!isRecord(v)) return null;
  const num = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
  const usage: ProviderUsage = {
    ...(num(v.input_tokens) !== undefined ? { input_tokens: num(v.input_tokens) } : {}),
    ...(num(v.output_tokens) !== undefined ? { output_tokens: num(v.output_tokens) } : {}),
    ...(num(v.cached_tokens) !== undefined ? { cached_tokens: num(v.cached_tokens) } : {}),
    ...(num(v.cost) !== undefined ? { cost: num(v.cost) } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * Построить отчёт из строк JSONL-журнала. Чистая функция над текстом журнала
 * (CLI-обёртка читает файл); недоступные данные — явные unavailable, не нули.
 */
export function buildTelemetryReport(
  lines: string[],
  opts: { tariff_version?: string; now?: Date } = {}
): TelemetryReport {
  let malformed = 0;
  const events: Array<{ ev: RawEvent; tsMs: number }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue; // пустые строки не считаются данными
    const ev = parseEventLine(trimmed);
    if (!ev) {
      malformed += 1;
      continue;
    }
    events.push({ ev, tsMs: Date.parse(ev.ts) });
  }

  const ordered = [...events].sort((a, b) => a.tsMs - b.tsMs);
  const tsStrings = ordered.map((e) => e.ev.ts);

  // --- вызовы и исходы ---
  const byTool: Record<string, number> = {};
  const byOutcome: Record<string, number> = { ok: 0, "no-op": 0, error: 0 };
  const latencies: number[] = [];
  const byToolLatency = new Map<string, number[]>();
  const byToolOutcome = new Map<string, Record<string, number>>();
  let eventsWithError = 0;
  let responseBytesUnavailable = 0;
  let mustReadUnavailable = 0;
  let issuedUnavailable = 0;
  let providerUsageUnavailable = 0;
  let responseBytesTotal = 0;
  const mustReadRefs: string[] = [];
  let callsWithRefs = 0;
  const writeCategories: Record<string, number> = {};
  let categoryUnavailable = 0;
  const usageRows: Array<{ usage: ProviderUsage }> = [];
  let eventsWithoutUsage = 0;

  for (const { ev } of ordered) {
    const tool = typeof ev.tool === "string" ? ev.tool : "unknown";
    byTool[tool] = (byTool[tool] ?? 0) + 1;
    const outcome: TelemetryOutcome =
      ev.outcome === "no-op" ? "no-op" : ev.outcome === "error" ? "error" : "ok";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;

    // latency — только числовые; отсутствующая помечается полнотой ниже.
    if (typeof ev.latency_ms === "number" && Number.isFinite(ev.latency_ms)) {
      latencies.push(ev.latency_ms);
      const arr = byToolLatency.get(tool) ?? [];
      arr.push(ev.latency_ms);
      byToolLatency.set(tool, arr);
    }
    const toolOutcomes = byToolOutcome.get(tool) ?? {};
    toolOutcomes[outcome] = (toolOutcomes[outcome] ?? 0) + 1;
    byToolOutcome.set(tool, toolOutcomes);

    if (outcome === "error") eventsWithError += 1;

    if (ev.response_bytes === "unavailable" || typeof ev.response_bytes !== "number") {
      responseBytesUnavailable += 1;
    } else {
      responseBytesTotal += ev.response_bytes;
    }
    if (ev.must_read_refs === "unavailable" || ev.must_read_refs === undefined) {
      mustReadUnavailable += 1;
    } else if (Array.isArray(ev.must_read_refs)) {
      callsWithRefs += 1;
      for (const ref of ev.must_read_refs) if (typeof ref === "string") mustReadRefs.push(ref);
    }
    if (ev.issued_nodes === "unavailable" || ev.issued_nodes === undefined) issuedUnavailable += 1;

    const usage = parseUsage(ev.provider_usage);
    if (usage === null) {
      providerUsageUnavailable += 1;
      eventsWithoutUsage += 1;
    } else {
      usageRows.push({ usage });
    }

    if (typeof ev.write_category === "string") {
      writeCategories[ev.write_category] = (writeCategories[ev.write_category] ?? 0) + 1;
    } else if (ev.write_category_unavailable === true || ev.write_category == null) {
      categoryUnavailable += 1;
    }
  }

  // --- сессиизация: общий module sessions.ts (та же константа разрыва) ---
  const sessionRows = ordered.map((e) => ({
    timestamp: timelineTsString(e.tsMs),
    tool: typeof e.ev.tool === "string" ? e.ev.tool : "unknown",
  }));
  const sessions = sessionize(sessionRows);
  const wallMs = sessions.map((s) => s.end - s.start);

  // --- must_read: выданные рекомендации и повторы ---
  const refCounts = new Map<string, number>();
  for (const ref of mustReadRefs) refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
  let repeatedRefs = 0;
  for (const count of refCounts.values()) if (count > 1) repeatedRefs += count - 1;

  // --- usage/деньги: каждая ось имеет свой набор наблюдений ---
  const tokenAxes = ["input_tokens", "output_tokens", "cached_tokens"] as const;
  const tokenTotals: Record<typeof tokenAxes[number], number | "unavailable"> = {
    input_tokens: "unavailable", output_tokens: "unavailable", cached_tokens: "unavailable",
  };
  const coverage = {} as TelemetryReport["tokens"]["provider"]["coverage"];
  for (const axis of tokenAxes) {
    const values = usageRows
      .map((r) => r.usage[axis])
      .filter((value): value is number => value !== undefined);
    tokenTotals[axis] = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : "unavailable";
    coverage[axis] = { events_with_value: values.length, events_without_value: events.length - values.length };
  }
  const anyTokens = tokenAxes.some((axis) => coverage[axis].events_with_value > 0);
  const completeTokens = anyTokens && tokenAxes.every((axis) => coverage[axis].events_without_value === 0);
  const costRows = usageRows.filter((r) => typeof r.usage.cost === "number");
  const costCoverage = { events_with_cost: costRows.length, events_without_cost: events.length - costRows.length };
  const tariff = opts.tariff_version;

  const report: TelemetryReport = {
    format: TELEMETRY_REPORT_FORMAT,
    generated_at: (opts.now ?? new Date()).toISOString(),
    source: {
      lines_total: events.length + malformed,
      events_parsed: events.length,
      lines_skipped_malformed: malformed,
      first_ts: tsStrings[0] ?? null,
      last_ts: tsStrings[tsStrings.length - 1] ?? null,
    },
    calls: {
      total: events.length,
      by_tool: byTool,
      by_outcome: {
        ok: byOutcome["ok"] ?? 0,
        "no-op": byOutcome["no-op"] ?? 0,
        error: byOutcome["error"] ?? 0,
      },
      sequential_round_trips: events.length,
      sessions: sessions.length,
      note: `каждое событие — один MCP round trip сервера; клиентские ретраи и обращения мимо сервера журнал не видит; сессиизация — разрыв ${SESSION_GAP_MINUTES} мин (общий module sessions.ts)`,
    },
    latency: {
      overall:
        latencies.length > 0
          ? {
              count: latencies.length,
              p50_ms: percentile([...latencies].sort((a, b) => a - b), 0.5) as number,
              p95_ms: percentile([...latencies].sort((a, b) => a - b), 0.95) as number,
            }
          : { count: 0 },
      by_tool: Object.fromEntries(
        [...byToolLatency.entries()].map(([tool, arr]) => {
          const sorted = [...arr].sort((a, b) => a - b);
          return [
            tool,
            {
              count: arr.length,
              p50_ms: percentile(sorted, 0.5) as number,
              p95_ms: percentile(sorted, 0.95) as number,
              by_outcome: byToolOutcome.get(tool) ?? {},
            },
          ];
        })
      ),
      sessions: {
        count: sessions.length,
        wall_ms: wallMs,
        wall_ms_p50: percentile([...wallMs].sort((a, b) => a - b), 0.5),
        wall_ms_p95: percentile([...wallMs].sort((a, b) => a - b), 0.95),
        note: "wall-время от первого до последнего события сессии; незакрытая последняя сессия не выделяется",
      },
      time_to_verified: {
        value: "unavailable",
        note: "время до ПРОВЕРЕННОГО ответа требует заранее зафиксированного oracle (j2-experiment-design); автоматически не вычисляется",
      },
    },
    tokens: {
      provider: {
        value: completeTokens ? "available" : anyTokens ? "partial" : "unavailable",
        ...tokenTotals,
        events_with_usage: usageRows.length,
        events_without_usage: eventsWithoutUsage,
        coverage,
        note: anyTokens
          ? "суммы только по реально переданным значениям каждой оси; coverage показывает её denominator по всем допустимым событиям; partial — неполное покрытие; cached ОТДЕЛЬНО и не прибавляется к input/output (без двойного учёта)"
          : "ни одно событие не несёт токенных осей провайдерского usage (J0-сервер его не видит) — фактические токены unavailable, не нули; cost не доказывает наличие токенов; нужен клиентский журнал (J2/J3)",
      },
      estimated_wire: {
        response_bytes_total: responseBytesTotal,
        unavailable_events: responseBytesUnavailable,
        note: "байты wire-ответов — оценочный объём, НЕ токены провайдера; не суммировать с tokens.provider",
      },
    },
    cost:
      costRows.length > 0 && tariff !== undefined
        ? {
            value: costCoverage.events_without_cost === 0 ? "available" : "partial",
            total_cost: costRows.reduce((s, r) => s + (r.usage.cost as number), 0),
            tariff_version: tariff,
            ...costCoverage,
            note: "стоимость посчитана КЛИЕНТОМ по указанной тарифной версии и передана в usage; сумма только по событиям с cost, denominator — events_with_cost/events_without_cost; cached-часть не считается повторно (отдельное поле tokens.provider.cached_tokens)",
          }
        : {
            value: "unavailable",
            ...costCoverage,
            note:
              costRows.length === 0
                ? "в журнале нет стоимости (usage.cost от клиента отсутствует) — деньги unavailable, не нули"
                : "стоимость в журнале есть, но не указана тарифная версия (--tariff-version) — деньги unavailable",
          },
    reads: {
      must_read_issued:
        callsWithRefs > 0
          ? {
              calls_with_refs: callsWithRefs,
              refs_total: mustReadRefs.length,
              distinct_refs: refCounts.size,
              repeated_refs: repeatedRefs,
            }
          : null,
      files_actually_read: {
        value: "unavailable",
        note: "must_read_refs — ВЫДАННЫЕ рекомендации, не факт чтения; фактически прочитанные файлы/диапазоны знает только клиент (J2/J3) и передаёт их явно",
      },
    },
    memory_writes: {
      by_category: writeCategories,
      category_unavailable: categoryUnavailable,
      writes_total: Object.values(writeCategories).reduce((s, n) => s + n, 0),
      note: "категории записей M1-A (knowledge/confirmation/maintenance/no-op); стоимость записи и поддержания памяти — та же трасса (число операций + объём ответов в estimated_wire)",
    },
    correctness: {
      computed: false,
      value: "unavailable",
      note: "правильность/пропущенные инварианты/ложное доверие stale — ТОЛЬКО заранее зафиксированный oracle (plans/new7/j2-experiment-design.md); автоматически не вычисляется",
    },
    data_completeness: {
      lines_total: events.length + malformed,
      events_parsed: events.length,
      lines_skipped_malformed: malformed,
      events_with_error: eventsWithError,
      response_bytes_unavailable: responseBytesUnavailable,
      must_read_unavailable: mustReadUnavailable,
      issued_unavailable: issuedUnavailable,
      provider_usage_unavailable: providerUsageUnavailable,
      note: "локальный append-only журнал best-effort: полноту активности клиента он не доказывает (ретраи/чтения файлов мимо сервера невидимы); усечения ответов видит только клиент",
    },
  };
  return report;
}

// ---- человекочитаемый вывод CLI ----

export function formatTelemetryReport(r: TelemetryReport): string[] {
  const out: string[] = [];
  out.push(`Telemetry report (format ${r.format}), generated ${r.generated_at}`);
  out.push(
    `  source: ${r.source.events_parsed} event(s) parsed, ${r.source.lines_skipped_malformed} malformed line(s)` +
      (r.source.first_ts ? `, ${r.source.first_ts} … ${r.source.last_ts}` : ", empty journal")
  );
  out.push(
    `  calls: ${r.calls.total} total, ${r.calls.sessions} session(s); by outcome: ` +
      `ok=${r.calls.by_outcome["ok"]}, no-op=${r.calls.by_outcome["no-op"]}, error=${r.calls.by_outcome["error"]}`
  );
  for (const [tool, agg] of Object.entries(r.latency.by_tool)) {
    out.push(
      `    ${tool}: ${agg.count} call(s), p50=${agg.p50_ms} ms, p95=${agg.p95_ms} ms, ` +
        `ok=${agg.by_outcome["ok"] ?? 0}, no-op=${agg.by_outcome["no-op"] ?? 0}, error=${agg.by_outcome["error"] ?? 0}`
    );
  }
  out.push(
    `  sessions wall: ` +
      (r.latency.sessions.wall_ms_p50 !== null ? `p50=${r.latency.sessions.wall_ms_p50} ms, p95=${r.latency.sessions.wall_ms_p95} ms` : "n/a")
  );
  out.push(`  time to verified answer: unavailable — нужен oracle (j2-experiment-design)`);
  const provider = r.tokens.provider;
  const tokenCoverage = provider.coverage;
  out.push(
    `  provider tokens: ${provider.value}, in=${provider.input_tokens}, out=${provider.output_tokens}, cached=${provider.cached_tokens} ` +
      `(events with usage: ${provider.events_with_usage}, without: ${provider.events_without_usage}; ` +
      `coverage: in=${tokenCoverage.input_tokens.events_with_value}/${r.calls.total}, ` +
      `out=${tokenCoverage.output_tokens.events_with_value}/${r.calls.total}, ` +
      `cached=${tokenCoverage.cached_tokens.events_with_value}/${r.calls.total})`
  );
  out.push(
    `  estimated wire: ${r.tokens.estimated_wire.response_bytes_total} bytes (unavailable events: ${r.tokens.estimated_wire.unavailable_events}) — оценка, не токены`
  );
  out.push(
    `  cost: ` +
      (r.cost.value !== "unavailable"
        ? `${r.cost.value} ${r.cost.total_cost} (tariff: ${r.cost.tariff_version}; coverage: ${r.cost.events_with_cost}/${r.calls.total})`
        : `unavailable — нет usage.cost и/или тарифной версии (coverage: ${r.cost.events_with_cost}/${r.calls.total})`)
  );
  if (r.reads.must_read_issued) {
    out.push(
      `  must_read issued: ${r.reads.must_read_issued.refs_total} ref(s) in ${r.reads.must_read_issued.calls_with_refs} call(s), distinct=${r.reads.must_read_issued.distinct_refs}, repeated=${r.reads.must_read_issued.repeated_refs} (рекомендации, не факт чтения)`
    );
  }
  const cats = Object.entries(r.memory_writes.by_category)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  out.push(
    `  memory writes: ${r.memory_writes.writes_total} (categories: ${cats || "нет"}; unavailable: ${r.memory_writes.category_unavailable})`
  );
  out.push(`  correctness: unavailable — только заранее зафиксированный oracle, автоматически не вычисляется`);
  const dc = r.data_completeness;
  out.push(
    `  completeness: errors=${dc.events_with_error}, bytes_unavailable=${dc.response_bytes_unavailable}, must_read_unavailable=${dc.must_read_unavailable}, issued_unavailable=${dc.issued_unavailable}, usage_unavailable=${dc.provider_usage_unavailable}`
  );
  return out;
}
