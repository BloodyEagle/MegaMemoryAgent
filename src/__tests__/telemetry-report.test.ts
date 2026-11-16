import { describe, it, expect } from "vitest";
import { buildTelemetryReport, formatTelemetryReport, type TelemetryReport } from "../telemetry-report.js";

// J1 (план 20+21 v3 §15): локальный агрегатор поверх J0-телеметрии.
//
// Контракт:
// - Читает ТОЛЬКО локальный JSONL-журнал телеметрии (никакой БД, никакой сети,
//   секреты не выводятся — их в журнале и так нет, payload'ы не писались).
// - input/output/cached токены и деньги — ТОЛЬКО реально переданный
//   провайдерский usage; сейчас unavailable — явная пометка, не нули.
// - Оценочные токены (response_bytes) и фактические НЕ смешиваются: разные
//   поля с разными пометками.
// - Время: latency события + сессиизация (общий module sessions.ts).
// - Правильность/пропущенные инварианты/ложное доверие stale — ТОЛЬКО
//   заранее зафиксированный oracle; автоматически не вычисляется.
// - Полнота данных эксперимента — явные поля (пропуски/ошибки/усечения/
//   доступность usage).

let clock = 0;
function ev(overrides: Record<string, unknown>): Record<string, unknown> {
  clock += 1;
  const base = {
    v: 1,
    ts: new Date(Date.UTC(2026, 10, 16, 10, 0, 0) + clock * 60_000).toISOString(),
    tool: "understand",
    outcome: "ok",
    write_category: null,
    response_bytes: 3000,
    latency_ms: 100,
    provider_usage: "unavailable",
  };
  return { ...base, ...overrides };
}

describe("J1 агрегатор: вызовы, исходы, latency", () => {
  it("считает вызовы по инструментам и исходам (ok/no-op/error); latency p50/p95 по отсортированным значениям", () => {
    const report = buildTelemetryReport([
      JSON.stringify(ev({ latency_ms: 100 })),
      JSON.stringify(ev({ tool: "get_concept", latency_ms: 200 })),
      JSON.stringify(ev({ tool: "get_concept", latency_ms: 300 })),
      JSON.stringify(ev({ outcome: "error", error: "boom", write_category_unavailable: true })),
      JSON.stringify(ev({ tool: "create_concept", outcome: "no-op", write_category: "no-op" })),
    ]);
    expect(report.calls.total).toBe(5);
    // understand ×2 (ok + error), get_concept ×2, create_concept ×1.
    expect(report.calls.by_tool.understand).toBe(2);
    expect(report.calls.by_tool.get_concept).toBe(2);
    expect(report.calls.by_outcome).toEqual({ ok: 3, "no-op": 1, error: 1 });
    // p50 из [100,100,100,100,100]→100... разные: [100,100,100,100,100] нет:
    // значения 100,200,300,100,100 → sorted [100,100,100,200,300], p50=100, p95=300.
    expect(report.latency.overall).toMatchObject({ p50_ms: 100, p95_ms: 300, count: 5 });
    expect(report.latency.by_tool.get_concept).toMatchObject({ count: 2, p50_ms: 250, p95_ms: 300 });
  });

  it.each([
    { label: "invalid", event: { tool: "understand", outcome: "error", ts: "invalid" } },
    { label: "missing", event: { tool: "understand", outcome: "error" } },
    { label: "non-string", event: { tool: "understand", outcome: "error", ts: 42 } },
    { label: "empty", event: { tool: "understand", outcome: "error", ts: "" } },
  ])("A13: $label timestamp отклоняется как malformed во всём отчёте", ({ event }) => {
    const report = buildTelemetryReport([
      JSON.stringify({ ...event, latency_ms: 999, response_bytes: 999,
        write_category: "knowledge", must_read_refs: ["src/invalid.ts"],
        provider_usage: { input_tokens: 999, output_tokens: 999, cost: 999 } }),
      JSON.stringify(ev({ ts: "2026-11-16T10:00:00.000Z", tool: "get_concept", latency_ms: 100 })),
    ], { tariff_version: "price-list-2026-11" });
    expect(report.source).toEqual({ lines_total: 2, events_parsed: 1,
      lines_skipped_malformed: 1, first_ts: "2026-11-16T10:00:00.000Z", last_ts: "2026-11-16T10:00:00.000Z" });
    expect(report.calls).toMatchObject({ total: 1, by_tool: { get_concept: 1 },
      by_outcome: { ok: 1, "no-op": 0, error: 0 }, sequential_round_trips: 1, sessions: 1 });
    expect(Object.values(report.calls.by_tool).reduce((sum, n) => sum + n, 0)).toBe(report.calls.total);
    expect(Object.values(report.calls.by_outcome).reduce((sum, n) => sum + n, 0)).toBe(report.calls.total);
    expect(report.latency.overall).toMatchObject({ count: 1, p50_ms: 100, p95_ms: 100 });
    expect(report.tokens.provider.value).toBe("unavailable");
    expect(report.tokens.estimated_wire.response_bytes_total).toBe(3000);
    expect(report.cost.value).toBe("unavailable");
    expect(report.reads.must_read_issued).toBeNull();
    expect(report.memory_writes.writes_total).toBe(0);
    expect(report.data_completeness).toMatchObject({ lines_total: 2, events_parsed: 1,
      lines_skipped_malformed: 1, events_with_error: 0, provider_usage_unavailable: 1 });
  });

  it("две сессии: разрыв >30 минут, wall [600000, 0], p50=300000 и p95=600000", () => {
    const report = buildTelemetryReport([
      JSON.stringify(ev({ ts: "2026-11-16T10:00:00.000Z", tool: "understand" })),
      JSON.stringify(ev({ ts: "2026-11-16T10:10:00.000Z", tool: "get_concept" })),
      JSON.stringify(ev({ ts: "2026-11-16T12:00:00.000Z", tool: "understand" })),
    ]);
    expect(report.calls.sessions).toBe(2);
    expect(report.latency.sessions).toMatchObject({
      count: 2, wall_ms: [600000, 0], wall_ms_p50: 300000, wall_ms_p95: 600000,
    });
  });

  it("время до ПРОВЕРЕННОГО ответа — unavailable: нет oracle-события, автоматически не вычисляется", () => {
    const report = buildTelemetryReport([JSON.stringify(ev({}))]);
    expect(report.latency.time_to_verified).toMatchObject({ value: "unavailable" });
    expect(report.latency.time_to_verified.note).toMatch(/oracle|провер/i);
  });
});

describe("J1 агрегатор: токены и деньги", () => {
  it("v1-события: провайдерский usage unavailable — явная пометка, не нули; оценка wire отдельно", () => {
    const report = buildTelemetryReport([JSON.stringify(ev({})), JSON.stringify(ev({}))]);
    expect(report.tokens.provider).toMatchObject({ value: "unavailable" });
    expect(report.tokens.provider.note).toMatch(/usage|провайдер|клиент/i);
    // Оценочный объём wire-ответов — отдельное поле с пометкой «оценка».
    expect(report.tokens.estimated_wire).toMatchObject({ response_bytes_total: 6000 });
    expect(report.tokens.estimated_wire.note).toMatch(/оценк|не токены провайдера|байт/i);
    expect(report.cost).toMatchObject({ value: "unavailable" });
  });

  it("реально переданный usage суммируется; cached — отдельным полем, не прибавляется к input/output", () => {
    const withUsage = {
      ...ev({}),
      v: 2,
      provider_usage: { input_tokens: 1000, output_tokens: 500, cached_tokens: 200 },
    };
    const report = buildTelemetryReport([JSON.stringify(withUsage), JSON.stringify(ev({}))]);
    expect(report.tokens.provider).toMatchObject({
      value: "partial",
      input_tokens: 1000,
      output_tokens: 500,
      cached_tokens: 200,
      events_with_usage: 1,
      events_without_usage: 1,
    });
    // cached не входит в сумму input/output; событие без usage даёт partial.
    expect(report.tokens.provider.input_tokens).toBe(1000);
    expect(report.tokens.provider.output_tokens).toBe(500);
    expect(report.tokens.provider.cached_tokens).toBe(200);
    expect(buildTelemetryReport([JSON.stringify(withUsage)]).tokens.provider).toMatchObject({
      value: "available", input_tokens: 1000, output_tokens: 500, cached_tokens: 200,
      events_with_usage: 1, events_without_usage: 0,
    });
  });

  it.each([
    { label: "cost-only", usage: { cost: 0.01 }, value: "unavailable", input: "unavailable", output: "unavailable", cached: "unavailable",
      inputCount: 0, outputCount: 0, cachedCount: 0 },
    { label: "input-only", usage: { input_tokens: 1000 }, value: "partial", input: 1000, output: "unavailable", cached: "unavailable",
      inputCount: 1, outputCount: 0, cachedCount: 0 },
    { label: "output-only", usage: { output_tokens: 500 }, value: "partial", input: "unavailable", output: 500, cached: "unavailable",
      inputCount: 0, outputCount: 1, cachedCount: 0 },
    { label: "cached-only", usage: { cached_tokens: 200 }, value: "partial", input: "unavailable", output: "unavailable", cached: 200,
      inputCount: 0, outputCount: 0, cachedCount: 1 },
    { label: "input-output-no-cache", usage: { input_tokens: 1000, output_tokens: 500 }, value: "partial", input: 1000, output: 500, cached: "unavailable",
      inputCount: 1, outputCount: 1, cachedCount: 0 },
  ])("A14: $label usage сохраняет независимые оси без выдуманных нулей", (c) => {
    const report = buildTelemetryReport([JSON.stringify(ev({ provider_usage: c.usage }))], { tariff_version: "test-tariff" });
    expect(report.tokens.provider).toMatchObject({ value: c.value,
      input_tokens: c.input, output_tokens: c.output, cached_tokens: c.cached,
      events_with_usage: 1, events_without_usage: 0,
      coverage: { input_tokens: { events_with_value: c.inputCount, events_without_value: 1 - c.inputCount },
        output_tokens: { events_with_value: c.outputCount, events_without_value: 1 - c.outputCount },
        cached_tokens: { events_with_value: c.cachedCount, events_without_value: 1 - c.cachedCount } },
    });
    const text = formatTelemetryReport(report).join("\n");
    expect(text).toContain(`provider tokens: ${c.value}`);
    expect(text).toContain(`in=${c.input}, out=${c.output}, cached=${c.cached}`);
    expect(text).not.toMatch(/(?:in|out|cached)=0(?:[, )]|$)/);
    expect(JSON.stringify(report)).not.toContain('"input_tokens":0');
    if (c.label === "cost-only") {
      expect(report.cost).toMatchObject({ value: "available", total_cost: 0.01,
        events_with_cost: 1, events_without_cost: 0, tariff_version: "test-tariff" });
    }
  });

  it("A14: смешанные частичные строки суммируются по каждой оси и показывают denominator", () => {
    const report = buildTelemetryReport([
      JSON.stringify(ev({ provider_usage: { input_tokens: 1000 } })),
      JSON.stringify(ev({ provider_usage: { output_tokens: 500, cached_tokens: 200 } })),
      JSON.stringify(ev({ provider_usage: { input_tokens: 100, output_tokens: 50, cached_tokens: 0, cost: 0.02 } })),
      JSON.stringify(ev({})),
    ], { tariff_version: "test-tariff" });
    expect(report.tokens.provider).toMatchObject({ value: "partial", input_tokens: 1100, output_tokens: 550, cached_tokens: 200,
      events_with_usage: 3, events_without_usage: 1,
      coverage: { input_tokens: { events_with_value: 2, events_without_value: 2 },
        output_tokens: { events_with_value: 2, events_without_value: 2 },
        cached_tokens: { events_with_value: 2, events_without_value: 2 } },
    });
    expect(report.cost).toMatchObject({ value: "partial", total_cost: 0.02, events_with_cost: 1, events_without_cost: 3 });
    const text = formatTelemetryReport(report).join("\n");
    expect(text).toContain("provider tokens: partial");
    expect(text).toContain("coverage: in=2/4, out=2/4, cached=2/4");
    expect(text).toContain("cost: partial 0.02");
    expect(text).toContain("coverage: 1/4");
  });

  it("A14: полный usage с реальными нулями остаётся available", () => {
    const report = buildTelemetryReport([
      JSON.stringify(ev({ provider_usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost: 0 } })),
    ], { tariff_version: "test-tariff" });
    expect(report.tokens.provider).toMatchObject({ value: "available", input_tokens: 0, output_tokens: 0, cached_tokens: 0,
      coverage: { input_tokens: { events_with_value: 1, events_without_value: 0 },
        output_tokens: { events_with_value: 1, events_without_value: 0 },
        cached_tokens: { events_with_value: 1, events_without_value: 0 } },
    });
    expect(report.cost).toMatchObject({ value: "available", total_cost: 0, events_with_cost: 1, events_without_cost: 0 });
    expect(formatTelemetryReport(report).join("\n")).toContain("in=0, out=0, cached=0");
  });

  it("A14: отрицательные и нечисловые оси unavailable, валидная ось сохраняется", () => {
    const report = buildTelemetryReport([JSON.stringify(ev({ provider_usage: {
      input_tokens: -1, output_tokens: "500", cached_tokens: 0, cost: "0.01",
    } }))], { tariff_version: "test-tariff" });
    expect(report.tokens.provider).toMatchObject({ value: "partial", input_tokens: "unavailable", output_tokens: "unavailable", cached_tokens: 0 });
    expect(report.cost.value).toBe("unavailable");
  });

  it("деньги: считаются только при usage И явно указанной тарифной версии; без тарифа — unavailable", () => {
    const withUsage = {
      ...ev({}),
      v: 2,
      provider_usage: { input_tokens: 1000, output_tokens: 500, cached_tokens: 200, cost: 0.012 },
    };
    const withTariff = buildTelemetryReport([JSON.stringify(withUsage)], { tariff_version: "price-list-2026-11" });
    expect(withTariff.cost).toMatchObject({
      value: "available",
      total_cost: 0.012,
      tariff_version: "price-list-2026-11",
    });
    expect(withTariff.cost.note).toMatch(/cached/i);
    const noTariff = buildTelemetryReport([JSON.stringify(withUsage)]);
    expect(noTariff.cost).toMatchObject({ value: "unavailable" });
    const noCostField = buildTelemetryReport(
      [JSON.stringify({ ...ev({}), v: 2, provider_usage: { input_tokens: 10, output_tokens: 5 } })],
      { tariff_version: "price-list-2026-11" }
    );
    expect(noCostField.cost).toMatchObject({ value: "unavailable" });
  });
});

describe("J1 агрегатор: чтения, записи, полнота, oracle", () => {
  it("must_read: выданные рекомендации считаются и повторяются; факт чтения файла — unavailable (это данные клиента)", () => {
    const lines = [
      JSON.stringify(ev({ must_read_refs: ["src/a.ts:1-10"] })),
      JSON.stringify(ev({ must_read_refs: ["src/a.ts:1-10", "src/b.ts"] })),
      JSON.stringify(ev({})),
    ];
    const report = buildTelemetryReport(lines);
    expect(report.reads.must_read_issued).toMatchObject({ calls_with_refs: 2, refs_total: 3, distinct_refs: 2, repeated_refs: 1 });
    expect(report.reads.files_actually_read).toMatchObject({ value: "unavailable" });
  });

  it("стоимость записи/поддержания памяти: категории записей из телеметрии", () => {
    const lines = [
      JSON.stringify(ev({ tool: "create_concept", write_category: "knowledge" })),
      JSON.stringify(ev({ tool: "confirm_supports", write_category: "confirmation" })),
      JSON.stringify(ev({ tool: "check_artifacts", write_category: "maintenance" })),
      JSON.stringify(ev({ tool: "trail_save", write_category: "maintenance" })),
    ];
    const report = buildTelemetryReport(lines);
    expect(report.memory_writes.by_category).toMatchObject({ knowledge: 1, confirmation: 1, maintenance: 2 });
  });

  it("полнота данных: ошибки, усечения, недоступность полей — явные счётчики", () => {
    const lines = [
      JSON.stringify(ev({})),
      JSON.stringify(ev({ outcome: "error", error: "fail" })),
      JSON.stringify(ev({ response_bytes: "unavailable" })),
      "не-json-строка",
      JSON.stringify(ev({ must_read_refs: "unavailable" })),
    ];
    const report = buildTelemetryReport(lines);
    expect(report.data_completeness).toMatchObject({
      lines_total: 5,
      events_parsed: 4,
      lines_skipped_malformed: 1,
      events_with_error: 1,
      response_bytes_unavailable: 1,
    });
  });

  it("правильность/инварианты/ложное доверие — только oracle, автоматически не вычисляется", () => {
    const report = buildTelemetryReport([JSON.stringify(ev({}))]);
    expect(report.correctness).toMatchObject({ computed: false, value: "unavailable" });
    expect(report.correctness.note).toMatch(/oracle/i);
  });

  it("пустой журнал — явный пустой отчёт, не падение", () => {
    const report = buildTelemetryReport([]);
    expect(report.calls.total).toBe(0);
    expect(report.data_completeness.events_parsed).toBe(0);
  });

  it("отчёт не выводит сообщения ошибок и payload'ы (секреты не печатаются)", () => {
    const secret = "token=ghp_abcdefghijklmnopqrstuvwx";
    const report: TelemetryReport = buildTelemetryReport([
      JSON.stringify(ev({ outcome: "error", error: `failed with ${secret}` })),
    ]);
    expect(JSON.stringify(report)).not.toContain("ghp_");
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
