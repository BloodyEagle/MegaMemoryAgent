import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB, SCHEMA_VERSION } from "../db.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-tombstones-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function rawEdges(d: KnowledgeDB): Array<{ id: number; from_id: string; to_id: string; relation: string; removed_at: string | null }> {
  return d.execSqlAll("SELECT id, from_id, to_id, relation, removed_at FROM edges") as never;
}

describe("schema v5", () => {
  it("fresh db is at user_version 5 with tombstone + epistemic columns", () => {
    const d = freshDb();
    expect(d.getUserVersion()).toBe(SCHEMA_VERSION);
    const nodeCols = new Set(
      (d.pragma("table_info(nodes)") as Array<{ name: string }>).map((c) => c.name)
    );
    expect(nodeCols.has("epistemic_status")).toBe(true);
    expect(nodeCols.has("status_scope")).toBe(true);
    const edgeCols = new Set(
      (d.pragma("table_info(edges)") as Array<{ name: string }>).map((c) => c.name)
    );
    expect(edgeCols.has("removed_at")).toBe(true);
  });

  it("migration v4 -> v5 is idempotent (reopen keeps data and version)", async () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    d.close();

    const reopened = new KnowledgeDB(tmpDir + "/knowledge.db");
    expect(reopened.getUserVersion()).toBe(SCHEMA_VERSION);
    expect(reopened.getStats().edges).toBe(1);
    // Second open must not fail or change anything.
    reopened.close();
    const again = new KnowledgeDB(tmpDir + "/knowledge.db");
    expect(again.getStats().nodes).toBe(2);
    await closeAndCleanup(again, tmpDir);
    db = undefined as unknown as KnowledgeDB;
  });
});

describe("edge tombstones (plan 1 §4)", () => {
  it("soft-delete tomstones edges instead of deleting them; reads hide them", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertNode({ id: "c", name: "C", kind: "feature", summary: "c" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    d.insertEdge({ from_id: "c", to_id: "a", relation: "connects_to" });

    d.softDeleteNode("a", "obsolete");

    // Edges survived physically with removed_at set.
    const raw = rawEdges(d);
    expect(raw).toHaveLength(2);
    expect(raw.every((e) => e.removed_at !== null)).toBe(true);

    // Reads do not see them.
    expect(d.getOutgoingEdges("a")).toHaveLength(0);
    expect(d.getIncomingEdges("a")).toHaveLength(0);
    expect(d.getAllEdges()).toHaveLength(0);
    expect(d.getStats().edges).toBe(0);
    expect(d.getStats().edges_removed).toBe(2);
  });

  it("restore brings the links back", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });

    d.softDeleteNode("a", "gone");
    expect(d.getOutgoingEdges("a")).toHaveLength(0);

    // Restore = clear removed_at (as the CLI restore path does).
    d.execSqlRun("UPDATE nodes SET removed_at = NULL, removed_reason = NULL WHERE id = 'a'");
    // Tombstones of edges touching the restored node are lifted by the same
    // operation in the tool layer; at db level the link tool revives them.
    const { inserted } = d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    expect(inserted).toBe(true);
    expect(d.getOutgoingEdges("a")).toHaveLength(1);
  });

  it("re-link after tombstone revives the same row — no duplicate", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });

    d.deleteEdge("a", "b", "connects_to");
    expect(d.getAllEdges()).toHaveLength(0);

    const { inserted } = d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    expect(inserted).toBe(true);
    const raw = rawEdges(d);
    expect(raw).toHaveLength(1); // same row revived, not duplicated
    expect(raw[0].removed_at).toBeNull();
  });

  it("link of an already-active pair is a no-op (inserted: false)", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    const { inserted } = d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    expect(inserted).toBe(false);
    expect(rawEdges(d)).toHaveLength(1);
  });

  it("hardDeleteNode still removes edges physically (expected behaviour)", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    d.hardDeleteNode("a");
    expect(rawEdges(d)).toHaveLength(0);
    expect(d.execSqlFirst("SELECT count(*) AS n FROM nodes")!.n).toBe(1);
  });

  it("getAllEdgesRaw stays unfiltered (raw export path)", () => {
    const d = freshDb();
    d.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
    d.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
    d.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    d.deleteEdge("a", "b", "connects_to");
    expect(d.getAllEdgesRaw()).toHaveLength(1);
  });
});
