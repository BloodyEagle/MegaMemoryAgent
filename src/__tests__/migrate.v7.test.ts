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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migrate-v7-"));
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

describe("migration v6 -> v7 (plan 4)", () => {
  it("a v6 database is upgraded on open: composite edge indexes, user_version = 7", async () => {
    const dbPath = freshDbPath();
    // Simulate a v6 database: build with the current code, then stamp it back.
    const v6 = new KnowledgeDB(dbPath);
    v6.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    v6.insertNode({ id: "b", name: "B", kind: "config", summary: "b" });
    v6.insertEdge({
      from_id: "a",
      to_id: "b",
      relation: "depends_on",
      description: "seed row",
    });
    v6.close();
    const forceV6 = new Database(dbPath);
    forceV6.pragma("user_version = 6");
    forceV6.close();

    const reopened = new KnowledgeDB(dbPath);
    openDb = reopened;
    expect(reopened.getUserVersion()).toBe(SCHEMA_VERSION);
    // v7 added the composite edge indexes; later versions build on top.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    const idx = (reopened.execSqlAll(
      "SELECT name FROM sqlite_master WHERE type='index' AND (name = 'idx_edges_relation_from' OR name = 'idx_edges_relation_to')"
    ) as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain("idx_edges_relation_from");
    expect(idx).toContain("idx_edges_relation_to");
    // Existing data survives.
    expect(reopened.getStats().nodes).toBe(2);
    expect(reopened.getStats().edges).toBe(1);
  });

  it("the migration is idempotent: reopen changes nothing", async () => {
    const dbPath = freshDbPath();
    const first = new KnowledgeDB(dbPath);
    first.insertNode({ id: "t1", name: "T", kind: "decision", summary: "s" });
    first.insertEdge({
      from_id: "t1",
      to_id: "t1",
      relation: "depends_on",
      description: "seed row",
    });
    first.close();

    const second = new KnowledgeDB(dbPath);
    expect(second.getUserVersion()).toBe(SCHEMA_VERSION);
    second.close();

    const third = new KnowledgeDB(dbPath);
    openDb = third;
    expect(third.getUserVersion()).toBe(SCHEMA_VERSION);
    expect(third.getStats().nodes).toBe(1);
    const idxCount = (
      third.execSqlAll(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('idx_edges_relation_from','idx_edges_relation_to')"
      ) as Array<{ n: number }>
    )[0].n;
    expect(idxCount).toBe(2);
  });

  it("a fresh database has the composite indexes too (parity with migrated dbs)", () => {
    const db = new KnowledgeDB(freshDbPath());
    openDb = db;
    expect(db.getUserVersion()).toBe(SCHEMA_VERSION);
    const idx = (db.execSqlAll(
      "SELECT name FROM sqlite_master WHERE type='index' AND (name = 'idx_edges_relation_from' OR name = 'idx_edges_relation_to')"
    ) as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain("idx_edges_relation_from");
    expect(idx).toContain("idx_edges_relation_to");
  });

  it("meta.schema_version (the legacy-conversion marker) is not touched by v6→v7", async () => {
    const dbPath = freshDbPath();
    const seed = new KnowledgeDB(dbPath);
    seed.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    seed.setMetaValue("schema_version", "3");
    seed.close();
    const forceV6 = new Database(dbPath);
    forceV6.pragma("user_version = 6");
    forceV6.close();

    const reopened = new KnowledgeDB(dbPath);
    openDb = reopened;
    expect(reopened.getUserVersion()).toBe(SCHEMA_VERSION);
    expect(reopened.getMetaValue("schema_version")).toBe("3");
  });
});
