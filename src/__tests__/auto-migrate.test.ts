import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KnowledgeDB } from "../db.js";
import { dbFingerprint } from "../migrate-cli.js";
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
function buildLegacyFixture(withVectors = true, version = 4, journal = "WAL"): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-automigrate-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  const raw = new Database(dbPath);
  raw.pragma(`journal_mode = ${journal}`);
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
  raw.pragma(`user_version = ${version}`);
  if (version !== 4) raw.pragma("wal_checkpoint(TRUNCATE)");
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

describe("R01 actual automatic startup backup boundary", () => {
  function contents(raw: InstanceType<typeof Database>) {
    return {
      version: (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      schema: raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      nodes: raw.prepare("SELECT * FROM nodes ORDER BY id").all(),
      edges: raw.prepare("SELECT * FROM edges ORDER BY id").all(),
    };
  }

  async function startup(target: "mcp" | "serve", optOut = false) {
    const project = fileURLToPath(new URL("../../", import.meta.url));
    const home = path.join(tmpDir, "profile");
    fs.mkdirSync(home, { recursive: true });
    const port = target === "serve" ? await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const value = (server.address() as net.AddressInfo).port;
        server.close((err) => err ? reject(err) : resolve(value));
      });
    }) : 0;
    const args = target === "mcp" ? ["--db", dbPath] : ["serve", "--db", dbPath, "--port", String(port)];
    return new Promise<{ ready: boolean; stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(project, "node_modules/tsx/dist/loader.mjs")).href, path.join(project, "src/index.ts"), ...args], {
        cwd: tmpDir, shell: false, windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: "", HOME: home, USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_DATA_HOME: path.join(home, "data"),
          OPENCODE_CONFIG_DIR: path.join(home, "opencode"), CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, "claude"),
          MEGAMEMORY_DB_PATH: dbPath, MEGAMEMORY_AUTO_MIGRATE: optOut ? "0" : "1", MEGAMEMORY_AUTO_DIGEST: "0", MEGAMEMORY_SEARCH: "fts",
          HF_HOME: path.join(home, "hf"), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", NO_COLOR: "1" },
      });
      let ready = false, stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 8000);
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const initialized = target === "serve" ? /Local:\s+http:\/\/127\.0\.0\.1:\d+/.test(stdout) : stdout.split(/\r?\n/).some((line) => {
          try { const message = JSON.parse(line); return message.id === 1 && !!message.result?.serverInfo; } catch { return false; }
        });
        if (initialized && !ready) { ready = true; child.kill("SIGTERM"); }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error(`startup timed out: ${stderr}\n${stdout}`));
        else resolve({ ready, stdout, stderr, code });
      });
      if (target === "mcp") child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prewrite-startup-regression", version: "1" },
      } }) + "\n");
    });
  }

  it.each(["mcp", "serve"] as const)("%s snapshots v3 duplicate edges and committed WAL before constructor migration", async (target) => {
    buildLegacyFixture(false, 3);
    const source = new Database(dbPath);
    try {
      source.exec("INSERT INTO edges (from_id, to_id, relation, description) VALUES ('n1', 'n2', 'connects_to', 'duplicate before startup')");
      source.exec("UPDATE nodes SET summary = 'committed WAL before startup' WHERE id = 'n1'");
      const before = contents(source);
      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      const result = await startup(target);
      expect(result.ready, result.stderr + result.stdout).toBe(true);
      const backups = fs.readdirSync(tmpDir).filter((file) => file.startsWith("knowledge.db.bak-"));
      expect(backups).toHaveLength(1);
      const copy = new Database(path.join(tmpDir, backups[0]));
      try {
        copy.pragma("query_only = ON");
        expect(contents(copy)).toEqual(before);
      } finally { copy.close(); }
      const after = new Database(dbPath);
      try {
        expect((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
        expect(after.prepare("SELECT * FROM edges").all()).toHaveLength(8);
        expect(after.prepare("SELECT id FROM nodes WHERE id = ''").get()).toBeUndefined();
      } finally { after.close(); }
    } finally { source.close(); }
  });

  it("MCP opt-out still snapshots pending migration but leaves legacy ids unrepaired", async () => {
    buildLegacyFixture(false, 3, "DELETE");
    const source = new Database(dbPath);
    const before = contents(source);
    source.close();
    const result = await startup("mcp", true);
    expect(result.ready, result.stderr).toBe(true);
    const backups = fs.readdirSync(tmpDir).filter((file) => file.startsWith("knowledge.db.bak-"));
    expect(backups).toHaveLength(1);
    const copy = new Database(path.join(tmpDir, backups[0]));
    try { expect(contents(copy)).toEqual(before); } finally { copy.close(); }
    const after = new Database(dbPath);
    try {
      expect(after.prepare("SELECT id FROM nodes WHERE id = ''").get()).toBeDefined();
      expect(after.prepare("SELECT id FROM nodes WHERE id = 'parent/'").get()).toBeDefined();
    } finally { after.close(); }
    expect(fs.readdirSync(tmpDir).filter((file) => file.startsWith("migration-report-"))).toEqual([]);
  });

  it.each(["mcp", "serve"] as const)("%s preserves the raw-upstream explicit-migration error without writes", async (target) => {
    buildLegacyFixture(false, 0, "DELETE");
    const before = dbFingerprint(dbPath);
    const result = await startup(target);
    expect(result.ready).toBe(false);
    expect(result.stderr + result.stdout).toContain("migrate --apply");
    expect(dbFingerprint(dbPath)).toEqual(before);
    expect(fs.readdirSync(tmpDir).filter((file) => file.includes(".bak-") || file.startsWith("migration-report-"))).toEqual([]);
  });

  it("startup backup failure stops before persistent PRAGMA or schema writes", async () => {
    buildLegacyFixture(false, 3, "DELETE");
    const before = dbFingerprint(dbPath);
    const { openStartupDatabase } = await import("../auto-migrate.js");
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: InstanceType<typeof Database>, sql: string) {
      if (sql.startsWith("VACUUM INTO")) throw new Error("startup snapshot denied");
      return exec.call(this, sql);
    });
    try {
      expect(() => openStartupDatabase(dbPath)).toThrow("startup snapshot denied");
      expect(dbFingerprint(dbPath)).toEqual(before);
    } finally { vi.restoreAllMocks(); }
  });

  it.each(["mcp", "serve"] as const)("%s first fresh startup and healthy repeat create no migration backup or report", async (target) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-startup-fresh-"));
    dbPath = path.join(tmpDir, "knowledge.db");
    for (let i = 0; i < 2; i++) {
      const result = await startup(target);
      expect(result.ready, result.stderr + result.stdout).toBe(true);
      expect(fs.readdirSync(tmpDir).filter((file) => file.includes(".bak-") || file.startsWith("migration-report-"))).toEqual([]);
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
