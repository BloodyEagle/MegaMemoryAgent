import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeConsolidation, mergeNodes } from "../consolidate.js";
import { MergeEngine } from "../merge.js";
import { ensureSchema } from "../migrate-schema.js";
import { provenanceTrace } from "../provenance.js";
import { resolveConflict } from "../tools.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function database(name: string) {
  const db = fixture.db(name);
  ensureSchema(db);
  return db;
}

describe("S-06 conflict resolution retains support loss evidence", () => {
  it("does not report an empty complete trace when the losing conflict variant was the only support", async () => {
    fixture.isolateHome();
    const left = database("left.db");
    const right = database("right.db");
    for (const [db, side] of [[left, "left"], [right, "right"]] as const) {
      addNode(db, "decision", { kind: "decision", summary: "The same decision on both branches", created_via: "agent" });
      addNode(db, "support", { kind: "fact", summary: `Conflicting support from ${side}`, created_via: "agent" });
    }
    right.insertEdge({ from_id: "decision", to_id: "support", relation: "informed_by", description: "Only the right support justified the decision" });
    new MergeEngine().merge(left.dbPath, right.dbPath, fixture.file("merged.db"));
    const db = fixture.db("merged.db");
    const losing = db.getNode("support::right");
    expect(losing?.merge_group).toEqual(expect.any(String));
    expect(db.getOutgoingEdges("decision").map((edge) => edge.to_id)).toEqual(["support::right"]);
    // Public meta switch: no embedding network/model and no internal mocks.
    db.setMetaValue("embed_model", "audit-no-vector");
    await expect(resolveConflict(db, {
      merge_group: losing!.merge_group!,
      resolved: { summary: "Resolved support definition" },
      reason: "Choose the left wording without hiding the previously used support",
    })).resolves.toHaveProperty("message");

    const trace = provenanceTrace(db, { node_id: "decision" });
    expect(db.nodeExists("decision")).toBe(true);
    expect(db.getNode("support")).toMatchObject({ summary: "Resolved support definition", needs_merge: 0 });
    // A valid identity remap may retain a live support. If the support was
    // actually lost, the trace must preserve that fact instead of empty complete.
    const liveSupport = trace.edges.some((edge) => edge.from === "decision" && !edge.removed);
    expect(liveSupport || trace.completeness !== "complete").toBe(true);
    expect(db.hasAnyInformedByRecord("decision")).toBe(true);
  });
});

describe("S-08 consolidation validates distinct live identities", () => {
  it("rejects self-consolidation without changing the graph or workflow state", () => {
    const db = database("knowledge.db");
    addNode(db, "only", { kind: "task", summary: "Single concept must survive invalid self-consolidation" });
    addNode(db, "peer", { kind: "fact" });
    db.insertEdge({ from_id: "only", to_id: "peer", relation: "informed_by", description: "Existing support" });
    db.setTaskState("only", "open", "2030-01-01");
    db.setSlot("project", "handoff", "only");
    db.insertTrail({ id: "trail", name: "Handoff", summary: "Saved reasoning", node_ids: ["only", "peer"] });
    const before = sqlState(db);
    let rejection: unknown;
    try { mergeNodes(db, "only", "only"); } catch (error) { rejection = error; }

    expect({ rejected: rejection instanceof Error, state: sqlState(db) })
      .toEqual({ rejected: true, state: before });
    expect(db.nodeExists("only")).toBe(true);
  });

  it("merges two distinct nodes, retains refs and edges, and rejects a repeated request atomically", () => {
    const db = database("knowledge.db");
    addNode(db, "survivor", { summary: "First claim", why: "Original rationale", file_refs: ["src/first.ts", "src/shared.ts"] });
    addNode(db, "other", { summary: "Second claim", file_refs: ["src/shared.ts", "src/second.ts"] });
    addNode(db, "peer", { kind: "fact" });
    db.insertEdge({ from_id: "other", to_id: "peer", relation: "connects_to", description: "Outgoing link" });
    db.insertEdge({ from_id: "peer", to_id: "other", relation: "depends_on", description: "Incoming link" });

    expect(mergeNodes(db, "survivor", "other")).toEqual({ survivor: "survivor", removed: "other" });
    expect(db.getAllNodesRaw().map((node) => node.id).sort()).toEqual(["peer", "survivor"]);
    const survivor = db.getNode("survivor")!;
    expect(survivor.summary).toBe("First claim\n\nSecond claim");
    expect(survivor.why).toBe("Original rationale");
    expect(JSON.parse(survivor.file_refs!)).toEqual(["src/first.ts", "src/shared.ts", "src/second.ts"]);
    expect(db.getOutgoingEdges("survivor")).toEqual([
      expect.objectContaining({ from_id: "survivor", to_id: "peer", relation: "connects_to", description: "Outgoing link" }),
    ]);
    expect(db.getIncomingEdges("survivor")).toEqual([
      expect.objectContaining({ from_id: "peer", to_id: "survivor", relation: "depends_on", description: "Incoming link" }),
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const afterMerge = sqlState(db);
    expect(() => mergeNodes(db, "survivor", "other")).toThrow();
    expect(sqlState(db)).toEqual(afterMerge);
  });

  // F-03 (план 03): участники workflow не теряются молча вместе с дублем.
  it("moves children, slot, trail membership and task state to the survivor", () => {
    const db = database("workflow.db");
    addNode(db, "survivor", { summary: "First wording" });
    addNode(db, "other", { kind: "task", summary: "Second wording" });
    addNode(db, "child", { parent_id: "other" });
    addNode(db, "peer", { kind: "fact" });
    db.setTaskState("other", "open", "2030-06-01");
    db.setSlot("project", "handoff", "other");
    db.insertTrail({ id: "trail", name: "Chain", summary: "Saved reasoning", node_ids: ["peer", "other"] });
    const savedMembers = db.getTrailMembers("trail");

    expect(mergeNodes(db, "survivor", "other")).toEqual({ survivor: "survivor", removed: "other" });

    const survivor = db.getNode("survivor")!;
    expect(survivor.task_state).toBe("open");
    expect(survivor.due_at).toBe("2030-06-01");
    expect(db.getNode("child")?.parent_id).toBe("survivor");
    expect(db.getSlot("project", "handoff")?.node_id).toBe("survivor");
    expect(db.getTrailMembers("trail")).toEqual(
      savedMembers.map((m) => ({ ...m, node_id: m.node_id === "other" ? "survivor" : m.node_id }))
    );
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects consolidation into a descendant without changing the graph", () => {
    const db = database("cycle.db");
    addNode(db, "root", { summary: "Root" });
    addNode(db, "mid", { parent_id: "root" });
    addNode(db, "leaf", { parent_id: "mid" });
    const before = sqlState(db);

    expect(() => mergeNodes(db, "leaf", "root")).toThrow(/cycle/i);
    expect(sqlState(db)).toEqual(before);
  });

  // F-03.6 (план 03): read-only описание последствий для preview плана 07 —
  // валидация та же, что в apply, ничего не пишется.
  it("preview describes consequences, writes nothing and previews the rejection", () => {
    const db = database("preview.db");
    addNode(db, "survivor", { summary: "First wording" });
    addNode(db, "other", { kind: "task", summary: "Second wording", file_refs: ["src/shared.ts"] });
    addNode(db, "child", { parent_id: "other" });
    addNode(db, "peer", { kind: "fact" });
    db.setTaskState("other", "open", "2030-06-01");
    db.setSlot("project", "handoff", "other");
    db.insertTrail({ id: "trail", name: "Chain", summary: "Saved reasoning", node_ids: ["peer", "other"] });
    db.insertEdge({ from_id: "other", to_id: "peer", relation: "connects_to", description: "Outgoing link" });
    const before = sqlState(db);

    const preview = describeConsolidation(db, "survivor", "other");
    expect(preview.rejection).toBeUndefined();
    expect(sqlState(db)).toEqual(before);
    // UX-01 (план 07): последствия — списки, а не счётчики: preview
    // показывает, ЧТО именно переедет. Планировщик один для preview и apply.
    expect(preview).toMatchObject({
      survivor: "survivor",
      other: "other",
      summaryCombines: true,
      refsAdded: ["src/shared.ts"],
      edgesToMove: [
        { from_id: "survivor", to_id: "peer", relation: "connects_to", description: "Outgoing link" },
      ],
      children: [{ id: "child", name: "child" }],
      trailMembers: 1,
      taskCarries: true,
      taskState: "open",
      dueAt: "2030-06-01",
      // kind различается, но lifecycle/epistemic статусы одинаковы —
      // расхождения статусов нет, поэтому «статус дубля не переносится»
      // предупреждением не становится.
      statusDiverges: false,
    });
    expect(preview.slots).toEqual([{ project: "project", role: "handoff" }]);
    expect(preview.finalSummary).toContain("First wording");
    expect(preview.finalSummary).toContain("Second wording");
    // why нет ни у одной из нод — честный источник «none».
    expect(preview.whySource).toBe("none");

    const rejected = describeConsolidation(db, "child", "other");
    expect(rejected.rejection).toMatch(/cycle/i);
    expect(sqlState(db)).toEqual(before);
  });
});
