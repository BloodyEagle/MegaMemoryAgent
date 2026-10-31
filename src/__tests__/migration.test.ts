import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import { runMigration } from "../migrate-schema.js";
import { cleanupDir } from "./helpers/cleanup.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// Upstream v1.6.2-shaped fixture: exact upstream schema, no fork columns.
function buildUpstreamFixture(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
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
    CREATE TABLE timeline (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')), tool TEXT NOT NULL,
      params TEXT NOT NULL, result_summary TEXT NOT NULL,
      is_write INTEGER NOT NULL, is_error INTEGER NOT NULL,
      affected_ids TEXT NOT NULL
    );
  `);

  const insertNode = db.prepare(`
    INSERT INTO nodes (id, name, kind, summary, embedding)
    VALUES (?, ?, 'feature', ?, NULL)
  `);
  const insertEdge = db.prepare(
    "INSERT INTO edges (from_id, to_id, relation) VALUES (?, ?, 'connects_to')"
  );
  const insertTimeline = db.prepare(
    "INSERT INTO timeline (tool, params, result_summary, is_write, is_error, affected_ids) VALUES ('understand', '{}', 'ok', 0, 0, '[]')"
  );

  // 17 well-formed ids + 2 broken legacy ids (empty, trailing slash).
  for (let i = 1; i <= 17; i++) {
    const id = `node-${String(i).padStart(2, "0")}`;
    insertNode.run(id, `Node ${i}`, `summary ${i}`);
  }
  insertNode.run("", "Книга", "broken empty id");
  insertNode.run("svc/", "Модуль", "broken trailing slash");
  // Child under the broken parent — must follow the rename.
  db.prepare(
    "INSERT INTO nodes (id, name, kind, summary, parent_id) VALUES ('svc/child', 'Ребёнок', 'feature', 'child of broken parent', 'svc/')"
  ).run();

  // 30 edges over existing ids, endpoints include both broken ones.
  for (let i = 1; i <= 14; i++) {
    insertEdge.run(`node-${String(i).padStart(2, "0")}`, `node-${String(i + 1).padStart(2, "0")}`);
  }
  insertEdge.run("node-01", "");
  insertEdge.run("", "node-02");
  insertEdge.run("svc/", "node-03");
  insertEdge.run("svc/child", "svc/");
  for (let i = 1; i <= 12; i++) {
    insertEdge.run(`node-${String(i).padStart(2, "0")}`, "node-17");
  }

  for (let i = 0; i < 5; i++) insertTimeline.run();

  // Fully-migrated upstream db: constructor's own migrate() must be a no-op,
  // otherwise the dry-run hash comparison would see a user_version write.
  db.pragma("user_version = 4");
  db.close();
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

let tmpDir: string;

afterEach(async () => {
  await cleanupDir(tmpDir);
});

function freshDir(): { dir: string; dbPath: string } {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migration-"));
  const dbPath = path.join(tmpDir, "knowledge.db");
  buildUpstreamFixture(dbPath);
  return { dir: tmpDir, dbPath };
}

describe("fork migration from upstream v1.6.2", () => {
  it("dry run does not change the database file", () => {
    const { dbPath } = freshDir();
    const before = sha256(dbPath);
    const db = new KnowledgeDB(dbPath);
    try {
      const report = runMigration(db, { apply: false });
      expect(report.warnings.join(" ")).toContain("2 id(s) would be renamed");
    } finally {
      db.close();
    }
    expect(sha256(dbPath)).toBe(before);
  });

  it("apply preserves counts, fills FTS, sets status, repairs ids", () => {
    const { dbPath } = freshDir();
    const db = new KnowledgeDB(dbPath);
    try {
      const report = runMigration(db, { apply: true, backup: () => null });
      expect(report.repairedIds).toBe(2);

      const raw = db.getAllNodesRaw();
      expect(raw).toHaveLength(20);
      expect(db.getAllEdgesRaw()).toHaveLength(30);

      // All statuses default to active.
      expect(raw.every((n) => (n as { status?: string }).status === "active")).toBe(true);

      // Broken ids repaired, including cyrillic slugs; children re-parented
      // (their own ids stay untouched, matching renameNodeId semantics).
      expect(db.nodeExists("книга")).toBe(true);
      expect(db.nodeExists("модуль")).toBe(true);
      expect(db.getNode("svc/child")?.parent_id).toBe("модуль");
      expect(raw.some((n) => n.id === "" || n.id.endsWith("/"))).toBe(false);

      // Edges intact and pointing at the new ids: no orphans.
      const orphans = db.execSqlFirst(`
        SELECT count(*) AS n FROM edges
        WHERE from_id NOT IN (SELECT id FROM nodes)
           OR to_id NOT IN (SELECT id FROM nodes)
      `) as { n: number };
      expect(orphans.n).toBe(0);

      // FTS fully populated.
      const fts = db.execSqlFirst("SELECT count(*) AS n FROM nodes_fts") as { n: number };
      expect(fts.n).toBe(20);

      // schema_version stamped.
      expect(db.getMetaValue("schema_version")).toBe("2");
    } finally {
      db.close();
    }
  });

  it("second apply changes nothing (idempotent)", () => {
    const { dbPath } = freshDir();
    const db = new KnowledgeDB(dbPath);
    try {
      runMigration(db, { apply: true, backup: () => null });
      const nodesBefore = db.getAllNodesRaw().length;
      const edgesBefore = db.getAllEdgesRaw().length;
    } finally {
      db.close();
    }
    const hashBefore = sha256(dbPath);

    const db2 = new KnowledgeDB(dbPath);
    try {
      const report2 = runMigration(db2, { apply: true, backup: () => null });
      expect(report2.applied.join("; ")).not.toContain("created meta table");
      expect(report2.applied.join("; ")).not.toContain("nodes_fts");
      expect(report2.repairedIds).toBe(0);
      expect(db2.getAllNodesRaw().length).toBe(20);
      expect(db2.getAllEdgesRaw().length).toBe(30);
    } finally {
      db2.close();
    }
    expect(sha256(dbPath)).toBe(hashBefore);
  });

  it("upstream-shaped INSERT after migration lands in FTS", () => {
    const { dbPath } = freshDir();
    const db = new KnowledgeDB(dbPath);
    try {
      runMigration(db, { apply: true, backup: () => null });

      // Exactly the column list upstream's insertNode uses — no fork columns.
      db.execSql(`
        INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id,
                           created_by_task, created_at, updated_at, embedding)
        VALUES ('upstream-insert', 'Search Feature', 'feature',
                'finds things fast', NULL, NULL, NULL, NULL,
                datetime('now'), datetime('now'), NULL)
      `);

      const hits = db.execSqlFirst(
        `SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH '"Search"'`
      ) as { n: number };
      expect(hits.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
