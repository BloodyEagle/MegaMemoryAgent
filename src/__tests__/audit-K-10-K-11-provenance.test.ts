import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkArtifacts } from "../artifacts.js";
import { ensureSchema } from "../migrate-schema.js";
import { provenanceTrace } from "../provenance.js";
import { CheckBudget, computeSupportCheck, confirmSupports } from "../support-baselines.js";
import { getConcept, link, updateConcept } from "../tools.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";
import type { KnowledgeDB } from "../db.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("Audit tests must not load an inference model"); }),
}));

let fixture: AuditFixture;
beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
});
afterEach(async () => { await fixture.close(); });

function freshDb() {
  const db = fixture.db();
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-disabled-vector-space");
  return db;
}

// Only server-returned digests cross this seam: no client-side hashing.
function readConfirmation(db: KnowledgeDB, decision: string) {
  const trace = provenanceTrace(db, { node_id: decision });
  return {
    decision_id: decision,
    expected_claim_digest: trace.current_digests!.claim,
    items: (trace.supports ?? []).map((support) => ({
      support_id: support.support_id,
      expected_claim_digest: support.claim_digest!,
      expected_status_digest: support.status_digest!,
      expected_edge_digest: support.edge_digest,
      // R-04/frozen 14: the artifact anchor is written only when the agent
      // pins what it read; an unpinned confirm leaves the anchor NULL.
      expected_artifacts_digest: support.artifacts_digest,
    })),
  };
}

function supportCheck(db: KnowledgeDB, decision = "consumer") {
  return computeSupportCheck(db, decision, new CheckBudget(5000, 2_000_000));
}

describe("K-10: rereading returns a confirmable current claim digest", () => {
  it.each(["get_concept", "provenance_trace"] as const)("P1: confirm -> edit -> reread -> confirm succeeds via %s", async (reader) => {
    const db = freshDb();
    addNode(db, "decision", { kind: "decision", summary: "Initial independent claim about the cache policy." });
    const first = getConcept(db, { id: "decision" });
    confirmSupports(db, { decision_id: "decision", expected_claim_digest: first.current_digests!.claim, items: [] });
    await updateConcept(db, { id: "decision", changes: { summary: "The revised claim describes a different independently measured invalidation sequence." } });
    const snapshot = db.getNode("decision")!.claim_digest;

    const current = reader === "get_concept"
      ? getConcept(db, { id: "decision" }).current_digests!
      : provenanceTrace(db, { node_id: "decision" }).current_digests!;

    expect.soft(current.claim).not.toBe(first.current_digests!.claim);
    expect(db.getNode("decision")!.claim_digest).toBe(snapshot);
    expect(() => confirmSupports(db, { decision_id: "decision", expected_claim_digest: current.claim, items: [] })).not.toThrow();
    expect(supportCheck(db, "decision")?.state).toBe("unchanged");
  });

  it("the first read can confirm a decision and its support without client-side hashing", () => {
    const db = freshDb();
    addNode(db, "decision", { kind: "decision" });
    addNode(db, "source");
    link(db, { from: "decision", to: "source", relation: "informed_by", description: "Independent evidence explains the policy." });

    const result = confirmSupports(db, readConfirmation(db, "decision"));

    expect(result.confirmed).toBe(1);
    expect(supportCheck(db, "decision")?.state).toBe("unchanged");
  });

  it("rejects an old claim digest after editing, leaving all tables unchanged", async () => {
    const db = freshDb();
    addNode(db, "decision", { kind: "decision" });
    const first = readConfirmation(db, "decision");
    confirmSupports(db, first);
    await updateConcept(db, { id: "decision", changes: { summary: "The revised independent measurement establishes a different cache policy." } });
    const before = sqlState(db);

    expect(() => confirmSupports(db, first)).toThrow(/version_conflict/);

    expect(sqlState(db)).toEqual(before);
  });
});

async function artifactSource(db: KnowledgeDB, refs: string[], source = "source", consumer = "consumer") {
  addNode(db, source, { file_refs: refs });
  addNode(db, consumer, { kind: "decision" });
  link(db, { from: consumer, to: source, relation: "informed_by", description: "The referenced independent measurement supports this decision." });
  await checkArtifacts(db, { node_ids: [source], cwd: fixture.root });
  confirmSupports(db, readConfirmation(db, consumer));
  expect(supportCheck(db, consumer)?.state).toBe("unchanged");
}

function evidenceFile(name: string, content: string) {
  const file = fixture.file(name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

describe("K-11: active artifact fingerprints follow the current reference set", () => {
  it("P3: removing the final file reference invalidates the confirmed support", async () => {
    const db = freshDb();
    const one = evidenceFile("one.txt", "The first independently observed artifact.");
    await artifactSource(db, [one]);

    await updateConcept(db, { id: "source", changes: { file_refs: [] } });
    const checked = await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });

    expect(checked.checked).toBe(0);
    expect(getConcept(db, { id: "source" }).file_refs).toEqual([]);
    expect(supportCheck(db)).toMatchObject({ state: "changed", artifact_changed_count: 1 });
  });

  it("P2: replacement fingerprints contain the active references, not historical observations", async () => {
    const db = freshDb();
    const one = evidenceFile("one.txt", "The initial independent observation.");
    const two = evidenceFile("two.txt", "The replacement independent observation.");
    await artifactSource(db, [one]);
    await updateConcept(db, { id: "source", changes: { file_refs: [two] } });
    await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });
    confirmSupports(db, readConfirmation(db, "consumer"));

    // Control has exactly the same active evidence, without the removed reference's history.
    await artifactSource(db, [two], "clean-source", "clean-consumer");
    const clean = db.getActiveSupportBaselines("clean-consumer")[0].artifacts_digest;
    const replaced = db.getActiveSupportBaselines("consumer")[0].artifacts_digest;

    expect(clean).toBeTruthy();
    expect(replaced).toBe(clean);
  });

  it("replacing a checked file reference is a change, even without altering the source summary", async () => {
    const db = freshDb();
    const one = evidenceFile("one.txt", "The initial independent observation.");
    const two = evidenceFile("two.txt", "The replacement independent observation.");
    await artifactSource(db, [one]);

    await updateConcept(db, { id: "source", changes: { file_refs: [two] } });
    await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });

    expect(supportCheck(db)).toMatchObject({ state: "changed", artifact_changed_count: 1 });
  });

  it("checking unchanged evidence retains a confirmed unchanged support", async () => {
    const db = freshDb();
    const one = evidenceFile("one.txt", "An unchanged independently observed artifact.");
    await artifactSource(db, [one]);

    const result = await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });

    expect(result).toEqual({ checked: 1, changed: [], missing: [], truncated: false });
    expect(supportCheck(db)?.state).toBe("unchanged");
  });

  it("a truncated scan does not retire the unchecked tail of active references", async () => {
    const db = freshDb();
    const one = evidenceFile("one.txt", "The first independent artifact.");
    const two = evidenceFile("two.txt", "The second independent artifact.");
    await artifactSource(db, [one, two]);
    const baseline = db.getActiveSupportBaselines("consumer")[0].artifacts_digest;

    const result = await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root, max_files: 1 });

    expect(result).toEqual({ checked: 1, changed: [], missing: [], truncated: true });
    expect(getConcept(db, { id: "source" }).file_refs).toEqual([one, two]);
    expect(supportCheck(db)?.state).toBe("unchanged");
    expect(db.getActiveSupportBaselines("consumer")[0].artifacts_digest).toBe(baseline);
  });
});
