import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";
import Database from "libsql";
import { KnowledgeDB, SCHEMA_VERSION, UpstreamSchemaError } from "../db.js";
import {
  MIGRATION_TARGET_SCHEMA_VERSION,
  runMigration,
} from "../migrate-schema.js";
import { preflight, autoMigrateIfNeeded } from "../auto-migrate.js";
import { runDoctor } from "../doctor.js";
import { cleanupDir } from "./helpers/cleanup.js";

/**
 * План 15 (2.3.1): свежая база — не legacy.
 *
 * Раньше db.ts при создании базы ставил только PRAGMA user_version, а
 * meta.schema_version оставался пустым — детектор legacy в auto-migrate.ts
 * считал каждую новую базу upstream-схемой: первый запуск печатал
 * «migrated: upstream schema → v3 · 0 nodes», писал VACUUM-бэкап и
 * migration-report рядом с пустой базой. Теперь маркер конверсии ставится
 * в create-пути migrate().
 */

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/demo.db"
);

let tmpDir: string;
let db: KnowledgeDB | null = null;

afterEach(async () => {
  if (db) {
    try {
      db.close();
    } catch {
      /* уже закрыта */
    }
    db = null;
  }
  if (tmpDir) await cleanupDir(tmpDir).catch(() => undefined);
  tmpDir = "";
});

function freshDir(): { tmpDir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-fresh-marker-"));
  return { tmpDir: dir, dbPath: path.join(dir, "knowledge.db") };
}

/** T3: сырая upstream-база — таблицы без форк-колонок, user_version не ставится. */
function buildRawUpstream(dbPath: string): void {
  const raw = new Database(dbPath);
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
  raw
    .prepare("INSERT INTO nodes (id, name, kind, summary) VALUES (?, ?, 'feature', ?)")
    .run("u1", "Upstream Node", "сырая upstream-база без форк-колонок");
  raw.close();
}

describe("план 15: маркер свежей базы", () => {
  it("T1: свежая база получает user_version = SCHEMA_VERSION и маркер '3'", () => {
    const { tmpDir: dir, dbPath } = freshDir();
    tmpDir = dir;
    db = new KnowledgeDB(dbPath);
    expect(db.getUserVersion()).toBe(SCHEMA_VERSION);
    // Страж расхождения: локальная константа в db.ts обязана совпадать с
    // MIGRATION_TARGET_SCHEMA_VERSION из migrate-schema.ts (там циклический
    // импорт невозможен, поэтому константа продублирована).
    expect(db.getMetaValue("schema_version")).toBe(MIGRATION_TARGET_SCHEMA_VERSION);
  });

  it("T2: первое авто-мигрирование на свежей базе — no-op без бэкапа и отчёта", async () => {
    const { tmpDir: dir, dbPath } = freshDir();
    tmpDir = dir;
    db = new KnowledgeDB(dbPath);
    expect(preflight(db).legacy).toBe(false);

    const result = await autoMigrateIfNeeded(db, dbPath);
    expect(result.performed).toBe(false);
    expect(result.report_file).toBeNull();

    const junk = fs
      .readdirSync(dir)
      .filter((f) => /^migration-report-/.test(f) || f.includes(".bak-"));
    expect(junk).toEqual([]);
  });

  it("T3: сырая upstream-база мигрирует штатно — после apply маркер '3', legacy false", async () => {
    const { tmpDir: dir, dbPath } = freshDir();
    tmpDir = dir;
    buildRawUpstream(dbPath);

    // 08-N1: RW-открытие сырой upstream-базы бросает UpstreamSchemaError —
    // молча мигрировать чужую схему нельзя.
    expect(() => new KnowledgeDB(dbPath)).toThrowError(UpstreamSchemaError);

    // Путь migrate --apply (openForMigration в migrate-cli): открытие без
    // авто-миграции, подъём схемы, затем конверсия. runPendingMigrations()
    // видит существующий nodes и маркер свежей базы НЕ ставит — его ставит
    // markMigrated в конце runMigration.
    const rawDb = new KnowledgeDB(dbPath, { autoMigrate: false });
    try {
      rawDb.runPendingMigrations();
      await runMigration(rawDb, { apply: true, dbPath });
      expect(rawDb.getMetaValue("schema_version")).toBe(MIGRATION_TARGET_SCHEMA_VERSION);
      // Новое: после apply детектор legacy больше не считает базу legacy
      // (часть «маркер '3'» уже покрыта migration.test.ts).
      expect(preflight(rawDb).legacy).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  it("T4: страж фикстуры — demo.db носит маркер конверсии '3'", () => {
    const fixtureDb = new KnowledgeDB(FIXTURE, { readonly: true });
    try {
      expect(fixtureDb.getUserVersion()).toBe(SCHEMA_VERSION);
      expect(fixtureDb.getMetaValue("schema_version")).toBe("3");
    } finally {
      fixtureDb.close();
    }
  });

  it("T5: doctor на свежей базе — проверка schema_version зелёная", () => {
    const { tmpDir: dir, dbPath } = freshDir();
    tmpDir = dir;
    db = new KnowledgeDB(dbPath);
    const report = runDoctor(db);
    const check = report.checks.find((c) => c.name === "schema_version");
    expect(check).toBeDefined();
    expect(check?.ok).toBe(true);
  });
});
