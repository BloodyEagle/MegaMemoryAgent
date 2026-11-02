import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { link, getConcept } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-informed-by-cycle-safe-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  // A pre-existing cycle (e.g. brought in by a merge), hand-crafted through
  // the raw path — the validated path refuses to build one. The downstream
  // edge also goes through the raw path: since plan 3 (invariant 16) the
  // validated path rejects ANY write touching a cyclic component.
  db.insertNode({ id: "c1", name: "C1", kind: "decision", summary: "c1" });
  db.insertNode({ id: "c2", name: "C2", kind: "config", summary: "c2" });
  db.insertNode({ id: "m", name: "M", kind: "pattern", summary: "m" });
  db.insertNode({ id: "z", name: "Z", kind: "pattern", summary: "z" });
  db.insertEdgeRaw({ from_id: "c1", to_id: "c2", relation: "informed_by", description: "1" });
  db.insertEdgeRaw({ from_id: "c2", to_id: "c1", relation: "informed_by", description: "2" });
  db.insertEdgeRaw({
    from_id: "c2",
    to_id: "m",
    relation: "informed_by",
    description: "out of the component",
  });
});

afterEach(async () => {
  await closeAndCleanup(db, tmpDir);
});

/**
 * Plan 4 §5: the acyclicity walk on a graph that already contains a cycle
 * must not hang any new write — visited set, no unbounded recursion.
 * Plan 3 §2 (invariant 16) tightens the contract: a component that kept its
 * cycle after needs_merge is closed for NEW informed_by until resolved.
 */
describe("cycle-safe traversal on a graph with a pre-existing cycle (plan 4 §5, plan 3 §2)", () => {
  it("a write whose reachability walk enters the cyclic component terminates and rejects", () => {
    // c1 → c2 → {c1, m}: the walk from c1 finds m only if the cycle is
    // handled; without a visited set this line would hang.
    expect(() =>
      link(db, { from: "m", to: "c1", relation: "informed_by", description: "closes through the cycle" })
    ).toThrow(/cycle/);
  });

  it("a write into the cyclic component is rejected until the conflict is resolved (plan 3, invariant 16)", () => {
    // z→c1 closes no cycle, but c1 sits in an unresolved cyclic component —
    // the write is refused instead of papering over the needs_merge zone.
    expect(() =>
      link(db, { from: "z", to: "c1", relation: "informed_by", description: "into the component" })
    ).toThrow(/needs_merge/);
    // Writes that touch nothing cyclic keep working.
    const result = link(db, { from: "z", to: "m", relation: "informed_by", description: "outside the component" });
    expect(result.message).toContain("Created");
  });

  it("reading a cyclic graph does not hang: node card and fingerprint", () => {
    const card = getConcept(db, { id: "c1" });
    expect(card.informed_by).toEqual([
      { to: "c2", to_name: "C2", rationale: "1" },
    ]);
    expect(card.informed_by_incoming).toEqual([
      { from: "c2", from_name: "C2", rationale: "2" },
    ]);
    expect(db.nodeFingerprint("c1")).toBeTruthy();
  });
});
