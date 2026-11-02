import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { slotSet, slotGet, slotRelease, slotList } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-slots-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("role slots (plan 2 §2)", () => {
  it("the first holder takes the role; the holder row exists", async () => {
    freshDb();
    db.insertNode({ id: "n1", name: "N1", kind: "decision", summary: "handoff v1" });
    const result = slotSet(db, "handoff", "n1");
    expect(result.message).toContain("taken");
    expect(db.getSlot("", "handoff")?.node_id).toBe("n1");
  });

  it("a second holder supersedes the first with an edge, and the old node is not touched", async () => {
    freshDb();
    db.insertNode({ id: "old", name: "Old", kind: "decision", summary: "yesterday" });
    db.insertNode({ id: "new", name: "New", kind: "decision", summary: "today" });
    slotSet(db, "handoff", "old");
    const result = slotSet(db, "handoff", "new");
    expect(result.message).toContain("superseded");

    // Exactly one live holder.
    expect(db.getSlot("", "handoff")?.node_id).toBe("new");
    // The handoff edge new --supersedes--> old exists.
    const edge = db.execSqlFirst(
      "SELECT * FROM edges WHERE from_id = 'new' AND to_id = 'old' AND relation = 'supersedes' AND removed_at IS NULL"
    );
    expect(edge).toBeTruthy();
    // The old node is NOT revoked or deleted — yesterday's handoff stays truthful.
    expect(db.getNode("old")).toBeTruthy();
  });

  it("re-taking by the same node is a no-op (no burial edge)", async () => {
    freshDb();
    db.insertNode({ id: "n1", name: "N1", kind: "decision", summary: "s" });
    slotSet(db, "handoff", "n1");
    const again = slotSet(db, "handoff", "n1");
    expect(again.message).toContain("no-op");
    const supersedes = db.execSqlAll(
      "SELECT * FROM edges WHERE relation = 'supersedes'"
    );
    expect(supersedes).toHaveLength(0);
    expect(db.getSlot("", "handoff")?.node_id).toBe("n1");
  });

  it("release frees the role without touching the holder node", async () => {
    freshDb();
    db.insertNode({ id: "n1", name: "N1", kind: "decision", summary: "s" });
    slotSet(db, "entrypoint", "n1");
    const released = slotRelease(db, "entrypoint");
    expect(released.message).toContain("released");
    expect(db.getSlot("", "entrypoint")).toBeUndefined();
    expect(db.getNode("n1")).toBeTruthy();
    // Releasing an empty role is a clean no-op.
    expect(slotRelease(db, "entrypoint").message).toContain("not held");
  });

  it("a role in another project is a different slot", async () => {
    freshDb();
    db.insertNode({ id: "n1", name: "N1", kind: "decision", summary: "s" });
    db.insertNode({ id: "n2", name: "N2", kind: "decision", summary: "t" });
    db.setSlot("proj-a", "handoff", "n1");
    db.setSlot("proj-b", "handoff", "n2");
    expect(db.getSlot("proj-a", "handoff")?.node_id).toBe("n1");
    expect(db.getSlot("proj-b", "handoff")?.node_id).toBe("n2");
    expect(db.listSlots("proj-a")).toHaveLength(1);
  });

  it("invariant: two live holders of one role are impossible (serialized upsert)", async () => {
    freshDb();
    db.insertNode({ id: "a", name: "A", kind: "decision", summary: "s" });
    db.insertNode({ id: "b", name: "B", kind: "decision", summary: "s" });
    slotSet(db, "role", "a");
    slotSet(db, "role", "b");
    const rows = db.execSqlAll("SELECT * FROM slots WHERE role = 'role'");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { node_id: string }).node_id).toBe("b");
  });

  it("slot_set refuses unknown or removed nodes; slot_list lists all", async () => {
    freshDb();
    db.insertNode({ id: "a", name: "A", kind: "decision", summary: "s" });
    expect(() => slotSet(db, "role", "ghost")).toThrow(/does not exist/);
    slotSet(db, "r1", "a");
    slotSet(db, "r2", "a");
    const list = slotList(db).slots;
    expect(list.map((s) => s.role)).toEqual(["r1", "r2"]);
  });

  it("slot_get describes the holder or the absence", async () => {
    freshDb();
    expect(slotGet(db, "queue").message).toContain("not held");
    db.insertNode({ id: "a", name: "A", kind: "decision", summary: "s" });
    slotSet(db, "queue", "a");
    expect(slotGet(db, "queue").message).toContain("a");
  });
});
