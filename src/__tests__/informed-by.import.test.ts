import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import { MergeEngine } from "../merge.js";
import { cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;

function dbPath(name: string): string {
  return path.join(tmpDir, name);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-informed-by-import-"));
});

afterEach(async () => {
  await cleanupDir(tmpDir);
});

/**
 * Plan 4 §5 (import): the only "file" ingestion path is the merge of two
 * knowledge.db files, so these tests drive MergeEngine. A "forward reference"
 * is an informed_by row whose target node is not in the same file — it must
 * resolve against the other side. A one-row cycle (self-loop) rejects the
 * whole file before anything is written.
 */
describe("informed_by file import via merge (plan 4 §5)", () => {
  it("a file with a forward reference passes: the edge resolves against the other side", () => {
    // Left file: node "a" plus a live informed_by a→b whose target b is not
    // in this file (hand-crafted through the raw path — the same way a
    // backup/legacy file can carry a row the local graph does not resolve).
    const left = new KnowledgeDB(dbPath("left.db"));
    left.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    left.close();
    const rawLeft = new Database(dbPath("left.db"));
    rawLeft.pragma("foreign_keys = OFF");
    rawLeft
      .prepare(
        "INSERT INTO edges (from_id, to_id, relation, description) VALUES ('a', 'b', 'informed_by', 'forward reference')"
      )
      .run();
    rawLeft.close();

    // Right file: the missing target.
    const right = new KnowledgeDB(dbPath("right.db"));
    right.insertNode({ id: "b", name: "B", kind: "config", summary: "b" });
    right.close();

    const engine = new MergeEngine();
    const result = engine.merge(dbPath("left.db"), dbPath("right.db"), dbPath("out.db"));

    expect(result.clean).toBe(2);
    const out = new KnowledgeDB(dbPath("out.db"));
    const rows = out.execSqlAll(
      "SELECT from_id, to_id, removed_at FROM edges WHERE relation = 'informed_by'"
    ) as Array<{ from_id: string; to_id: string; removed_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_id: "a", to_id: "b", removed_at: null });
    out.close();
  });

  it("a file with a one-row cycle is rejected entirely — no half-written output", () => {
    const bad = new KnowledgeDB(dbPath("bad.db"));
    bad.insertNode({ id: "u", name: "U", kind: "decision", summary: "u" });
    // Live self-loop through the raw path (the validated path refuses it).
    bad.insertEdgeRaw({
      from_id: "u",
      to_id: "u",
      relation: "informed_by",
      description: "self-loop",
    });
    bad.close();

    const right = new KnowledgeDB(dbPath("right.db"));
    right.insertNode({ id: "b", name: "B", kind: "config", summary: "b" });
    right.close();

    const engine = new MergeEngine();
    expect(() =>
      engine.merge(dbPath("bad.db"), dbPath("right.db"), dbPath("out2.db"))
    ).toThrow(/self-loop/);

    // No partial rows: the output carries no nodes and no edges.
    const out = new KnowledgeDB(dbPath("out2.db"));
    const stats = out.getStats();
    expect(stats.nodes).toBe(0);
    expect(stats.edges).toBe(0);
    out.close();
  });

  it("a tombstoned self-loop is history, not a violation — the file passes", () => {
    const hist = new KnowledgeDB(dbPath("hist.db"));
    hist.insertNode({ id: "u", name: "U", kind: "decision", summary: "u" });
    hist.insertEdgeRaw({
      from_id: "u",
      to_id: "u",
      relation: "informed_by",
      description: "old mistake",
      removed_at: "2026-01-01 00:00:00",
    });
    hist.close();

    const right = new KnowledgeDB(dbPath("right.db"));
    right.insertNode({ id: "b", name: "B", kind: "config", summary: "b" });
    right.close();

    const engine = new MergeEngine();
    expect(() =>
      engine.merge(dbPath("hist.db"), dbPath("right.db"), dbPath("out3.db"))
    ).not.toThrow();

    const out = new KnowledgeDB(dbPath("out3.db"));
    const rows = out.execSqlAll(
      "SELECT removed_at FROM edges WHERE relation = 'informed_by'"
    ) as Array<{ removed_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].removed_at).not.toBeNull();
    out.close();
  });
});
