import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTelemetryReport, type TelemetryReport } from "../telemetry-report.js";
import { closeAndCleanup } from "./helpers/cleanup.js";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";

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

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-j1rep-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

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

  it("сессиизация: разрыв ≤30 минут — одна сессия, больше — новая; wall-время сессий с p50/p95", () => {
    const lines: string[] = [];
    // Сессия 1: 10:00 и 10:10 (10 минут).
    lines.push(JSON.stringify({ ...ev({ ts: "2026-11-16T10:00:00.000Z" }), tool: "understand" }));
    lines.push(JSON.stringify({ ...ev({ ts: "2026-11-16T10:10:00.000Z" }), tool: "get_concept" }));
    // Сессия 2: 12:00 (разрыв > 30 минут).
    lines.push(JSON.stringify({ ...ev({ ts: "2026-11-16T12:00:00.000Z" }), tool: "understand" }));
    const report = buildTelemetryReport(lines);
    expect(report.latency.sessions.count).toBe(2);
    // wall: [600000, 0] → p50 = 0? sorted [0,600000] → p50=600000? Определим в коде: медиана чётного — верхняя из средних? Проверяем честно ниже.
    expect(report.latency.sessions.wall_ms).toHaveLength(2);
  });

  it("полное время сессий: p50 пары [0, 600000] — средняя (300000); правило детерминировано", () => {
    const lines: string[] = [];
    // Сессия 1: 10:00 → 10:10 (wall 600000), сессия 2: 12:00 (wall 0).
    lines.push(JSON.stringify({ ...ev({ ts: "2026-11-16T10:00:00.000Z" }) }));
    lines.push(JSON.stringify({ ...ev({ ts: "2026-11-16T10:10:00.000Z" }) }));
    lines.push(JSON.stringify({ ...ev({ ts: "2026-11-16T12:00:00.000Z" }) }));
    const report = buildTelemetryReport(lines);
    expect(report.latency.sessions.count).toBe(2);
    expect(report.latency.sessions.wall_ms_p50).toBe(300000);
    expect(report.latency.sessions.wall_ms_p95).toBe(600000);
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
      value: "available",
      input_tokens: 1000,
      output_tokens: 500,
      cached_tokens: 200,
      events_with_usage: 1,
      events_without_usage: 1,
    });
    // cached не входит в сумму input/output (нет двойного учёта).
    if (report.tokens.provider.value === "available") {
      expect(report.tokens.provider.input_tokens).toBe(1000);
      expect(report.tokens.provider.output_tokens).toBe(500);
      expect(report.tokens.provider.cached_tokens).toBe(200);
    }
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
