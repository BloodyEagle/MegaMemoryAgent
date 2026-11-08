import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import { autoMigrateIfNeeded } from "../auto-migrate.js";
import { ensureSchema, emptyReport } from "../migrate-schema.js";
import { runDoctor } from "../doctor.js";
import { cleanupDir } from "./helpers/cleanup.js";

/**
 * Plan 17 (2.3.3): the FTS sync-trigger DDL has exactly one source in
 * migrate-schema.ts. The schema repair (auto-migrate.ts) used to carry a
 * verbatim copy — the copies were identical, so a divergence could only
 * break silently; this file pins the invariant so it cannot return
 * unnoticed:
 *
 * - S1/S4: the creation path (ensureSchema) and the repair path
 *   (autoMigrateIfNeeded) produce equivalent trigger DDL (regular and
 *   trigram);
 * - S2: after a repair the index is maintained by the triggers alone
 *   (insert/update/delete visible in nodes_fts without any rebuild) — R3
 *   only checks a rebuilt index, not the triggers that keep it fresh;
 * - S3: doctor carries no 'migrate --apply' advice on a fresh repaired db
 *   (the NOTES item, closed by a test rather than by words).
 */

let tmpDir = "";
const openDbs: KnowledgeDB[] = [];

const trigramEnv = process.env.MEGAMEMORY_FTS_TOKENIZER;

afterEach(async () => {
  process.env.MEGAMEMORY_FTS_TOKENIZER = trigramEnv;
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* closed by the test itself */
    }
  }
  openDbs.length = 0;
  if (tmpDir) await cleanupDir(tmpDir).catch(() => undefined);
  tmpDir = "";
});

function makeTmp(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-ftstriggers-"));
  return tmpDir;
}

function track(db: KnowledgeDB): KnowledgeDB {
  openDbs.push(db);
  return db;
}

const FTS_TRIGGERS = ["nodes_ai", "nodes_ad", "nodes_au"];
const TRI_TRIGGERS = ["nodes_tri_ai", "nodes_tri_ad", "nodes_tri_au"];

function triggerDdl(db: KnowledgeDB, names: string[]): Map<string, string> {
  const placeholders = names.map(() => "?").join(",");
  const rows = db.execSqlAll(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders})`,
    ...names
  ) as Array<{ name: string; sql: string }>;
  return new Map(rows.map((r) => [r.name, r.sql.replace(/\s+/g, " ").trim()]));
}

/** Path (a): a fresh db whose incomplete schema is repaired on open. */
async function repairedBase(dir: string): Promise<KnowledgeDB> {
  const dbPath = path.join(dir, "repaired.db");
  const db = track(new KnowledgeDB(dbPath));
  await autoMigrateIfNeeded(db, dbPath);
  return db;
}

/**
 * Path (b): the legacy-conversion path — an upstream-shaped db converted by
 * a direct ensureSchema (the same DDL the CLI `migrate --apply` runs).
 */
function ensureSchemaBase(dir: string): KnowledgeDB {
  const dbPath = path.join(dir, "legacy-path.db");
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
  raw.close();
  const db = track(new KnowledgeDB(dbPath, { autoMigrate: false }));
  ensureSchema(db, emptyReport());
  return db;
}

function expectSameTriggers(
  a: KnowledgeDB,
  b: KnowledgeDB,
  names: string[]
): void {
  const ddlA = triggerDdl(a, names);
  const ddlB = triggerDdl(b, names);
  expect([...ddlA.keys()].sort()).toEqual([...names].sort());
  expect([...ddlB.keys()].sort()).toEqual([...names].sort());
  for (const name of names) {
    expect(ddlB.get(name), `trigger ${name}`).toBe(ddlA.get(name));
  }
}

function ftsHits(db: KnowledgeDB, query: string): number {
  return (
    db.execSqlFirst(
      "SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH ?",
      query
    ) as { n: number }
  ).n;
}

describe("FTS trigger DDL has one source (plan 17)", () => {
  it("S1: repair path and ensureSchema path produce identical trigger DDL", async () => {
    makeTmp();
    const repaired = await repairedBase(tmpDir);
    const viaSchema = ensureSchemaBase(tmpDir);
    expectSameTriggers(repaired, viaSchema, FTS_TRIGGERS);
  });

  it("S2: after a repair the index is kept in sync by the triggers alone", async () => {
    makeTmp();
    const db = await repairedBase(tmpDir);

    db.insertNode({
      id: "sync-probe",
      name: "Sync probe",
      kind: "module",
      summary: "carries the floobword marker",
    });
    expect(ftsHits(db, '"floobword"')).toBe(1);

    db.execSqlRun(
      "UPDATE nodes SET summary = ? WHERE id = ?",
      "carries the zorkword marker",
      "sync-probe"
    );
    expect(ftsHits(db, '"floobword"')).toBe(0);
    expect(ftsHits(db, '"zorkword"')).toBe(1);

    db.execSqlRun("DELETE FROM nodes WHERE id = ?", "sync-probe");
    expect(ftsHits(db, '"zorkword"')).toBe(0);
  });

  it("S3: doctor on a fresh repaired db has no 'migrate --apply' advice", async () => {
    makeTmp();
    const db = await repairedBase(tmpDir);
    const { checks, problems } = runDoctor(db);
    expect(problems).toBe(0);
    for (const check of checks) {
      expect(
        check.detail.includes("migrate --apply"),
        `${check.name}: ${check.detail}`
      ).toBe(false);
    }
  });

  it("S4: with trigram requested both trigger sets match across the paths", async () => {
    process.env.MEGAMEMORY_FTS_TOKENIZER = "trigram";
    makeTmp();
    const repaired = await repairedBase(tmpDir);
    const viaSchema = ensureSchemaBase(tmpDir);
    expectSameTriggers(repaired, viaSchema, FTS_TRIGGERS);
    expectSameTriggers(repaired, viaSchema, TRI_TRIGGERS);
    // the trigram companion table exists on both paths
    for (const db of [repaired, viaSchema]) {
      expect(
        db.execSqlFirst(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts_tri'"
        )
      ).toBeDefined();
    }
  });
});
