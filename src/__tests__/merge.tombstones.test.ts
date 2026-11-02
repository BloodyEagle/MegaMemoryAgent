import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeDB } from "../db.js";
import { MergeEngine } from "../merge.js";
import fs from "fs";
import path from "path";
import os from "os";
import { cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
let engine: MergeEngine;

function createTmpDb(name: string): { db: KnowledgeDB; path: string } {
  const dbPath = path.join(tmpDir, name);
  const db = new KnowledgeDB(dbPath);
  return { db, path: dbPath };
}

function insertTestNode(db: KnowledgeDB, id: string): void {
  db.insertNode({ id, name: id, kind: "feature", summary: `Summary for ${id}` });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-merge-tombstones-"));
  engine = new MergeEngine();
});

afterEach(async () => {
  await cleanupDir(tmpDir);
});

describe("merge preserves edge tombstones (plan 1 §4.6)", () => {
  it("merge carries removed_at over — it does not revive tombstones", () => {
    const left = createTmpDb("left.db");
    const right = createTmpDb("right.db");
    const outputPath = path.join(tmpDir, "output.db");

    insertTestNode(left.db, "node-a");
    insertTestNode(left.db, "node-b");
    insertTestNode(left.db, "left-only");
    insertTestNode(right.db, "node-a");
    insertTestNode(right.db, "node-b");
    insertTestNode(right.db, "right-only");

    // Left side has a tombstoned edge a->b (unlinked before the merge).
    left.db.insertEdge({ from_id: "node-a", to_id: "node-b", relation: "connects_to" });
    left.db.deleteEdge("node-a", "node-b", "connects_to");
    // And a tombstoned edge on the left-only node.
    left.db.insertEdge({ from_id: "left-only", to_id: "node-a", relation: "depends_on" });
    left.db.deleteEdge("left-only", "node-a", "depends_on");
    left.db.close();
    right.db.close();

    const result = engine.merge(left.path, right.path, outputPath);
    expect(result.clean).toBe(4);

    const output = new KnowledgeDB(outputPath);
    const raw = output.execSqlAll(
      "SELECT from_id, to_id, relation, removed_at FROM edges ORDER BY from_id"
    ) as Array<{ from_id: string; to_id: string; relation: string; removed_at: string | null }>;

    // All tombstoned edges arrived as tombstones...
    const tombstoned = raw.filter((e) => e.removed_at !== null);
    expect(tombstoned.length).toBe(2);
    expect(tombstoned.some((e) => e.from_id === "node-a" && e.to_id === "node-b")).toBe(true);
    expect(tombstoned.some((e) => e.from_id === "left-only")).toBe(true);

    // ...and the reads do not treat them as live links.
    expect(output.getOutgoingEdges("node-a")).toHaveLength(0);
    expect(output.getStats().edges).toBe(0);
    expect(output.getStats().edges_removed).toBe(2);
    output.close();
  });
});
