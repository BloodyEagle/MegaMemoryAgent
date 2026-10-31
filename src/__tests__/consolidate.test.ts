import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { findDuplicates, mergeNodes, nameSimilarity } from "../consolidate.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-consolidate-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function setEmbedding(db: KnowledgeDB, id: string, vec: number[]): void {
  const v = new Float32Array(vec);
  db.execSqlRun(
    "UPDATE nodes SET embedding = @e WHERE id = @id",
    { e: Buffer.from(v.buffer, v.byteOffset, v.byteLength), id }
  );
}

describe("findDuplicates", () => {
  it("finds near-identical pairs, skips dissimilar nodes", () => {
    const db = freshDb();
    db.insertNode({ id: "dup-a", name: "Payment Module", kind: "module", summary: "processes payments via stripe" });
    db.insertNode({ id: "dup-b", name: "Payment Module Copy", kind: "module", summary: "processes payments via stripe (copy)" });
    db.insertNode({ id: "other", name: "Logging", kind: "module", summary: "writes logs to files" });
    setEmbedding(db, "dup-a", [1, 0, 0, 0]);
    setEmbedding(db, "dup-b", [0.99, 0.1, 0, 0]); // ≈0.995 cosine
    setEmbedding(db, "other", [0, 1, 0, 0]); // orthogonal

    const candidates = findDuplicates(db, { threshold: 0.95 });
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect([c.a, c.b].sort()).toEqual(["dup-a", "dup-b"]);
    expect(c.same_parent).toBe(true);
    expect(c.older).toBe("dup-a"); // created first
  });

  it("dry run (findDuplicates) never mutates the database", () => {
    const db = freshDb();
    db.insertNode({ id: "x1", name: "Same", kind: "module", summary: "same" });
    db.insertNode({ id: "x2", name: "Same", kind: "module", summary: "same" });
    setEmbedding(db, "x1", [1, 0, 0, 0]);
    setEmbedding(db, "x2", [1, 0, 0, 0]);

    const before = db.getAllNodesRaw().length;
    findDuplicates(db, { threshold: 0.9 });
    expect(db.getAllNodesRaw().length).toBe(before);
  });
});

describe("mergeNodes", () => {
  it("merges into the older node, combines summary, moves edges, removes twin", () => {
    const db = freshDb();
    db.insertNode({ id: "old", name: "Old Node", kind: "module", summary: "first version" });
    db.insertNode({ id: "twin", name: "Twin Node", kind: "module", summary: "second version" });
    db.insertNode({ id: "peer", name: "Peer", kind: "module", summary: "peer" });
    // Edges touching the twin must survive via the survivor.
    db.insertEdge({ from_id: "twin", to_id: "peer", relation: "connects_to" });
    db.insertEdge({ from_id: "peer", to_id: "twin", relation: "depends_on" });

    const before = db.getAllNodesRaw().length;
    const beforeEdges = db.getAllEdgesRaw().length;
    const result = mergeNodes(db, "old", "twin");

    expect(result).toEqual({ survivor: "old", removed: "twin" });
    expect(db.getAllNodesRaw().length).toBe(before - 1);
    expect(db.nodeExists("twin")).toBe(false);
    expect(db.nodeExists("old")).toBe(true);

    // Summary combined.
    const survivor = db.getNode("old")!;
    expect(survivor.summary).toContain("first version");
    expect(survivor.summary).toContain("second version");

    // Edges moved: count preserved (2 moved, none lost, none duplicated).
    expect(db.getAllEdgesRaw().length).toBe(beforeEdges);
    expect(db.getOutgoingEdges("old").some((e) => e.to_id === "peer" && e.relation === "connects_to")).toBe(true);
    expect(db.getIncomingEdges("old").some((e) => e.from_id === "peer" && e.relation === "depends_on")).toBe(true);
  });
});

describe("nameSimilarity", () => {
  it("is 1 for identical names, low for different ones", () => {
    expect(nameSimilarity("Payment Module", "payment module")).toBe(1);
    expect(nameSimilarity("Payment Module", "Payment Module Copy")).toBeGreaterThan(0.5);
    expect(nameSimilarity("Payment Module", "Logging")).toBeLessThan(0.5);
  });
});

describe("М7: digest excluded from consolidation", () => {
  it("digest nodes are never candidates even with identical vectors", () => {
    const db = freshDb();
    db.insertNode({ id: "m", name: "Module", kind: "module", summary: "m" });
    db.insertNode({ id: "m/d1", name: "Digest one", kind: "digest", summary: "digest payload", parent_id: "m" });
    db.insertNode({ id: "m/d2", name: "Digest two", kind: "digest", summary: "digest payload 2", parent_id: "m" });
    setEmbedding(db, "m/d1", [1, 0, 0, 0]);
    setEmbedding(db, "m/d2", [1, 0, 0, 0]);
    const candidates = findDuplicates(db, { threshold: 0.9 });
    expect(candidates).toHaveLength(0);
  });
});
