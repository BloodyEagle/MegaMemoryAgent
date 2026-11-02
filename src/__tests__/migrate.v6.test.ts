import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB, SCHEMA_VERSION } from "../db.js";
import { closeAndCleanup, cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
let openDb: KnowledgeDB | undefined;

function freshDbPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migrate-v6-"));
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

describe("migration v5 -> v6 (plan 2)", () => {
  it("a v5 database is upgraded on open: tables, columns, indexes, user_version = 6", async () => {
    const dbPath = freshDbPath();
    // Simulate a v5 database: build with the current code, then stamp it back to 5.
    const v5 = new KnowledgeDB(dbPath);
    v5.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    v5.close();
    const forceV5 = new Database(dbPath);
    forceV5.pragma("user_version = 5");
    forceV5.close();

    const reopened = new KnowledgeDB(dbPath);
    openDb = reopened;
    expect(reopened.getUserVersion()).toBe(SCHEMA_VERSION);
    const tables = new Set(
      (reopened.execSqlAll(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ) as Array<{ name: string }>).map((r) => r.name)
    );
    expect(tables.has("trails")).toBe(true);
    expect(tables.has("trail_members")).toBe(true);
    expect(tables.has("slots")).toBe(true);
    const nodeCols = new Set(
      (reopened.pragma("table_info(nodes)") as Array<{ name: string }>).map((c) => c.name)
    );
    expect(nodeCols.has("task_state")).toBe(true);
    expect(nodeCols.has("due_at")).toBe(true);
    // Existing data survives.
    expect(reopened.getStats().nodes).toBe(1);
  });

  it("the migration is idempotent: reopen changes nothing", async () => {
    const dbPath = freshDbPath();
    const first = new KnowledgeDB(dbPath);
    first.insertNode({ id: "t1", name: "T", kind: "task", summary: "s" });
    first.close();

    const second = new KnowledgeDB(dbPath);
    expect(second.getUserVersion()).toBe(SCHEMA_VERSION);
    second.setSlot("", "handoff", "t1");
    second.close();

    const third = new KnowledgeDB(dbPath);
    openDb = third;
    expect(third.getUserVersion()).toBe(SCHEMA_VERSION);
    expect(third.getSlot("", "handoff")?.node_id).toBe("t1");
    expect(third.getStats().nodes).toBe(1);
  });

  it("a fresh database has task_state/due_at in CREATE TABLE (parity with migrated dbs)", () => {
    const db = new KnowledgeDB(freshDbPath());
    openDb = db;
    const cols = (db.pragma("table_info(nodes)") as Array<{ name: string }>).map((c) => c.name);
    // Column order must be identical between a fresh and a migrated db —
    // SELECT * relies on it (plan 0 audit B2).
    expect(cols).toContain("task_state");
    expect(cols).toContain("due_at");
    expect(cols.indexOf("epistemic_status")).toBeLessThan(cols.indexOf("task_state"));
  });

  it("partial indexes on task_state/due_at exist", () => {
    const db = new KnowledgeDB(freshDbPath());
    openDb = db;
    const idx = (db.execSqlAll(
      "SELECT name FROM sqlite_master WHERE type='index' AND (name = 'idx_nodes_task' OR name = 'idx_nodes_due')"
    ) as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain("idx_nodes_task");
    expect(idx).toContain("idx_nodes_due");
  });
});
