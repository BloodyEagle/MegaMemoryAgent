import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import {
  autoMigrateIfNeeded,
  describeAutoMigration,
  describeSchemaRepair,
} from "../auto-migrate.js";
import { ftsSearch } from "../search.js";
import { computeFunnel } from "../funnel.js";
import { healthReport, runDoctor } from "../doctor.js";
import { cleanupDir } from "./helpers/cleanup.js";

/**
 * 2.3.2 (plan 16): a non-legacy db with an incomplete schema is repaired on
 * open. The 2.3.1 fresh-db marker removed the only startup caller of
 * ensureSchema along with the spurious legacy conversion — and new dbs were
 * created without FTS, trigram and embed meta (search silently degraded to
 * LIKE). None of the older tests looked at sqlite_master of a fresh db,
 * which is exactly how 1018 green tests missed it.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-schemarepair-"));
  return tmpDir;
}

function track(db: KnowledgeDB): KnowledgeDB {
  openDbs.push(db);
  return db;
}

function hashDb(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Keep raw connections and their statements out of the async test frame.
 * libsql close() alone does not release every native reference; the fixture
 * callback must finish and the owner be dropped before cleanup collects it. */
function withRawDatabase(dbPath: string, use: (raw: Database.Database) => void): void {
  let raw: Database.Database | undefined = new Database(dbPath);
  try {
    use(raw);
  } finally {
    raw.close();
    raw = undefined;
  }
}

/** libsql releases native references after collection; give finalizers an
 * event-loop turn on every poll without extending the three-second deadline. */
async function waitUntilGone(p: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  let iterations = 0;
  while (fs.existsSync(p) && performance.now() < deadline) {
    iterations += 1;
    globalThis.gc?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!fs.existsSync(p)) return;
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  }
  const dbPath = p.replace(/-(?:wal|shm)$/, "");
  const walPath = `${dbPath}-wal`;
  let walSize: number | string = "absent";
  try { walSize = fs.statSync(walPath).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") walSize = String(error);
  }
  const message = `Native cleanup: path=${p}, WAL size=${walSize}, SHM exists=${fs.existsSync(`${dbPath}-shm`)}, iterations=${iterations}`;
  expect(fs.existsSync(p), message).toBe(false);
}

function listObjects(db: KnowledgeDB, names: string[]): Array<{ type: string; name: string }> {
  const placeholders = names.map(() => "?").join(",");
  return db.execSqlAll(
    `SELECT type, name FROM sqlite_master WHERE name IN (${placeholders})`,
    ...names
  ) as Array<{ type: string; name: string }>;
}

/** The artifact kinds 2.3.1 taught us not to write on a mere open. */
function expectNoArtifacts(dir: string): void {
  const files = fs.readdirSync(dir);
  expect(files.some((f) => f.includes(".bak-"))).toBe(false);
  expect(files.some((f) => f.startsWith("migration-report-"))).toBe(false);
}

describe("schema repair on open (plan 16)", () => {
  for (const fails of [false, true]) {
    it(`raw fixture lifecycle releases the connection and statement before cleanup (throws=${fails})`, async () => {
      makeTmp();
      const dbPath = path.join(tmpDir, "knowledge.db");
      let connection: WeakRef<Database.Database> | undefined;
      let statement: WeakRef<Database.Statement> | undefined;
      const failure = new Error("raw fixture failure");
      let caught: unknown;
      let closed = false;
      try {
        withRawDatabase(dbPath, (raw) => {
          const close = raw.close;
          raw.close = function () {
            const result = close.call(this);
            closed = true;
            return result;
          };
          raw.pragma("journal_mode = WAL");
          raw.exec("CREATE TABLE fixture (value TEXT)");
          const insert = raw.prepare("INSERT INTO fixture VALUES (?)");
          insert.run("fixture");
          connection = new WeakRef(raw);
          statement = new WeakRef(insert);
          if (fails) throw failure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(fails ? failure : undefined);
      expect(closed).toBe(true);
      expect(connection).toBeDefined();
      expect(statement).toBeDefined();
      // WeakRef creation keeps its target alive for the current job. Exit it
      // before the one collection; no native owner may survive into cleanup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(globalThis.gc).toBeTypeOf("function");
      globalThis.gc!();
      expect(connection!.deref() === undefined).toBe(true);
      expect(statement!.deref() === undefined).toBe(true);
      await waitUntilGone(dbPath + "-wal");
      await waitUntilGone(dbPath + "-shm");
    });
  }

  it("R1: fresh db is repaired to the full opt-in schema on first open", async () => {
    // trigram requested: the repair must create BOTH indexes + all triggers
    process.env.MEGAMEMORY_FTS_TOKENIZER = "trigram";
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    const db = track(new KnowledgeDB(dbPath));

    const result = await autoMigrateIfNeeded(db, dbPath);
    expect(result.repaired).toBe(true);
    expect(result.performed).toBe(false);
    expect(result.legacy).toBe(false);
    expect(result.backup).toBeNull();
    expect(result.report_file).toBeNull();

    const objs = listObjects(db, [
      "nodes_fts",
      "nodes_fts_tri",
      "nodes_ai",
      "nodes_ad",
      "nodes_au",
      "nodes_tri_ai",
      "nodes_tri_ad",
      "nodes_tri_au",
    ]);
    const present = (type: string, name: string): boolean =>
      objs.some((o) => o.type === type && o.name === name);
    expect(present("table", "nodes_fts")).toBe(true);
    expect(present("table", "nodes_fts_tri")).toBe(true);
    for (const t of ["nodes_ai", "nodes_ad", "nodes_au"]) {
      expect(present("trigger", t)).toBe(true);
    }
    for (const t of ["nodes_tri_ai", "nodes_tri_ad", "nodes_tri_au"]) {
      expect(present("trigger", t)).toBe(true);
    }
    expect(db.getMetaValue("embed_model")).toBeTruthy();

    // the stderr wording belongs to the repair, never to `migrated:`
    const line = describeSchemaRepair(result);
    expect(line).toContain("schema repair:");
    expect(line).toContain("created nodes_fts + triggers");
    expect(line).toContain("created nodes_fts_tri (+triggers)");
    expect(line).toContain("embed meta");
    expect(describeAutoMigration(result)).toBeNull();
  });

  it("R2: repair writes no backup, no migration report, no WAL leftovers", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    const db = track(new KnowledgeDB(dbPath));
    await autoMigrateIfNeeded(db, dbPath);
    db.close();
    openDbs.length = 0;

    expectNoArtifacts(tmpDir);
    await waitUntilGone(dbPath + "-wal");
    await waitUntilGone(dbPath + "-shm");
  });

  it("R3: a 2.3.1-shaped db (FTS dropped, data kept) is repaired with the index rebuilt", async () => {
    process.env.MEGAMEMORY_FTS_TOKENIZER = "trigram";
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    const db1 = track(new KnowledgeDB(dbPath));
    await autoMigrateIfNeeded(db1, dbPath); // full schema first
    db1.insertNode({ id: "pay", name: "Payment", kind: "module", summary: "processes payments" });
    db1.insertNode({ id: "auth", name: "Auth", kind: "feature", summary: "session cookies and jwt tokens" });
    db1.insertNode({ id: "idx", name: "Index", kind: "config", summary: "storage of the index" });
    db1.close();
    openDbs.length = 0;

    // simulate the damage: everything the 2.3.1 creation path skipped
    withRawDatabase(dbPath, (raw) => {
      raw.exec(`
        DROP TRIGGER nodes_ai; DROP TRIGGER nodes_ad; DROP TRIGGER nodes_au;
        DROP TRIGGER nodes_tri_ai; DROP TRIGGER nodes_tri_ad; DROP TRIGGER nodes_tri_au;
        DROP TABLE nodes_fts; DROP TABLE nodes_fts_tri;
      `);
      raw.prepare("DELETE FROM meta WHERE key = 'embed_model'").run();
    });

    const db2 = track(new KnowledgeDB(dbPath));
    const result = await autoMigrateIfNeeded(db2, dbPath);
    expect(result.repaired).toBe(true);
    expect(result.performed).toBe(false);
    expect(
      (db2.execSqlFirst("SELECT count(*) AS n FROM nodes_fts") as { n: number }).n
    ).toBe(3);
    // the rebuilt index serves search right away — by a summary word
    const hits = ftsSearch(db2, "payments", 10);
    expect(hits.some((h) => h.id === "pay")).toBe(true);

    // downstream consumers survive the repaired base
    expect(() => computeFunnel(db2)).not.toThrow();
    expect(() => healthReport(db2)).not.toThrow();
  });

  it("R4: second open is silent and writes nothing (byte-identical file)", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    const db1 = track(new KnowledgeDB(dbPath));
    const first = await autoMigrateIfNeeded(db1, dbPath);
    expect(first.repaired).toBe(true);
    db1.close();
    openDbs.length = 0;
    // The -wal unlink is the signal that the native handle is fully released
    // (libsql does it asynchronously); without this wait the second close
    // does not see itself as the last connection and skips the unlink.
    await waitUntilGone(dbPath + "-wal");
    const hashBefore = hashDb(dbPath);

    const db2 = track(new KnowledgeDB(dbPath));
    const second = await autoMigrateIfNeeded(db2, dbPath);
    expect(second.repaired).toBe(false);
    expect(second.performed).toBe(false);
    // no stderr line: describeSchemaRepair is the only thing startup prints
    expect(describeSchemaRepair(second)).toBeNull();
    expect(describeAutoMigration(second)).toBeNull();
    db2.close();
    openDbs.length = 0;

    await waitUntilGone(dbPath + "-wal");
    await waitUntilGone(dbPath + "-shm");
    expect(hashDb(dbPath)).toBe(hashBefore);
  });

  it("R5: legacy conversion is untouched — migrated line, no repair line", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "upstream.db");
    withRawDatabase(dbPath, (raw) => {
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
        "INSERT INTO nodes (id, name, kind, summary) VALUES (?, ?, 'feature', ?)"
      );
      ins.run("n1", "Книга", "заметки о книгах");
      ins.run("n2", "Поиск", "полнотекстовый поиск");
      raw.pragma("user_version = 4");
    });

    const db = track(new KnowledgeDB(dbPath));
    const result = await autoMigrateIfNeeded(db, dbPath);
    expect(result.performed).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.legacy).toBe(true);

    // exactly one line, and it is the conversion wording
    const migrated = describeAutoMigration(result);
    expect(migrated).toContain("migrated:");
    expect((migrated?.match(/migrated:/g) ?? []).length).toBe(1);
    expect(describeSchemaRepair(result)).toBeNull();
    // the conversion left a complete schema behind — no follow-up repair
    expect(result.after?.schema_complete).toBe(true);
  });

  it("R6: readonly connection never repairs, never writes; search falls back to LIKE", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    // build a damaged 2.3.1-shaped base with data (default env: no trigram)
    const db1 = track(new KnowledgeDB(dbPath));
    await autoMigrateIfNeeded(db1, dbPath);
    db1.insertNode({ id: "pay", name: "Payment", kind: "module", summary: "processes payments" });
    db1.close();
    openDbs.length = 0;
    withRawDatabase(dbPath, (raw) => {
      raw.exec(`
        DROP TRIGGER nodes_ai; DROP TRIGGER nodes_ad; DROP TRIGGER nodes_au;
        DROP TABLE nodes_fts;
      `);
    });
    const hashBefore = hashDb(dbPath);

    const ro = track(new KnowledgeDB(dbPath, { readonly: true }));
    const result = await autoMigrateIfNeeded(ro, dbPath);
    expect(result.repaired).toBe(false);
    expect(result.warnings.join(" ")).not.toContain("schema repair");
    // the fts table is gone — ftsSearch must still answer through LIKE
    const hits = ftsSearch(ro, "payments", 10);
    expect(hits.some((h) => h.id === "pay")).toBe(true);
    ro.close();
    openDbs.length = 0;

    expect(hashDb(dbPath)).toBe(hashBefore);
    expectNoArtifacts(tmpDir);
  });

  it("R7: the demo fixture copy opens without any repair or write", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "demo.db");
    fs.copyFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/demo.db"),
      dbPath
    );
    const hashBefore = hashDb(dbPath);

    const db = track(new KnowledgeDB(dbPath));
    const result = await autoMigrateIfNeeded(db, dbPath);
    expect(result.repaired).toBe(false);
    expect(result.performed).toBe(false);
    // the fixture's schema is already complete for its creation settings —
    // the completeness probe must agree (this is the scenario plan 15 broke)
    expect(result.before.schema_complete).toBe(true);
    db.close();
    openDbs.length = 0;

    expect(hashDb(dbPath)).toBe(hashBefore);
    expectNoArtifacts(tmpDir);
  });

  it("R8: doctor is green on a repaired fresh db (schema, user_version, FTS, embed)", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    const db = track(new KnowledgeDB(dbPath));
    await autoMigrateIfNeeded(db, dbPath);

    const { checks } = runDoctor(db);
    const verdict = (name: string): boolean =>
      checks.find((c) => c.name === name)?.ok ?? false;
    expect(verdict("schema_version")).toBe(true);
    expect(verdict("user_version")).toBe(true);
    expect(verdict("FTS index")).toBe(true);
    expect(verdict("embedding model")).toBe(true);
  });

  it("R9: a failed repair does not kill the startup — warning, data intact", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    const db1 = track(new KnowledgeDB(dbPath));
    await autoMigrateIfNeeded(db1, dbPath);
    db1.insertNode({ id: "n1", name: "Node", kind: "module", summary: "intact" });
    db1.close();
    openDbs.length = 0;

    // sabotage: an object named nodes_fts that no CREATE can replace
    withRawDatabase(dbPath, (raw) => {
      raw.exec(`
        DROP TRIGGER nodes_ai; DROP TRIGGER nodes_ad; DROP TRIGGER nodes_au;
        DROP TABLE nodes_fts;
        CREATE VIEW nodes_fts AS SELECT 1 AS name, 1 AS summary, 1 AS why;
      `);
    });

    const db2 = track(new KnowledgeDB(dbPath));
    // resolves — the MCP/serve startup path must survive a failed repair
    const result = await autoMigrateIfNeeded(db2, dbPath);
    expect(result.repaired).toBe(false);
    expect(result.warnings.join(" ")).toContain("schema repair failed");
    expect(
      (db2.execSqlFirst("SELECT count(*) AS n FROM nodes") as { n: number }).n
    ).toBe(1);
    expect(describeSchemaRepair(result)).toBeNull();
  });

  // 2.4.0 (plan 18, часть A): решение о ремонте триггеров — по КОЛИЧЕСТВУ
  // триггеров набора (< 3), а не по одному имени-стражу: база с 1-2 из 3
  // триггеров обязана ремонтироваться, иначе она навсегда остаётся неполной
  // и ремонт (с записью в файл) срабатывает на каждом старте.
  it("A1: a base that lost ONE of three triggers is repaired, set fully restored", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    // 1st open: full repair of a fresh base (default env: unicode61 only)
    const db1 = track(new KnowledgeDB(dbPath));
    expect((await autoMigrateIfNeeded(db1, dbPath)).repaired).toBe(true);
    db1.close();
    openDbs.length = 0;
    await waitUntilGone(dbPath + "-wal");

    // damage: exactly one trigger of the set of three
    withRawDatabase(dbPath, (raw) => {
      raw.exec("DROP TRIGGER nodes_au");
    });

    const db2 = track(new KnowledgeDB(dbPath));
    const result = await autoMigrateIfNeeded(db2, dbPath);
    expect(result.repaired).toBe(true);
    expect(result.performed).toBe(false);
    for (const t of ["nodes_ai", "nodes_ad", "nodes_au"]) {
      expect(
        db2.execSqlFirst(
          "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
          t
        )
      ).toBeTruthy();
    }
    expect(result.repair_steps).toContain("restored nodes_fts sync triggers and rebuilt index");
    expect(describeSchemaRepair(result)).toContain(
      "restored nodes_fts sync triggers and rebuilt index"
    );
  });

  it("A2: the run after the trigger repair is silent and writes nothing", async () => {
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    // 1st open: full repair of a fresh base
    let db1: KnowledgeDB | null = track(new KnowledgeDB(dbPath));
    expect((await autoMigrateIfNeeded(db1, dbPath)).repaired).toBe(true);
    db1.close();
    db1 = null;
    openDbs.length = 0;
    await waitUntilGone(dbPath + "-wal");

    // 2nd open: one trigger of three was lost — repaired again
    withRawDatabase(dbPath, (raw) => {
      raw.exec("DROP TRIGGER nodes_au");
    });
    let db2: KnowledgeDB | null = track(new KnowledgeDB(dbPath));
    expect((await autoMigrateIfNeeded(db2, dbPath)).repaired).toBe(true);
    db2.close();
    db2 = null;
    openDbs.length = 0;
    await waitUntilGone(dbPath + "-wal");
    await waitUntilGone(dbPath + "-shm");
    const hashBefore = hashDb(dbPath);

    // 3rd open: the base is complete — nothing to repair, no file write
    let db3: KnowledgeDB | null = track(new KnowledgeDB(dbPath));
    const third = await autoMigrateIfNeeded(db3, dbPath);
    expect(third.repaired).toBe(false);
    expect(third.performed).toBe(false);
    expect(describeSchemaRepair(third)).toBeNull();
    db3.close();
    db3 = null;
    openDbs.length = 0;

    await waitUntilGone(dbPath + "-wal");
    await waitUntilGone(dbPath + "-shm");
    expect(hashDb(dbPath)).toBe(hashBefore);
    expectNoArtifacts(tmpDir);
  });

  it("A3: trigram env — a partial trigram trigger set is restored in full", async () => {
    // afterEach restores the captured value — other tests must not see trigram
    process.env.MEGAMEMORY_FTS_TOKENIZER = "trigram";
    makeTmp();
    const dbPath = path.join(tmpDir, "knowledge.db");
    // 1st open: full repair with BOTH indexes and all six triggers
    const db1 = track(new KnowledgeDB(dbPath));
    expect((await autoMigrateIfNeeded(db1, dbPath)).repaired).toBe(true);
    db1.close();
    openDbs.length = 0;
    await waitUntilGone(dbPath + "-wal");

    // damage: exactly one trigram trigger of the set of three
    withRawDatabase(dbPath, (raw) => {
      raw.exec("DROP TRIGGER nodes_tri_au");
    });

    const db2 = track(new KnowledgeDB(dbPath));
    const result = await autoMigrateIfNeeded(db2, dbPath);
    expect(result.repaired).toBe(true);
    for (const t of ["nodes_tri_ai", "nodes_tri_ad", "nodes_tri_au"]) {
      expect(
        db2.execSqlFirst(
          "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
          t
        )
      ).toBeTruthy();
    }
    expect(result.repair_steps).toContain(
      "restored nodes_fts_tri sync triggers and rebuilt index"
    );
  });
});
