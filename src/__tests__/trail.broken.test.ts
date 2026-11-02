import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { trailSave, trailGet, removeConcept } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-trail-broken-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function seed(): string {
  db.insertNode({ id: "a", name: "A", kind: "feature", summary: "a" });
  db.insertNode({ id: "b", name: "B", kind: "feature", summary: "b" });
  const saved = trailSave(db, { node_ids: ["a", "b"], summary: "why ab", name: "ab" });
  return saved.id;
}

describe("trail broken / removal (plan 2 §1, audit B5)", () => {
  it("soft-deleting a member makes the chain stale with an explicit reason — never silent", async () => {
    freshDb();
    const trailId = seed();
    const result = removeConcept(db, { id: "b", reason: "obsolete" });
    // The removal answer names the chain and the cause (audit B5).
    expect(result.message).toContain(trailId);
    expect(result.message).toContain("stale");

    const view = trailGet(db, trailId);
    expect(view.state).toBe("stale");
    const member = view.members.find((m) => m.node_id === "b")!;
    expect(member.state).toBe("stale");
    expect(member.reason).toContain("removed");
    // The member is NOT silently dropped from the list.
    expect(view.members.map((m) => m.node_id)).toEqual(["a", "b"]);
  });

  it("hard-deleting a member makes the chain broken, not stale", async () => {
    freshDb();
    const trailId = seed();
    db.hardDeleteNode("b");
    const view = trailGet(db, trailId);
    expect(view.state).toBe("broken");
    const member = view.members.find((m) => m.node_id === "b")!;
    expect(member.state).toBe("broken");
    expect(member.node_name).toBeNull();
  });

  it("the stored stale flag follows what the read found (lazy persist)", async () => {
    freshDb();
    const trailId = seed();
    const raw = () =>
      (db.execSqlFirst("SELECT stale FROM trails WHERE id = ?", trailId) as { stale: number }).stale;
    expect(raw()).toBe(0);
    removeConcept(db, { id: "b", reason: "obsolete" });
    // removeConcept marks it explicitly — no read required to notice.
    expect(raw()).toBe(1);
    // A fresh chain read back keeps the flag at 0.
    const trailId2 = trailSave(db, { node_ids: ["a"], summary: "solo", name: "solo" }).id;
    trailGet(db, trailId2);
    expect(
      (db.execSqlFirst("SELECT stale FROM trails WHERE id = ?", trailId2) as { stale: number }).stale
    ).toBe(0);
  });
});
