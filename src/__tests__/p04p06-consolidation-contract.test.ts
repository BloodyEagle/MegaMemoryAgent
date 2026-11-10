import { describe, expect, it } from "vitest";
import { planConsolidation, type ConsolidationPlanInput } from "../consolidate.js";
import type { EdgeRow, NodeRow } from "../types.js";

// Agreed P06 seam: the public pure planner. No native DB/model/fixtures.
// Expected payload is a literal historical row, not recomputed from the plan.
function node(id: string): NodeRow {
  return {
    id, name: "Одно утверждение", kind: "decision", summary: "Подтверждённая формулировка",
    why: null, file_refs: null, parent_id: null, created_by_task: "Исторический контекст",
    created_at: "2026-01-01 00:00:00", updated_at: "2026-01-02 00:00:00",
    removed_at: null, removed_reason: null, embedding: null, merge_group: null,
    needs_merge: 0, source_branch: null, merge_timestamp: null, status: "active",
    valid_from: null, valid_until: null, epistemic_status: null, status_scope: null,
    task_state: null, due_at: null, claim_digest: null, claim_digest_at: null,
    created_via: "agent",
  };
}

function input(edges: EdgeRow[]): ConsolidationPlanInput {
  const survivor = node("keep"), other = node("duplicate"), support = node("support");
  return {
    survivor, other, nodes: [survivor, other, support], edges,
    workflow: { slots: [], trailMembers: 0, artifacts: 0, baselines: 0 },
  };
}

export const historicalEdge: EdgeRow = {
  id: 41, from_id: "duplicate", to_id: "support", relation: "informed_by",
  description: "Первоначальная причина опоры", created_at: "2026-02-01 00:00:00",
  merge_group: "historical-group", needs_merge: 1, source_branch: "original-branch",
  merge_timestamp: "2026-02-02 00:00:00", removed_at: "2026-03-01 00:00:00",
  created_via: "agent", accepted_at: "2026-02-03 00:00:00",
};

describe("P06 full provenance plan contract", () => {
  it("plans a tombstoned support with its original identity and every metadata field", () => {
    const plan = planConsolidation(input([{ ...historicalEdge }]));
    expect(plan.rejection).toBeUndefined();
    expect(plan.edgesDropped).toBe(0);
    expect(plan.edgesToMove).toEqual([{
      id: 41, from_id: "keep", to_id: "support", relation: "informed_by",
      description: "Первоначальная причина опоры", created_at: "2026-02-01 00:00:00",
      merge_group: "historical-group", needs_merge: 1, source_branch: "original-branch",
      merge_timestamp: "2026-02-02 00:00:00", removed_at: "2026-03-01 00:00:00",
      created_via: "agent", accepted_at: "2026-02-03 00:00:00",
    }]);
  });

  it.each([
    ["accepted_at", "2026-04-01 00:00:00"],
    ["created_via", "import"],
    ["merge_group", "changed-group"],
    ["source_branch", "changed-branch"],
    ["merge_timestamp", "2026-04-02 00:00:00"],
    ["needs_merge", 0],
    ["created_at", "2026-04-03 00:00:00"],
  ])("binds preview CAS to the full edge %s payload", (field, value) => {
    const before = planConsolidation(input([{ ...historicalEdge }]));
    const changed = { ...historicalEdge, [field]: value };
    const after = planConsolidation(input([changed]));
    expect(after.base.digest).not.toBe(before.base.digest);
  });

  it("rejects a stale full history payload even when row counts and graph are unchanged", () => {
    const graph = input([{ ...historicalEdge }]);
    const before = planConsolidation({ ...graph, aggregate: {
      tables: { support_revisions: [{ id: 9, decision_id: "duplicate", edge_key: "41", artifacts_digest: "observed-v1", confirmed_by: "original actor" }] },
    } } as ConsolidationPlanInput);
    const after = planConsolidation({ ...graph, aggregate: {
      tables: { support_revisions: [{ id: 9, decision_id: "duplicate", edge_key: "41", artifacts_digest: "observed-v2", confirmed_by: "original actor" }] },
    } } as ConsolidationPlanInput);
    expect(after.base.digest).not.toBe(before.base.digest);
  });

  it("refuses a full edge PK collision instead of reporting a silently dropped history", () => {
    const existing: EdgeRow = { ...historicalEdge, id: 12, from_id: "keep", description: "Другая историческая причина" };
    const plan = planConsolidation(input([{ ...historicalEdge }, existing]));
    expect(plan.rejection).toMatch(/collision/i);
    expect(plan.edgesDropped).toBe(0);
  });

  it("refuses a historical self-loop contraction rather than deleting its saved evidence", () => {
    const edge: EdgeRow = { ...historicalEdge, to_id: "keep", relation: "depends_on" };
    const plan = planConsolidation(input([edge]));
    expect(plan.rejection).toMatch(/self.loop/i);
    expect(plan.edgesDropped).toBe(0);
  });

  it("pins carried BLOB payload and distinguishes absent from null in full aggregate CAS", () => {
    const graph = input([]);
    const first = planConsolidation({ ...graph, aggregate: { tables: {
      nodes_vec: [{ id: "duplicate", embedding: Buffer.from([1, 2]), generation: 7 }],
    } } });
    const changed = planConsolidation({ ...graph, aggregate: { tables: {
      nodes_vec: [{ id: "duplicate", embedding: Buffer.from([1, 3]), generation: 7 }],
    } } });
    expect(changed.base.digest).not.toBe(first.base.digest);
  });

  it("refuses to make a live informed_by edge point at a removed endpoint", () => {
    const graph = input([{ ...historicalEdge, removed_at: null }]);
    graph.nodes[2] = { ...graph.nodes[2], removed_at: "2026-05-01 00:00:00" };
    const plan = planConsolidation(graph);
    expect(plan.rejection).toMatch(/removed endpoint/i);
    expect(plan.edgesDropped).toBe(0);
  });

  it("pins the complete affected support node rather than only its id and parent", () => {
    const before = input([{ ...historicalEdge }]);
    const after = input([{ ...historicalEdge }]);
    after.nodes[2] = { ...after.nodes[2], summary: "Изменённая опора при тех же связях" };
    expect(planConsolidation(after).base.digest).not.toBe(planConsolidation(before).base.digest);
  });

  it("refuses malformed saved file_refs instead of converting preserved raw payload to an empty list", () => {
    const graph = input([]);
    graph.other = { ...graph.other, file_refs: "[невалидный JSON" };
    graph.nodes[1] = graph.other;
    expect(planConsolidation(graph).rejection).toMatch(/file_refs/i);
  });

  it("predicts parent cycles before any identity transfer", () => {
    const graph = input([]);
    graph.survivor = { ...graph.survivor, parent_id: "duplicate" };
    graph.nodes[0] = graph.survivor;
    expect(planConsolidation(graph).rejection).toMatch(/hierarchy.*cycle/i);
  });

  it("pins a changed canonical vector payload in the complete affected node aggregate", () => {
    const before = input([]), after = input([]);
    before.nodes[2] = { ...before.nodes[2], embedding: Buffer.from([1, 2]) };
    after.nodes[2] = { ...after.nodes[2], embedding: Buffer.from([1, 3]) };
    expect(planConsolidation(after).base.digest).not.toBe(planConsolidation(before).base.digest);
  });

  it("preview refuses an artifact PK collision that cannot preserve both observations", () => {
    const graph = input([]);
    graph.aggregate = { tables: { node_artifacts: [
      { node_id: "duplicate", kind: "file", ref: "source.ts", digest: "observed-left", checked_by: "left actor" },
      { node_id: "keep", kind: "file", ref: "source.ts", digest: "observed-right", checked_by: "right actor" },
    ] } };
    expect(planConsolidation(graph).rejection).toMatch(/node_artifacts.*collision/i);
  });

  it("preview refuses a pair snapshot collision instead of silently choosing a baseline", () => {
    const graph = input([]);
    graph.aggregate = { tables: { support_baselines: [
      { decision_id: "duplicate", support_id: "support", edge_key: "41", artifacts_digest: "left" },
      { decision_id: "keep", support_id: "support", edge_key: "41", artifacts_digest: "right" },
    ] } };
    expect(planConsolidation(graph).rejection).toMatch(/support_baselines.*collision/i);
  });

  it("preview refuses a digest lookup-key collision before losing the captured membership", () => {
    const graph = input([]);
    graph.aggregate = { tables: { digest_sources: [
      { digest_id: "duplicate", sources: '[{"node_id":"duplicate","version":"left"}]', format_version: 1 },
      { digest_id: "keep", sources: '[{"node_id":"keep","version":"right"}]', format_version: 1 },
    ] } };
    expect(planConsolidation(graph).rejection).toMatch(/digest_sources.*collision/i);
  });
});
