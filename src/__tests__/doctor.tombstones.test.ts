import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { runDoctor } from "../doctor.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-doctor-tomb-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function check(res: { checks: Array<{ name: string; ok: boolean; detail: string }> }, name: string) {
  const c = res.checks.find((x) => x.name === name);
  expect(c, `check "${name}" missing`).toBeDefined();
  return c!;
}

describe("doctor: plan 1 checks", () => {
  it("user_version matches SCHEMA_VERSION on a healthy db", () => {
    const d = freshDb();
    const res = runDoctor(d);
    expect(check(res, "user_version").ok).toBe(true);
    expect(check(res, "user_version").detail).toContain("matches");
  });

  it("detects live edges at removed nodes (removal desync)", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    // Simulate desync: node removed without tombstoning (pre-plan-1 state).
    d.execSqlRun("UPDATE nodes SET removed_at = datetime('now') WHERE id = 'a'");
    const res = runDoctor(d);
    expect(check(res, "edge/node removal sync").ok).toBe(false);
  });

  it("reports tombstones and flags tombstones between live nodes", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    d.deleteEdge("a", "b", "connects_to");
    const res = runDoctor(d);
    const c = check(res, "edge tombstones");
    expect(c.ok).toBe(true); // informational
    expect(c.detail).toContain("1 tombstoned");
    expect(c.detail).toContain("between live nodes");
  });

  it("flags validated nodes without status_scope.artifact", () => {
    const d = freshDb();
    d.insertNode({ id: "v", name: "V", kind: "decision", summary: "x" });
    d.execSqlRun("UPDATE nodes SET epistemic_status = 'validated' WHERE id = 'v'");
    let res = runDoctor(d);
    expect(check(res, "validated scope").ok).toBe(false);
    expect(check(res, "validated scope").detail).toContain("without status_scope.artifact");

    d.execSqlRun(
      `UPDATE nodes SET status_scope = '{"env":"ci","artifact":"run-9"}' WHERE id = 'v'`
    );
    res = runDoctor(d);
    expect(check(res, "validated scope").ok).toBe(true);
  });

  it("reports the two status axes separately", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "decision", summary: "x" });
    d.execSqlRun("UPDATE nodes SET epistemic_status = 'refuted' WHERE id = 'a'");
    const res = runDoctor(d);
    const c = check(res, "status axes");
    expect(c.detail).toContain("epistemic: refuted=1");
    expect(c.detail).toContain("lifecycle:");
  });

  it("flags epistemic transitions without a reason", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "decision", summary: "x" });
    // status_history is created lazily — a lifecycle write materializes it.
    d.setNodeStatus("a", "deprecated", undefined, "test setup");
    d.execSqlRun(
      `INSERT INTO status_history (node_id, from_status, to_status, reason, field)
       VALUES ('a', 'open', 'refuted', NULL, 'epistemic_status')`
    );
    const res = runDoctor(d);
    expect(check(res, "epistemic history").ok).toBe(false);
  });
});
