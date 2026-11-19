import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { buildNextHints, RECORD_FACT, UNRECORDED_READS_THRESHOLD } from "../next-hints.js";
import { timelineTsString } from "../sessions.js";
import { createTimelineLogger, type TimelineLogger } from "../timeline.js";
import { measureMcpPayload, understand } from "../tools.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

const now = Date.parse("2026-11-19T12:00:00Z");
const minute = 60_000;
const previousSentence = "В прошлой сессии после understand не было ни одной записи — если сейчас есть вывод, запиши его.";
let fixture: AuditFixture;
let db: KnowledgeDB;
let logger: TimelineLogger;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  ensureSchema(db);
  db.setMetaValue("embed_model", "short-session-disabled-vector-space");
  addNode(db, "activity", { name: "Activity" });
  logger = createTimelineLogger(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await fixture.close();
});

function logAt(at: number, tool = "understand", isWrite = false, target = db, isError = false): void {
  target.execSqlRun(
    "INSERT INTO timeline (timestamp, tool, params, result_summary, is_write, is_error, affected_ids) VALUES (?, ?, '{}', 'fixture', ?, ?, '[]')",
    timelineTsString(at), tool, isWrite ? 1 : 0, isError ? 1 : 0
  );
}

function hints(at = now): ReturnType<typeof buildNextHints> {
  return buildNextHints({ db, cards: [{ id: "activity" }], now: new Date(at) });
}

function previous(hadUnderstand = true, hadRecord = false, at = now - 31 * minute): NonNullable<ReturnType<typeof buildNextHints>["previous_session"]> {
  return { had_understand: hadUnderstand, had_record: hadRecord, ended_at: timelineTsString(at) };
}

describe("short-session recording hints (E T3)", () => {
  it("reminds after exactly two completed reads without changing logger semantics", async () => {
    expect(UNRECORDED_READS_THRESHOLD).toBe(2);
    for (let count = 0; count < 2; count++) {
      const out = await understand(db, { query: "Activity" });
      expect(out.next!.record).toBe(RECORD_FACT);
      expect(out.next).not.toHaveProperty("unrecorded");
      logger.log({ tool: "get_concept", params: {}, result_summary: "read", is_write: false, is_error: false, affected_ids: [] });
    }
    const out = await understand(db, { query: "Activity" });
    expect(out.next!.unrecorded).toEqual({ reads_since_write: 2, last_write_at: null });
    expect(out.next!.record).toBe(`${RECORD_FACT} С последней записи 2 чтений — если это законченный вывод, запиши его.`);
  });

  it("appends the exact sentence and additive previous-session evidence", () => {
    logAt(now - 31 * minute);
    const out = hints();
    expect(out.record).toBe(`${RECORD_FACT} ${previousSentence}`);
    expect(out.previous_session).toEqual(previous());
    expect(out).not.toHaveProperty("unrecorded");
  });

  it("does not nudge if the previous session wrote, even before understand", () => {
    logAt(now - 32 * minute, "create_concept", true);
    logAt(now - 31 * minute);
    expect(hints().record).toBe(RECORD_FACT);
    expect(hints().previous_session).toEqual(previous(true, true));
  });

  it("does not count a failed write as recording in the previous session", () => {
    logAt(now - 32 * minute, "create_concept", true, db, true);
    logAt(now - 31 * minute);
    expect(hints().record).toBe(`${RECORD_FACT} ${previousSentence}`);
    expect(hints().previous_session).toEqual(previous(true, false));
  });

  it("keeps both reminders absent on an empty base", async () => {
    logAt(now - 31 * minute);
    for (let count = 0; count < 2; count++) {
      logger.log({ tool: "understand", params: {}, result_summary: "empty", is_write: false, is_error: false, affected_ids: [] });
    }
    db.execSqlRun("DELETE FROM nodes");
    const out = await understand(db, { query: "Activity" });
    expect(out.meta!.reason).toBe("empty_base");
    expect(out.next!.record).not.toContain(previousSentence);
    expect(out.next!.record).not.toContain("С последней записи");
    expect(out.next).not.toHaveProperty("unrecorded");
    expect(out.next).not.toHaveProperty("previous_session");
  });

  it("uses a strict greater-than-30-minute gap and recomputes it with cached rows", () => {
    logAt(now - 30 * minute);
    expect(hints().record).toBe(RECORD_FACT);
    expect(hints()).not.toHaveProperty("previous_session");
    expect(hints(now + minute).record).toBe(`${RECORD_FACT} ${previousSentence}`);
    expect(hints(now + 1000).record).toBe(`${RECORD_FACT} ${previousSentence}`);
  });

  it("never duplicates the sentence across repeated calls or new current-session rows", () => {
    logAt(now - 31 * minute);
    for (let count = 0; count < 3; count++) {
      expect(hints(now + count * minute).record).toBe(`${RECORD_FACT} ${previousSentence}`);
      expect(hints(now + count * minute).record.split(previousSentence)).toHaveLength(2);
      logAt(now + count * minute, "get_concept");
      vi.setSystemTime(now + count * minute);
    }
    expect(hints(now + 2 * minute).record.split(previousSentence)).toHaveLength(2);
  });

  it("caches the bounded timeline query and invalidates after local inserts and updates", () => {
    logAt(now - 31 * minute);
    const spy = vi.spyOn(db, "execSqlAll");
    expect(hints().record).toContain(previousSentence);
    expect(hints().record).toContain(previousSentence);
    const reads = spy.mock.calls.filter(([sql]) => sql.includes("FROM timeline"));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual([
      "SELECT seq, timestamp, tool, is_write, is_error FROM timeline ORDER BY seq DESC LIMIT ?", 200,
    ]);
    logAt(now - 31 * minute, "create_concept", true);
    expect(hints().record).toBe(RECORD_FACT);
    db.execSqlRun("UPDATE timeline SET is_write = 0, tool = 'get_concept' WHERE is_write = 1");
    expect(hints().record).toContain(previousSentence);
    db.execSqlRun("DELETE FROM timeline");
    expect(hints()).not.toHaveProperty("previous_session");
  });

  it("invalidates the cache on external updates without seq/count changes", () => {
    logAt(now - 31 * minute);
    expect(hints().record).toContain(previousSentence);
    const external = fixture.db("knowledge.db");
    external.execSqlRun("UPDATE timeline SET is_write = 1");
    expect(hints().record).toBe(RECORD_FACT);
    expect(hints().previous_session).toEqual(previous(true, true));
  });

  it("does not invent a no-write result when an older write falls outside the last 200 rows", () => {
    logAt(now - 40 * minute, "create_concept", true);
    for (let count = 0; count < 200; count++) logAt(now - 31 * minute);
    expect(hints().record).toBe(RECORD_FACT);
    expect(hints()).not.toHaveProperty("previous_session");
  });

  it("can qualify a complete newer session even when the oldest sampled session is partial", () => {
    logAt(now - 100 * minute, "create_concept", true);
    for (let count = 0; count < 200; count++) logAt(now - 95 * minute, "get_concept");
    logAt(now - 31 * minute);
    logAt(now, "get_concept");
    expect(hints().record).toContain(previousSentence);
    expect(hints().previous_session).toEqual(previous());
  });

  it("accepts exactly 200 rows when no earlier history is hidden", () => {
    for (let count = 0; count < 200; count++) logAt(now - 31 * minute);
    expect(hints().record).toContain(previousSentence);
    expect(hints().previous_session).toEqual(previous());
  });

  it("is scoped to the database and requires a successful understand in the previous session", () => {
    logAt(now - 31 * minute);
    expect(hints().record).toContain(previousSentence);
    const other = fixture.db("other.db");
    logAt(now - 31 * minute, "get_concept", false, other);
    expect(buildNextHints({ db: other, cards: [], now: new Date(now) }).previous_session).toEqual(previous(false));
    db.execSqlRun("UPDATE timeline SET is_error = 1");
    expect(hints().record).toBe(RECORD_FACT);
    expect(hints().previous_session).toEqual(previous(false));
  });

  it("does not infer session boundaries from malformed or nonmonotonic timestamps", () => {
    logAt(now - 31 * minute);
    logAt(now - 60 * minute, "get_concept");
    expect(hints()).not.toHaveProperty("previous_session");
    db.execSqlRun("UPDATE timeline SET timestamp = 'invalid' WHERE tool = 'get_concept'");
    expect(hints()).not.toHaveProperty("previous_session");
  });

  it("keeps both complete recording hints at a constrained wire budget", async () => {
    logAt(now - 31 * minute);
    for (let count = 0; count < 2; count++) {
      logger.log({ tool: "get_concept", params: {}, result_summary: "read", is_write: false, is_error: false, affected_ids: [] });
      // SQLite's datetime('now') is not controlled by Vitest's Date clock.
      db.execSqlRun("UPDATE timeline SET timestamp = ? WHERE seq = (SELECT MAX(seq) FROM timeline)", timelineTsString(now));
    }
    const out = await understand(db, { query: "Activity", max_tokens: 1000 });
    expect(out.next!.record).toBe(`${RECORD_FACT} С последней записи 2 чтений — если это законченный вывод, запиши его. ${previousSentence}`);
    expect(out.next!.previous_session).toEqual(previous());
    expect(out.next!.unrecorded).toEqual({ reads_since_write: 2, last_write_at: null });
    expect(out.meta!.tokens_estimated).toBeLessThanOrEqual(1000);
    expect(out.meta!.tokens_estimated).toBe(measureMcpPayload(out));
  });

  it("uses the immediately previous session instead of an older read-only session", () => {
    logAt(now - 100 * minute);
    logAt(now - 31 * minute, "create_concept", true);
    expect(hints().record).toBe(RECORD_FACT);
    expect(hints().previous_session).toEqual(previous(false, true));
  });

  it("preserves the full cross-session sentence in compact, brief and full payloads", async () => {
    logAt(now - 31 * minute);
    for (const mode of ["compact", "brief", "full"] as const) {
      const out = await understand(db, { query: "Activity", mode, max_tokens: 2500 });
      expect(out.next!.record).toBe(`${RECORD_FACT} ${previousSentence}`);
      expect(out.next!.previous_session).toEqual(previous());
      expect(out.meta!.tokens_estimated).toBe(measureMcpPayload(out));
    }
  });
});
