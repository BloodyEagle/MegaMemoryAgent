import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { createConcept } from "../tools.js";
import { readProvenanceConfig } from "../provenance.js";

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async () => {
    const embedding = new Float32Array([1, 0, 0]);
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }),
  embeddingText: vi.fn((name: string, kind: string, summary: string) =>
    `${kind}: ${name} — ${summary}`
  ),
  findTopK: vi.fn(),
  embedForStorage: vi.fn(async () => {
    const embedding = new Float32Array([1, 0, 0]);
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }),
  vectorSearchEnabled: vi.fn(() => true),
}));

let db: KnowledgeDB;
let tmpDir: string;
const originalEnvAutoGround = process.env.MEGAMEMORY_PROVENANCE_AUTO_GROUND;

beforeEach(() => {
  delete process.env.MEGAMEMORY_PROVENANCE_AUTO_GROUND;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-provenance-record-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

// Close only: see provenance.trace.test.ts — the 4 s removal budget of
// helpers/cleanup.ts loses to libsql's post-close file lock on Windows.
afterEach(() => {
  if (originalEnvAutoGround === undefined) {
    delete process.env.MEGAMEMORY_PROVENANCE_AUTO_GROUND;
  } else {
    process.env.MEGAMEMORY_PROVENANCE_AUTO_GROUND = originalEnvAutoGround;
  }
  db.close();
});

describe("evidence shortcut and auto_ground (plan-3-fixes-2 F6, F19)", () => {
  it("23. evidence with {node} and {ref}: both edges written, file-fact node created, counter right", async () => {
    db.insertNode({ id: "support-a", name: "A", kind: "config", summary: "a" });
    const result = await createConcept(db, {
      name: "Conclusion",
      kind: "decision",
      summary: "drawn from two sources: one existing node and one file ref that becomes a fact node",
      evidence: [
        { node: "support-a", why: "measured in support-a" },
        { ref: "src/module/impl.ts", why: "read from impl.ts" },
      ],
    });

    const edges = db.execSqlAll(
      "SELECT from_id, to_id, description FROM edges WHERE relation = 'informed_by' AND removed_at IS NULL ORDER BY to_id"
    ) as Array<{ from_id: string; to_id: string; description: string }>;
    expect(edges).toHaveLength(2);
    // makeId slugifies the ref for the node id; file_refs keeps the raw path.
    expect(edges.map((e) => e.to_id)).toEqual(["src-module-implts", "support-a"]);
    expect(edges[0].description).toBe("read from impl.ts");
    expect(edges[1].description).toBe("measured in support-a");
    // The file ref became a file-fact node.
    const fact = db.getNode("src-module-implts");
    expect(fact).not.toBeNull();
    expect(fact!.kind).toBe("feature");
    expect(JSON.parse(fact!.file_refs!)).toEqual(["src/module/impl.ts"]);
    // F6: two supports, one of them a new node.
    expect(result.message).toContain("Создано опор: 2");
    expect(result.message).toContain("из них новых узлов-источников: 1");
    // F19: explicit evidence is agent-declared — no auto-note.
    expect(result.message).not.toContain("Добавил опор");
  });

  it("24. two evidence items about the same node count as one support (F6)", async () => {
    db.insertNode({ id: "support-a", name: "A", kind: "config", summary: "a" });
    const result = await createConcept(db, {
      name: "Conclusion",
      kind: "decision",
      summary: "two reasons, one support: both evidence items name the same node so the counter stays one",
      evidence: [
        { node: "support-a", why: "first reason" },
        { node: "support-a", why: "second reason" },
      ],
    });

    expect(result.message).toContain("Создано опор: 1");
    const edges = db.execSqlAll(
      "SELECT from_id, to_id, description FROM edges WHERE relation = 'informed_by' AND removed_at IS NULL"
    ) as Array<{ from_id: string; to_id: string; description: string }>;
    // One edge row per (pair, relation): the second rationale does not
    // duplicate the link — and the counter must not have counted it either.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from_id: "conclusion", to_id: "support-a" });
  });

  it("25. auto_ground is off by default — no support edges from why + file_refs (F19)", async () => {
    db.insertNode({
      id: "file-node",
      name: "src/module/impl.ts",
      kind: "feature",
      summary: "file fact",
      file_refs: ["src/module/impl.ts"],
    });
    const result = await createConcept(db, {
      name: "Decision",
      kind: "decision",
      summary: "a decision with why and refs but no evidence: auto_ground must not invent supports",
      why: "because the implementation says so",
      file_refs: ["src/module/impl.ts"],
    });

    const edges = db.execSqlAll(
      "SELECT from_id, to_id FROM edges WHERE relation = 'informed_by' AND removed_at IS NULL"
    ) as unknown[];
    expect(edges).toEqual([]); // the server invented nothing
    expect(result.message).not.toContain("Добавил опор");
    expect(readProvenanceConfig(path.join(tmpDir, "knowledge.db")).auto_ground).toBe(false);
  });

  it("25b. auto_ground still works when explicitly enabled", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "megamemory.config.json"),
      JSON.stringify({ provenance: { auto_ground: true } })
    );
    db.insertNode({
      id: "file-node",
      name: "src/module/impl.ts",
      kind: "feature",
      summary: "file fact",
      file_refs: ["src/module/impl.ts"],
    });
    const result = await createConcept(db, {
      name: "Decision",
      kind: "decision",
      summary: "a decision with why and refs but no evidence: auto_ground must not invent supports",
      why: "because the implementation says so",
      file_refs: ["src/module/impl.ts"],
    });

    const edges = db.execSqlAll(
      "SELECT from_id, to_id FROM edges WHERE relation = 'informed_by' AND removed_at IS NULL"
    ) as Array<{ from_id: string; to_id: string }>;
    expect(edges).toEqual([{ from_id: "decision", to_id: "file-node" }]);
    // F19: derived supports are marked as derived, never passed off as declared.
    expect(result.message).toContain("Добавил опор по file_refs: 1");
  });
});
