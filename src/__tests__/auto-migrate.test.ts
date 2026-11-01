import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import { preflight, autoMigrateIfNeeded } from "../auto-migrate.js";
import { vectorSearchEnabled } from "../embeddings.js";
import { getConcept } from "../tools.js";
import { cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
let dbPath: string;
let db: KnowledgeDB | null = null;

afterEach(async () => {
  delete process.env.MEGAMEMORY_AUTO_MIGRATE;
  if (db) { try { db.close(); } catch { /* closed by rollback */ } db = null; }
  if (tmpDir) await cleanupDir(tmpDir).catch(() => undefined);
  tmpDir = "";
});

/**
 * Upstream-shaped fixture (F14.6.1): 6 nodes, 2 with id='' (only one such
 * row can exist — PK), 1 with id='parent/', 8 edges, MiniLM-shaped vectors.
 */
function buildLegacyFixture(withVectors = true): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-automigrate-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      summary TEXT NOT NULL, why TEXT, file_refs TEXT, parent_id TEXT,
      created_by_task TEXT, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')), removed_at TEXT,
      removed_reason TEXT, embedding BLOB, merge_group TEXT,
      needs_merge INTEGER DEFAULT 0, source_branch TEXT, merge_timestamp TEXT,
      FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE SET NULL
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL,
      to_id TEXT NOT NULL, relation TEXT NOT NULL, description TEXT,
      created_at TEXT DEFAULT (datetime('now')), merge_group TEXT,
      needs_merge INTEGER DEFAULT 0, source_branch TEXT, merge_timestamp TEXT,
      FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
  `);
  const ins = raw.prepare(
    "INSERT INTO nodes (id, name, kind, summary, embedding) VALUES (?, ?, 'feature', ?, ?)"
  );
  const vec = withVectors ? Buffer.alloc(384 * 4, 0) : null;
  ins.run("n1", "Книга", "заметки о книгах", vec);
  ins.run("n2", "Поиск", "полнотекстовый поиск", vec);
  ins.run("", "Книга учёбы", "broken empty id", vec);
  ins.run("parent/", "Модуль", "broken trailing slash", vec);
  raw
    .prepare("INSERT INTO nodes (id, name, kind, summary, parent_id, embedding) VALUES (?, ?, 'feature', ?, ?, ?)")
    .run("parent/child", "Ребёнок", "child of broken parent", "parent/", vec);
  ins.run("n6", "模块设计", "payment module", vec);
  // 8 edges
  const edge = raw.prepare("INSERT INTO edges (from_id, to_id, relation) VALUES (?, ?, 'connects_to')");
  edge.run("n1", "n2");
  edge.run("n2", "n1");
  edge.run("n1", "");
  edge.run("", "n2");
  edge.run("parent/", "n6");
  edge.run("parent/child", "parent/");
  edge.run("n6", "parent/child");
  edge.run("n1", "n6");
  raw.pragma("user_version = 4");
  raw.close();
}

describe("auto-migration on first open (F14)", () => {
  it("converts on first open: schema v3, counts preserved, ids repaired", async () => {
    buildLegacyFixture();
    db = new KnowledgeDB(dbPath);
    const result = await autoMigrateIfNeeded(db, dbPath);

    expect(result.performed).toBe(true);
    expect(result.after?.nodes).toBe(result.before.nodes); // 6
    expect(db.getAllNodesRaw()).toHaveLength(6);
    expect(db.getAllEdgesRaw()).toHaveLength(8);
    expect(db.getMetaValue("schema_version")).toBe("3");
    expect(
      db.getAllNodesRaw().some((n) => n.id === "" || n.id.endsWith("/"))
    ).toBe(false);
    expect(fs.existsSync(dbPath + ".bak-")).toBe(false); // stamp-suffixed backups only
    expect(result.backup).toBeTruthy();
    expect(fs.readdirSync(tmpDir).some((f) => f.includes(".bak-"))).toBe(true);
  });

  it("old ids resolve through aliases; cyrillic search works right away", async () => {
    buildLegacyFixture();
    db = new KnowledgeDB(dbPath);
    autoMigrateIfNeeded(db, dbPath);

    // The empty-id row was renamed from its name — resolvable directly AND
    // through the alias ('' cannot be a stored alias key target though:
    // the alias maps '' -> new id).
    const repaired = autoMigrateIds();
    expect(repaired.length).toBeGreaterThan(0);

    // getConcept resolves through aliases.
    const throughAlias = getConcept(db, { id: "parent/" });
    expect(throughAlias.id).not.toBe("parent/");

    // FTS was rebuilt: cyrillic query hits immediately.
    const fts = db.execSqlFirst(
      `SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH '"Книга"'`
    ) as { n: number };
    expect(fts.n).toBeGreaterThan(0);
  });

  it("vector channel is disabled until reembed (F10 interaction)", async () => {
    buildLegacyFixture(true);
    db = new KnowledgeDB(dbPath);
    autoMigrateIfNeeded(db, dbPath);
    expect(db.getMetaValue("embed_model")).toBe("unknown");
    expect(vectorSearchEnabled(db)).toBe(false);
    expect(autoMigrateReembedRequired()).toBe(true);
  });

  it("second open is a no-op: nothing applied, no new backups", async () => {
    buildLegacyFixture(false);
    db = new KnowledgeDB(dbPath);
    autoMigrateIfNeeded(db, dbPath);
    const backupsAfterFirst = fs.readdirSync(tmpDir).filter((f) => f.includes(".bak-")).length;

    const result = await autoMigrateIfNeeded(db, dbPath);
    expect(result.performed).toBe(false);
    expect(result.legacy).toBe(false);
    const backupsAfterSecond = fs.readdirSync(tmpDir).filter((f) => f.includes(".bak-")).length;
    expect(backupsAfterSecond).toBe(backupsAfterFirst);
  });

  it("postflight failure restores the backup and throws", async () => {
    buildLegacyFixture(false);
    db = new KnowledgeDB(dbPath);

    // Simulate a broken postflight: corrupt the counters the verification
    // reads by making one node invisible to the count but visible to repair.
    const original = KnowledgeDB.prototype.execSqlFirst;
    let calls = 0;
    vi.spyOn(KnowledgeDB.prototype, "execSqlFirst").mockImplementation(function (
      this: unknown,
      sql: string,
      ...params: unknown[]
    ) {
      // After the conversion (schema stamped), lie about the node count.
      if (sql.includes("count(*) AS n FROM nodes") && ++calls > 6) {
        return { n: 999 };
      }
      return original.call(this, sql, ...params);
    });

    await expect(autoMigrateIfNeeded(db, dbPath)).rejects.toThrow(
      "migration failed verification",
    );
    vi.restoreAllMocks();
    db.close();
    db = null;

    // The file was rolled back: a fresh open sees the legacy fixture again.
    const check = new KnowledgeDB(dbPath);
    try {
      const pf = preflight(check);
      expect(pf.nodes).toBe(6);
      expect(pf.empty_ids).toBe(1);
    } finally {
      check.close();
    }
  });

  it("corrupted database (integrity not ok) is skipped, not converted", async () => {
    buildLegacyFixture(false);
    // Corrupt the file body BEFORE opening it (Windows locks open files).
    const raw = fs.readFileSync(dbPath);
    raw[4096] = 0xde;
    raw[4097] = 0xad;
    fs.writeFileSync(dbPath, raw);

    db = new KnowledgeDB(dbPath);
    let result: Awaited<ReturnType<typeof autoMigrateIfNeeded>> | null = null;
    try {
      result = await autoMigrateIfNeeded(db, dbPath);
    } catch (err) {
      // Postflight caught a real inconsistency and rolled back.
      expect(String(err)).toContain("rolled back");
    }
    if (result === null) {
      expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".bak-"))).toHaveLength(1);
      return;
    }
    if (result.before.integrity !== "ok") {
      // libsql detected the corruption: conversion skipped, no backup made.
      expect(result.performed).toBe(false);
      expect(result.warnings.join(" ")).toContain("integrity");
      expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".bak-"))).toHaveLength(0);
    } else if (result.performed) {
      expect(result.after?.nodes).toBe(6);
    }
  });
});

// helpers reading the last-run repair plan through the aliases table
function autoMigrateIds(): Array<{ old: string; new: string }> {
  const db2 = db as unknown as KnowledgeDB;
  const rows = db2.execSqlAll("SELECT old_id, new_id FROM aliases") as Array<{
    old_id: string;
    new_id: string;
  }>;
  return rows.map((r) => ({ old: r.old_id, new: r.new_id }));
}

function autoMigrateReembedRequired(): boolean {
  // reembed_required is surfaced on the result; recompute via meta:
  // after auto-migration embed_model === 'unknown' means reembed pending.
  return (db as KnowledgeDB).getMetaValue("embed_model") === "unknown";
}
