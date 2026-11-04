import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// F5 (2.1.1): the call journal used to grow forever — no DELETE, no age
// cleanup, on the same file the agent carries around. These tests pin the
// retention contract: age rule, count rule, 0 = unlimited, other tables and
// the bounds read untouched, batched deletes that stay fast on a backlog.

let tmpDir: string;
let db: KnowledgeDB;
const envBackup: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in envBackup)) envBackup[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function insert(entry: { ageDays?: number; tool?: string }): void {
  const seq = db.insertTimelineEntry({
    tool: entry.tool ?? "get_concept",
    params: "{}",
    result_summary: "ok",
    is_write: false,
    is_error: false,
    affected_ids: [],
  });
  if (entry.ageDays !== undefined) {
    // datetime('now') stores "YYYY-MM-DD HH:MM:SS" (UTC) — same format
    // SQLite's datetime(…) modifier produces, so the comparison in the
    // prune query sees exactly this value.
    db.execSqlRun(
      "UPDATE timeline SET timestamp = datetime('now', ?) WHERE seq = ?",
      `-${entry.ageDays} days`,
      seq
    );
  }
}

function count(): number {
  return db.getTimelineBounds().count;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-timeline-retention-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

afterEach(async () => {
  db.close();
  for (const [name, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await closeAndCleanup(db, tmpDir);
});

describe("timeline retention (F5, 2.1.1)", () => {
  it("1. entries older than retention_days go, fresh ones stay", () => {
    setEnv("MEGAMEMORY_TIMELINE_RETENTION_DAYS", "30");
    setEnv("MEGAMEMORY_TIMELINE_MAX_ENTRIES", "0");
    insert({ ageDays: 40 });
    insert({ ageDays: 100 });
    insert({ ageDays: 31 });
    insert({ ageDays: 29 });
    insert({ ageDays: 0 });

    const { byAge, byCount } = db.pruneTimeline();
    expect(byAge).toBe(3);
    expect(byCount).toBe(0);
    expect(count()).toBe(2);

    const left = db.getTimelineEntries();
    expect(left.map((e) => e.seq)).toEqual([4, 5]);
  });

  it("2. over max_entries the oldest go until the count returns to the limit", () => {
    setEnv("MEGAMEMORY_TIMELINE_RETENTION_DAYS", "0");
    setEnv("MEGAMEMORY_TIMELINE_MAX_ENTRIES", "10");
    for (let i = 0; i < 35; i++) insert({});

    const { byAge, byCount } = db.pruneTimeline();
    expect(byAge).toBe(0);
    expect(byCount).toBe(25);
    expect(count()).toBe(10);

    // The survivors are the NEWEST rows — seq 26..35.
    expect(db.getTimelineEntries().map((e) => e.seq)).toEqual([
      26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
    ]);
  });

  it("3. 0 in both settings deletes nothing", () => {
    setEnv("MEGAMEMORY_TIMELINE_RETENTION_DAYS", "0");
    setEnv("MEGAMEMORY_TIMELINE_MAX_ENTRIES", "0");
    insert({ ageDays: 400 });
    insert({ ageDays: 200 });
    insert({});

    const { byAge, byCount } = db.pruneTimeline();
    expect(byAge).toBe(0);
    expect(byCount).toBe(0);
    expect(count()).toBe(3);
  });

  it("4. prune touches the timeline only; bounds stay consistent", () => {
    setEnv("MEGAMEMORY_TIMELINE_RETENTION_DAYS", "1");
    setEnv("MEGAMEMORY_TIMELINE_MAX_ENTRIES", "2");

    // Real data next to the journal.
    db.insertNode({ id: "d", name: "D", kind: "decision", summary: "d" });
    db.insertNode({ id: "f", name: "F", kind: "config", summary: "f" });
    db.insertEdgeRaw({ from_id: "d", to_id: "f", relation: "informed_by", description: "why" });
    const auditTableExisted = db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='provenance_audit_runs'"
    );

    insert({ ageDays: 5 });
    insert({ ageDays: 5 });
    insert({ ageDays: 5 });
    insert({});
    insert({});
    insert({});

    const nodesBefore = db.getStats().nodes;
    const edgesBefore = db.getStats().edges;
    const baselinesBefore = countTable("support_baselines");
    const auditBefore = countTable("provenance_audit_runs");

    const { byAge, byCount } = db.pruneTimeline();
    expect(byAge).toBe(3);
    expect(byCount).toBe(1); // 3 left, limit 2 → the oldest goes

    expect(db.getStats().nodes).toBe(nodesBefore);
    expect(db.getStats().edges).toBe(edgesBefore);
    expect(countTable("support_baselines")).toBe(baselinesBefore);
    expect(countTable("provenance_audit_runs")).toBe(auditBefore);
    expect(Boolean(auditTableExisted)).toBe(false);

    // /api/timeline/bounds reads exactly these numbers — after a prune the
    // bounds must describe the surviving rows, not the deleted ones.
    const bounds = db.getTimelineBounds();
    expect(bounds.count).toBe(2);
    expect(bounds.first).not.toBeNull();
    expect(bounds.last).not.toBeNull();
    expect(bounds.first! <= bounds.last!).toBe(true);
  });

  it(
    "5. a 100k backlog clears in batches fast enough to stay interactive",
    () => {
      setEnv("MEGAMEMORY_TIMELINE_RETENTION_DAYS", "30");
      setEnv("MEGAMEMORY_TIMELINE_MAX_ENTRIES", "0");
      // One statement builds the backlog — the fixture must not dominate
      // the timing; what is measured is the batched DELETE walk.
      db.execSqlRun(`
        WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 100000)
        INSERT INTO timeline (tool, params, result_summary, is_write, is_error, affected_ids, timestamp)
        SELECT 'bench', '{}', 'x', 0, 0, '[]', datetime('now', '-200 days') FROM cnt
      `);
      expect(count()).toBe(100_000);

      const t0 = performance.now();
      const { byAge, byCount } = db.pruneTimeline();
      const ms = performance.now() - t0;

      expect(byAge).toBe(100_000);
      expect(byCount).toBe(0);
      expect(count()).toBe(0);
      // 100 batches of 1000: each statement holds the write lock alone. A
      // single giant transaction would be faster in the best case and a
      // lock-out for concurrent readers in the worst — the point is that
      // batched stays within the same order of magnitude anyway.
      expect(ms).toBeLessThan(30_000);
    },
    60_000
  );

  it("6. the write-time prune fires once per interval and honours the settings", () => {
    setEnv("MEGAMEMORY_TIMELINE_RETENTION_DAYS", "30");
    setEnv("MEGAMEMORY_TIMELINE_MAX_ENTRIES", "0");
    // TIMELINE_PRUNE_INTERVAL - 1 writes stay below the throttle: nothing
    // is deleted even though every row is far past the retention.
    for (let i = 0; i < 499; i++) insert({ ageDays: 90 });
    expect(count()).toBe(499);

    // The 500th write triggers the automatic pass — it clears the 499 rows
    // that were old at that moment. (The 500th row itself is backdated by
    // the fixture AFTER the insert returned, i.e. after the prune ran, so it
    // survives until the next interval — the throttle, not per-write
    // re-checking, is exactly what this asserts.)
    insert({ ageDays: 90 });
    expect(count()).toBe(1);

    // Explicitly: the survivor is 90 days past the retention — pruning is
    // throttled by writes, not driven by a clock.
    const left = db.getTimelineEntries();
    expect(left).toHaveLength(1);
    expect(left[0].seq).toBe(500);
  });

  it("7. defaults keep the journal intact on a healthy base", () => {
    // No env overrides: the 90 days / 50k defaults must not remove fresh
    // entries during ordinary writes (the automatic pass fires at the
    // interval and deletes nothing here).
    for (let i = 0; i < 500; i++) insert({});
    expect(count()).toBe(500);
    const { byAge, byCount } = db.pruneTimeline();
    expect(byAge).toBe(0);
    expect(byCount).toBe(0);
  });
});

function countTable(table: string): number {
  const exists = db.execSqlFirst(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    table
  );
  if (!exists) return 0;
  return Number((db.execSqlFirst(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n);
}
