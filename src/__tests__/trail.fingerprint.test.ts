import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { trailSave, trailGet, trailRefresh, trailExtend, trailState } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-trail-fp-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function seedGraph(): { fact: string; support: string; chain: string } {
  db.insertNode({ id: "conclusion", name: "Conclusion", kind: "decision", summary: "use sqlite" });
  db.insertNode({ id: "fact", name: "Fact", kind: "config", summary: "fk are on" });
  db.insertNode({ id: "support", name: "Support", kind: "pattern", summary: "wal mode" });
  db.insertEdge({ from_id: "conclusion", to_id: "fact", relation: "informed_by", description: "integrity" });
  db.insertEdge({ from_id: "conclusion", to_id: "support", relation: "informed_by", description: "durability" });
  return { fact: "fact", support: "support", chain: "chain" };
}

describe("trail fingerprints (plan 2 §1)", () => {
  it("a fresh chain reports fresh; every member is listed in order", async () => {
    freshDb();
    seedGraph();
    const saved = trailSave(db, {
      node_ids: ["fact", "support", "conclusion"],
      summary: "sqlite is fine because fk and wal work",
      name: "db-choice",
    });
    const view = trailGet(db, saved.id);
    expect(view.state).toBe("fresh");
    expect(view.members.map((m) => m.node_id)).toEqual(["fact", "support", "conclusion"]);
    expect(view.members.every((m) => m.state === "fresh")).toBe(true);
  });

  it("editing a member summary rots the chain; renaming the node does not", async () => {
    freshDb();
    seedGraph();
    const saved = trailSave(db, {
      node_ids: ["fact", "conclusion"],
      summary: "why sqlite",
      name: "why",
    });
    expect(trailGet(db, saved.id).state).toBe("fresh");

    // Rename: meaning unchanged — still fresh.
    db.updateNode("fact", { name: "Fact Renamed" });
    expect(trailGet(db, saved.id).state).toBe("fresh");

    // Summary edit: the claim changed — stale, with a reason.
    db.updateNode("fact", { summary: "fk are OFF" });
    const stale = trailGet(db, saved.id);
    expect(stale.state).toBe("stale");
    const member = stale.members.find((m) => m.node_id === "fact")!;
    expect(member.state).toBe("stale");
    expect(member.reason).toBeTruthy();
  });

  it("changing epistemic_status of a member rots the chain (refuted evidence)", async () => {
    freshDb();
    seedGraph();
    const saved = trailSave(db, {
      node_ids: ["fact", "conclusion"],
      summary: "why sqlite",
      name: "why",
    });
    db.setEpistemicStatus("fact", "refuted", "proved wrong by test X");
    expect(trailGet(db, saved.id).state).toBe("stale");
  });

  it("adding or removing an informed_by edge of a member rots the chain", async () => {
    freshDb();
    seedGraph();
    db.insertNode({ id: "extra", name: "Extra", kind: "pattern", summary: "more proof" });
    const saved = trailSave(db, {
      node_ids: ["conclusion"],
      summary: "conclusion only",
      name: "c",
    });
    // New support appears — the conclusion's justification grew.
    db.insertEdge({ from_id: "conclusion", to_id: "extra", relation: "informed_by", description: "extra" });
    expect(trailGet(db, saved.id).state).toBe("stale");
    trailRefresh(db, saved.id);
    expect(trailGet(db, saved.id).state).toBe("fresh");

    // Rationale change also rots (it is part of the fingerprint).
    db.deleteEdge("conclusion", "extra", "informed_by");
    expect(trailGet(db, saved.id).state).toBe("stale");
  });

  it("rolling the text back honestly makes the chain fresh again", async () => {
    freshDb();
    seedGraph();
    const saved = trailSave(db, {
      node_ids: ["fact", "conclusion"],
      summary: "why sqlite",
      name: "why",
    });
    const fpBefore = db.nodeFingerprint("fact");
    db.updateNode("fact", { summary: "fk are OFF" });
    expect(trailState(db, saved.id)).toBe("stale");
    db.updateNode("fact", { summary: "fk are on" });
    expect(db.nodeFingerprint("fact")).toBe(fpBefore);
    expect(trailGet(db, saved.id).state).toBe("fresh");
  });

  it("trail_extend appends members; trail_refresh re-snapshots after verified change", async () => {
    freshDb();
    seedGraph();
    const saved = trailSave(db, {
      node_ids: ["fact", "conclusion"],
      summary: "why sqlite",
      name: "why",
    });
    trailExtend(db, saved.id, ["support"]);
    const view = trailGet(db, saved.id);
    expect(view.members).toHaveLength(3);
    expect(view.members[2].node_id).toBe("support");

    db.updateNode("fact", { summary: "fk are on, verified" });
    expect(trailGet(db, saved.id).state).toBe("stale");
    trailRefresh(db, saved.id);
    expect(trailGet(db, saved.id).state).toBe("fresh");
  });

  it("trail_save refuses an empty summary and unknown nodes", async () => {
    freshDb();
    seedGraph();
    expect(() => trailSave(db, { node_ids: ["fact"], summary: "  " })).toThrow(/non-empty/);
    expect(() => trailSave(db, { node_ids: ["nope"], summary: "x" })).toThrow(/does not exist/);
  });
});
