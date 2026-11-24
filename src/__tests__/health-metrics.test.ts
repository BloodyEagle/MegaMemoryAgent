/**
 * Этап A (план 20+21 v3 §6): честные health-метрики и окна.
 *
 * Три группы не смешивать (A1): состояние сейчас / активность за окно /
 * экономия (не выводится). Collector — один module (health.ts), doctor и
 * stats — потребители одного interface (§17 seam 1).
 *
 * Ключевые честности:
 * - agent_nodes_created — снимочная метрика происхождения/даты, включая
 *   soft-deleted; НЕ число операций записи.
 * - unsupported_decisions — живость И ребра, И цели; исключённые группы
 *   показываются отдельно; общий weak_links не сужается.
 * - claim_digest не делает случай корректным пустым подтверждением —
 *   разбор через существующий support-check.
 * - окно [from, to), время один раз на запуск, UTC; сессии через границу
 *   окна — ограниченный обход до реального разрыва.
 * - незавершённая сессия — не нарушение; отсутствующие записи никогда не
 *   повышают problems.
 * - readonly-путь не меняет базу; старая база без колонок — unavailable,
 *   не падение и не создание таблиц.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import { link, removeConcept } from "../tools.js";
import { confirmSupports, claimDigestOf, statusDigestOf, edgeDigestOf } from "../support-baselines.js";
import { computeHealth, formatHealth } from "../health.js";
import { sessionize, SESSION_GAP_MINUTES, timelineTsString } from "../sessions.js";
import { computeFunnel } from "../funnel.js";
import { runDoctor } from "../doctor.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async () => Buffer.alloc(0)),
  embeddingText: vi.fn((_n: string, k: string, s: string) => `${k}: ${s}`),
  findTopK: vi.fn(),
  embedForStorage: vi.fn(async () => null),
  vectorSearchEnabled: vi.fn(() => false),
  vectorChannelState: vi.fn(() => ({ state: "off", reason: "no_generation" })),
  cosineSimilarity: vi.fn(() => 0),
  queryText: vi.fn((q: string) => q),
  MODEL_NAME: "test-model",
  isModelLoaded: vi.fn(() => false),
}));

// Фиксированный «сейчас»: 2026-11-15 12:00:00 UTC. Окно 7d — [08.11 12:00, 15.11 12:00).
const NOW = Date.parse("2026-11-15T12:00:00Z");
const FROM_7D = Date.parse("2026-11-08T12:00:00Z");

let tmpDir: string;
let dbPath: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-health-metrics-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  db = new KnowledgeDB(dbPath);
});

afterEach(async () => {
  await closeAndCleanup(db, tmpDir);
});

// ---- helpers ----

interface FakeEntry {
  tool: string;
  timestamp: string;
  params?: Record<string, unknown>;
  is_write?: boolean;
  is_error?: boolean;
  affected_ids?: string[];
}

function addEntry(entry: FakeEntry): number {
  const seq = db.insertTimelineEntry({
    tool: entry.tool,
    params: JSON.stringify(entry.params ?? {}),
    result_summary: "",
    is_write: entry.is_write ?? false,
    is_error: entry.is_error ?? false,
    affected_ids: entry.affected_ids ?? [],
  });
  db.execSqlRun("UPDATE timeline SET timestamp = ? WHERE seq = ?", entry.timestamp, seq);
  return seq;
}

function node(id: string, kind = "config", summary = `s-${id}`) {
  db.insertNode({ id, name: id.toUpperCase(), kind, summary });
}

function supportEdge(from: string, to: string, description = `why ${to}`) {
  link(db, { from, to, relation: "informed_by", description });
}

function confirm(decisionId: string, supportIds: string[]) {
  const decision = db.getNode(decisionId)!;
  const edges = db.getInformedByEdges(decisionId, "ancestry", false);
  return confirmSupports(db, {
    decision_id: decisionId,
    expected_claim_digest: claimDigestOf(decision.summary),
    items: supportIds.map((sid) => {
      const edge = edges.find((e) => e.other_id === sid)!;
      const support = db.getNode(sid)!;
      return {
        support_id: sid,
        expected_claim_digest: claimDigestOf(support.summary),
        expected_status_digest: statusDigestOf(support.status, support.epistemic_status),
        expected_edge_digest: edgeDigestOf(edge.description),
      };
    }),
  });
}

function confirmedDecision(id: string, supports: string[]) {
  node(id, "decision", `decision ${id}`);
  for (const s of supports) {
    node(s, "fact");
    supportEdge(id, s);
  }
  confirm(id, supports);
  return id;
}

const health = () => computeHealth(db, { window: "7d", now: NOW });

// ---- A3: модуль сессиизации (один на funnel и health) ----

describe("sessions: единый модуль сессиизации (30-минутный разрыв)", () => {
  it("разрыв ровно 30 минут — одна сессия, 31 минута — две", () => {
    const rows = [
      { seq: 1, timestamp: "2026-11-01 10:00:00" },
      { seq: 2, timestamp: "2026-11-01 10:30:00" },
      { seq: 3, timestamp: "2026-11-01 11:01:00" },
    ];
    const sessions = sessionize(rows);
    expect(SESSION_GAP_MINUTES).toBe(30);
    expect(sessions.length).toBe(2);
    expect(sessions[0].entries.length).toBe(2);
    expect(sessions[1].entries.length).toBe(1);
  });

  it("timelineTsString даёт формат журнала в UTC", () => {
    expect(timelineTsString(Date.parse("2026-11-08T12:00:00Z"))).toBe("2026-11-08 12:00:00");
  });
});

// ---- пустая база ----

describe("health: пустая база", () => {
  it("нули без падения; coverage unknown — журнал пуст", () => {
    const r = health();
    expect(r.activity_window.understand_calls).toEqual({ total: 0, successful: 0, errored: 0 });
    expect(r.activity_window.writes).toEqual({
      knowledge: 0,
      confirmation: 0,
      maintenance: 0,
      no_op: 0,
      unknown: 0,
      errors: 0,
    });
    expect(r.activity_window.sessions.silent_sessions).toBe(0);
    expect(r.completeness.coverage).toBe("unknown");
    expect(r.completeness.reasons.length).toBeGreaterThan(0);
    expect(r.state_now.decisions_in_scope).toBe(0);
    expect(r.state_now.unsupported_decisions).toBe(0);
  });

  it("форма JSON: три группы не смешаны, экономия не выводится", () => {
    const json = JSON.parse(JSON.stringify(health())) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(
      ["activity_window", "completeness", "db", "generated_at", "state_now", "window"].sort()
    );
    expect(json.window).toMatchObject({ requested: "7d", from: "2026-11-08 12:00:00", to: "2026-11-15 12:00:00" });
    // Экономия не является производной метрикой — поля экономики отсутствуют.
    expect(JSON.stringify(json)).not.toContain("economy");
    expect(JSON.stringify(json)).not.toContain("saved_tokens");
  });
});

// ---- A2.1: agent_nodes_created ----

describe("health: agent_nodes_created — снимочная метрика происхождения/даты", () => {
  function agentNode(id: string, kind = "config", summary = `s-${id}`) {
    db.insertNode({ id, name: id.toUpperCase(), kind, summary, created_via: "agent" });
    // created_at — DEFAULT datetime('now') (реальное время); фиксируем в окне
    // фиксированного запуска, чтобы снимок даты детерминирован.
    db.execSqlRun("UPDATE nodes SET created_at = '2026-11-14 00:00:00' WHERE id = ?", id);
  }

  it("считает created_via='agent' в окне, включая сохранённые soft-deleted строки", () => {
    agentNode("live-1");
    agentNode("gone-1");
    db.execSqlRun("UPDATE nodes SET removed_at = '2026-11-10 00:00:00' WHERE id = 'gone-1'");
    // Вне окна — не считается.
    db.execSqlRun("UPDATE nodes SET created_at = '2026-11-01 00:00:00' WHERE id = 'live-1'");
    agentNode("fresh-2");
    const r = health();
    const created = r.activity_window.agent_nodes_created;
    expect(created.available).toBe(true);
    if (created.available) {
      expect(created.count).toBe(2); // gone-1 (soft-deleted, в окне) + fresh-2
      expect(created.soft_deleted_included).toBe(1);
      // Явное ограничение: это происхождение/дата строк, не число операций записи.
      expect(created.note).toContain("не число операций");
    }
  });

  it("уточнение: не число операций записи — импорт сохраняет атрибуты", () => {
    // Две строки созданы одним импортом, создавших операций записи могло не быть.
    agentNode("imp-1");
    agentNode("imp-2");
    const r = health();
    if (r.activity_window.agent_nodes_created.available) {
      expect(r.activity_window.agent_nodes_created.count).toBe(2);
    }
  });
});

// ---- A2.3/A2.4: категории записей и silent_sessions ----

describe("health: категории записей за окно", () => {
  it("read-only сессия: understand + get_concept — записей нет, сессия молчаливая", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00", params: { query: "q" } });
    addEntry({ tool: "get_concept", timestamp: "2026-11-14 10:01:00", affected_ids: ["a"] });
    // Закрываем сессию реальным разрывом.
    addEntry({ tool: "board", timestamp: "2026-11-14 10:45:00" });
    const r = health();
    expect(r.activity_window.understand_calls).toEqual({ total: 1, successful: 1, errored: 0 });
    expect(r.activity_window.writes.knowledge).toBe(0);
    expect(r.activity_window.sessions.silent_sessions).toBe(1);
    // Информационная метрика: «не записывали», не «память не используется».
    expect(r.activity_window.sessions.note).toContain("не записывали");
  });

  it("update без create — изменение знания; ошибочная запись — errors", () => {
    addEntry({
      tool: "update_concept",
      timestamp: "2026-11-14 10:00:00",
      params: { id: "a", changed_fields: ["summary"] },
      is_write: true,
    });
    addEntry({
      tool: "create_concept",
      timestamp: "2026-11-14 10:05:00",
      params: { name: "x" },
      is_write: true,
      is_error: true,
    });
    const r = health();
    expect(r.activity_window.writes.knowledge).toBe(1);
    expect(r.activity_window.writes.errors).toBe(1);
    expect(r.activity_window.understand_calls.successful).toBe(0);
  });

  it("подтверждение без нового знания — confirmation, не knowledge", () => {
    addEntry({ tool: "confirm_supports", timestamp: "2026-11-14 10:00:00", is_write: true });
    const r = health();
    expect(r.activity_window.writes.confirmation).toBe(1);
    expect(r.activity_window.writes.knowledge).toBe(0);
  });

  it("duplicate create (is_write=0) и no-op update — категория no-op", () => {
    addEntry({
      tool: "create_concept",
      timestamp: "2026-11-14 10:00:00",
      params: { name: "dup" },
      is_write: false,
    });
    addEntry({
      tool: "update_concept",
      timestamp: "2026-11-14 10:01:00",
      params: { id: "a", changed_fields: [] },
      is_write: true,
    });
    const r = health();
    expect(r.activity_window.writes.no_op).toBe(2);
    expect(r.activity_window.writes.knowledge).toBe(0);
  });

  it("обслуживание (remove/check_artifacts/trail) — maintenance", () => {
    addEntry({ tool: "remove_concept", timestamp: "2026-11-14 10:00:00", is_write: true });
    addEntry({ tool: "check_artifacts", timestamp: "2026-11-14 10:01:00", is_write: true });
    addEntry({ tool: "trail_save", timestamp: "2026-11-14 10:02:00", is_write: true });
    const r = health();
    expect(r.activity_window.writes.maintenance).toBe(3);
    expect(r.activity_window.writes.knowledge).toBe(0);
  });

  it("неизвестный записывающий инструмент — unknown и счётчик unknown_outcomes", () => {
    addEntry({ tool: "future_tool", timestamp: "2026-11-14 10:00:00", is_write: true });
    const r = health();
    expect(r.activity_window.writes.unknown).toBe(1);
    expect(r.completeness.unknown_outcomes).toBe(1);
  });

  it("ошибочные understand считаются отдельно от успешных", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00", is_error: true });
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:01:00" });
    const r = health();
    expect(r.activity_window.understand_calls).toEqual({ total: 2, successful: 1, errored: 1 });
  });
});

describe("health: silent_sessions — только после understand", () => {
  it("запись ДО understand не выполняет его рекомендацию — сессия молчаливая", () => {
    addEntry({
      tool: "create_concept",
      timestamp: "2026-11-14 10:00:00",
      params: { name: "x" },
      is_write: true,
    });
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:01:00", params: { query: "q" } });
    addEntry({ tool: "board", timestamp: "2026-11-14 10:45:00" });
    const r = health();
    expect(r.activity_window.sessions.silent_sessions).toBe(1);
    expect(r.activity_window.writes.knowledge).toBe(1);
  });

  it("ошибочный understand не делает сессию understand-сессией молчания", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00", is_error: true });
    addEntry({ tool: "board", timestamp: "2026-11-14 10:45:00" });
    const r = health();
    expect(r.activity_window.sessions.understand_sessions).toBe(0);
    expect(r.activity_window.sessions.silent_sessions).toBe(0);
  });

  it("незавершённая текущая сессия — не нарушение и не silent", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-15 11:58:00", params: { query: "q" } });
    // Разрыва после нет — это последняя запись журнала: сессия не закрыта.
    const r = health();
    expect(r.completeness.sessions_unclosed).toBe(1);
    expect(r.activity_window.sessions.silent_sessions).toBe(0);
  });

  it("ошибки записи не мешают сессии быть молчаливой", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00" });
    addEntry({
      tool: "create_concept",
      timestamp: "2026-11-14 10:01:00",
      is_write: true,
      is_error: true,
    });
    addEntry({ tool: "board", timestamp: "2026-11-14 10:45:00" });
    const r = health();
    expect(r.activity_window.sessions.silent_sessions).toBe(1);
    expect(r.activity_window.writes.errors).toBe(1);
  });
});

// ---- A3: окно, границы UTC, сессии через границу ----

describe("health: окно [from, to) и границы UTC", () => {
  it("событие ровно на from считается, на to — нет (полуинтервал)", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-08 12:00:00" });
    addEntry({ tool: "understand", timestamp: "2026-11-08 11:59:59" });
    addEntry({ tool: "understand", timestamp: "2026-11-15 11:59:59" });
    addEntry({ tool: "understand", timestamp: "2026-11-15 12:00:00" });
    const r = health();
    expect(r.activity_window.understand_calls.total).toBe(2);
    expect(r.completeness.timeline_entries).toBe(2);
  });

  it("окно 30d и all задают другие границы; all — без нижней", () => {
    addEntry({ tool: "understand", timestamp: "2026-10-20 00:00:00" });
    const r30 = computeHealth(db, { window: "30d", now: NOW });
    const rall = computeHealth(db, { window: "all", now: NOW });
    expect(r30.window.from).toBe("2026-10-16 12:00:00");
    expect(r30.activity_window.understand_calls.total).toBe(1);
    expect(rall.window.from).toBeNull();
    expect(rall.activity_window.understand_calls.total).toBe(1);
  });

  it("время один раз на запуск: from/to вычислены из переданного now, не из часов", () => {
    const r = health();
    expect(r.generated_at).toBe("2026-11-15 12:00:00");
    expect(r.window.to).toBe("2026-11-15 12:00:00");
  });

  it("сессия через границу окна: обход назад до реального разрыва, флаг явный", () => {
    // Сессия началась ДО окна: 10:45 → 11:55 (разрыв 70 мин до этого) → 12:00 в окне.
    addEntry({ tool: "get_concept", timestamp: "2026-11-08 10:45:00", affected_ids: ["a"] });
    addEntry({ tool: "understand", timestamp: "2026-11-08 11:55:00" });
    addEntry({ tool: "get_concept", timestamp: "2026-11-08 12:00:00", affected_ids: ["b"] });
    addEntry({ tool: "board", timestamp: "2026-11-08 12:35:00" }); // закрывает разрывом
    const r = health();
    expect(r.completeness.sessions_started_before_window).toBe(1);
    // Понимание случилось до границы окна — в окне его нет: события считаются
    // по окну, пересечение сессии помечено отдельно (не терять и не домысливать).
    expect(r.activity_window.sessions.understand_sessions).toBe(0);
  });

  it("фиксированные +30 минут не требуются: обход до разрыва, не до from-30min", () => {
    // Сессия начинается в 11:00 — дальше «from-30мин» (11:30): обход назад до
    // реального разрыва находит её начало, фиксированные +30 минут — нет.
    addEntry({ tool: "get_concept", timestamp: "2026-11-08 11:00:00", affected_ids: ["a"] });
    addEntry({ tool: "get_concept", timestamp: "2026-11-08 11:20:00", affected_ids: ["a"] });
    addEntry({ tool: "get_concept", timestamp: "2026-11-08 11:40:00", affected_ids: ["a"] });
    addEntry({ tool: "understand", timestamp: "2026-11-08 12:00:00" });
    addEntry({ tool: "board", timestamp: "2026-11-08 12:40:00" });
    const r = health();
    expect(r.completeness.sessions_started_before_window).toBe(1);
    expect(r.activity_window.sessions.understand_sessions).toBe(1);
    // Сессия закрыта разрывом (board на 12:40), успешной записи после
    // understand нет — молчаливая.
    expect(r.activity_window.sessions.silent_sessions).toBe(1);
  });
});

// ---- A3: полнота окна (ретеншн, prune по количеству) ----

describe("health: полнота окна при ретеншне", () => {
  it("журнал покрывает начало окна — coverage full", () => {
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 00:00:00", affected_ids: ["a"] });
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00" });
    const r = health();
    expect(r.completeness.coverage).toBe("full");
  });

  it("количественный prune срезал начало — coverage partial с явной причиной", () => {
    // Часть записей ВНУТРИ окна: после вытеснения по количеству первая
    // запись журнала попадает внутрь окна — начало не покрыто.
    addEntry({ tool: "get_concept", timestamp: "2026-11-06 00:00:00", affected_ids: ["a"] });
    addEntry({ tool: "get_concept", timestamp: "2026-11-07 00:00:00", affected_ids: ["a"] });
    addEntry({ tool: "get_concept", timestamp: "2026-11-08 13:00:00", affected_ids: ["a"] });
    addEntry({ tool: "get_concept", timestamp: "2026-11-08 14:00:00", affected_ids: ["a"] });
    addEntry({ tool: "get_concept", timestamp: "2026-11-09 00:00:00", affected_ids: ["a"] });
    vi.stubEnv("MEGAMEMORY_TIMELINE_MAX_ENTRIES", "2");
    try {
      db.pruneTimeline();
    } finally {
      vi.unstubAllEnvs();
    }
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00" });
    const r = health();
    expect(r.completeness.coverage).toBe("partial");
    expect(r.completeness.reasons.join(" ")).toContain("начало");
  });

  it("all-окно на журнале с включённым ретеншном — честный partial", () => {
    vi.stubEnv("MEGAMEMORY_TIMELINE_RETENTION_DAYS", "90");
    try {
      addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00" });
      const r = computeHealth(db, { window: "all", now: NOW });
      expect(r.completeness.coverage).toBe("partial");
      expect(r.completeness.reasons.join(" ")).toContain("ретеншн");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("непрерывный timeline не доказывает полноту активности — примечание", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00" });
    const r = health();
    expect(r.completeness.reasons.join(" ")).toContain("полноту");
  });
});

// ---- A2.5/A2.6: безопорные решения (состояние сейчас) ----

describe("health: unsupported_decisions — область отчёта", () => {
  it("решение без опор и без снимка — unsupported; исключённые группы отдельно", () => {
    node("d-bare", "decision", "решение без опор");
    node("d-epi", "decision", "опровергнутое");
    db.execSqlRun("UPDATE nodes SET epistemic_status = 'refuted' WHERE id = 'd-epi'");
    node("d-gone", "decision", "удалённое");
    db.execSqlRun("UPDATE nodes SET removed_at = '2026-11-10 00:00:00' WHERE id = 'd-gone'");
    node("d-sup", "decision", "заменённое");
    db.execSqlRun("UPDATE nodes SET status = 'superseded' WHERE id = 'd-sup'");
    node("d-exp", "decision", "просроченное");
    db.execSqlRun("UPDATE nodes SET valid_until = '2026-11-10 00:00:00' WHERE id = 'd-exp'");

    const r = health();
    expect(r.state_now.decisions_in_scope).toBe(1); // только d-bare
    expect(r.state_now.unsupported_decisions).toBe(1);
    expect(r.state_now.excluded.removed).toBe(1);
    expect(r.state_now.excluded.refuted_or_abandoned).toBe(1);
    expect(r.state_now.excluded.not_active).toBe(1);
    expect(r.state_now.excluded.expired).toBe(1);
  });

  it("живость проверяется И у ребра, И у цели: живое ребро на удалённую цель — не опора", () => {
    confirmedDecision("d-1", ["f-1"]);
    // Цель soft-deleted напрямую, ребро остаётся живым (разъ consistency).
    db.execSqlRun("UPDATE nodes SET removed_at = '2026-11-10 00:00:00' WHERE id = 'f-1'");
    const r = health();
    expect(r.state_now.with_live_support).toBe(0);
    expect(r.state_now.without_live_support_with_snapshot).toBe(1);
    expect(r.state_now.snapshot_breakdown.supports_vanished).toBe(1);
    expect(r.state_now.unsupported_decisions).toBe(0);
  });

  it("подтверждённый пустой набор — не unsupported, отдельная категория", () => {
    confirmedDecision("d-1", ["f-1"]);
    removeConcept(db, { id: "f-1", reason: "убрали", force: true });
    // Явное подтверждение пустого набора.
    const decision = db.getNode("d-1")!;
    confirmSupports(db, {
      decision_id: "d-1",
      expected_claim_digest: claimDigestOf(decision.summary),
      items: [],
    });
    const r = health();
    expect(r.state_now.unsupported_decisions).toBe(0);
    expect(r.state_now.without_live_support_with_snapshot).toBe(1);
    expect(r.state_now.snapshot_breakdown.confirmed_empty_set).toBe(1);
  });

  it("исчезнувшая опора при живом снимке — supports_vanished, не пустое подтверждение", () => {
    confirmedDecision("d-1", ["f-1"]);
    removeConcept(db, { id: "f-1", reason: "убрали", force: true });
    const r = health();
    expect(r.state_now.without_live_support_with_snapshot).toBe(1);
    expect(r.state_now.snapshot_breakdown.supports_vanished).toBe(1);
    expect(r.state_now.snapshot_breakdown.confirmed_empty_set).toBe(0);
  });

  it("изменение формулировки решения — claim_changed", () => {
    confirmedDecision("d-1", ["f-1"]);
    removeConcept(db, { id: "f-1", reason: "убрали", force: true });
    db.updateNode("d-1", { summary: "переписанная формулировка" });
    const r = health();
    expect(r.state_now.snapshot_breakdown.claim_changed).toBe(1);
    expect(r.state_now.snapshot_breakdown.supports_vanished).toBe(0);
  });

  it("живые опоры — with_live_support, не unsupported; область отчёта не сужает weak_links", () => {
    confirmedDecision("d-1", ["f-1"]);
    const r = health();
    expect(r.state_now.with_live_support).toBe(1);
    expect(r.state_now.unsupported_decisions).toBe(0);
    expect(r.state_now.note).toContain("weak_links");
  });

  it("полный проход по снимкам без бюджета — truncate-флаг false и checked = всем", () => {
    confirmedDecision("d-1", ["f-1"]);
    confirmedDecision("d-2", ["f-2"]);
    removeConcept(db, { id: "f-1", reason: "убрали", force: true });
    removeConcept(db, { id: "f-2", reason: "убрали", force: true });
    const r = health();
    expect(r.state_now.snapshot_checked).toBe(2);
    expect(r.state_now.snapshot_truncated).toBe(false);
    expect(r.state_now.snapshot_breakdown.supports_vanished).toBe(2);
  });
});

// ---- must_read: legacy-название и точная метрика ----

describe("health: must_read refs_returned и legacy opened", () => {
  it("refs_returned считает выданные refs; opened_legacy — get_concept-вызовы", () => {
    addEntry({
      tool: "understand",
      timestamp: "2026-11-14 10:00:00",
      params: {
        must_read: [
          { ref: "src/a.ts:1-10", why: "w", node_id: "x-1" },
          { ref: "src/b.ts:1-5", why: "w", node_id: "y-2" },
        ],
        must_read_ids: ["x-1", "y-2"],
      },
    });
    addEntry({ tool: "get_concept", timestamp: "2026-11-14 10:01:00", affected_ids: ["x-1"] });
    const r = health();
    expect(r.activity_window.must_read.refs_returned).toBe(2);
    expect(r.activity_window.must_read.opened_legacy).toBe(1);
    // Явное описание legacy-названия: считает get_concept-вызовы, не чтение файлов.
    expect(r.activity_window.must_read.legacy_note).toContain("get_concept");
  });
});

// ---- A4: doctor и stats — потребители одного расчёта ----

describe("health: consumers одного окна дают одинаковые числа", () => {
  it("doctor-сводка содержит те же числа, что computeHealth; problems не растут", () => {
    node("d-bare", "decision", "решение без опор");
    // Метки времени относительно реального «сейчас» — doctor и comparison
    // используют один и тот же реальный запуск (время один раз на запуск).
    const yesterday = timelineTsString(Date.now() - 24 * 60 * 60 * 1000);
    addEntry({ tool: "understand", timestamp: yesterday });
    addEntry({
      tool: "get_concept",
      timestamp: timelineTsString(Date.now() - 24 * 60 * 60 * 1000 + 60_000),
      affected_ids: ["a"],
    });
    addEntry({
      tool: "board",
      timestamp: timelineTsString(Date.now() - 24 * 60 * 60 * 1000 + 45 * 60_000),
    });
    node("n1");

    const { checks, problems } = runDoctor(db);
    const check = checks.find((c) => c.name === "memory activity");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true); // отсутствие записей никогда не повышает problems
    // Сводка — информационная: problems складываются только из остальных
    // проверок (на синтетической базе модель/схема могут краснеть сами).
    const otherProblems = checks.filter((c) => !c.ok && c.name !== "memory activity").length;
    expect(problems).toBe(otherProblems);

    const r = computeHealth(db, { window: "7d" });
    const summary = check!.detail;
    // Числа из сводки совпадают с расчётом того же окна.
    expect(summary).toContain(`unsupported=${r.state_now.unsupported_decisions}`);
    expect(summary).toContain(`silent=${r.activity_window.sessions.silent_sessions}`);
    const created = r.activity_window.agent_nodes_created;
    expect(summary).toContain(`agent_nodes=${created.available ? created.count : "n/a"}`);
    expect(summary).toContain(`coverage=${r.completeness.coverage}`);
  });

  it("пустая база: doctor-сводка не растит problems и честно говорит об отсутствии данных", () => {
    const { checks, problems } = runDoctor(db);
    const check = checks.find((c) => c.name === "memory activity");
    expect(check!.ok).toBe(true);
    expect(check!.detail).not.toBe("");
    const otherProblems = checks.filter((c) => !c.ok && c.name !== "memory activity").length;
    expect(problems).toBe(otherProblems);
  });

  it("formatHealth — человекочитаемые строки, три группы разделены", () => {
    const lines = formatHealth(health());
    const text = lines.join("\n");
    expect(text).toContain("Window");
    expect(text).toContain("State");
    expect(text).toContain("Activity");
    expect(text.trimStart().startsWith("{")).toBe(false);
  });
});

// ---- A5: неизменность БД на readonly-пути ----

describe("health: сравнение хешей до/после на копии", () => {
  it("readonly-открытие и computeHealth не меняют байты .db", () => {
    node("d-1", "decision", "решение");
    node("f-1");
    supportEdge("d-1", "f-1");
    confirm("d-1", ["f-1"]);
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00" });
    // Чекпоинт WAL в главный файл — копируем полный снимок, не хвост журнала.
    db.execSqlRun("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();

    const copy = path.join(tmpDir, "copy.db");
    fs.copyFileSync(dbPath, copy);
    const shaBefore = createHash("sha256").update(fs.readFileSync(copy)).digest("hex");

    const ro = new KnowledgeDB(copy, { readonly: true });
    try {
      const r = computeHealth(ro, { window: "7d", now: NOW });
      expect(r.state_now.decisions_in_scope).toBe(1);
    } finally {
      ro.close();
    }
    const shaAfter = createHash("sha256").update(fs.readFileSync(copy)).digest("hex");
    expect(shaAfter).toBe(shaBefore);
  });
});

// ---- A5: старая база без нужных колонок/таблиц ----

describe("health: старая база без legacy-полей — честный unavailable", () => {
  function makeOldDb(): string {
    const p = path.join(tmpDir, "old.db");
    const raw = new Database(p);
    raw.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, name TEXT, kind TEXT, summary TEXT,
        removed_at TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE timeline (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, tool TEXT,
        params TEXT, result_summary TEXT, is_write INTEGER, is_error INTEGER, affected_ids TEXT
      );
      PRAGMA user_version = 14;
    `);
    raw.close();
    return p;
  }

  it("нет created_via/edges/support_baselines — unavailable, не падение, не создание таблиц", async () => {
    const oldPath = makeOldDb();
    // autoMigrate: false — сырая схема не поднимается (assertSchema14Columns
    // отверг бы её как неполную); расчёт обязан честно degrade, не чинить.
    const oldDb = new KnowledgeDB(oldPath, { autoMigrate: false });
    try {
      const r = computeHealth(oldDb, { window: "7d", now: NOW });
      expect(r.activity_window.agent_nodes_created.available).toBe(false);
      if (!r.activity_window.agent_nodes_created.available) {
        expect(r.activity_window.agent_nodes_created.reason).toContain("created_via");
      }
      expect(r.state_now.unavailable).toBeTruthy();
      // Таблицы не созданы: support_baselines по-прежнему отсутствует.
      const still = oldDb.execSqlFirst(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_baselines'"
      );
      expect(still).toBeUndefined();
    } finally {
      await closeAndCleanup(oldDb, tmpDir);
    }
  });
});

// ---- computeFunnel: старый режим all без аргументов ----

describe("computeFunnel: совместимость и окно", () => {
  it("без аргументов — режим all, поля эталона (существующие тесты не ломаются)", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-01 10:00:00" });
    addEntry({ tool: "create_concept", timestamp: "2026-11-01 10:02:00", is_write: true });
    const r = computeFunnel(db);
    expect(r.with_record).toBe(1);
    expect(r.window.entries).toBe(2);
  });

  it("с окном: события вне окна не считаются; пересекающая сессия видна", () => {
    addEntry({ tool: "get_concept", timestamp: "2026-11-08 11:55:00", affected_ids: ["a"] });
    addEntry({ tool: "understand", timestamp: "2026-11-08 12:00:00" });
    addEntry({ tool: "understand", timestamp: "2026-11-14 10:00:00" });
    addEntry({ tool: "create_concept", timestamp: "2026-11-14 10:02:00", is_write: true });
    const r = computeFunnel(db, { window: { from: FROM_7D, to: NOW } });
    // Обе understand-записи в окне; get_concept до окна — в пересекающей сессии.
    expect(r.understand_sessions).toBe(2);
    expect(r.with_record).toBe(1);
    expect(r.window.entries).toBe(3);
  });
});
