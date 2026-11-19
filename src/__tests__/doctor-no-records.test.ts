import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { runDoctor } from "../doctor.js";
import { ensureSchema } from "../migrate-schema.js";
import { timelineTsString } from "../sessions.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";

const now = Date.parse("2026-11-19T12:00:00Z");
const minute = 60_000;
const day = 86_400_000;
const warning = "warn: 3 сессии с understand и 0 записей за 14 дней — память читается, но не пополняется.\n" +
  "      Проверь: megamemory install --target kilo и next.record в ответе understand.";
let fixture: AuditFixture;
let db: KnowledgeDB;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  ensureSchema(db);
  addNode(db, "activity");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fixture.close();
});

function logAt(at: number, tool = "understand", isWrite = false, isError = false): void {
  db.execSqlRun(
    "INSERT INTO timeline (timestamp, tool, params, result_summary, is_write, is_error, affected_ids) VALUES (?, ?, '{}', 'fixture', ?, ?, '[]')",
    timelineTsString(at), tool, isWrite ? 1 : 0, isError ? 1 : 0
  );
}

function sessions(count: number): void {
  for (let index = 0; index < count; index++) logAt(now - (count - index) * day);
}

function recordingChecks(): ReturnType<typeof runDoctor>["checks"] {
  return runDoctor(db).checks.filter((check) => check.name === "memory recording");
}

describe("doctor read-only recording warning (E T4)", () => {
  it("warns on three understand sessions and zero records with the exact install command", () => {
    sessions(3);
    expect(recordingChecks()).toEqual([{ name: "memory recording", ok: true, detail: warning }]);
    expect(warning).toContain("megamemory install --target kilo");
    expect(warning).toContain("next.record в ответе understand");
  });

  it("stays silent below three sessions even with many understand calls", () => {
    sessions(2);
    for (let index = 0; index < 10; index++) logAt(now - day + index * minute);
    expect(recordingChecks()).toEqual([]);
  });

  it("stays silent if any session in the window recorded, even one without understand", () => {
    sessions(3);
    logAt(now - 12 * 60 * minute, "create_concept", true);
    expect(recordingChecks()).toEqual([]);
  });

  it("stays silent on an empty base even with enough historical sessions", () => {
    sessions(3);
    db.execSqlRun("DELETE FROM nodes");
    expect(recordingChecks()).toEqual([]);
  });

  it("stays silent on an empty or unavailable timeline", () => {
    expect(recordingChecks()).toEqual([]);
    db.execSqlRun("DROP TABLE timeline");
    expect(recordingChecks()).toEqual([]);
  });

  it("does not change problems or persist any state", () => {
    sessions(2);
    const baseline = runDoctor(db).problems;
    logAt(now - 12 * 60 * minute);
    const before = sqlState(db);
    const report = runDoctor(db);
    expect(report.checks.some((check) => check.detail === warning)).toBe(true);
    expect(report.problems).toBe(baseline);
    expect(sqlState(db)).toEqual(before);
  });

  it("uses only the last fourteen days, including the lower boundary", () => {
    logAt(now - 14 * day - 1000);
    sessions(2);
    expect(recordingChecks()).toEqual([]);
    // Rebuild in chronological/seq order with the exact lower boundary.
    db.execSqlRun("DELETE FROM timeline");
    logAt(now - 14 * day);
    sessions(2);
    expect(recordingChecks()[0]?.detail).toBe(warning);
  });

  it("does not count understand events at or after the upper window boundary", () => {
    sessions(2);
    logAt(now);
    logAt(now + day);
    expect(recordingChecks()).toEqual([]);
  });

  it("does not let an older record suppress a warning in the current window", () => {
    logAt(now - 14 * day - 1000, "create_concept", true);
    sessions(3);
    expect(recordingChecks()[0]?.detail).toBe(warning);
  });

  it("uses the shared strict thirty-minute session gap and counts sessions, not calls", () => {
    logAt(now - 93 * minute);
    logAt(now - 63 * minute);
    logAt(now - 32 * minute);
    expect(recordingChecks()).toEqual([]);
    logAt(now - minute);
    expect(recordingChecks()[0]?.detail).toBe(warning);
  });

  it("does not count failed understand calls as successful reading sessions", () => {
    logAt(now - 3 * day, "understand", false, true);
    sessions(2);
    expect(recordingChecks()).toEqual([]);
  });

  it("does not count a failed write attempt as a recording", () => {
    sessions(3);
    logAt(now - minute, "create_concept", true, true);
    expect(recordingChecks()[0]?.detail).toBe(warning);
  });

  it("includes the actual count when more than three sessions read without records", () => {
    sessions(4);
    expect(recordingChecks()[0]?.detail).toBe(warning.replace("warn: 3", "warn: 4"));
  });
});
