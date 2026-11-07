import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeNodes } from "../consolidate.js";
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
});
