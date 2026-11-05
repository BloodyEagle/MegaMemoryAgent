import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { link, createConcept } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async () => {
    const embedding = new Float32Array([1, 0, 0]);
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }),
  embeddingText: vi.fn((name: string, kind: string, summary: string) =>
    `${kind}: ${name} — ${summary}`
  ),
  findTopK: vi.fn(() => []),
  embedForStorage: vi.fn(async () => {
    const embedding = new Float32Array([1, 0, 0]);
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }),
  vectorSearchEnabled: vi.fn(() => true),
}));

let tmpDir: string;
let db: KnowledgeDB;

function liveEdgeCount(from: string, to: string): number {
  return (
    db.execSqlAll(
      "SELECT id FROM edges WHERE from_id = ? AND to_id = ? AND relation = 'informed_by' AND removed_at IS NULL",
      from,
      to
    ) as unknown[]
  ).length;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-informed-by-dag-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  db.insertNode({ id: "a", name: "A", kind: "decision", summary: "a" });
  db.insertNode({ id: "b", name: "B", kind: "config", summary: "b" });
  db.insertNode({ id: "c", name: "C", kind: "pattern", summary: "c" });
});

afterEach(async () => {
  await closeAndCleanup(db, tmpDir);
});

describe("informed_by is a strict DAG (plan 4 §5)", () => {
  it("a direct self-loop u→u is rejected", () => {
    expect(() =>
      link(db, { from: "a", to: "a", relation: "informed_by", description: "self" })
    ).toThrow(/self-loop/);
    expect(liveEdgeCount("a", "a")).toBe(0);
  });

  it("a two-node cycle: the closing edge is rejected, nothing is written", () => {
    link(db, { from: "a", to: "b", relation: "informed_by", description: "a leans on b" });
    expect(() =>
      link(db, { from: "b", to: "a", relation: "informed_by", description: "back" })
    ).toThrow(/cycle/);
    expect(liveEdgeCount("a", "b")).toBe(1);
    expect(liveEdgeCount("b", "a")).toBe(0);
  });

  it("a cycle arising only in the union of two batches: the second write is rejected", async () => {
    // Batch 1: create_concept with an edges array — conclusion relies on evidence.
    db.insertNode({ id: "evidence", name: "Evidence", kind: "config", summary: "e" });
    const created = await createConcept(db, {
      name: "Conclusion",
      kind: "decision",
      summary: "the conclusion leans on the evidence node through an explicit informed_by edge batch",
      edges: [
        { to: "evidence", relation: "informed_by", description: "measured" },
      ],
    });
    expect(liveEdgeCount("conclusion", "evidence")).toBe(1);

    // Batch 2: the same edge backwards — acyclic alone, closes a cycle in the
    // union with batch 1.
    expect(() =>
      link(db, {
        from: "evidence",
        to: created.id,
        relation: "informed_by",
        description: "back-reference",
      })
    ).toThrow(/cycle/);
    expect(liveEdgeCount("evidence", "conclusion")).toBe(0);
  });

  it("legal chains a→b→c (and a shortcut) pass", () => {
    link(db, { from: "a", to: "b", relation: "informed_by", description: "1" });
    link(db, { from: "b", to: "c", relation: "informed_by", description: "2" });
    link(db, { from: "a", to: "c", relation: "informed_by", description: "3" });
    expect(liveEdgeCount("a", "b")).toBe(1);
    expect(liveEdgeCount("b", "c")).toBe(1);
    expect(liveEdgeCount("a", "c")).toBe(1);
  });

  it("supersedes/contradicts take no part in the cycle check", () => {
    // q supersedes p and contradicts p — other layers. If the check wrongly
    // followed them, p→q would look like closing a cycle.
    db.insertNode({ id: "p", name: "P", kind: "decision", summary: "p" });
    db.insertNode({ id: "q", name: "Q", kind: "decision", summary: "q" });
    db.insertEdge({ from_id: "q", to_id: "p", relation: "supersedes" });
    db.insertEdge({ from_id: "q", to_id: "p", relation: "contradicts" });
    link(db, { from: "p", to: "q", relation: "informed_by", description: "p leans on q" });
    expect(liveEdgeCount("p", "q")).toBe(1);
  });

  it("an edge without a rationale is rejected — via link and via a whole batch", async () => {
    // link: missing, empty, whitespace-only.
    for (const description of [undefined, "", "   "]) {
      expect(() =>
        link(db, {
          from: "a",
          to: "b",
          relation: "informed_by",
          description,
        })
      ).toThrow(/рационал обязателен/);
    }
    expect(liveEdgeCount("a", "b")).toBe(0);

    // create_concept: one bad informed_by edge rejects the whole batch —
    // the node is not created, no half-written rows.
    await expect(
      createConcept(db, {
        name: "Half Written",
        kind: "decision",
        summary: "this decision must not exist because the whole batch is rejected before any write",
        edges: [
          { to: "b", relation: "informed_by", description: "fine" },
          { to: "c", relation: "informed_by", description: "  " },
        ],
      })
    ).rejects.toThrow(/рационал обязателен/);
    expect(db.getNode("half-written")).toBeUndefined();
    expect(liveEdgeCount("half-written", "b")).toBe(0);
  });

  it("an informed_by edge onto a removed node is an error, not a silent skip", async () => {
    db.insertNode({ id: "gone", name: "Gone", kind: "config", summary: "g" });
    db.softDeleteNode("gone", "obsolete");

    // create_concept batch: rejected, node not created.
    await expect(
      createConcept(db, {
        name: "Hanging",
        kind: "decision",
        summary: "this decision must not exist because the whole batch is rejected before any write",
        edges: [{ to: "gone", relation: "informed_by", description: "dangling" }],
      })
    ).rejects.toThrow(/does not exist \(or is removed\)/);
    expect(db.getNode("hanging")).toBeUndefined();

    // link onto a tombstoned node: rejected as well (the tool's pre-check
    // fires before the db-layer validation, same refusal, different wording).
    expect(() =>
      link(db, { from: "a", to: "gone", relation: "informed_by", description: "x" })
    ).toThrow(/not found/);
  });
});
