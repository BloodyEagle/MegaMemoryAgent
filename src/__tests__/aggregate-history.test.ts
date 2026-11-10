import { describe, it, expect } from "vitest";
import { auditFixture, addNode, sqlState } from "./helpers/audit.js";
import { ensureSchema } from "../migrate-schema.js";
import { MergeEngine } from "../merge.js";

describe("P-04 aggregate history carry", () => {
  it.each([false, true])("lossless carry bypasses retention; the snapshot actor normalizes to import, the journal keeps the original (reverse=%s)", async reverse => {
    const fixture = auditFixture();
    try {
      const left = fixture.db("left.db"), right = fixture.db("right.db");
      for (const db of [left, right]) { ensureSchema(db); addNode(db, "decision"); addNode(db, "support"); }
      for (let i = 0; i < 50; i++) left.execSqlRun("INSERT INTO support_revisions(decision_id,support_id,edge_key,claim_digest,status_digest,edge_digest,format_version,confirmed_at,recorded_at,source,reason) VALUES ('decision','support','5',?,'status','edge',1,'2026-11-10','2026-11-10','agent',NULL)", `historic-${i}`);
      right.upsertSupportBaseline({ decision_id: "decision", support_id: "support", edge_key: "5", claim_digest: "current", status_digest: "status", edge_digest: "edge", format_version: 1, confirmed_at: "2026-11-10", confirmed_by: "original-agent", superseded_at: null, artifacts_digest: null });
      right.execSqlRun("INSERT INTO support_revisions(decision_id,support_id,edge_key,claim_digest,status_digest,edge_digest,format_version,confirmed_at,recorded_at,source,reason) VALUES ('decision','support','5','current','status','edge',1,'2026-11-10','2026-11-10','agent','confirmed')");
      const inputs = reverse ? ["right.db", "left.db"] : ["left.db", "right.db"];
      new MergeEngine().merge(fixture.file(inputs[0]), fixture.file(inputs[1]), fixture.file("out.db"));
      const output = fixture.db("out.db");
      const revisions = output.execSqlAll("SELECT claim_digest, source FROM support_revisions") as Array<{ claim_digest: string; source: string }>;
      for (let i = 0; i < 50; i++) expect(revisions.some(row => row.claim_digest === `historic-${i}`)).toBe(true);
      // §7: the import never confirms — the snapshot row is normalized, the
      // original actor survives in the verbatim journal row.
      expect(output.getAllSupportBaselines()[0].confirmed_by).toBe("import");
      expect(revisions.some(row => row.claim_digest === "current" && row.source === "agent")).toBe(true);
    } finally { await fixture.close(); }
  });

  it("conflicting artifact observations reject without replacing an existing output", async () => {
    const fixture = auditFixture();
    try {
      const left = fixture.db("left.db"), right = fixture.db("right.db"), output = fixture.db("out.db");
      for (const db of [left, right, output]) ensureSchema(db);
      for (const db of [left, right]) addNode(db, "decision");
      addNode(output, "sentinel");
      for (const [db, digest] of [[left, "first"], [right, "second"]] as const) db.upsertNodeArtifact({ node_id: "decision", kind: "file", ref: "source.txt", digest, prev_digest: null, size_bytes: 1, checked_at: "2026-11-10", changed_at: null, checked_by: "tester", repo_path: null });
      const before = sqlState(output);
      expect(() => new MergeEngine().merge(fixture.file("left.db"), fixture.file("right.db"), fixture.file("out.db"))).toThrow(/conflicting artifact/);
      expect(sqlState(output)).toEqual(before);
    } finally { await fixture.close(); }
  });

  it("empty merge keeps the full revision journal, digest membership and audit history", async () => {
    const fixture = auditFixture();
    try {
      const left = fixture.db("left.db"), right = fixture.db("right.db");
      ensureSchema(left); ensureSchema(right);
      addNode(left, "decision"); addNode(left, "support");
      left.insertSupportRevision({ decision_id: "decision", support_id: "support", edge_key: "5", claim_digest: "historic claim", status_digest: "historic status", edge_digest: "historic edge", format_version: 1, confirmed_at: "2026-11-10", recorded_at: "2026-11-10", source: "superseded", reason: "reconfirmed" });
      left.execSqlRun("CREATE TABLE digest_sources(digest_id TEXT PRIMARY KEY,sources TEXT NOT NULL)");
      left.execSqlRun("INSERT INTO digest_sources VALUES (?,?)", "decision", JSON.stringify([{ node_id: "support", version: "historic" }]));
      left.insertProvenanceAuditRun({ root_id: "decision", direction: "ancestry", params: {}, result: { nodes: [{ id: "support" }] } });
      new MergeEngine().merge(fixture.file("left.db"), fixture.file("right.db"), fixture.file("out.db"));
      const output = fixture.db("out.db");
      expect(output.execSqlAll("SELECT * FROM support_revisions")).toHaveLength(1);
      expect(output.execSqlFirst("SELECT * FROM digest_sources")).toMatchObject({ digest_id: "decision", sources: JSON.stringify([{ node_id: "support", version: "historic" }]) });
      expect(output.getProvenanceAuditRuns("decision")).toHaveLength(1);
    } finally { await fixture.close(); }
  });
});
