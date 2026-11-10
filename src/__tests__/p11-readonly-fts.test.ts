import fs from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema, runMigration } from "../migrate-schema.js";
import { autoMigrateIfNeeded, preflight } from "../auto-migrate.js";
import { runExpire } from "../expire-cli.js";
import { auditFixture, addNode, sqlState } from "./helpers/audit.js";

const originalTokenizer = process.env.MEGAMEMORY_FTS_TOKENIZER;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalTokenizer === undefined) delete process.env.MEGAMEMORY_FTS_TOKENIZER;
  else process.env.MEGAMEMORY_FTS_TOKENIZER = originalTokenizer;
});

function matches(db: KnowledgeDB, table: "nodes_fts" | "nodes_fts_tri", word: string): number {
  return Number((db.execSqlFirst(`SELECT count(*) AS n FROM ${table} WHERE ${table} MATCH ?`, `"${word}"`) as { n: number }).n);
}

function syncCycle(db: KnowledgeDB, table: "nodes_fts" | "nodes_fts_tri") {
  addNode(db, "p11-cycle", { name: "cycle", summary: "insertmarker" });
  expect(matches(db, table, "insertmarker")).toBe(1);
  db.execSqlRun("UPDATE nodes SET summary = ? WHERE id = ?", "updatemarker", "p11-cycle");
  expect(matches(db, table, "insertmarker")).toBe(0);
  expect(matches(db, table, "updatemarker")).toBe(1);
  db.execSqlRun("DELETE FROM nodes WHERE id = ?", "p11-cycle");
  expect(matches(db, table, "updatemarker")).toBe(0);
}

function damageInsert(db: KnowledgeDB, trigger: string, wrong: boolean) {
  db.execSql(`DROP TRIGGER ${trigger}`);
  if (wrong) db.execSql(`CREATE TRIGGER ${trigger} AFTER INSERT ON nodes BEGIN SELECT 1; END`);
  // One raw insert avoids an update trigger deleting a row the broken insert trigger never indexed.
  db.execSqlRun("INSERT INTO nodes(id,name,kind,summary,name_norm) VALUES ('p11-stale','stale','feature','staleindexmarker','stale')");
}

describe("P11 A-02 public FTS repair", () => {
  it.each([
    ["nodes_fts", "nodes_ai", false],
    ["nodes_fts", "nodes_ai", true],
    ["nodes_fts_tri", "nodes_tri_ai", false],
    ["nodes_fts_tri", "nodes_tri_ai", true],
  ] as const)("ensureSchema repairs %s missing/wrong=%s/%s without opt-in", async (table, trigger, wrong) => {
    const fixture = auditFixture();
    try {
      process.env.MEGAMEMORY_FTS_TOKENIZER = "trigram";
      const db = fixture.track(new KnowledgeDB(":memory:"));
      ensureSchema(db);
      damageInsert(db, trigger, wrong);
      expect(matches(db, table, "staleindexmarker")).toBe(0);
      delete process.env.MEGAMEMORY_FTS_TOKENIZER;
      const report = ensureSchema(db);
      expect(report.applied.some(step => step.includes(table))).toBe(true);
      expect(matches(db, table, "staleindexmarker")).toBe(1);
      syncCycle(db, table);
      const before = sqlState(db);
      expect(ensureSchema(db).applied).toEqual([]);
      expect(sqlState(db)).toEqual(before);
    } finally { await fixture.close(); }
  });

  it("autoMigrateIfNeeded detects all three wrongly defined surviving triggers", async () => {
    const fixture = auditFixture();
    try {
      delete process.env.MEGAMEMORY_FTS_TOKENIZER;
      const dbPath = fixture.file("auto.db");
      const db = fixture.track(new KnowledgeDB(dbPath));
      ensureSchema(db);
      for (const [name, event] of [["nodes_ai", "INSERT"], ["nodes_ad", "DELETE"], ["nodes_au", "UPDATE"]]) {
        db.execSql(`DROP TRIGGER ${name}; CREATE TRIGGER ${name} AFTER ${event} ON nodes BEGIN SELECT 1; END`);
      }
      addNode(db, "p11-stale", { name: "stale", summary: "staleindexmarker" });
      expect(preflight(db).schema_complete).toBe(false);
      const result = await autoMigrateIfNeeded(db, dbPath);
      expect(result).toMatchObject({ repaired: true, performed: false, backup: null, report_file: null });
      expect(matches(db, "nodes_fts", "staleindexmarker")).toBe(1);
      syncCycle(db, "nodes_fts");
      expect(preflight(db).schema_complete).toBe(true);
      expect((await autoMigrateIfNeeded(db, dbPath)).repaired).toBe(false);
    } finally { await fixture.close(); }
  });

  it("same-connection rollback restores lost triggers/index and lazy writers can retry", async () => {
    const fixture = auditFixture();
    try {
      delete process.env.MEGAMEMORY_FTS_TOKENIZER;
      const db = fixture.track(new KnowledgeDB(":memory:"));
      ensureSchema(db);
      addNode(db, "p11-lazy");
      damageInsert(db, "nodes_ai", false);
      db.execSql("DROP TABLE status_history; DROP TABLE usage");
      const before = sqlState(db);
      expect(() => db.runInTransaction(() => {
        ensureSchema(db);
        db.setNodeStatus("p11-lazy", "deprecated", undefined, "P11 rollback");
        db.insertUsage({ tool: "p11", nodes: 0, returnedChars: 0, returnedTokens: 0 });
        db.insertProvenanceAuditRun({ root_id: "p11-lazy", direction: "upstream", params: {}, result: {} });
        throw new Error("P11 forced rollback");
      })).toThrow("P11 forced rollback");
      expect(sqlState(db)).toEqual(before);
      expect(matches(db, "nodes_fts", "staleindexmarker")).toBe(0);
      ensureSchema(db);
      db.setNodeStatus("p11-lazy", "deprecated", undefined, "P11 retry");
      db.insertUsage({ tool: "p11", nodes: 0, returnedChars: 0, returnedTokens: 0 });
      db.insertProvenanceAuditRun({ root_id: "p11-lazy", direction: "upstream", params: {}, result: {} });
      expect(matches(db, "nodes_fts", "staleindexmarker")).toBe(1);
      expect(db.execSqlFirst("SELECT tool FROM usage")).toMatchObject({ tool: "p11" });
      expect(db.execSqlFirst("SELECT reason FROM status_history")).toMatchObject({ reason: "P11 retry" });
      expect(db.getProvenanceAuditRuns("p11-lazy")).toHaveLength(1);
      const columns = db.pragma("table_info(status_history)") as Array<{ name: string }>;
      expect(columns.map(row => row.name)).toEqual(expect.arrayContaining(["claim_digest", "scope_digest", "status_scope"]));
    } finally { await fixture.close(); }
  });
});

describe("P11 A-03 integrity rejects before repair writes", () => {
  it.each([
    ["quick_check", [{ quick_check: "ok" }, { quick_check: "damaged later row" }]],
    ["integrity_check", [{ integrity_check: "ok" }, { integrity_check: "damaged later row" }]],
    ["integrity_check", [{ result: "ok" }]],
    ["integrity_check", []],
  ])("rejects %s malformed/all-row result %j through public paths", async (pragma, rows) => {
    const fixture = auditFixture();
    try {
      const dbPath = fixture.file("integrity.db");
      const db = fixture.track(new KnowledgeDB(dbPath));
      const before = sqlState(db);
      const native = (db as unknown as { db: { pragma(text: string): unknown } }).db;
      const original = native.pragma.bind(native);
      vi.spyOn(native, "pragma").mockImplementation(text => text === pragma ? rows : original(text));
      expect(() => ensureSchema(db)).toThrow(/PRAGMA/);
      await expect(autoMigrateIfNeeded(db, dbPath)).rejects.toThrow(/PRAGMA/);
      const backup = vi.fn(() => null);
      await expect(runMigration(db, { apply: true, dbPath, backup })).rejects.toThrow(/PRAGMA/);
      expect(backup).not.toHaveBeenCalled();
      expect(sqlState(db)).toEqual(before);
      expect(fs.readdirSync(fixture.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/bak-|migration-report/)]));
    } finally { vi.restoreAllMocks(); await fixture.close(); }
  });
});

describe("P11 A-04 public expire readonly", () => {
  it("default dry-run uses query_only before reading nodes and leaves schema/data unchanged", async () => {
    const fixture = auditFixture();
    try {
      const dbPath = fixture.file("expire.db");
      const db = fixture.track(new KnowledgeDB(dbPath));
      addNode(db, "p11-expire");
      const before = sqlState(db);
      const queryOnly: number[] = [];
      const getNode = KnowledgeDB.prototype.getNode;
      vi.spyOn(KnowledgeDB.prototype, "getNode").mockImplementation(function (this: KnowledgeDB, ...args) {
        queryOnly.push((this.pragma("query_only") as Array<{ query_only: number }>)[0].query_only);
        return getNode.apply(this, args);
      });
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await runExpire(["--db", dbPath, "--ids", "p11-expire", "--until", "2026-01-01T00:00:00.000Z"]);
      expect(queryOnly.length).toBeGreaterThan(0);
      expect(queryOnly.every(value => value === 1)).toBe(true);
      expect(sqlState(db)).toEqual(before);
    } finally { vi.restoreAllMocks(); await fixture.close(); }
  });

  it("schema-12 dry-run refuses before migration and preserves main bytes/schema", async () => {
    const fixture = auditFixture();
    try {
      const db = fixture.db();
      addNode(db, "p11-expire");
      const sourcePath = fixture.snapshot(db, "schema12.db");
      const source = fixture.track(new KnowledgeDB(sourcePath, { autoMigrate: false }));
      source.pragma("journal_mode = DELETE");
      source.pragma("user_version = 12");
      source.pragma("query_only = ON");
      const before = sqlState(source);
      const hash = () => createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      const bytes = hash();
      await expect(runExpire(["--db", sourcePath, "--ids", "p11-expire", "--until", "past"]))
        .rejects.toMatchObject({ code: "SCHEMA_TOO_OLD_READONLY" });
      expect(sqlState(source)).toEqual(before);
      expect(hash()).toBe(bytes);
      expect(fs.existsSync(sourcePath + "-wal")).toBe(false);
    } finally { await fixture.close(); }
  });

  it("unknown id closes the command connection on failure", async () => {
    const fixture = auditFixture();
    try {
      const dbPath = fixture.file("failure.db");
      fixture.track(new KnowledgeDB(dbPath));
      const close = vi.spyOn(KnowledgeDB.prototype, "close");
      await expect(runExpire(["--db", dbPath, "--ids", "unknown", "--until", "past"])).rejects.toThrow(/неизвестные id/);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); await fixture.close(); }
  });
});
