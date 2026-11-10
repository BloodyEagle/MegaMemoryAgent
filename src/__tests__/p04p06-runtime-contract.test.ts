import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { describeConsolidation, mergeNodes } from "../consolidate.js";
import { auditFixture, sqlState } from "./helpers/audit.js";
import { CheckBudget, claimDigestOf, computeSupportCheck, confirmSupports, edgeDigestOf, statusDigestOf } from "../support-baselines.js";

// Agreed P06 seams: describeConsolidation + mergeNodes + published aggregate.
// Native execution waits for the stable schema14 handoff and coordinator slot.
const owned: KnowledgeDB[] = [];
afterEach(() => {
  for (const db of owned.splice(0)) db.close();
  (globalThis as { gc?: () => void }).gc?.();
});
function database(): KnowledgeDB {
  const db = new KnowledgeDB(":memory:");
  owned.push(db);
  ensureSchema(db);
  for (const id of ["keep", "duplicate", "support"]) {
    db.insertNode({ id, name: "Одинаковая мысль", kind: "decision", summary: "Подтверждённая формулировка" });
  }
  return db;
}

describe("P06 native full aggregate acceptance", () => {
  it("applies the exact tombstone plan without losing edge identity, origin, acceptance or merge history", () => {
    const db = database();
    const edge = db.insertEdgeRaw({
      from_id: "duplicate", to_id: "support", relation: "informed_by",
      description: "Историческая опора", created_at: "2026-01-01 00:00:00",
      removed_at: "2026-03-01 00:00:00", created_via: "agent",
      accepted_at: "2026-02-01 00:00:00", merge_group: "prior-group",
      needs_merge: 1, source_branch: "original", merge_timestamp: "2026-02-02 00:00:00",
    });
    const plan = describeConsolidation(db, "keep", "duplicate");
    expect(plan.rejection).toBeUndefined();
    const beforePreview = sqlState(db);
    expect(describeConsolidation(db, "keep", "duplicate").base.digest).toBe(plan.base.digest);
    expect(sqlState(db)).toEqual(beforePreview);
    mergeNodes(db, "keep", "duplicate", { expect: plan.base });
    expect(db.getAllEdgesRaw()).toEqual([{
      id: edge.id, from_id: "keep", to_id: "support", relation: "informed_by",
      description: "Историческая опора", created_at: "2026-01-01 00:00:00",
      removed_at: "2026-03-01 00:00:00", created_via: "agent",
      accepted_at: "2026-02-01 00:00:00", merge_group: "prior-group",
      needs_merge: 1, source_branch: "original", merge_timestamp: "2026-02-02 00:00:00",
    }]);
    expect(db.getNodeIncludingRemoved("duplicate")).toBeUndefined();
  });

  it("rejects a same-count artifact observation mutation after preview before any consolidate write", () => {
    const db = database();
    const artifact = {
      node_id: "duplicate", kind: "file" as const, ref: "source.ts", digest: "observed-v1",
      prev_digest: null, size_bytes: 3, checked_at: "2026-02-01 00:00:00",
      changed_at: null, checked_by: "original actor", repo_path: "C:/owned/repository",
    };
    db.upsertNodeArtifact(artifact);
    const plan = describeConsolidation(db, "keep", "duplicate");
    db.upsertNodeArtifact({ ...artifact, digest: "observed-v2", repo_path: "C:/owned/different-repository" });
    const changed = sqlState(db);
    expect(() => mergeNodes(db, "keep", "duplicate", { expect: plan.base })).toThrow(/version_conflict/);
    expect(sqlState(db)).toEqual(changed);
  });

  it("keeps a confirmed identity-only pair unchanged and reachable with the original edge key", () => {
    const db = database();
    const edge = db.insertEdgeRaw({ from_id: "duplicate", to_id: "support", relation: "informed_by",
      description: "Точная причина подтверждения", created_via: "agent" });
    const support = db.getNode("support")!;
    confirmSupports(db, { decision_id: "duplicate",
      expected_claim_digest: claimDigestOf(db.getNode("duplicate")!.summary),
      items: [{ support_id: "support", expected_claim_digest: claimDigestOf(support.summary),
        expected_status_digest: statusDigestOf(support.status, support.epistemic_status),
        expected_edge_digest: edgeDigestOf("Точная причина подтверждения"),
        expected_edge_key: String(edge.id), expected_artifacts_digest: null }] });
    expect(computeSupportCheck(db, "duplicate", new CheckBudget(100, 1000000))?.state).toBe("unchanged");
    const history = db.getSupportRevisions("duplicate", "support", 1000);
    const plan = describeConsolidation(db, "keep", "duplicate");
    mergeNodes(db, "keep", "duplicate", { expect: plan.base });
    expect(db.getSupportBaselineRow("keep", "support", String(edge.id))).toBeDefined();
    expect(db.getSupportRevisions("keep", "support", 1000)).toHaveLength(history.length);
    expect(computeSupportCheck(db, "keep", new CheckBudget(100, 1000000))?.state).toBe("unchanged");
  });

  it("invalidates the removed node's native vector projection instead of copying it blindly", async () => {
    const fixture = auditFixture();
    try {
      const db = fixture.db("vectors.db");
      ensureSchema(db);
      for (const id of ["keep", "duplicate"]) {
        db.insertNode({ id, name: "Одинаковая мысль", kind: "decision", summary: "Подтверждённая формулировка" });
      }
      const bytes = Buffer.alloc(8);
      bytes.writeFloatLE(0.25, 0);
      bytes.writeFloatLE(-0.5, 4);
      db.upsertVector("duplicate", bytes);
      expect(db.vectorSupportOk()).toBe(true);
      const plan = describeConsolidation(db, "keep", "duplicate");
      mergeNodes(db, "keep", "duplicate", { expect: plan.base });
      // Frozen derived-invalidate: foreign vector payload is not blind-copied
      // onto the survivor — the projection leaves with its owner node.
      expect(db.execSqlAll("SELECT id FROM nodes_vec")).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
