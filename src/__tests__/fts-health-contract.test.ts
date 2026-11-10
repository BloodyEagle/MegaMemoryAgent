import { describe, it, expect } from "vitest";
import { auditFixture, addNode, sqlState } from "./helpers/audit.js";
import { ensureSchema } from "../migrate-schema.js";
import { healthReport, runDoctor } from "../doctor.js";

function ftsCheck(db: Parameters<typeof runDoctor>[0]) {
  return runDoctor(db).checks.find(check => check.name === "FTS index")!;
}

describe("F-06 shared read-only FTS health", () => {
  it("external-content counts cannot hide an empty index", async () => {
    const fixture = auditFixture();
    try {
      const db = fixture.db(); ensureSchema(db);
      addNode(db, "measurement", { name: "measurement", summary: "Verified FTS measurement" });
      db.execSqlRun("INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all')");
      const before = sqlState(db);
      expect(healthReport(db).fts.in_sync).toBe(false);
      expect(ftsCheck(db).ok).toBe(false);
      expect(sqlState(db)).toEqual(before);
    } finally { await fixture.close(); }
  });

  it("healthy, absent and rebuilt indexes share doctor and machine verdicts", async () => {
    const fixture = auditFixture();
    try {
      const db = fixture.db(); ensureSchema(db);
      addNode(db, "measurement", { name: "measurement", summary: "Verified FTS measurement" });
      expect(healthReport(db).fts.in_sync).toBe(true);
      expect(ftsCheck(db).ok).toBe(true);
      db.execSqlRun("INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all')");
      expect(healthReport(db).fts.in_sync).toBe(false);
      db.execSqlRun("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
      expect(healthReport(db).fts.in_sync).toBe(true);
      expect(ftsCheck(db).ok).toBe(true);
      db.execSqlRun("DROP TABLE nodes_fts");
      expect(healthReport(db).fts.in_sync).toBe(false);
      expect(ftsCheck(db).ok).toBe(false);
    } finally { await fixture.close(); }
  });
});
