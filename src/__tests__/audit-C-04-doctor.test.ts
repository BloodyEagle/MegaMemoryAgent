import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../doctor.js";
import { ensureSchema } from "../migrate-schema.js";
import { addNode, AuditHarnessError, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";
import { timelineTsString } from "../sessions.js";

let fixture: AuditFixture;

beforeEach(() => {
  fixture = auditFixture();
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.close();
});

function alphaDatabase() {
  const db = fixture.db();
  ensureSchema(db);
  addNode(db, "alpha", { name: "Alpha", summary: "Alpha has a searchable body." });
  const hits = db.execSqlAll("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'Alpha'");
  if (hits.length !== 1) throw new AuditHarnessError("The healthy FTS fixture must match Alpha once");
  return db;
}

describe("C-04 doctor probes the real FTS index", () => {
  it.each([false, true])("recording warnings leave problems and FTS unchanged (broken=%s)", (broken) => {
    const db = alphaDatabase();
    if (broken) db.execSql("INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all')");
    const baseline = runDoctor(db);
    const expectedMatches = broken ? 0 : 1;
    const baselineFts = baseline.checks.find((check) => check.name === "FTS index");
    expect(baselineFts).toMatchObject({ ok: !broken });
    const now = Date.now();
    const totalChanges = (): number => (db.execSqlFirst("SELECT total_changes() AS n") as { n: number }).n;
    for (let count = 1; count <= 4; count++) {
      db.execSqlRun(
        "INSERT INTO timeline (timestamp, tool, params, result_summary, is_write, is_error, affected_ids) VALUES (?, 'understand', '{}', 'fixture', 0, 0, '[]')",
        timelineTsString(now - (5 - count) * 86_400_000)
      );
      const before = sqlState(db);
      const changes = totalChanges();

      const report = runDoctor(db);

      expect(report.problems).toBe(baseline.problems);
      expect(report.checks.find((check) => check.name === "FTS index")).toEqual(baselineFts);
      const warning = report.checks.find((check) => check.name === "memory recording");
      if (count < 3) expect(warning).toBeUndefined();
      else {
        expect(warning).toMatchObject({ ok: true });
        expect(warning!.detail).toContain(`warn: ${count} сессии с understand и 0 записей за 14 дней`);
      }
      expect(db.execSqlAll("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'Alpha'")).toHaveLength(expectedMatches);
      expect(totalChanges()).toBe(changes);
      expect(sqlState(db)).toEqual(before);
    }
    db.execSqlRun(
      "INSERT INTO timeline (timestamp, tool, params, result_summary, is_write, is_error, affected_ids) VALUES (?, 'create_concept', '{}', 'fixture', 1, 0, '[]')",
      timelineTsString(now - 60_000)
    );
    const before = sqlState(db);
    const changes = totalChanges();
    const recorded = runDoctor(db);
    expect(recorded.checks.find((check) => check.name === "memory recording")).toBeUndefined();
    expect(recorded.problems).toBe(baseline.problems);
    expect(recorded.checks.find((check) => check.name === "FTS index")).toEqual(baselineFts);
    expect(db.execSqlAll("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'Alpha'")).toHaveLength(expectedMatches);
    expect(totalChanges()).toBe(changes);
    expect(sqlState(db)).toEqual(before);
  });

  it("reports an intact searchable index as healthy", () => {
    const db = alphaDatabase();

    const fts = runDoctor(db).checks.find((check) => check.name === "FTS index");

    expect(fts).toMatchObject({ ok: true });
  });

  it("rejects an empty inverted index even when external-content row counts agree", () => {
    const db = alphaDatabase();
    db.execSql("INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all')");
    const matches = () => db.execSqlAll("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'Alpha'");
    const count = db.execSqlFirst("SELECT count(*) AS n FROM nodes_fts") as { n: number };
    if (matches().length !== 0 || count.n !== 1) {
      throw new AuditHarnessError("delete-all must empty MATCH results without changing the content count");
    }

    const fts = runDoctor(db).checks.find((check) => check.name === "FTS index");

    // Doctor is diagnostic: it must not silently repair away the evidence.
    expect(matches()).toHaveLength(0);
    expect(fts, "C-04: an unsearchable index is not healthy").toMatchObject({ ok: false });
  });

  it("accepts the index after an explicit rebuild restores searchability", () => {
    const db = alphaDatabase();
    db.execSql("INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all')");
    db.execSql("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
    if (db.execSqlAll("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'Alpha'").length !== 1) {
      throw new AuditHarnessError("The explicitly rebuilt fixture must match Alpha");
    }

    const fts = runDoctor(db).checks.find((check) => check.name === "FTS index");

    expect(fts).toMatchObject({ ok: true });
  });
});
