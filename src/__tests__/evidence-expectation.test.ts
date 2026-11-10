import { describe, it, expect } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { createConcept, updateConcept, getConcept } from "../tools.js";
import { addNode } from "./helpers/audit.js";
import { claimDigestOf, statusDigestOf } from "../support-baselines.js";

describe("C-02 read expectations and C-03 validation binding", () => {
  it("a validated rewrite preserves the old artifact but cannot validate the opposite claim", async () => {
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      const result = await createConcept(db, { name: "Measured cache policy", kind: "feature", summary: "The measured cache policy reduces repeated reads in the tested environment because it reuses parsed module results without bypassing source freshness checks.", epistemic_status: "validated", status_scope: { artifact: "independent-run-1" }, force: true });
      expect(getConcept(db, { id: result.id! }).current_digests?.validation_state).toBe("current");
      await updateConcept(db, { id: result.id!, changes: { summary: "The measured cache policy increases repeated reads in the tested environment because it discards parsed module results and repeats source freshness checks." } });
      const current = getConcept(db, { id: result.id! });
      expect(current.current_digests?.validation_state).toBe("stale");
      expect(current.status_scope?.artifact).toBe("independent-run-1");
      expect(db.execSqlAll("SELECT claim_digest,scope_digest,status_scope FROM status_history WHERE node_id=?", result.id)).toEqual(expect.arrayContaining([expect.objectContaining({ claim_digest: claimDigestOf("The measured cache policy reduces repeated reads in the tested environment because it reuses parsed module results without bypassing source freshness checks.") })]));
    } finally { db.close(); }
  });

  it("reused evidence without an expectation is never auto-confirmed", async () => {
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db); addNode(db, "source");
      const result = await createConcept(db, { name: "New verified decision", kind: "decision", summary: "The decision follows the independent source measurement and constrains the module cache policy so concurrent updates cannot silently reuse unobserved evidence.", force: true, evidence: [{ node: "source", why: "The measurement constrains this decision." }] });
      expect(db.getAllSupportBaselines()).toEqual([]);
      expect(getConcept(db, { id: result.id! }).support_check?.state).toBe("unknown");
    } finally { db.close(); }
  });

  it("read matching evidence can bind the newly declared decision", async () => {
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db); addNode(db, "source");
      const source = db.getNode("source")!;
      const result = await createConcept(db, { name: "New verified decision", kind: "decision", summary: "The decision follows the independent source measurement and constrains the module cache policy so concurrent updates cannot silently reuse unobserved evidence.", force: true, evidence: [{ node: "source", why: "The measurement constrains this decision.", expect: { claim_digest: claimDigestOf(source.summary), status_digest: statusDigestOf(source.status, source.epistemic_status) } }] });
      expect(getConcept(db, { id: result.id! }).support_check?.state).toBe("unchanged");
    } finally { db.close(); }
  });
});
