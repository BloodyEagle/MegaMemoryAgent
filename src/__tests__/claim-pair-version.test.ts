import { describe, it, expect } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { claimDigestOf, statusDigestOf, edgeDigestOf, confirmSupports, computeSupportCheck, CheckBudget } from "../support-baselines.js";
import { addNode } from "./helpers/audit.js";

describe("C-01 pair-level decision claim", () => {
  it("subset confirmation does not pardon the other support of an old wording", () => {
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      addNode(db, "decision", { kind: "decision", summary: "Decision first wording" });
      for (const id of ["f", "g"]) {
        addNode(db, id);
        db.insertEdge({ from_id: "decision", to_id: id, relation: "informed_by", description: `Measurement from ${id}` });
      }
      const confirm = (ids: string[]) => confirmSupports(db, {
        decision_id: "decision", expected_claim_digest: claimDigestOf(db.getNode("decision")!.summary),
        items: ids.map(id => ({ support_id: id, expected_claim_digest: claimDigestOf(db.getNode(id)!.summary), expected_status_digest: statusDigestOf(db.getNode(id)!.status, db.getNode(id)!.epistemic_status), expected_edge_digest: edgeDigestOf(`Measurement from ${id}`) })),
      });
      confirm(["f", "g"]);
      db.updateNode("decision", { summary: "Decision opposite second wording" });
      confirm(["f"]);
      const partial = computeSupportCheck(db, "decision", new CheckBudget(100, 100000))!;
      expect(partial.state).toBe("unknown");
      expect(partial.unknown).toContain("g");
      confirm(["g"]);
      expect(computeSupportCheck(db, "decision", new CheckBudget(100, 100000))?.state).toBe("unchanged");
    } finally { db.close(); }
  });
});
