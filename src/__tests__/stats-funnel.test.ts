import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { KnowledgeDB } from "../db.js";
import { computeFunnel, formatFunnel } from "../funnel.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// План 13 §2.3/§6: `stats --funnel` считает воронку по реальному timeline,
// а не по догадкам. Здесь — контролируемая база: записи добавляются через
// db.insertTimelineEntry, timestamp переписывается публичным execSqlRun
// (db.ts не трогаем — его владеет план 13.1).

let db: KnowledgeDB;
let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-stats-funnel-test-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  db = new KnowledgeDB(dbPath);
});

afterEach(async () => {
  await closeAndCleanup(db, tmpDir);
});

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

describe("computeFunnel (stats --funnel)", () => {
  it("разрыв 40 минут — две сессии", () => {
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:00:00" });
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:40:00" });
    const r = computeFunnel(db);
    expect(r.sessions_total).toBe(2);
    expect(r.understand_sessions).toBe(0);
    expect(r.shares.follow_up_pct).toBe(0);
  });

  it("разрыв ровно 30 минут — ещё одна сессия (разрыв > 30 = новая)", () => {
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:00:00" });
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:30:00" });
    const r = computeFunnel(db);
    expect(r.sessions_total).toBe(1);
  });

  it("understand → get_concept → create_concept: follow-up и запись посчитаны", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-01 10:00:00", params: { query: "merge" } });
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:01:00", affected_ids: ["d-1"] });
    addEntry({
      tool: "create_concept",
      timestamp: "2026-11-01 10:02:00",
      is_write: true,
      affected_ids: ["n-1"],
    });
    const r = computeFunnel(db);
    expect(r.sessions_total).toBe(1);
    expect(r.understand_sessions).toBe(1);
    expect(r.started_with_understand).toBe(1);
    expect(r.with_follow_up).toBe(1);
    expect(r.with_record).toBe(1);
    expect(r.avg_calls_per_understand_session).toBe(3);
    expect(r.shares.follow_up_pct).toBe(100);
    expect(r.shares.record_pct).toBe(100);
  });

  it("understand без продолжения — follow-up 0, запись 0", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-01 10:00:00" });
    const r = computeFunnel(db);
    expect(r.understand_sessions).toBe(1);
    expect(r.with_follow_up).toBe(0);
    expect(r.with_record).toBe(0);
    expect(r.avg_calls_per_understand_session).toBe(1);
    expect(r.shares.follow_up_pct).toBe(0);
    expect(r.shares.record_pct).toBe(0);
  });

  it("understand с is_error открывает сессию; ошибочные чтение и запись не считаются", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-01 10:00:00", is_error: true });
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:01:00", is_error: true });
    addEntry({
      tool: "create_concept",
      timestamp: "2026-11-01 10:02:00",
      is_write: true,
      is_error: true,
    });
    const r = computeFunnel(db);
    expect(r.understand_sessions).toBe(1);
    expect(r.started_with_understand).toBe(1);
    expect(r.with_follow_up).toBe(0);
    expect(r.with_record).toBe(0);
  });

  it("сессия без understand в воронку не попадает", () => {
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 12:00:00", affected_ids: ["x"] });
    addEntry({
      tool: "create_concept",
      timestamp: "2026-11-01 12:01:00",
      is_write: true,
      affected_ids: ["n-1"],
    });
    const r = computeFunnel(db);
    expect(r.sessions_total).toBe(1);
    expect(r.understand_sessions).toBe(0);
    expect(r.started_with_understand).toBe(0);
    expect(r.with_follow_up).toBe(0);
    expect(r.with_record).toBe(0);
  });

  it("must_read: выдано 2, открыт 1 (по get_concept в той же сессии)", () => {
    addEntry({
      tool: "understand",
      timestamp: "2026-11-01 10:00:00",
      params: {
        must_read: [
          { ref: "src/a.ts:1-10", why: "решение S-1 опирается на этот участок", node_id: "x-1" },
          { ref: "src/b.ts:1-5", why: "решение S-2", node_id: "y-2" },
        ],
        must_read_ids: ["x-1", "y-2"],
      },
    });
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:01:00", affected_ids: ["x-1"] });
    const r = computeFunnel(db);
    expect(r.must_read_issued).toBe(2);
    expect(r.must_read_opened).toBe(1);
  });

  it("must_read: старая запись без поля — 0; открытие в другой сессии не считается", () => {
    addEntry({
      tool: "understand",
      timestamp: "2026-11-01 10:00:00",
      params: { must_read_ids: ["x-1"] },
    });
    // Разрыв 60 минут — новая сессия, get_concept туда не засчитывается.
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 11:00:00", affected_ids: ["x-1"] });
    const r = computeFunnel(db);
    expect(r.sessions_total).toBe(2);
    expect(r.must_read_issued).toBe(0);
    expect(r.must_read_opened).toBe(0);
  });

  it("форма JSON-объекта: ровно поля эталона, округления toFixed", () => {
    // Три understand-сессии, 11 вызовов суммарно → avg 3.67.
    // follow-up после understand в 1 из 3 → 33.3%; запись в 1 из 3 → 33.3%.
    addEntry({ tool: "understand", timestamp: "2026-11-01 10:00:00" });
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:01:00", affected_ids: ["a"] });
    addEntry({ tool: "board", timestamp: "2026-11-01 10:02:00" });
    addEntry({ tool: "trail_get", timestamp: "2026-11-01 10:03:00" });

    addEntry({ tool: "understand", timestamp: "2026-11-01 11:00:00" });
    addEntry({ tool: "create_concept", timestamp: "2026-11-01 11:01:00", is_write: true });
    addEntry({ tool: "update_concept", timestamp: "2026-11-01 11:02:00", is_write: true });
    addEntry({ tool: "remove_concept", timestamp: "2026-11-01 11:03:00", is_write: true });

    addEntry({ tool: "understand", timestamp: "2026-11-01 12:00:00" });
    addEntry({ tool: "digest", timestamp: "2026-11-01 12:01:00" });
    addEntry({ tool: "merge", timestamp: "2026-11-01 12:02:00" });

    const r = computeFunnel(db);
    const json = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;

    expect(Object.keys(json).sort()).toEqual(
      [
        "db",
        "window",
        "session_gap_minutes",
        "sessions_total",
        "understand_sessions",
        "started_with_understand",
        "with_follow_up",
        "with_record",
        "avg_calls_per_understand_session",
        "must_read_issued",
        "must_read_opened",
        "shares",
      ].sort()
    );
    expect(json.db).toBe(path.resolve(dbPath));
    expect(json.window).toEqual({
      first: "2026-11-01 10:00:00",
      last: "2026-11-01 12:02:00",
      entries: 11,
    });
    expect(json.session_gap_minutes).toBe(30);
    expect(json.sessions_total).toBe(3);
    expect(json.understand_sessions).toBe(3);
    expect(json.started_with_understand).toBe(3);
    expect(json.with_follow_up).toBe(1);
    expect(json.with_record).toBe(1);
    expect(json.avg_calls_per_understand_session).toBe(3.67);
    expect(json.shares).toEqual({ follow_up_pct: 33.3, record_pct: 33.3 });
  });

  it("пустая база: нули, window без first/last после JSON", () => {
    const r = computeFunnel(db);
    expect(r.sessions_total).toBe(0);
    expect(r.understand_sessions).toBe(0);
    expect(r.avg_calls_per_understand_session).toBe(0);
    expect(r.window.entries).toBe(0);
    const json = JSON.parse(JSON.stringify(r)) as { window: Record<string, unknown> };
    expect(json.window).toEqual({ entries: 0 });
    expect(r.shares).toEqual({ follow_up_pct: 0, record_pct: 0 });
  });

  it("formatFunnel — человекочитаемые строки, не JSON", () => {
    addEntry({ tool: "understand", timestamp: "2026-11-01 10:00:00" });
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:01:00", affected_ids: ["a"] });
    const lines = formatFunnel(computeFunnel(db));
    expect(lines.length).toBeGreaterThan(1);
    const text = lines.join("\n");
    expect(text).toContain("10:00:00");
    expect(text).toContain("1");
    expect(text.trimStart().startsWith("{")).toBe(false);
  });
});

// B-07 (аудит 2026-11-12): открытие must_read засчитывается только ПОСЛЕ
// конкретной выдачи рекомендации. Поиск по всей сессии засчитывал чтение,
// случившееся до understand — метрика была завышена. Порядок — по позиции
// записи в журнале (seq), не по секундному timestamp; каждая выдача ищет
// своё чтение только среди последующих записей.
describe("B-07: must_read_opened учитывает чтение только после рекомендации", () => {
  // must_read_issued считается по массиву must_read (как пишет understand),
  // ids — по must_read_ids; в записях передаём оба поля, как в реальном вызове.
  function addUnderstandMustRead(timestamp: string): void {
    addEntry({
      tool: "understand",
      timestamp,
      params: {
        must_read: [
          { ref: "src/a.ts:1-10", why: "решение опирается на этот участок", node_id: "alpha" },
        ],
        must_read_ids: ["alpha"],
      },
    });
  }

  it("чтение ДО рекомендации не считается: get_concept затем understand", () => {
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:00:00", affected_ids: ["alpha"] });
    addUnderstandMustRead("2026-11-01 10:01:00");
    const r = computeFunnel(db);
    expect(r.must_read_issued).toBe(1);
    expect(
      r.must_read_opened,
      "B-07: чтение до выдачи не обязано засчитываться"
    ).toBe(0);
  });

  it("чтение ПОСЛЕ рекомендации считается", () => {
    addUnderstandMustRead("2026-11-01 10:00:00");
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:01:00", affected_ids: ["alpha"] });
    const r = computeFunnel(db);
    expect(r.must_read_issued).toBe(1);
    expect(r.must_read_opened).toBe(1);
  });

  it("одинаковые timestamps: различаются по позиции журнала, не по времени", () => {
    // Чтение раньше по seq при том же timestamp — не считается.
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:00:00", affected_ids: ["alpha"] });
    addUnderstandMustRead("2026-11-01 10:00:00");
    expect(computeFunnel(db).must_read_opened).toBe(0);

    // Чтение позже по seq при том же timestamp — считается.
    addUnderstandMustRead("2026-11-01 11:00:00");
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 11:00:00", affected_ids: ["alpha"] });
    const r = computeFunnel(db);
    expect(r.must_read_opened).toBe(1);
  });

  it("чтение в чужой (более поздней) сессии не считается", () => {
    addUnderstandMustRead("2026-11-01 10:00:00");
    // Разрыв 40 минут — уже другая сессия.
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:40:00", affected_ids: ["alpha"] });
    const r = computeFunnel(db);
    expect(r.sessions_total).toBe(2);
    expect(r.must_read_opened).toBe(0);
  });

  it("повторные рекомендации: каждая выдача ищет своё чтение после себя", () => {
    // Чтение между двумя выдачами — засчитывается только первой.
    addUnderstandMustRead("2026-11-01 10:00:00");
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 10:01:00", affected_ids: ["alpha"] });
    addUnderstandMustRead("2026-11-01 10:02:00");
    const r = computeFunnel(db);
    expect(r.must_read_issued).toBe(2);
    expect(
      r.must_read_opened,
      "B-07: чтение между выдачами не засчитывается второй выдаче"
    ).toBe(1);

    // Чтение после обеих выдач — засчитывается каждой.
    addUnderstandMustRead("2026-11-01 11:00:00");
    addUnderstandMustRead("2026-11-01 11:01:00");
    addEntry({ tool: "get_concept", timestamp: "2026-11-01 11:02:00", affected_ids: ["alpha"] });
    const r2 = computeFunnel(db);
    expect(r2.must_read_issued).toBe(4);
    expect(r2.must_read_opened).toBe(3);
  });
});
