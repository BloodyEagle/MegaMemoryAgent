import { KnowledgeDB } from "./db.js";
import { planIdRepair, applyIdRepair } from "./migrate.js";
import { CURRENT_EMBED_MODEL } from "./embed-model.js";

/**
 * Fork schema migration (plan T0.5): additive-only, upstream-compatible.
 *
 * Principles:
 * - no DROP/RENAME of existing columns, or upstream v1.6.2 could no longer
 *   open a database the fork has migrated;
 * - new columns get DEFAULT so upstream's column-listed INSERTs keep working;
 * - every step is idempotent: re-running changes nothing.
 */

export const MIGRATION_TARGET_SCHEMA_VERSION = "2";

export interface MigrationReport {
  applied: string[];
  alreadyOk: string[];
  warnings: string[];
  repairedIds: number;
  skippedIdConflicts: number;
  reembedNeeded: boolean;
  /** Parents with >=5 children that have no digest node yet (built in T6). */
  digestPending: number;
}

export function emptyReport(): MigrationReport {
  return {
    applied: [],
    alreadyOk: [],
    warnings: [],
    repairedIds: 0,
    skippedIdConflicts: 0,
    reembedNeeded: false,
    digestPending: 0,
  };
}

function tableColumns(db: KnowledgeDB, table: string): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function tableExists(db: KnowledgeDB, name: string): boolean {
  const row = db.execSqlFirst(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    name
  );
  return row !== undefined;
}

/** FTS index + sync triggers. Trigger-managed, so upstream INSERTs stay indexed. */
function ensureFts(db: KnowledgeDB, report: MigrationReport): void {
  if (tableExists(db, "nodes_fts")) {
    report.alreadyOk.push("nodes_fts");
    return;
  }
  db.execSql(`
    CREATE VIRTUAL TABLE nodes_fts USING fts5(
      name, summary, why,
      content='nodes', content_rowid='rowid',
      tokenize="unicode61 remove_diacritics 2"
    );
    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, name, summary, why)
      VALUES (new.rowid, new.name, new.summary, new.why);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, name, summary, why)
      VALUES ('delete', old.rowid, old.name, old.summary, old.why);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, name, summary, why)
      VALUES ('delete', old.rowid, old.name, old.summary, old.why);
      INSERT INTO nodes_fts(rowid, name, summary, why)
      VALUES (new.rowid, new.name, new.summary, new.why);
    END;
  `);
  db.execSql("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  report.applied.push("created nodes_fts + triggers, rebuilt index");
}

/**
 * Optional trigram companion table for CJK (plan T2): unicode61 keeps a
 * hieroglyph run as one token, trigram splits it — but only for >=3 chars.
 * Created when MEGAMEMORY_FTS_TOKENIZER=trigram; both tables may coexist.
 */
function ensureTrigramFts(db: KnowledgeDB, report: MigrationReport): void {
  if (
    (process.env.MEGAMEMORY_FTS_TOKENIZER ?? "").toLowerCase() !== "trigram"
  ) {
    return;
  }
  if (tableExists(db, "nodes_fts_tri")) {
    report.alreadyOk.push("nodes_fts_tri");
    return;
  }
  db.execSql(`
    CREATE VIRTUAL TABLE nodes_fts_tri USING fts5(
      name, summary, why,
      content='nodes', content_rowid='rowid',
      tokenize="trigram"
    );
    CREATE TRIGGER IF NOT EXISTS nodes_tri_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts_tri(rowid, name, summary, why)
      VALUES (new.rowid, new.name, new.summary, new.why);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_tri_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts_tri(nodes_fts_tri, rowid, name, summary, why)
      VALUES ('delete', old.rowid, old.name, old.summary, old.why);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_tri_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts_tri(nodes_fts_tri, rowid, name, summary, why)
      VALUES ('delete', old.rowid, old.name, old.summary, old.why);
      INSERT INTO nodes_fts_tri(rowid, name, summary, why)
      VALUES (new.rowid, new.name, new.summary, new.why);
    END;
  `);
  db.execSql("INSERT INTO nodes_fts_tri(nodes_fts_tri) VALUES('rebuild')");
  report.applied.push("created nodes_fts_tri (trigram), rebuilt index");
}

/** Additive schema steps: meta table, fork columns, indexes, FTS, usage. */
export function ensureSchema(
  db: KnowledgeDB,
  report: MigrationReport = emptyReport()
): MigrationReport {
  // Step 1: meta table.
  if (tableExists(db, "meta")) {
    report.alreadyOk.push("meta table");
  } else {
    db.execSql("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    report.applied.push("created meta table");
  }

  // Step 2: schema_version marker.
  db.execSql(
    "INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', '1')"
  );
  report.alreadyOk.push("schema_version marker");

  // Step 3: fork columns on nodes.
  const cols = tableColumns(db, "nodes");
  const newCols: Array<[string, string]> = [
    ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ["valid_from", "TEXT"],
    ["valid_until", "TEXT"],
  ];
  for (const [name, decl] of newCols) {
    if (!cols.has(name)) {
      db.execSql(`ALTER TABLE nodes ADD COLUMN ${name} ${decl}`);
      report.applied.push(`added nodes.${name}`);
    } else {
      report.alreadyOk.push(`nodes.${name}`);
    }
  }

  // Step 4: indexes.
  db.execSql("CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status)");
  db.execSql("CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)");
  report.alreadyOk.push("fork indexes");

  // Step 5: FTS index + sync triggers (+ optional trigram table for CJK).
  ensureFts(db, report);
  ensureTrigramFts(db, report);

  // Step 6: usage table (token accounting, T8).
  db.execSql(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT DEFAULT (datetime('now')),
      tool TEXT NOT NULL,
      query TEXT,
      nodes INTEGER NOT NULL,
      returned_chars INTEGER NOT NULL,
      returned_tokens INTEGER NOT NULL
    );
  `);
  report.alreadyOk.push("usage table");

  return report;
}

/** Step 8: embedding-model bookkeeping — flag reembed when the model changed. */
export function ensureEmbedMeta(
  db: KnowledgeDB,
  report: MigrationReport
): void {
  const model = db.getMetaValue("embed_model");
  if (model === undefined) {
    db.setMetaValue("embed_model", CURRENT_EMBED_MODEL);
    report.applied.push(`set meta.embed_model=${CURRENT_EMBED_MODEL}`);
    return;
  }
  if (model !== CURRENT_EMBED_MODEL) {
    report.warnings.push(
      `embedding model changed: ${model} -> ${CURRENT_EMBED_MODEL}; run 'megamemory reembed'`
    );
    report.reembedNeeded = true;
  }
}

/** Step 9 preview: parents with >=5 children and no digest child yet. */
export function countDigestPending(db: KnowledgeDB): number {
  // Dry-run may execute before the status column exists — filter accordingly.
  const hasStatus = tableColumns(db, "nodes").has("status");
  const active = (qual: string) =>
    hasStatus ? `${qual}.status = 'active'` : "1=1";
  const row = db.execSqlFirst(`
    SELECT count(*) AS n FROM nodes p
    WHERE ${active("p")}
      AND (SELECT count(*) FROM nodes c
           WHERE c.parent_id = p.id AND ${active("c")}) >= 5
      AND NOT EXISTS (
        SELECT 1 FROM nodes d
        WHERE d.parent_id = p.id AND d.kind = 'digest' AND ${active("d")}
      )
  `) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Set schema_version to the fork target (step 10). */
export function markMigrated(db: KnowledgeDB): void {
  db.setMetaValue("schema_version", MIGRATION_TARGET_SCHEMA_VERSION);
}

/**
 * Full CLI migration: dry-run prints the plan without writing anything;
 * apply = backup + schema + id repair + meta, then marks schema_version=2.
 * Idempotent: a second apply reports "alreadyOk" and changes nothing.
 */
export function runMigration(
  db: KnowledgeDB,
  opts: { apply: boolean; backup?: (dbPath: string) => string | null; dbPath?: string }
): MigrationReport {
  const report = emptyReport();

  // Read-only previews (also shown in dry-run).
  report.digestPending = countDigestPending(db);
  const repairPlan = planIdRepair(db);

  if (!opts.apply) {
    // Dry-run: nothing written. Surface what apply WOULD do.
    report.warnings.push(`dry run: ${repairPlan.entries.length} id(s) would be renamed`);
    report.reembedNeeded = db.getMetaValue("embed_model") !== undefined &&
      db.getMetaValue("embed_model") !== CURRENT_EMBED_MODEL;
    return report;
  }

  // Step 0: backup (apply only). Checkpoint WAL first so the copied file
  // contains everything written since the last checkpoint.
  if (opts.backup && opts.dbPath) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    const backupPath = opts.backup(opts.dbPath);
    if (backupPath) {
      report.applied.push(`backup: ${backupPath}`);
    }
  }

  ensureSchema(db, report);
  ensureEmbedMeta(db, report);

  // Step 7: repair legacy ids.
  if (repairPlan.entries.length > 0 || repairPlan.conflicts.length > 0) {
    const result = applyIdRepair(db, repairPlan);
    report.repairedIds = result.renamed;
    report.skippedIdConflicts = result.skipped;
    report.applied.push(`repaired ${result.renamed} legacy id(s)`);
  }

  // Step 9: digest building arrives with T6; report pending count for now.
  if (report.digestPending > 0) {
    report.warnings.push(
      `${report.digestPending} module(s) with >=5 children have no digest yet (digest building lands in T6)`
    );
  }

  markMigrated(db);
  return report;
}
