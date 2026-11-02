import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { link } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

interface EdgeRowLite {
  id: number;
  from_id: string;
  to_id: string;
  description: string | null;
  removed_at: string | null;
}

function tripleRows(from: string, to: string): EdgeRowLite[] {
  return db.execSqlAll(
    "SELECT id, from_id, to_id, description, removed_at FROM edges WHERE from_id = ? AND to_id = ? AND relation = 'informed_by' ORDER BY id",
    from,
    to
  ) as unknown as EdgeRowLite[];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-informed-by-revive-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  db.insertNode({ id: "u", name: "U", kind: "decision", summary: "u" });
  db.insertNode({ id: "v", name: "V", kind: "config", summary: "v" });
  db.insertNode({ id: "c", name: "C", kind: "pattern", summary: "c" });
  db.insertNode({ id: "d", name: "D", kind: "pattern", summary: "d" });
});

afterEach(async () => {
  await closeAndCleanup(db, tmpDir);
});

describe("tombstone revival goes through the same check (plan 4 §5)", () => {
  it("tombstone u→v, then v→u, then reviving u→v is rejected; one row per triple", () => {
    link(db, { from: "u", to: "v", relation: "informed_by", description: "first" });
    db.deleteEdge("u", "v", "informed_by");
    expect(tripleRows("u", "v")[0].removed_at).not.toBeNull();

    // The reverse edge is fine while u→v is a tombstone.
    link(db, { from: "v", to: "u", relation: "informed_by", description: "reverse" });

    // Reviving u→v would close the cycle — the fast path must not exist.
    expect(() =>
      link(db, { from: "u", to: "v", relation: "informed_by", description: "revive" })
    ).toThrow(/cycle/);

    // Exactly one row per triple: no new row was inserted for the refusal,
    // and the reverse edge is a single row too.
    const uv = tripleRows("u", "v");
    expect(uv).toHaveLength(1);
    expect(uv[0].removed_at).not.toBeNull();
    expect(tripleRows("v", "u")).toHaveLength(1);
  });

  it("revival without a cycle works: same row, no duplicates, description updated", () => {
    link(db, { from: "c", to: "d", relation: "informed_by", description: "v1" });
    db.deleteEdge("c", "d", "informed_by");

    const again = link(db, { from: "c", to: "d", relation: "informed_by", description: "v2" });
    expect(again.message).toContain("Created");

    const rows = tripleRows("c", "d");
    expect(rows).toHaveLength(1);
    expect(rows[0].removed_at).toBeNull();
    expect(rows[0].description).toBe("v2");
  });

  it("re-linking a live edge is a no-op, still exactly one row", () => {
    link(db, { from: "c", to: "d", relation: "informed_by", description: "once" });
    const repeat = link(db, { from: "c", to: "d", relation: "informed_by", description: "once" });
    expect(repeat.message).toContain("already exists");
    expect(tripleRows("c", "d")).toHaveLength(1);
  });
});
