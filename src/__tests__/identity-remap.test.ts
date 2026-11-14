import { describe, it, expect } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { sqlState, addNode, auditFixture } from "./helpers/audit.js";
import { runResolve } from "../merge-cli.js";
import { applyIdRepair } from "../migrate.js";

function aggregate(db: KnowledgeDB, id: string) {
  db.setSlot("project", "handoff", id);
  db.insertTrail({ id: "trail", name: "trail", summary: "Independent reasoning steps", node_ids: [id] });
  db.upsertNodeArtifact({ node_id: id, kind: "file", ref: "source.txt", digest: "artifact-v1", prev_digest: null, size_bytes: 1, checked_at: "2026-11-10T00:00:00Z", changed_at: null, checked_by: "tester", repo_path: null });
  db.recordAlias("historic", id);
  db.upsertSupportBaseline({ decision_id: id, support_id: "support", edge_key: "1", claim_digest: "claim", status_digest: "status", edge_digest: "edge", format_version: 1, confirmed_at: "2026-11-10T00:00:00Z", confirmed_by: "tester", superseded_at: null, artifacts_digest: "artifact" });
  db.insertSupportRevision({ decision_id: id, support_id: "support", edge_key: "1", claim_digest: "claim", status_digest: "status", edge_digest: "edge", format_version: 1, confirmed_at: "2026-11-10T00:00:00Z", recorded_at: "2026-11-10T00:00:00Z", source: "agent", reason: null });
  db.execSqlRun("CREATE TABLE digest_sources(digest_id TEXT PRIMARY KEY, sources TEXT NOT NULL)");
  db.execSqlRun("INSERT INTO digest_sources VALUES (?, ?)", id, JSON.stringify([{ node_id: id, version: "preserved" }]));
  db.execSqlRun("INSERT INTO status_history(node_id,from_status,to_status,reason,at) VALUES (?, 'active', 'superseded', 'historic transition', '2026-11-10')", id);
}

describe("B-03 complete technical identity remap", () => {
  it("moves operational and history lookup keys without rewriting fingerprints", () => {
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      addNode(db, "old"); addNode(db, "support"); addNode(db, "child", { parent_id: "old" });
      db.insertEdge({ from_id: "old", to_id: "support", relation: "informed_by", description: "Independent support" });
      aggregate(db, "old");
      db.insertProvenanceAuditRun({ root_id: "old", direction: "ancestry", params: {}, result: { nodes: [{ id: "old" }] } });
      db.execSqlRun("INSERT INTO timeline(tool,params,result_summary,is_write,is_error,affected_ids) VALUES ('test', ?, 'historic old', 0, 0, ?)", JSON.stringify({ id: "old" }), JSON.stringify(["old"]));
      const beforeFingerprint = db.getTrailMembers("trail")[0].fingerprint;
      expect(db.renameNodeId("old", "new")).toBe(true);
      expect(db.getNode("new")).toBeDefined();
      expect(db.getNode("child")?.parent_id).toBe("new");
      expect(db.getTrailMembers("trail")[0]).toMatchObject({ node_id: "new", fingerprint: beforeFingerprint });
      expect(db.getNodeArtifacts("new")).toHaveLength(1);
      expect(db.execSqlFirst("SELECT node_id FROM slots")).toMatchObject({ node_id: "new" });
      expect(db.execSqlFirst("SELECT new_id FROM aliases WHERE old_id='historic'")).toMatchObject({ new_id: "new" });
      expect(db.execSqlFirst("SELECT decision_id FROM support_revisions")).toMatchObject({ decision_id: "new" });
      const digest = db.execSqlFirst("SELECT * FROM digest_sources") as { digest_id: string; sources: string };
      expect(digest.digest_id).toBe("new");
      expect(JSON.parse(digest.sources)).toEqual([{ node_id: "new", version: "preserved" }]);
      expect(db.execSqlFirst("SELECT node_id FROM status_history")).toMatchObject({ node_id: "new" });
      const audit = db.getProvenanceAuditRuns("new")[0];
      expect(JSON.parse(audit.result!)).toEqual({ nodes: [{ id: "old" }] });
      const timeline = db.execSqlFirst("SELECT params,affected_ids FROM timeline WHERE tool='test'") as { params: string; affected_ids: string };
      expect(JSON.parse(timeline.params)).toEqual({ id: "old" });
      expect(JSON.parse(timeline.affected_ids)).toEqual(["old"]);
      expect(db.getSupportBaselineRow("new", "support", "1")).toMatchObject({ claim_digest: "claim", artifacts_digest: "artifact" });
    } finally { db.close(); }
  });

  it("repair-ids uses the same aggregate remap and leaves old aliases resolvable", () => {
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      addNode(db, "old/"); addNode(db, "support"); aggregate(db, "old/");
      const result = applyIdRepair(db, { entries: [{ oldId: "old/", newId: "new", name: "old" }], conflicts: [], dataLossEmptyIds: 0, unresolvedDescendants: 0 });
      expect(result.renamed).toBe(1);
      expect(db.getAliasTarget("old/")).toBe("new");
      expect(db.getNodeArtifacts("new")).toHaveLength(1);
      expect(db.getTrailMembers("trail")[0].node_id).toBe("new");
    } finally { db.close(); }
  });

  it("B-07 public keep-both rejects a second destination collision atomically", async () => {
    const fixture = auditFixture();
    try {
      const db = fixture.db("resolve.db"); ensureSchema(db);
      for (const id of ["claim::left", "claim::right", "claim-right"]) addNode(db, id);
      db.execSqlRun("UPDATE nodes SET merge_group='group', needs_merge=1, source_branch='left' WHERE id='claim::left'");
      db.execSqlRun("UPDATE nodes SET merge_group='group', needs_merge=1, source_branch='right' WHERE id='claim::right'");
      const before = sqlState(db);
      await expect(runResolve(["group", "--keep", "both", "--db", fixture.file("resolve.db")])).rejects.toThrow(/already exists/);
      expect(sqlState(db)).toEqual(before);
    } finally { await fixture.close(); }
  });

  it("a lookup-key collision rejects the entire remap instead of ignoring history", () => {
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      addNode(db, "old"); addNode(db, "support"); aggregate(db, "old");
      db.execSqlRun("INSERT INTO node_artifacts SELECT 'new',kind,ref,'different',prev_digest,size_bytes,checked_at,changed_at,checked_by,repo_path FROM node_artifacts WHERE node_id='old'");
      const before = sqlState(db);
      expect(() => db.renameNodeId("old", "new")).toThrow();
      expect(sqlState(db)).toEqual(before);
    } finally { db.close(); }
  });
});
