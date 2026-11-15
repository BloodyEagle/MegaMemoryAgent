import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { planDigests, rebuildDigests, buildDigest } from "../digest.js";
import { computeDigestPriority, type DigestUseCounters } from "../digest-priority.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// P4.3 (план 20+21 v3 §13): дайджесты по полезности.
//
// Контракт:
// - НЕ опираться на несуществующую per-node статистику getUsageStats (R20):
//   частота ЯВНЫХ открытий выводится из событий журнала (get_concept) и
//   opt-in телеметрии J0, где включена.
// - Различать «попал в выдачу» (issued), «открыт» (opened) и «явно
//   использован» (used) — отдельные счётчики, ни одно не выдаётся за другое.
// - Точный исход операции для новых данных: ok/error — отдельно (no-op у
//   открытия не бывает).
// - Приоритет влияет на ПОРЯДОК/ограниченную очередь, не исключает редко
//   читаемые области; eligible-область дайджеста (дети >= порога) не меняется.
// - При отсутствии достаточных событий — стабильный fallback (прежний
//   порядок) с явной пометкой недостатка данных.
// - Общий расчёт кандидатов для preview и apply — один и тот же
//   scanDigestCandidates (правила количества детей не размножаются).
// - Расчёт приоритета только читает: никаких записей при построении плана.

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p4dig-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

let counter = 0;

function makeParentWithChildren(name: string, n: number): string {
  counter += 1;
  const parentId = `mod-${name}-${counter}`;
  db.insertNode({ id: parentId, name, kind: "module", summary: `Модуль ${name}.` });
  for (let i = 0; i < n; i++) {
    db.insertNode({
      id: `${parentId}-c${i}`,
      name: `${name} concept ${i}`,
      kind: "feature",
      summary: `Фича ${i} модуля ${name}.`,
      parent_id: parentId,
    });
  }
  return parentId;
}

function logGetConcept(nodeId: string, isError = false): void {
  db.insertTimelineEntry({
    tool: "get_concept",
    params: JSON.stringify({ id: nodeId }),
    result_summary: isError ? "not found" : `opened ${nodeId}`,
    is_write: false,
    is_error: isError,
    affected_ids: isError ? [] : [nodeId],
  });
}

function logConfirmSupports(decisionId: string, supportId: string): void {
  db.insertTimelineEntry({
    tool: "confirm_supports",
    params: JSON.stringify({ decision_id: decisionId, items: [{ support_id: supportId }] }),
    result_summary: "confirmed",
    is_write: true,
    is_error: false,
    affected_ids: [decisionId],
  });
}

describe("P4.3 прежнее поведение без приоритета", () => {
  it("planDigests без opts — прежний контракт: порядок скана, никакой приоритетной надстройки", () => {
    const a = makeParentWithChildren("Alpha", 6);
    const b = makeParentWithChildren("Beta", 5);
    logGetConcept(`${a}-c0`);
    const plan = planDigests(db);
    expect(plan.build.map((b2) => b2.moduleId)).toEqual([a, b]);
    // Новые поля приоритета появляются только при явном запросе.
    expect(plan.build[0]?.use).toBeUndefined();
    expect((plan as { use_note?: string }).use_note).toBeUndefined();
  });

  it("eligible-область не меняется: порог детей и skipped одинаковы с приоритетом и без", () => {
    makeParentWithChildren("Alpha", 6);
    makeParentWithChildren("Beta", 5);
    makeParentWithChildren("Small", 2);
    const plain = planDigests(db);
    const prio = planDigests(db, undefined, { by_use: true });
    expect(prio.build.map((b) => b.moduleId)).toEqual(plain.build.map((b) => b.moduleId));
    expect(prio.skipped.map((s) => s.moduleId)).toEqual(plain.skipped.map((s) => s.moduleId));
  });
});

describe("P4.3 счётчики полезности", () => {
  it("opened считается по ok-открытиям get_concept; ошибки — отдельный счётчик; used — отдельный; issued недоступен без телеметрии", () => {
    const a = makeParentWithChildren("Alpha", 5);
    logGetConcept(`${a}-c0`);
    logGetConcept(`${a}-c0`);
    logGetConcept(`${a}-c1`);
    logGetConcept(`${a}-c2`, true);
    logConfirmSupports(`${a}-c0`, `${a}-c1`);
    const counters: Record<string, DigestUseCounters> = {
      [a]: computeDigestPriority(db, a).counters,
    };
    expect(counters[a]?.opened).toBe(3);
    expect(counters[a]?.opened_error).toBe(1);
    // Одно использование-событие (confirm_supports решения c0 с опорой c1) —
    // операция, не число затронутых узлов.
    expect(counters[a]?.used).toBe(1);
    expect(counters[a]?.issued).toBe("unavailable");
  });

  it("счётчики не выдают одно за другое: issued (телemetry) не подмешивается в opened, used не считается от открытий", () => {
    const a = makeParentWithChildren("Alpha", 5);
    logGetConcept(`${a}-c0`);
    const telemetryPath = path.join(tmpDir, "telemetry.jsonl");
    // issued: узел попал в выдачу understand, но НЕ был открыт.
    fs.writeFileSync(
      telemetryPath,
      JSON.stringify({
        v: 1,
        ts: "2026-11-16T10:00:00.000Z",
        tool: "understand",
        outcome: "ok",
        write_category: null,
        response_bytes: 100,
        latency_ms: 5,
        issued_nodes: [{ id: `${a}-c1`, status: "active" }],
        provider_usage: "unavailable",
      }) + "\n",
      "utf8"
    );
    const counters = computeDigestPriority(db, a, { telemetry_path: telemetryPath }).counters;
    expect(counters.issued).toBe(1);
    expect(counters.opened).toBe(1);
    expect(counters.used).toBe(0);
  });
});

describe("P4.3 порядок приоритета", () => {
  it("область с явными открытиями и использованием ставится выше области без событий; детерминизм при равенстве (id)", () => {
    const quiet = makeParentWithChildren("Quiet", 6);
    const busy = makeParentWithChildren("Busy", 6);
    logGetConcept(`${busy}-c0`);
    logConfirmSupports(`${busy}-c0`, `${busy}-c1`);
    const prio = planDigests(db, undefined, { by_use: true });
    expect(prio.build[0]?.moduleId).toBe(busy);
    expect(prio.build[1]?.moduleId).toBe(quiet);
    expect((prio as { use_note?: string }).use_note).toMatch(/событ|use|opened/i);
    // Детерминизм: повторный расчёт даёт тот же порядок.
    const prio2 = planDigests(db, undefined, { by_use: true });
    expect(prio2.build.map((b) => b.moduleId)).toEqual(prio.build.map((b) => b.moduleId));
  });

  it("нет событий вообще → стабильный fallback (прежний порядок) с явной пометкой недостатка данных", () => {
    const a = makeParentWithChildren("Alpha", 6);
    const b = makeParentWithChildren("Beta", 6);
    const prio = planDigests(db, undefined, { by_use: true });
    expect(prio.build.map((x) => x.moduleId)).toEqual([a, b]);
    expect((prio as { use_note?: string }).use_note).toMatch(/недостат|fallback|нет событи/i);
    expect(prio.build.every((b2) => b2.use?.opened === 0)).toBe(true);
  });

  it("устаревший дайджест (расхождение состава источников) приоритетнее свежего при прочих равных", async () => {
    const staleMod = makeParentWithChildren("Stale", 6);
    const freshMod = makeParentWithChildren("Fresh", 6);
    await buildDigest(db, staleMod, { embed: false });
    await buildDigest(db, freshMod, { embed: false });
    // Оба получили по одному открытию — сравниваем именно вклад устаревания.
    logGetConcept(`${staleMod}-c0`);
    logGetConcept(`${freshMod}-c0`);
    // Дайджест Stale устарел: состав источников изменился после сборки.
    db.insertNode({
      id: `${staleMod}-c99`,
      name: "Stale extra",
      kind: "feature",
      summary: "Новая фича после сборки дайджеста.",
      parent_id: staleMod,
    });
    const prio = planDigests(db, undefined, { by_use: true });
    expect(prio.build[0]?.moduleId).toBe(staleMod);
    expect(prio.build[0]?.use?.stale_existing).toBe(true);
  });

  it("limit: ограниченная очередь — верх приоритета в build, остаток в queued (не теряются молча); без limit — все", () => {
    const a = makeParentWithChildren("A", 6);
    const b = makeParentWithChildren("B", 6);
    const c = makeParentWithChildren("C", 6);
    logGetConcept(`${b}-c0`);
    logGetConcept(`${b}-c1`);
    const limited = planDigests(db, undefined, { by_use: true, limit: 1 });
    expect(limited.build.map((x) => x.moduleId)).toEqual([b]);
    expect((limited as { queued?: Array<{ moduleId: string }> }).queued?.map((q) => q.moduleId)).toEqual(
      [a, c].sort()
    );
    const full = planDigests(db, undefined, { by_use: true });
    expect(full.build).toHaveLength(3);
    expect((full as { queued?: string[] }).queued).toBeUndefined();
  });

  it("apply использует тот же расчёт кандидатов: rebuildDigests с by_use строит очередь в приоритетном порядке", async () => {
    const a = makeParentWithChildren("A", 6);
    const b = makeParentWithChildren("B", 6);
    logGetConcept(`${b}-c0`);
    const result = await rebuildDigests(db, undefined, { embed: false, by_use: true, limit: 1 });
    expect(result.built).toHaveLength(1);
    expect(result.built[0]?.moduleId).toBe(b);
    expect((result as { queued?: Array<{ moduleId: string }> }).queued?.map((q) => q.moduleId)).toEqual([a]);
  });

  it("расчёт приоритета только читает: план не пишет узлов, рёбер, timeline и digest_sources", () => {
    const a = makeParentWithChildren("Alpha", 6);
    logGetConcept(`${a}-c0`);
    const before = {
      nodes: (db.execSqlAll("SELECT COUNT(*) AS n FROM nodes") as Array<{ n: number }>)[0].n,
      timeline: (db.execSqlAll("SELECT COUNT(*) AS n FROM timeline") as Array<{ n: number }>)[0].n,
      edges: (db.execSqlAll("SELECT COUNT(*) AS n FROM edges") as Array<{ n: number }>)[0].n,
    };
    planDigests(db, undefined, { by_use: true });
    const after = {
      nodes: (db.execSqlAll("SELECT COUNT(*) AS n FROM nodes") as Array<{ n: number }>)[0].n,
      timeline: (db.execSqlAll("SELECT COUNT(*) AS n FROM timeline") as Array<{ n: number }>)[0].n,
      edges: (db.execSqlAll("SELECT COUNT(*) AS n FROM edges") as Array<{ n: number }>)[0].n,
    };
    expect(after).toEqual(before);
  });
});
