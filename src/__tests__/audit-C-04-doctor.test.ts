import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../doctor.js";
import { ensureSchema } from "../migrate-schema.js";
import { addNode, AuditHarnessError, auditFixture, type AuditFixture } from "./helpers/audit.js";

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
