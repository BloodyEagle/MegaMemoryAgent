import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { healthReport } from "../doctor.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-health-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("healthReport (U3)", () => {
  it("reports clean counters on a healthy fixture", () => {
    const db = freshDb();
    db.insertNode({ id: "a", name: "A", kind: "feature", summary: "x" });
    db.insertNode({ id: "b", name: "B", kind: "feature", summary: "y" });

    const h = healthReport(db);
    expect(h.nodes).toBe(2);
    expect(h.vectors).toEqual({ have: 0, total: 2 });
    expect(h.fts.in_sync).toBe(true);
    expect(h.empty_ids).toBe(0);
    expect(h.orphan_edges).toBe(0);
    expect(h.digests.count).toBe(0);
    expect(typeof h.model_loaded).toBe("boolean");
    expect(h.rss_mb).toBeGreaterThan(0);
  });

  it("detects a node without embedding and orphan edges", () => {
    const db = freshDb();
    db.insertNode({ id: "a", name: "A", kind: "feature", summary: "x" });
    db.insertNode({ id: "b", name: "B", kind: "feature", summary: "y" });
    // Orphan edge via a raw node delete (FK cascade would remove the edge).
    db.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    db.execSqlRun("PRAGMA foreign_keys = OFF");
    db.execSqlRun("DELETE FROM nodes WHERE id = 'b'");
    db.execSqlRun("PRAGMA foreign_keys = ON");

    const h = healthReport(db);
    expect(h.nodes).toBe(1);
    expect(h.vectors).toEqual({ have: 0, total: 1 });
    expect(h.orphan_edges).toBe(1);
  });

  it("counts digests and flags stale ones (child newer than digest)", () => {
    const db = freshDb();
    db.insertNode({ id: "m", name: "Module", kind: "module", summary: "m" });
    db.insertNode({
      id: "m/digest",
      name: "Digest",
      kind: "digest",
      summary: "s",
      parent_id: "m",
    });
    db.insertNode({
      id: "m/child",
      name: "Child",
      kind: "feature",
      summary: "c",
      parent_id: "m",
    });

    let h = healthReport(db);
    expect(h.digests).toEqual({ count: 1, stale: 0 });

    // Touch the child so it becomes newer than the digest.
    db.execSqlRun(
      "UPDATE nodes SET updated_at = datetime('now', '+1 hour') WHERE id = 'm/child'"
    );
    h = healthReport(db);
    expect(h.digests.stale).toBe(1);
  });

  it("reports empty ids for legacy broken rows", () => {
    const db = freshDb();
    db.execSqlRun(
      "INSERT INTO nodes (id, name, kind, summary) VALUES ('', 'Broken', 'feature', 'x')"
    );
    const h = healthReport(db);
    expect(h.empty_ids).toBe(1);
  });
});
