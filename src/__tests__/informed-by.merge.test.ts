import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { MergeEngine } from "../merge.js";
import { closeAndCleanup, cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
let openDb: KnowledgeDB | undefined;

function dbPath(name: string): string {
  return path.join(tmpDir, name);
}

function liveInformedBy(db: KnowledgeDB): Array<{ from_id: string; to_id: string }> {
  return db.execSqlAll(
    "SELECT from_id, to_id FROM edges WHERE relation = 'informed_by' AND removed_at IS NULL"
  ) as Array<{ from_id: string; to_id: string }>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-informed-by-merge-"));
});

afterEach(async () => {
  if (openDb) {
    await closeAndCleanup(openDb, tmpDir);
    openDb = undefined;
    return;
  }
  await cleanupDir(tmpDir);
});

/**
 * Plan 4 §5 (merge): after a merge there is no u == v and no live informed_by
 * edge onto a tombstoned node — caught, not silently alive. Tombstoned rows
 * travel verbatim (history preservation, plan 1 §4.6).
 */
describe("informed_by merge hygiene (plan 4 §5)", () => {
  it("after a merge there are no live informed_by edges onto a tombstoned node", () => {
    const left = new KnowledgeDB(dbPath("left.db"));
    left.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    left.insertNode({ id: "t", name: "T", kind: "config", summary: "t" });
    left.insertNode({ id: "k", name: "K", kind: "pattern", summary: "k" });
    left.softDeleteNode("t", "obsolete");
    // Live edge onto the tombstone, hand-crafted after the soft delete (the
    // validated path refuses it; a legacy/backup file can still carry one).
    left.insertEdgeRaw({
      from_id: "a",
      to_id: "t",
      relation: "informed_by",
      description: "onto a grave",
    });
    // Live edge between live nodes — must survive the merge.
    left.insertEdge({
      from_id: "a",
      to_id: "k",
      relation: "informed_by",
      description: "legitimate",
    });
    left.close();

    const right = new KnowledgeDB(dbPath("right.db"));
    right.close();

    new MergeEngine().merge(dbPath("left.db"), dbPath("right.db"), dbPath("out.db"));

    const out = new KnowledgeDB(dbPath("out.db"));
    openDb = out;
    const live = liveInformedBy(out);
    expect(live).toEqual([{ from_id: "a", to_id: "k" }]);
    // Generic post-condition: no live edge onto any tombstoned node.
    const ontoGraves = out.execSqlAll(
      `SELECT e.from_id, e.to_id FROM edges e
       JOIN nodes n ON n.id = e.to_id
       WHERE e.relation = 'informed_by' AND e.removed_at IS NULL AND n.removed_at IS NOT NULL`
    ) as unknown[];
    expect(ontoGraves).toEqual([]);
  });

  it("after a merge there is no active u == v; a tombstoned self-loop stays history", () => {
    const left = new KnowledgeDB(dbPath("left.db"));
    left.insertNode({ id: "u", name: "U", kind: "decision", summary: "u" });
    left.insertEdgeRaw({
      from_id: "u",
      to_id: "u",
      relation: "informed_by",
      description: "old mistake",
      removed_at: "2026-01-01 00:00:00",
    });
    left.close();

    const right = new KnowledgeDB(dbPath("right.db"));
    right.close();

    new MergeEngine().merge(dbPath("left.db"), dbPath("right.db"), dbPath("out.db"));

    const out = new KnowledgeDB(dbPath("out.db"));
    openDb = out;
    // Generic post-condition: no ACTIVE self-loop in the informed_by layer.
    const selfLoops = out.execSqlAll(
      "SELECT from_id FROM edges WHERE relation = 'informed_by' AND removed_at IS NULL AND from_id = to_id"
    ) as unknown[];
    expect(selfLoops).toEqual([]);
    // The tombstoned row is preserved verbatim.
    const rows = out.execSqlAll(
      "SELECT removed_at FROM edges WHERE relation = 'informed_by'"
    ) as Array<{ removed_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].removed_at).not.toBeNull();
  });

  it("live informed_by edges between live nodes round-trip through the merge", () => {
    const left = new KnowledgeDB(dbPath("left.db"));
    left.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    left.insertNode({ id: "b", name: "B", kind: "config", summary: "b" });
    left.insertEdge({
      from_id: "a",
      to_id: "b",
      relation: "informed_by",
      description: "measured",
    });
    left.close();

    const right = new KnowledgeDB(dbPath("right.db"));
    right.insertNode({ id: "c", name: "C", kind: "pattern", summary: "c" });
    right.insertNode({ id: "d", name: "D", kind: "config", summary: "d" });
    right.insertEdge({
      from_id: "c",
      to_id: "d",
      relation: "informed_by",
      description: "also measured",
    });
    right.close();

    new MergeEngine().merge(dbPath("left.db"), dbPath("right.db"), dbPath("out.db"));

    const out = new KnowledgeDB(dbPath("out.db"));
    openDb = out;
    const live = liveInformedBy(out).map((e) => `${e.from_id}->${e.to_id}`).sort();
    expect(live).toEqual(["a->b", "c->d"]);
  });
});
