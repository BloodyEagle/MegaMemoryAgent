import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { MergeEngine, edgeKey, edgeSetsAreIdentical } from "../merge.js";
import { link } from "../tools.js";

let tmpDir: string;

function dbPath(name: string): string {
  return path.join(tmpDir, name);
}

function open(name: string): KnowledgeDB {
  return new KnowledgeDB(dbPath(name));
}

// Every test closes its own dbs; temp dirs are the OS's to clean (see
// provenance.trace.test.ts for why removal is not attempted here).
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-provenance-merge-"));
});

describe("merge: needs_merge, tombstone precedence, epistemic conflicts (26-29)", () => {
  it("26. a -> b in one base and b -> a in the other: merge does not throw, both edges need_merge", () => {
    const left = open("left.db");
    left.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    left.insertNode({ id: "b", name: "B", kind: "decision", summary: "b" });
    left.insertEdge({ from_id: "a", to_id: "b", relation: "informed_by", description: "why a" });
    left.close();

    const right = open("right.db");
    right.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    right.insertNode({ id: "b", name: "B", kind: "decision", summary: "b" });
    right.insertEdge({ from_id: "b", to_id: "a", relation: "informed_by", description: "why b" });
    right.close();

    const result = new MergeEngine().merge(dbPath("left.db"), dbPath("right.db"), dbPath("out.db"));
    expect(result.informedByCycles).toBeTruthy();
    expect(result.informedByCycles![0].sort()).toEqual(["a", "b"]);

    const out = open("out.db");
    const flagged = out.execSqlAll(
      "SELECT from_id, to_id FROM edges WHERE relation = 'informed_by' AND removed_at IS NULL AND needs_merge = 1 ORDER BY from_id"
    ) as Array<{ from_id: string; to_id: string }>;
    expect(flagged).toEqual([
      { from_id: "a", to_id: "b" },
      { from_id: "b", to_id: "a" },
    ]);
    out.close();
  });

  it("27. F18: into the unresolved component is rejected, out of it passes", () => {
    const left = open("left.db");
    left.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    left.insertNode({ id: "b", name: "B", kind: "decision", summary: "b" });
    left.insertEdge({ from_id: "a", to_id: "b", relation: "informed_by", description: "why a" });
    left.close();

    const right = open("right.db");
    right.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
    right.insertNode({ id: "b", name: "B", kind: "decision", summary: "b" });
    right.insertEdge({ from_id: "b", to_id: "a", relation: "informed_by", description: "why b" });
    right.close();

    new MergeEngine().merge(dbPath("left.db"), dbPath("right.db"), dbPath("out.db"));

    const out = open("out.db");
    out.insertNode({ id: "new", name: "New", kind: "config", summary: "new" });
    // Incoming into the unresolved component: still refused (invariant 16).
    expect(() =>
      link(out, { from: "new", to: "a", relation: "informed_by", description: "into it" })
    ).toThrow(/needs_merge/);
    // Outgoing from the component: closes no cycle — must pass (F18).
    const res = link(out, {
      from: "b",
      to: "new",
      relation: "informed_by",
      description: "out of it",
    });
    expect(res.message).toContain("Created");
    const live = out.execSqlAll(
      "SELECT 1 FROM edges WHERE from_id = 'b' AND to_id = 'new' AND removed_at IS NULL"
    );
    expect(live).toHaveLength(1);
    out.close();
  });

  it("28. F20: the tombstone wins over the live copy — in either arrangement", () => {
    const build = (
      leftRemoved: boolean,
      tag: string
    ): void => {
      const left = open(`${tag}-left.db`);
      left.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
      left.insertNode({ id: "b", name: "B", kind: "config", summary: "b" });
      left.insertEdge({ from_id: "a", to_id: "b", relation: "informed_by", description: "shared why" });
      if (leftRemoved) {
        left.execSqlRun(
          "UPDATE edges SET removed_at = datetime('now') WHERE from_id = 'a' AND to_id = 'b'"
        );
      }
      left.close();

      const right = open(`${tag}-right.db`);
      right.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
      right.insertNode({ id: "b", name: "B", kind: "config", summary: "b" });
      right.insertEdge({ from_id: "a", to_id: "b", relation: "informed_by", description: "shared why" });
      if (!leftRemoved) {
        right.execSqlRun(
          "UPDATE edges SET removed_at = datetime('now') WHERE from_id = 'a' AND to_id = 'b'"
        );
      }
      right.close();

      new MergeEngine().merge(
        dbPath(`${tag}-left.db`),
        dbPath(`${tag}-right.db`),
        dbPath(`${tag}-out.db`)
      );

      const out = open(`${tag}-out.db`);
      const rows = out.execSqlAll(
        "SELECT removed_at FROM edges WHERE from_id = 'a' AND to_id = 'b' AND relation = 'informed_by'"
      ) as Array<{ removed_at: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].removed_at).not.toBeNull(); // the link did not resurrect
      out.close();
    };

    build(true, "tomb-left");
    build(false, "tomb-right");
  });

  it("29. divergent epistemic_status is a conflict, not a silent merge", () => {
    const left = open("left.db");
    left.insertNode({
      id: "a",
      name: "A",
      kind: "decision",
      summary: "a",
      epistemic_status: "open",
    });
    left.close();

    const right = open("right.db");
    right.insertNode({
      id: "a",
      name: "A",
      kind: "decision",
      summary: "a",
      epistemic_status: "validated",
    });
    right.close();

    const result = new MergeEngine().merge(dbPath("left.db"), dbPath("right.db"), dbPath("out.db"));
    expect(result.conceptConflicts).toBe(1);
    expect(result.mergeGroups).toHaveLength(1);

    const out = open("out.db");
    const variants = out
      .getAllNodesRaw()
      .filter((n) => n.id.startsWith("a"))
      .map((n) => `${n.id}:${n.epistemic_status}`)
      .sort();
    expect(variants).toEqual(["a::left:open", "a::right:validated"]);
    out.close();
  });
});

describe("edge keys with pipe-bearing ids (30, F11)", () => {
  it("edgeKey does not collide for ('a|b','c') and ('a','b|c')", () => {
    const mk = (from: string, to: string) =>
      ({
        from_id: from,
        to_id: to,
        relation: "informed_by",
        description: "why",
      }) as Parameters<typeof edgeKey>[0];
    expect(edgeKey(mk("a|b", "c"))).not.toBe(edgeKey(mk("a", "b|c")));
    expect(edgeKey(mk("a", "b"))).toBe(edgeKey(mk("a", "b")));
  });

  it("edgeSetsAreIdentical distinguishes pipe-bearing pairs", () => {
    const mk = (from: string, to: string) =>
      ({
        from_id: from,
        to_id: to,
        relation: "informed_by",
        description: "why",
      }) as Parameters<typeof edgeKey>[0];
    expect(edgeSetsAreIdentical([mk("a|b", "c")], [mk("a", "b|c")])).toBe(false);
    expect(edgeSetsAreIdentical([mk("a", "b")], [mk("a", "b")])).toBe(true);
  });
});
