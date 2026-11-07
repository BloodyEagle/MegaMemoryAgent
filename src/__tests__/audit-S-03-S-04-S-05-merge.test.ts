import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { MergeEngine } from "../merge.js";
import { ensureSchema } from "../migrate-schema.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function database(name: string) {
  const db = fixture.db(name);
  ensureSchema(db);
  return db;
}

function edgeState(db: KnowledgeDB) {
  return db.getAllEdgesRaw().map((edge) => ({
    from: edge.from_id, to: edge.to_id, relation: edge.relation,
    description: edge.description, removed_at: edge.removed_at,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe("S-03 merge preserves workflow knowledge", () => {
  it.each(["left", "right"] as const)("preserves tasks, slots and saved trail fingerprints with the populated input on %s", (populatedSide) => {
    const populated = database("populated.db");
    const empty = database("empty.db");
    addNode(populated, "task", { kind: "task", summary: "Open task with a saved deadline" });
    addNode(populated, "done", { kind: "task", summary: "Completed task stays in the terminal column" });
    addNode(populated, "source", { kind: "fact", summary: "Evidence saved before the task wording changes" });
    populated.setTaskState("task", "open", "2030-01-01");
    populated.setTaskState("done", "done", null);
    populated.insertEdge({ from_id: "task", to_id: "source", relation: "informed_by", description: "Task rationale" });
    populated.setSlot("project", "handoff", "task");
    populated.insertTrail({ id: "trail", name: "Saved handoff", summary: "Preserve the saved reasoning", node_ids: ["source", "task"] });
    const savedMembers = populated.getTrailMembers("trail");
    // Merge must carry the saved fingerprints, not silently reconfirm new wording.
    populated.updateNode("task", { summary: "Task wording changed after the trail was saved" });
    populated.setTrailStale("trail", true);
    const savedSlot = populated.getSlot("project", "handoff");
    const savedTrail = populated.getTrail("trail");
    expect(savedMembers).toHaveLength(2);
    expect(savedSlot?.node_id).toBe("task");
    expect(savedTrail?.stale).toBe(1);
    expect(savedMembers[1].fingerprint).not.toBe(populated.nodeFingerprint("task"));

    const left = populatedSide === "left" ? populated : empty;
    const right = populatedSide === "left" ? empty : populated;
    new MergeEngine().merge(left.dbPath, right.dbPath, fixture.file("merged.db"));
    const output = fixture.db("merged.db");
    expect({
      task: { state: output.getNode("task")?.task_state, due: output.getNode("task")?.due_at },
      done: { state: output.getNode("done")?.task_state, due: output.getNode("done")?.due_at },
      openIds: output.getOpenTasks().map((node) => node.id),
      doneIds: output.getDoneTasks().map((node) => node.id),
      slot: output.getSlot("project", "handoff"),
      trail: output.getTrail("trail"),
      members: output.getTrailMembers("trail"),
    }).toEqual({
      task: { state: "open", due: "2030-01-01" },
      done: { state: "done", due: null },
      openIds: ["task"], doneIds: ["done"],
      slot: savedSlot, trail: savedTrail, members: savedMembers,
    });
    expect(output.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("S-04 conflicting parents and atomic output", () => {
  it.each(["shared", "conflicting"] as const)("preserves three hierarchy levels with a conflicting parent and %s descendants", (descendants) => {
    const left = database("left.db");
    const right = database("right.db");
    for (const [db, side] of [[left, "left"], [right, "right"]] as const) {
      const wording = descendants === "shared" ? "shared" : side;
      addNode(db, "parent", { name: "Root", kind: "module", summary: `Root from ${side}` });
      addNode(db, "parent/child", { name: "Child", summary: `Child from ${wording}`, parent_id: "parent" });
      addNode(db, "parent/child/leaf", { name: "Leaf", summary: `Leaf from ${wording}`, parent_id: "parent/child" });
    }
    const beforeInputs = [sqlState(left), sqlState(right)];
    const outputPath = fixture.file("merged.db");
    expect(() => new MergeEngine().merge(left.dbPath, right.dbPath, outputPath)).not.toThrow();
    const output = fixture.db("merged.db");
    expect(output.pragma("foreign_key_check")).toEqual([]);
    const nodes = output.getAllNodesRaw();
    expect(nodes.filter((node) => node.name === "Root").map((node) => node.summary).sort())
      .toEqual(["Root from left", "Root from right"]);
    const children = nodes.filter((node) => node.name === "Child");
    const leaves = nodes.filter((node) => node.name === "Leaf");
    expect(children.length).toBeGreaterThan(0);
    expect(leaves.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(nodes.find((node) => node.id === child.parent_id)?.name).toBe("Root");
    }
    for (const leaf of leaves) {
      const child = nodes.find((node) => node.id === leaf.parent_id);
      expect(child?.name).toBe("Child");
      const parent = nodes.find((node) => node.id === child?.parent_id);
      expect(parent?.name).toBe("Root");
      if (descendants === "conflicting") {
        const side = leaf.summary.endsWith("left") ? "left" : "right";
        expect(child?.summary).toBe(`Child from ${side}`);
        expect(parent?.summary).toBe(`Root from ${side}`);
      }
    }
    if (descendants === "conflicting") {
      expect(children).toHaveLength(2);
      expect(leaves).toHaveLength(2);
    }
    expect([sqlState(left), sqlState(right)]).toEqual(beforeInputs);
  });

  it.each(["new", "existing"] as const)("rejects an invalid imported parent without publishing partial %s output", (kind) => {
    const left = database("left.db");
    const right = database("right.db");
    addNode(left, "safe", { summary: "Valid row written before the invalid row" });
    addNode(left, "orphan");
    // External SQLite is the import boundary: simulate a corrupted FK, not
    // an internal-method mock. A valid row precedes it to expose partial writes.
    left.pragma("foreign_keys = OFF");
    try {
      left.execSqlRun("UPDATE nodes SET parent_id = ? WHERE id = ?", "missing-parent", "orphan");
    } finally {
      left.pragma("foreign_keys = ON");
    }
    expect(left.pragma("foreign_key_check")).not.toEqual([]);
    const outputPath = fixture.file("output.db");
    let existing: KnowledgeDB | undefined;
    if (kind === "existing") {
      existing = database("output.db");
      addNode(existing, "original-output", { summary: "Previously published graph" });
    }
    const beforeOutput = existing ? sqlState(existing) : undefined;
    const beforeInputs = [sqlState(left), sqlState(right)];

    expect(() => new MergeEngine().merge(left.dbPath, right.dbPath, outputPath)).toThrow();

    expect([sqlState(left), sqlState(right)]).toEqual(beforeInputs);
    if (existing) expect(sqlState(existing)).toEqual(beforeOutput);
    else expect(fs.existsSync(outputPath)).toBe(false);
  });
});

describe("S-05 re-merge preserves edge tombstones", () => {
  it.each(["stale-first", "current-first"] as const)("keeps unlink history and is idempotent with %s inputs", (order) => {
    const left = database("left.db");
    const right = database("right.db");
    for (const [db, side] of [[left, "left"], [right, "right"]] as const) {
      addNode(db, "claim", { summary: `Conflicting claim from ${side}` });
      addNode(db, "source", { kind: "fact", summary: "Shared support for both branches" });
      db.insertEdge({ from_id: "claim", to_id: "source", relation: "informed_by", description: "Evidence" });
    }
    new MergeEngine().merge(left.dbPath, right.dbPath, fixture.file("first.db"));
    const first = fixture.db("first.db");
    const stalePath = fixture.snapshot(first, "stale.db");
    fixture.snapshot(first, "current.db");
    const current = fixture.db("current.db");
    expect(current.deleteEdge("claim::left", "source", "informed_by")).toBe(true);
    const removedAt = current.getAllEdgesRaw().find((edge) => edge.from_id === "claim::left")?.removed_at;
    expect(removedAt).toEqual(expect.any(String));
    const expectedEdges = edgeState(current);
    expect(expectedEdges).toHaveLength(2);
    const inputs = order === "stale-first" ? [stalePath, current.dbPath] : [current.dbPath, stalePath];

    new MergeEngine().merge(inputs[0], inputs[1], fixture.file("second.db"));
    const second = fixture.db("second.db");
    new MergeEngine().merge(second.dbPath, current.dbPath, fixture.file("repeated.db"));
    const repeated = fixture.db("repeated.db");

    expect({ once: edgeState(second), repeated: edgeState(repeated) })
      .toEqual({ once: expectedEdges, repeated: expectedEdges });
    expect(second.getOutgoingEdges("claim::left")).toEqual([]);
    expect(repeated.getOutgoingEdges("claim::left")).toEqual([]);
    expect(repeated.getAllNodesRaw().map((node) => node.id).sort())
      .toEqual(["claim::left", "claim::right", "source"]);
    expect(repeated.pragma("foreign_key_check")).toEqual([]);
  });
});
