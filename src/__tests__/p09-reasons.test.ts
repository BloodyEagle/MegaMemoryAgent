import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import { activeArtifactRows, artifactsDigestOf } from "../artifacts.js";
import { CheckBudget, claimDigestOf, computeSupportCheck, confirmSupports, edgeDigestOf, statusDigestOf } from "../support-baselines.js";
import { provenanceTrace } from "../provenance.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";
let fixture: AuditFixture;
let db: KnowledgeDB;
beforeEach(() => { fixture = auditFixture(); db = fixture.db(); db.setMetaValue("embed_model", "none"); addNode(db, "decision", { kind: "decision" }); });
afterEach(async () => {
  await fixture.release(db);
  db = undefined as unknown as KnowledgeDB;
  (globalThis as { gc?: () => void }).gc?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await fixture.close();
});
function support(id: string) {
  addNode(db, id, { file_refs: ["evidence.txt"] });
  db.insertEdge({ from_id: "decision", to_id: id, relation: "informed_by", description: "Independent measurements" });
  observe(id, "old");
}
function observe(id: string, digest: string) {
  db.upsertNodeArtifact({ node_id: id, kind: "file", ref: "evidence.txt", digest, prev_digest: "old", checked_at: "2030-01-01", changed_at: "2030-01-01", size_bytes: null, checked_by: "agent", repo_path: fixture.root });
}
function confirmAll() {
  confirmSupports(db, { decision_id: "decision", expected_claim_digest: claimDigestOf(db.getNode("decision")!.summary), items: db.getInformedByEdges("decision", "ancestry", false).map((edge) => {
    const node = db.getNode(edge.other_id)!;
    return { support_id: node.id, expected_edge_key: String(edge.id), expected_claim_digest: claimDigestOf(node.summary), expected_status_digest: statusDigestOf(node.status, node.epistemic_status), expected_edge_digest: edgeDigestOf(edge.description), expected_artifacts_digest: artifactsDigestOf(activeArtifactRows(node, db.getNodeArtifacts(node.id))) };
  }) });
}
function verdict() { return computeSupportCheck(db, "decision", new CheckBudget(10000, 10000000))!; }
function weak() { return provenanceTrace(db, { node_id: "decision", direction: "ancestry", max_nodes: 200, max_check_edges: 10000, max_check_bytes: 10000000 }).weak_links; }

describe("P09 C05 independent change reasons", () => {
  it("counts every overlapping reason before either list is capped", () => {
    for (let i = 0; i < 55; i++) support(`s-${String(i).padStart(2, "0")}`);
    confirmAll();
    for (let i = 0; i < 55; i++) {
      const id = `s-${String(i).padStart(2, "0")}`;
      db.updateNode(id, { summary: "Changed exact source statement." });
      db.setNodeStatus(id, "deprecated"); observe(id, "new");
    }
    const check = verdict();
    expect(check.changed_count).toBe(55); expect(check.semantic_changed_count).toBe(55);
    expect(check.artifact_changed_count).toBe(55); expect(check.semantic_reason_counts).toEqual({ summary: 55, status: 55 });
    expect(check.semantic_changed).toHaveLength(50); expect(check.artifact_changed).toHaveLength(50);
    const links = weak();
    expect(links.find((link) => link.type === "support_changed")?.count).toBe(55);
    expect(links.find((link) => link.type === "support_changed")?.note).toContain("summary 55, status 55");
    expect(links.find((link) => link.type === "artifact_changed")?.count).toBe(55);
  });
  it("preserves artifact samples after a semantic-only prefix larger than the cap", () => {
    for (let i = 0; i < 55; i++) support(`a-${String(i).padStart(2, "0")}`);
    support("z-artifact"); confirmAll();
    for (let i = 0; i < 55; i++) db.updateNode(`a-${String(i).padStart(2, "0")}`, { summary: "Changed exact source statement." });
    observe("z-artifact", "new");
    const links = weak();
    expect(links.find((link) => link.type === "support_changed")?.count).toBe(55);
    expect(links.find((link) => link.type === "artifact_changed")).toMatchObject({ count: 1, sample: ["z-artifact"] });
  });
  it("work-budget exhaustion keeps a partial verdict instead of claiming full counts", () => {
    support("s1"); support("s2"); confirmAll();
    db.updateNode("s1", { summary: "Changed exact source statement." });
    const check = computeSupportCheck(db, "decision", new CheckBudget(1, 10000))!;
    expect(check.state).toBe("incomplete"); expect(check.incomplete).toBe(true);
    expect(check.semantic_changed_count).toBeLessThanOrEqual(1);
  });

  it.each(["summary", "artifact", "both", "disjoint"] as const)("reports honest independent counts for %s", (mode) => {
    support("s1"); if (mode === "disjoint") support("s2"); confirmAll();
    if (mode !== "artifact") db.updateNode("s1", { summary: "New independent measurement changed the exact statement." });
    if (mode !== "summary") observe(mode === "disjoint" ? "s2" : "s1", "new");
    const check = verdict();
    expect(check.semantic_changed_count).toBe(mode === "artifact" ? 0 : 1);
    expect(check.artifact_changed_count ?? 0).toBe(mode === "summary" ? 0 : 1);
    expect((check.changed_count ?? check.changed!.length)).toBe(mode === "disjoint" ? 2 : 1);
    const links = weak();
    expect(links.find((link) => link.type === "support_changed")?.count ?? 0).toBe(mode === "artifact" ? 0 : 1);
    expect(links.find((link) => link.type === "artifact_changed")?.count ?? 0).toBe(mode === "summary" ? 0 : 1);
  });
  it("keeps semantic samples after an artifact-only prefix larger than the response cap", () => {
    for (let i = 0; i < 55; i++) support(`a-${String(i).padStart(2, "0")}`);
    support("z-semantic"); confirmAll();
    for (let i = 0; i < 55; i++) observe(`a-${String(i).padStart(2, "0")}`, "new");
    db.updateNode("z-semantic", { summary: "A later independently measured statement changed." });
    const check = verdict();
    expect(check.changed_count).toBe(56); expect(check.artifact_changed_count).toBe(55);
    expect(check.semantic_changed_count).toBe(1); expect(check.semantic_reason_counts).toEqual({ summary: 1 });
    expect(check.semantic_changed!.map((pair) => pair.support)).toEqual(["z-semantic"]);
    const links = weak();
    expect(links.find((link) => link.type === "support_changed")).toMatchObject({ count: 1, sample: ["z-semantic"] });
    expect(links.find((link) => link.type === "artifact_changed")?.count).toBe(55);
  });
});
