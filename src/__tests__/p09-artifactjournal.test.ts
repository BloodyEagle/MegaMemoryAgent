import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { activeArtifactRows, artifactsDigestOf, checkArtifacts } from "../artifacts.js";
import { CheckBudget, claimDigestOf, computeSupportCheck, confirmSupports, edgeDigestOf, provenanceHistory, statusDigestOf } from "../support-baselines.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
let db: KnowledgeDB;
beforeEach(() => {
  fixture = auditFixture();
  db = fixture.db();
  db.setMetaValue("embed_model", "none");
  addNode(db, "decision", { kind: "decision" });
  addNode(db, "support", { file_refs: ["evidence.txt"] });
  db.insertEdge({ from_id: "decision", to_id: "support", relation: "informed_by", description: "Measured evidence" });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await fixture.release(db); db = undefined as unknown as KnowledgeDB; await fixture.close(); });

function observe(digest: string | null) {
  db.upsertNodeArtifact({ node_id: "support", kind: "file", ref: "evidence.txt", digest, prev_digest: null,
    size_bytes: null, checked_at: new Date().toISOString(), changed_at: null, checked_by: "agent", repo_path: fixture.root });
}
function confirm() {
  const support = db.getNode("support")!;
  const edge = db.getInformedByEdges("decision", "ancestry", false)[0];
  return confirmSupports(db, { decision_id: "decision", expected_claim_digest: claimDigestOf(db.getNode("decision")!.summary), items: [{
    support_id: "support", expected_edge_key: String(edge.id), expected_claim_digest: claimDigestOf(support.summary),
    expected_status_digest: statusDigestOf(support.status, support.epistemic_status), expected_edge_digest: edgeDigestOf(edge.description),
    expected_artifacts_digest: artifactsDigestOf(activeArtifactRows(support, db.getNodeArtifacts("support"))),
  }] });
}

describe("P09 C04 artifact journal", () => {
  it("legacy history explicitly exposes unknown nullable columns without borrowing current observations", () => {
    observe("current-but-not-historical");
    db.insertSupportRevision({ decision_id: "decision", support_id: "support", edge_key: "old", claim_digest: "old-claim", status_digest: "old-status", edge_digest: "old-rationale", format_version: 1, confirmed_at: "2030-01-01", recorded_at: new Date().toISOString(), source: "import", reason: null });
    const entry = provenanceHistory(db, { decision_id: "decision", support_id: "support" }).pairs[0].revisions[0];
    expect(entry).toMatchObject({ decision_claim_digest: null, artifacts_digest: null, confirmed_by: null, superseded_at: null, format_version: 1, is_current: false });
  });
  it("explicit expected null is exact, not a wildcard for non-null observations", () => {
    observe("observed-version");
    const support = db.getNode("support")!; const edge = db.getInformedByEdges("decision", "ancestry", false)[0];
    expect(() => confirmSupports(db, { decision_id: "decision", expected_claim_digest: claimDigestOf(db.getNode("decision")!.summary), items: [{ support_id: "support", expected_claim_digest: claimDigestOf(support.summary), expected_status_digest: statusDigestOf(support.status, support.epistemic_status), expected_edge_digest: edgeDigestOf(edge.description), expected_artifacts_digest: null }] })).toThrow(/version_conflict/);
    expect(db.countSupportRevisions()).toBe(0);
    expect(db.getSupportBaselines("decision")).toEqual([]);
  });
  it("edge identity mismatch refuses despite unchanged rationale", () => {
    const support = db.getNode("support")!; const edge = db.getInformedByEdges("decision", "ancestry", false)[0];
    expect(() => confirmSupports(db, { decision_id: "decision", expected_claim_digest: claimDigestOf(db.getNode("decision")!.summary), items: [{ support_id: "support", expected_edge_key: "displaced-edge", expected_claim_digest: claimDigestOf(support.summary), expected_status_digest: statusDigestOf(support.status, support.epistemic_status), expected_edge_digest: edgeDigestOf(edge.description) }] })).toThrow(/version_conflict/);
    expect(db.countSupportRevisions()).toBe(0);
  });
  it("stable file checks and observed missing remain distinct from absent observations", async () => {
    fs.writeFileSync(fixture.file("evidence.txt"), "bytes", "utf8");
    const first = await checkArtifacts(db, { node_ids: ["support"], cwd: fixture.root });
    expect(first).toMatchObject({ checked: 1, changed: [], missing: [], truncated: false });
    const observed = db.getNodeArtifacts("support")[0];
    const second = await checkArtifacts(db, { node_ids: ["support"], cwd: fixture.root });
    expect(second.changed).toEqual([]); expect(db.getNodeArtifacts("support")[0].changed_at).toBeNull();
    fs.unlinkSync(fixture.file("evidence.txt"));
    await checkArtifacts(db, { node_ids: ["support"], cwd: fixture.root });
    const missing = db.getNodeArtifacts("support")[0];
    expect(missing.digest).toBeNull(); expect(missing.prev_digest).toBe(observed.digest);
    expect(artifactsDigestOf([missing])).not.toBeNull(); expect(artifactsDigestOf([])).toBeNull();
  });

  it("does not adopt an unread artifact observation when the expectation is absent", () => {
    observe("unread-artifact");
    const support = db.getNode("support")!;
    const edge = db.getInformedByEdges("decision", "ancestry", false)[0];
    confirmSupports(db, { decision_id: "decision", expected_claim_digest: claimDigestOf(db.getNode("decision")!.summary), items: [{
      support_id: "support", expected_claim_digest: claimDigestOf(support.summary), expected_edge_key: String(edge.id),
      expected_status_digest: statusDigestOf(support.status, support.epistemic_status), expected_edge_digest: edgeDigestOf(edge.description),
    }] });
    expect(db.getSupportBaselines("decision")[0].artifacts_digest).toBeNull();
  });
  it.each(["refs", "observation", "root"] as const)("refuses an unread concurrent %s after hashing without overwriting it", async (axis) => {
    fs.writeFileSync(fixture.file("evidence.txt"), "checked bytes", "utf8");
    observe("previous-observation");
    const stat = fs.promises.stat.bind(fs.promises);
    let changed = false;
    vi.spyOn(fs.promises, "stat").mockImplementation((async (...args: Parameters<typeof fs.promises.stat>) => {
      const result = await stat(...args);
      if (!changed) {
        changed = true;
        if (axis === "refs") db.updateNode("support", { file_refs: ["different.txt"] });
        else {
          const row = db.getNodeArtifacts("support")[0];
          db.upsertNodeArtifact({ ...row, ...(axis === "root" ? { repo_path: path.join(fixture.root, "other-root") } : { digest: "concurrent-observation" }) });
        }
      }
      return result;
    }) as typeof fs.promises.stat);
    await expect(checkArtifacts(db, { node_ids: ["support"], cwd: fixture.root })).rejects.toThrow(/version_conflict/);
    expect(db.getNodeArtifacts("support")[0].digest).toBe(axis === "observation" ? "concurrent-observation" : "previous-observation");
    vi.restoreAllMocks();
  });

  it("orders displaced revisions newest-first even when confirmation timestamps tie", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    observe("first"); confirm(); const first = db.getSupportBaselines("decision")[0].artifacts_digest;
    observe("second"); confirm(); const second = db.getSupportBaselines("decision")[0].artifacts_digest;
    observe("third"); confirm();
    const displaced = provenanceHistory(db, { decision_id: "decision", support_id: "support" }).pairs[0].revisions.filter((entry) => entry.source === "superseded");
    expect(displaced.map((entry) => entry.artifacts_digest)).toEqual([second!.slice(0, 12), first!.slice(0, 12)]);
  });
  it("preserves displaced artifact v1/v2 and full nullable history metadata without inventing old digests", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    observe("artifact-v1"); confirm();
    const v1 = db.getSupportBaselines("decision")[0];
    vi.setSystemTime(new Date("2030-01-02T00:00:00Z"));
    observe("artifact-v2"); confirm();
    const v2 = db.getSupportBaselines("decision")[0];
    vi.setSystemTime(new Date("2030-01-03T00:00:00Z"));
    observe("artifact-v3"); confirm();
    const v3 = db.getSupportBaselines("decision")[0];
    const count = db.countSupportRevisions();
    confirm();
    expect(db.countSupportRevisions()).toBe(count);
    const history = provenanceHistory(db, { decision_id: "decision", support_id: "support" }).pairs[0].revisions;
    expect(history[0]).toMatchObject({ artifacts_digest: v3.artifacts_digest!.slice(0, 12), decision_claim_digest: v3.decision_claim_digest!.slice(0, 12), confirmed_by: "agent", superseded_at: null, is_current: true });
    const displaced = history.filter((entry) => entry.source === "superseded");
    expect(displaced.map((entry) => entry.artifacts_digest)).toEqual([v2.artifacts_digest!.slice(0, 12), v1.artifacts_digest!.slice(0, 12)]);
    expect(displaced.map((entry) => entry.confirmed_at)).toEqual(["2030-01-02T00:00:00.000Z", "2030-01-01T00:00:00.000Z"]);
    expect(displaced.every((entry) => entry.confirmed_by === "agent" && entry.superseded_at === null)).toBe(true);
    expect(computeSupportCheck(db, "decision", new CheckBudget(100, 100000))!.state).toBe("unchanged");
  });
});
