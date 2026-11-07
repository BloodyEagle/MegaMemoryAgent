import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupDb, snapshotDb } from "../migrate.js";
import { runMigrate, runRepairIds, dbFingerprint } from "../migrate-cli.js";
import { ensureSchema } from "../migrate-schema.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => {
  vi.useRealTimers();
  await fixture.close();
});

// SHM contains volatile reader locks/read marks, not persistent graph data.
// Its presence matters; main, WAL, journal and every other file retain their bytes.
function fileState(dir: string): Record<string, unknown> {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const state = entry.isDirectory()
        ? fileState(file)
        : entry.name.endsWith("-shm")
          ? { present: true }
          : { size: fs.statSync(file).size, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
      return [entry.name, state];
    }));
}

// Historical v4 input from repro-dryrun.mts, with an actual repair candidate
// and meta/edge data so a dry-run cannot pass by preserving only node text.
function legacyDb(journal: "WAL" | "DELETE") {
  const raw = fixture.raw("original/knowledge.db");
  raw.pragma(`journal_mode = ${journal}`);
  raw.pragma("wal_autocheckpoint = 0");
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
    CREATE UNIQUE INDEX idx_edges_unique ON edges(from_id, to_id, relation);
    CREATE TABLE timeline (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')),
      tool TEXT NOT NULL, params TEXT NOT NULL, result_summary TEXT NOT NULL,
      is_write INTEGER NOT NULL, is_error INTEGER NOT NULL, affected_ids TEXT NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('audit_marker', 'preserve legacy metadata');
    INSERT INTO nodes(id, name, kind, summary) VALUES
      ('legacy/', 'Legacy repair candidate', 'feature', 'Existing legacy content must not be rewritten'),
      ('source', 'Source', 'fact', 'Independent evidence already present in the old database');
    INSERT INTO edges(from_id, to_id, relation, description)
      VALUES ('legacy/', 'source', 'informed_by', 'Existing legacy rationale');
    PRAGMA user_version = 4;
  `);
  if (journal === "WAL") raw.pragma("wal_checkpoint(TRUNCATE)");
  return raw;
}

describe("S-01 SQLite backups", () => {
  it("includes committed WAL rows and excludes an in-flight writer transaction", () => {
    const source = fixture.db("source.db");
    ensureSchema(source);
    addNode(source, "seed", { summary: "Checkpointed baseline" });
    source.pragma("wal_autocheckpoint = 0");
    source.pragma("wal_checkpoint(TRUNCATE)");
    source.runInTransaction(() => {
      addNode(source, "committed", { parent_id: "seed", summary: "Committed only in WAL" });
      source.insertEdge({ from_id: "committed", to_id: "seed", relation: "depends_on" });
    });
    expect(source.nodeExists("committed")).toBe(true);
    expect(fs.statSync(`${source.dbPath}-wal`).size).toBeGreaterThan(0);

    // A real uncommitted transaction is the barrier: no sleeps or races.
    const writer = fixture.raw("source.db");
    writer.pragma("foreign_keys = ON");
    writer.exec("BEGIN IMMEDIATE");
    let backup: string | null = null;
    try {
      writer.prepare("INSERT INTO nodes(id, name, kind, summary, parent_id) VALUES (?, ?, ?, ?, ?)")
        .run("pending", "Pending", "feature", "Not committed", "committed");
      expect(() => { backup = backupDb(source.dbPath); }).not.toThrow();
    } finally {
      writer.exec("ROLLBACK");
    }
    expect(backup).not.toBeNull();
    const copy = fixture.raw(path.relative(fixture.root, backup!), { readonly: true, fileMustExist: true });
    const ids = copy.prepare("SELECT id FROM nodes ORDER BY id").all() as { id: string }[];
    expect(ids.map((row) => row.id)).toEqual(["committed", "seed"]);
    expect(copy.prepare("SELECT from_id, to_id, relation FROM edges").all()).toEqual([
      { from_id: "committed", to_id: "seed", relation: "depends_on" },
    ]);
    expect(copy.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(copy.pragma("foreign_key_check")).toEqual([]);
  });

  it("creates distinct immutable backups for two calls in the same second", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-02T03:04:05.000Z"));
    const source = fixture.db("source.db");
    ensureSchema(source);
    addNode(source, "seed");
    source.pragma("wal_checkpoint(TRUNCATE)");
    const first = backupDb(source.dbPath);
    expect(first).not.toBeNull();
    const firstBytes = fs.readFileSync(first!);

    addNode(source, "later");
    source.pragma("wal_checkpoint(TRUNCATE)");
    const second = backupDb(source.dbPath);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(fs.readFileSync(first!)).toEqual(firstBytes);
    const oldCopy = fixture.raw(path.relative(fixture.root, first!), { readonly: true, fileMustExist: true });
    const newCopy = fixture.raw(path.relative(fixture.root, second!), { readonly: true, fileMustExist: true });
    expect(oldCopy.prepare("SELECT id FROM nodes ORDER BY id").all()).toEqual([{ id: "seed" }]);
    expect(newCopy.prepare("SELECT id FROM nodes ORDER BY id").all()).toEqual([{ id: "later" }, { id: "seed" }]);
  });
});

describe("S-07 dry-run leaves the original database untouched", () => {
  const cases = [
    { command: "migrate", run: runMigrate, journal: "WAL" as const },
    { command: "repair-ids", run: runRepairIds, journal: "WAL" as const },
    { command: "migrate", run: runMigrate, journal: "DELETE" as const },
    { command: "repair-ids", run: runRepairIds, journal: "DELETE" as const },
  ];

  it.each(cases)("$command --dry-run preserves raw SQL and files in $journal mode", async ({ run, journal }) => {
    fixture.isolateHome();
    const seed = legacyDb(journal);
    expect(seed.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
    const file = fixture.file("original/knowledge.db");
    // A separate raw connection observes committed SQL without auto-migration.
    // Keep both handles open so close/checkpoint cannot hide a WAL-only write.
    const observer = fixture.raw("original/knowledge.db", { readonly: true, fileMustExist: true });
    const beforeSql = sqlState(observer);
    const beforeFiles = fileState(path.dirname(file));

    await expect(run(["--db", file, "--dry-run"])).resolves.toBeUndefined();

    const afterSql = sqlState(observer);
    const afterFiles = fileState(path.dirname(file));
    expect({ sql: afterSql, files: afterFiles }).toEqual({ sql: beforeSql, files: beforeFiles });
  });
});

describe("S-01 backup retention", () => {
  it("deletes only own verified files beyond the three newest", () => {
    const source = fixture.db("source.db");
    ensureSchema(source);
    addNode(source, "seed");
    source.pragma("wal_checkpoint(TRUNCATE)");
    const dir = path.dirname(source.dbPath);
    const base = path.basename(source.dbPath);

    // A valid standalone SQLite file to serve as five aging own backups.
    const template = fixture.raw("template.db");
    template.exec("CREATE TABLE t (x)");
    template.prepare("INSERT INTO t VALUES (1)").run();

    const stamps = [
      "20200101-000000-001", "20200101-000000-002", "20200101-000001-001",
      "20200101-000002-001", "20200101-000003-001",
    ];
    stamps.forEach((stamp, i) => {
      const file = path.join(dir, `${base}.bak-${stamp}`);
      fs.copyFileSync(path.join(dir, "template.db"), file);
      const at = new Date(Date.UTC(2020, 0, 1, 0, 0, 10 + i));
      fs.utimesSync(file, at, at);
    });

    // Foreign files: a lookalike name outside the strict pattern, and a file
    // matching the naming but failing the SQLite inspection — both survive.
    fs.writeFileSync(path.join(dir, `${base}.bak-20200101-000000-old-tool`), "another tool's file");
    fs.writeFileSync(path.join(dir, `${base}.bak-20190101-000000`), "definitely not a sqlite database");

    const backup = backupDb(source.dbPath);
    expect(backup).not.toBeNull();

    const left = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.bak-`)).sort();
    expect(left).toEqual([
      `${base}.bak-20190101-000000`, // matches the pattern, fails inspection
      `${base}.bak-20200101-000000-old-tool`, // not our naming pattern
      `${base}.bak-20200101-000002-001`,
      `${base}.bak-20200101-000003-001`,
      path.basename(backup!), // the fresh one, newest by mtime
    ]);

    // The fresh backup is a readable snapshot of the source.
    const copy = fixture.raw(path.relative(fixture.root, backup!), { readonly: true, fileMustExist: true });
    expect(copy.prepare("SELECT count(*) AS n FROM nodes").get()).toMatchObject({ n: 1 });
  });

  it("fingerprint sees a WAL-only commit even when the main file hash does not change", () => {
    const source = fixture.db("fp.db");
    ensureSchema(source);
    addNode(source, "seed");
    source.pragma("wal_autocheckpoint = 0");
    source.pragma("wal_checkpoint(TRUNCATE)");
    const before = dbFingerprint(source.dbPath);
    const mainHash = () =>
      createHash("sha256").update(fs.readFileSync(source.dbPath)).digest("hex");
    const beforeMain = mainHash();

    addNode(source, "committed", { summary: "WAL-only write after the checkpoint" });

    // Main-hash-only comparison — the blind spot of the old dry-run test —
    // sees nothing; the fingerprint must.
    expect(mainHash()).toBe(beforeMain);
    const after = dbFingerprint(source.dbPath);
    expect(after.main).toBe(before.main);
    expect(after.wal).not.toBe(before.wal);
    expect(after).not.toEqual(before);
  });
});

describe("S-07 dry-run claims", () => {
  const logCapture = () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    return { lines, spy };
  };

  it("claims 'nothing written' after a verified unchanged fingerprint", async () => {
    fixture.isolateHome();
    legacyDb("WAL");
    const file = fixture.file("original/knowledge.db");
    const { lines, spy } = logCapture();
    try {
      await runMigrate(["--db", file, "--dry-run"], {
        fingerprint: () => ({ main: "same", wal: null }),
      });
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("\n");
    expect(out).toContain("nothing written");
    expect(out).not.toContain("concurrent writer");
  });

  it("reports a changed fingerprint instead of claiming 'nothing written'", async () => {
    fixture.isolateHome();
    legacyDb("WAL");
    const file = fixture.file("original/knowledge.db");
    let call = 0;
    const { lines, spy } = logCapture();
    try {
      await runMigrate(["--db", file, "--dry-run"], {
        fingerprint: () => (++call === 1 ? { main: "before", wal: null } : { main: "after", wal: "changed" }),
      });
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("\n");
    expect(out).toContain("concurrent writer");
    expect(out).not.toContain("nothing written");
  });

  it("sweeps dry-run temp dirs abandoned by earlier CLI processes, keeps fresh ones", async () => {
    fixture.isolateHome();
    legacyDb("WAL");
    const file = fixture.file("original/knowledge.db");

    const abandoned = path.join(os.tmpdir(), `megamemory-dryrun-stale-${randomUUID()}`);
    const fresh = path.join(os.tmpdir(), `megamemory-dryrun-fresh-${randomUUID()}`);
    fs.mkdirSync(abandoned, { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(abandoned, "knowledge.db"), "leftover");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(abandoned, old, old);

    try {
      await runMigrate(["--db", file, "--dry-run"]);
      expect(fs.existsSync(abandoned)).toBe(false); // swept
      expect(fs.existsSync(fresh)).toBe(true); // concurrent run is not touched
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
