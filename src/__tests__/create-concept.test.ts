import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KnowledgeDB } from "../db.js";
import { createConcept } from "../tools.js";
import fs from "fs";
import path from "path";
import os from "os";
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

let db: KnowledgeDB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-create-concept-test-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

afterEach(async () => {
  await closeAndCleanup(db, tmpDir);
});

describe("createConcept tool", () => {
  it("creates a root concept when parent_id is omitted", async () => {
    const result = await createConcept(db, {
      name: "Root Concept",
      kind: "module",
      summary: "A root concept",
    });

    expect(result.id).toBe("root-concept");
    expect(db.getNode("root-concept")!.parent_id).toBeNull();
    expect(db.getRootNodes().map((node) => node.id)).toContain("root-concept");
  });

  it("treats empty string parent_id as omitted and stores null", async () => {
    const result = await createConcept(db, {
      name: "Empty Parent Root",
      kind: "feature",
      summary: "A root concept created with an empty parent_id, which is treated as omitted and stores null",
      parent_id: "",
    });

    const node = db.getNode("empty-parent-root")!;
    expect(result.id).toBe("empty-parent-root");
    expect(node.parent_id).toBeNull();
    expect(db.getRootNodes().map((root) => root.id)).toContain("empty-parent-root");
  });

  it("creates a child concept for a valid non-empty parent_id", async () => {
    const parent = await createConcept(db, {
      name: "Parent Concept",
      kind: "module",
      summary: "A parent concept",
    });

    const child = await createConcept(db, {
      name: "Child Concept",
      kind: "feature",
      summary: "A child concept nested under a valid non-empty parent_id to check the hierarchy links",
      parent_id: parent.id,
    });

    const childNode = db.getNode("parent-concept/child-concept")!;
    expect(child.id).toBe("parent-concept/child-concept");
    expect(childNode.parent_id).toBe("parent-concept");
    expect(db.getChildren("parent-concept").map((node) => node.id)).toContain(
      "parent-concept/child-concept"
    );
  });

  it("rejects invalid non-empty parent_id without normalizing it", async () => {
    await expect(
      createConcept(db, {
        name: "Orphan Concept",
        kind: "feature",
        summary: "Should not be created because the parent id does not exist anywhere in the graph yet",
        parent_id: "null",
      })
    ).rejects.toThrow('Parent concept "null" does not exist.');

    expect(db.getNode("null/orphan-concept")).toBeUndefined();
    expect(db.getNode("orphan-concept")).toBeUndefined();
  });
});

// ---- 2.1.2 F1: два evidence с одним ref не роняют создание ----

describe("createConcept: duplicate evidence refs (2.1.2 F1)", () => {
  it("two evidence items with the same unseen ref create the node, one support, one snapshot", async () => {
    const result = await createConcept(db, {
      name: "Decision",
      kind: "decision",
      summary: "A decision resting on one file fact: both evidence items point at the very same ref",
      evidence: [
        { ref: "docs/spec.md", why: "первое чтение спеки" },
        { ref: "docs/spec.md", why: "повторное указание той же опоры" },
      ],
    });

    // The node itself was created (the transaction did not roll back).
    expect(db.getNode(result.id)).toBeDefined();
    // Exactly one fact node, one support edge, one snapshot row.
    const factIds = db
      .getInformedByEdges(result.id, "ancestry", false)
      .map((e) => e.other_id);
    expect(factIds).toHaveLength(1);
    const fact = db.getNode(factIds[0])!;
    expect(fact.kind).toBe("feature");
    expect(fact.file_refs ? JSON.parse(fact.file_refs) : null).toEqual(["docs/spec.md"]);
    const check = db.getSupportBaselines(result.id);
    expect(check).toHaveLength(1);
    expect(check[0].support_id).toBe(factIds[0]);
  });

  it("the same duplicate-ref call succeeds when the support already exists", async () => {
    const first = await createConcept(db, {
      name: "First",
      kind: "decision",
      summary: "creates the file fact node on the first evidence ref that points at docs/other.md",
      evidence: [{ ref: "docs/other.md", why: "почему опора" }],
    });
    const factId = db.getInformedByEdges(first.id, "ancestry", false)[0].other_id;

    // Second call: the ref now resolves to the existing fact node — and the
    // evidence lists that node twice.
    const second = await createConcept(db, {
      name: "Second",
      kind: "decision",
      summary: "reuses the existing file fact node instead of creating a second one for the same ref",
      evidence: [
        { node: factId, why: "опора существует" },
        { node: factId, why: "дубль той же опоры" },
      ],
    });

    expect(db.getNode(second.id)).toBeDefined();
    const factIds = db
      .getInformedByEdges(second.id, "ancestry", false)
      .map((e) => e.other_id);
    expect(factIds).toEqual([factId]);
    expect(db.getSupportBaselines(second.id)).toHaveLength(1);
  });
});
