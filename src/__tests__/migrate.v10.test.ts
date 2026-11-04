import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB, SCHEMA_VERSION } from "../db.js";
import { runDoctor } from "../doctor.js";
import { closeAndCleanup, cleanupDir } from "./helpers/cleanup.js";

// plan-4-fixes-7 F2 (2.1.1): schema v10 — idx_edges_live_from_to on
// edges(from_id, relation, removed_at, to_id) backs the keyset walk of the
// live-support pagination. Old dbs must get the same index as fresh ones.

let tmpDir: string;
let openDb: KnowledgeDB | undefined;

function freshDbPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migrate-v10-"));
  return tmpDir + "/knowledge.db";
}

afterEach(async () => {
  if (openDb) {
    await closeAndCleanup(openDb, tmpDir);
    openDb = undefined;
    return;
  }
  await cleanupDir(tmpDir);
});

function buildDb(dbPath: string): void {
  const db = new KnowledgeDB(dbPath);
  db.insertNode({ id: "d", name: "D", kind: "decision", summary: "d" });
  db.insertNode({ id: "x", name: "X", kind: "config", summary: "x" });
  for (let i = 1; i <= 7; i++) {
    db.insertNode({ id: `s${i}`, name: `S${i}`, kind: "config", summary: `s-${i}` });
    db.insertEdgeRaw({
      from_id: "d",
      to_id: `s${i}`,
      relation: "informed_by",
      description: `why s${i}`,
    });
  }
  db.insertEdge({ from_id: "d", to_id: "x", relation: "connects_to" });
  db.close();
}

function doctorProblems(db: KnowledgeDB): Set<string> {
  // The doctor's fork-meta checks (schema_version, embedding model, FTS) fail
  // on any fixture that never ran 'megamemory migrate --apply' — that is the
  // manual migrate path, not the additive schema migration under test. What
  // the v9 -> v10 step must guarantee: it introduces NO problems of its own,
  // so the failing check NAMES stay exactly the same before and after.
  return new Set(runDoctor(db).checks.filter((c) => !c.ok).map((c) => c.name));
}

describe("migration v9 -> v10 (plan-4-fixes-7 F2: live-edge index)", () => {
  it("a v9 database gains idx_edges_live_from_to on open; data untouched, doctor unchanged", async () => {
    const dbPath = freshDbPath();
    buildDb(dbPath);

    // Baseline doctor state of the fixture BEFORE the version strip.
    const beforeStrip = new KnowledgeDB(dbPath);
    const problemsBefore = doctorProblems(beforeStrip);
    beforeStrip.close();

    // Reproduce a genuine v9 file: current column set, no v10 index,
    // user_version stamped back to 9.
    const strip = new Database(dbPath);
    strip.exec("DROP INDEX IF EXISTS idx_edges_live_from_to;");
    strip.pragma("user_version = 9");
    strip.close();

    const reopened = new KnowledgeDB(dbPath);
    openDb = reopened;
    expect(reopened.getUserVersion()).toBe(SCHEMA_VERSION);
    expect(doctorProblems(reopened)).toEqual(problemsBefore);

    const indexes = reopened.execSqlAll(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edges_live_from_to'"
    );
    expect(indexes).toHaveLength(1);

    // The data survived verbatim.
    expect(reopened.getStats().nodes).toBe(9);
    const live = reopened.getInformedByEdges("d", "ancestry", false);
    expect(live).toHaveLength(7);
    expect(live.map((e) => e.to_id)).toEqual(
      ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]
    );
  });

  it("fresh databases carry the same index (fresh/migrated parity)", async () => {
    const dbPath = freshDbPath();
    const db = new KnowledgeDB(dbPath);
    openDb = db;
    expect(db.getUserVersion()).toBe(SCHEMA_VERSION);
    const indexes = db.execSqlAll(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edges_live_from_to'"
    );
    expect(indexes).toHaveLength(1);
  });

  it("the pagination query uses the index, not a scan + temp b-tree", async () => {
    const dbPath = freshDbPath();
    const db = new KnowledgeDB(dbPath);
    openDb = db;
    const plan = db.execSqlAll(
      `EXPLAIN QUERY PLAN
       SELECT e.*, e.to_id AS other_id FROM edges e
       WHERE e.from_id = ? AND e.relation = 'informed_by' AND e.removed_at IS NULL
         AND e.to_id > ?
       ORDER BY e.to_id LIMIT ?`,
      "d",
      "",
      200
    ) as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join("\n");
    expect(details).toContain("idx_edges_live_from_to");
    expect(details).not.toMatch(/SCAN edges/);
    expect(details).not.toMatch(/TEMP B-TREE/i);
  });
});
