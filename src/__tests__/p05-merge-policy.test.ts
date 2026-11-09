import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { MergeEngine } from "../merge.js";
import type { NodeRow } from "../types.js";
import { cleanupDir } from "./helpers/cleanup.js";

// Agreed seam: public MergeEngine.merge and the published KnowledgeDB output.
// All input databases are newly owned TEMP files, never fixtures or live data.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p05-policy-owned-"));
let serial = 0;
afterEach(() => { (globalThis as { gc?: () => void }).gc?.(); });
afterAll(async () => {
  (globalThis as { gc?: () => void }).gc?.();
  await cleanupDir(temp);
});

function node(id = "claim", overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id, name: "Claim", kind: "feature", summary: "Preserve every branch meaning",
    why: null, file_refs: null, parent_id: null, created_by_task: "Original task context",
    created_at: "2026-01-01 00:00:00", updated_at: "2026-01-02 00:00:00",
    removed_at: null, removed_reason: null, embedding: null, merge_group: null,
    needs_merge: 0, source_branch: null, merge_timestamp: null, status: "active",
    valid_from: null, valid_until: null, epistemic_status: null, status_scope: null,
    task_state: "open", due_at: "2030-01-01", claim_digest: "claim-original",
    claim_digest_at: "2026-01-01 00:00:00", created_via: "agent", ...overrides,
  };
}
function input(rows: NodeRow[], setup?: (db: KnowledgeDB) => void): string {
  const filename = path.join(temp, `input-${serial++}.db`);
  const db = new KnowledgeDB(filename);
  try { ensureSchema(db); for (const row of rows) db.insertNodeRaw(row); setup?.(db); }
  finally { db.close(); }
  return filename;
}
function read<T>(filename: string, inspect: (db: KnowledgeDB) => T): T {
  const db = new KnowledgeDB(filename);
  try { return inspect(db); } finally { db.close(); }
}
function merge(left: string, right: string): string {
  const output = path.join(temp, `output-${serial++}.db`);
  new MergeEngine().merge(left, right, output);
  return output;
}
function unresolved(): NodeRow[] {
  return [
    node("claim::left", { summary: "First unresolved version", needs_merge: 1, merge_group: "prior-group", source_branch: "old-left" }),
    node("claim::right", { summary: "Second unresolved version", needs_merge: 1, merge_group: "prior-group", source_branch: "old-right" }),
  ];
}

for (const reverse of [false, true]) {
  describe(`P05 public merge policy (${reverse ? "right-first" : "left-first"})`, () => {
    const ordered = (a: string, b: string): [string, string] => reverse ? [b, a] : [a, b];

    it("B-02 keeps two different payloads sharing the same suffix", () => {
      const a = input([node("claim::left", { summary: "First meaning", needs_merge: 1, merge_group: "prior-group" })]);
      const b = input([node("claim::left", { summary: "Second meaning", needs_merge: 1, merge_group: "prior-group" })]);
      const output = merge(...ordered(a, b));
      const rows = read(output, db => db.getAllNodesRaw());
      expect(rows.map(row => row.summary).sort()).toEqual(["First meaning", "Second meaning"]);
      expect(rows.map(row => row.id).sort()).toEqual(["claim::left", "claim::right"]);
      expect(rows.every(row => row.needs_merge === 1 && row.merge_group)).toBe(true);
    });

    it("B-02 canonical matching an unresolved variant remaps its edges without losing the other variant", () => {
      const variants = unresolved();
      const a = input([...variants, node("target")]);
      const b = input([node("claim", { summary: "Second unresolved version" }), node("target")], db => {
        db.insertEdgeRaw({ from_id: "claim", to_id: "target", relation: "depends_on", description: "canonical edge" });
      });
      const output = merge(...ordered(a, b));
      expect(read(output, db => db.getAllNodesRaw().map(row => row.id).sort())).toEqual(["claim::left", "claim::right", "target"]);
      expect(read(output, db => db.getAllEdgesRaw().map(edge => [edge.from_id, edge.to_id, edge.description]))).toEqual([["claim::right", "target", "canonical edge"]]);
    });

    it("B-02 considers an unflagged suffix instead of discarding it", () => {
      const a = input([node("claim::left", { summary: "First meaning" })]);
      const b = input([node("claim", { summary: "Second meaning" })]);
      const rows = read(merge(...ordered(a, b)), db => db.getAllNodesRaw());
      expect(rows.map(row => row.summary).sort()).toEqual(["First meaning", "Second meaning"]);
      expect(rows.every(row => row.needs_merge === 1)).toBe(true);
    });

    it("B-02 rejection leaves an existing output untouched", () => {
      const a = input(unresolved());
      const b = input([node("claim", { summary: "Third independent version" })]);
      const output = input([node("sentinel")]);
      const before = fs.readFileSync(output);
      expect(() => new MergeEngine().merge(...ordered(a, b), output)).toThrow(/unsupported.*versions/i);
      expect(fs.readFileSync(output)).toEqual(before);
    });

    it("B-05 repeated equal edge payload never clears prior unresolved flags", () => {
      const make = (flagged: boolean) => input([node("claim"), node("target")], db => {
        db.insertEdgeRaw({ from_id: "claim", to_id: "target", relation: "depends_on", description: "saved rationale", needs_merge: flagged ? 1 : 0, merge_group: flagged ? "saved-edge-group" : null, source_branch: flagged ? "saved-branch" : null, merge_timestamp: flagged ? "2026-01-03 00:00:00" : null });
      });
      const a = make(false), b = make(true);
      const output = merge(...ordered(a, b));
      for (const filename of [output, merge(...ordered(output, a)), merge(...ordered(output, input([])))]) {
        expect(read(filename, db => db.getAllEdgesRaw().map(edge => [edge.description, edge.needs_merge, edge.merge_group, edge.source_branch, edge.merge_timestamp]))).toEqual([["saved rationale", 1, "saved-edge-group", "saved-branch", "2026-01-03 00:00:00"]]);
      }
    });

    it.each([
      ["task_state", "done"], ["due_at", "2031-01-01"],
      ["valid_from", "2027-01-01"], ["valid_until", "2027-02-01"],
      ["status_scope", '{"artifact":"independent"}'], ["removed_reason", "Different reason"],
      ["created_by_task", "Different context"], ["claim_digest", "independent-claim"],
      ["claim_digest_at", "2026-02-01 00:00:00"], ["created_via", "file_ref"],
    ])("B-01 %s difference preserves both payloads through public merge", (field, value) => {
      const a = input([node()]);
      const b = input([node("claim", { [field]: value })]);
      const output = merge(...ordered(a, b));
      for (const filename of [output, merge(...ordered(output, input([]))), merge(...ordered(output, output))]) {
        const rows = read(filename, db => db.getAllNodesRaw());
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row[field as keyof NodeRow]).sort()).toEqual([node()[field as keyof NodeRow], value].sort());
        expect(rows.every(row => row.needs_merge === 1)).toBe(true);
      }
    });

    it("B-01 empty and repeated clean merge retain task TTL and evidence", () => {
      const original = node("claim", { valid_from: "2026-01-01", valid_until: "2030-01-01", status_scope: '{"env":"test"}' });
      const a = input([original]), empty = input([]);
      const output = merge(...ordered(a, empty));
      expect(read(output, db => db.getNodeIncludingRemoved("claim"))).toMatchObject(original);
      const repeated = merge(...ordered(output, output));
      expect(read(repeated, db => db.getNodeIncludingRemoved("claim"))).toMatchObject(original);
    });

    it("B-01 updated_at-only noise is not a concept conflict", () => {
      const a = input([node()]);
      const b = input([node("claim", { updated_at: "2026-09-01 00:00:00" })]);
      const output = merge(...ordered(a, b));
      expect(read(output, db => db.getAllNodesRaw().map(row => [row.id, row.needs_merge]))).toEqual([["claim", 0]]);
    });

    it("B-02 rejects unresolved pair plus a third canonical meaning atomically", () => {
      const a = input(unresolved());
      const b = input([node("claim", { summary: "Third independent version" })]);
      const output = path.join(temp, `rejected-${serial++}.db`);
      const before = [fs.readFileSync(a), fs.readFileSync(b)];
      expect(() => new MergeEngine().merge(...ordered(a, b), output)).toThrow(/unsupported.*versions/i);
      expect(fs.existsSync(output)).toBe(false);
      expect([fs.readFileSync(a), fs.readFileSync(b)]).toEqual(before);
    });
  });
}
