import fs from "node:fs";
import path from "node:path";
import { KnowledgeDB } from "./db.js";
import {
  MIGRATION_TARGET_SCHEMA_VERSION,
  ensureSchema,
  ensureEmbedMeta,
  emptyReport,
} from "./migrate-schema.js";
import { planIdRepair, applyIdRepair, backupDb } from "./migrate.js";

/**
 * F14: automatic conversion of a legacy database on first open.
 *
 * open db
 *   ├─ preflight: integrity_check, counters, empty ids, orphan edges
 *   ├─ already on the target schema with intact ids → nothing to do (idempotent)
 *   ├─ else: backup → ONE transaction [ensureSchema → id repair (aliases) →
 *   │        FTS rebuild → name_norm backfill → embed meta (F10) →
 *   │        schema_version=3 → postflight] — a failed postflight rolls the
 *   │        whole transaction back, the file on disk is never touched
 *   └─ one stderr line + a JSON report next to the database
 *
 * The backup is still written before the transaction: a cheap safety
 * artifact, but the rollback mechanism does not depend on it.
 */

export interface PreflightReport {
  integrity: "ok" | string;
  nodes: number;
  edges: number;
  empty_ids: number;
  trailing_slash_ids: number;
  orphan_edges: number;
  schema_version: string | null;
  fts_rows: number | null;
  has_vectors: number;
  legacy: boolean;
}

export function preflight(db: KnowledgeDB): PreflightReport {
  const integrityRow = db.execSqlFirst("PRAGMA integrity_check") as
    | { result?: string }
    | string
    | undefined;
  const integrity =
    typeof integrityRow === "object" && integrityRow !== null
      ? (integrityRow.result ?? "ok")
      : typeof integrityRow === "string"
        ? integrityRow
        : "ok";

  const count = (sql: string): number =>
    (db.execSqlFirst(sql) as { n: number }).n;

  const emptyIds = count("SELECT count(*) AS n FROM nodes WHERE id = ''");
  const trailingSlash = count("SELECT count(*) AS n FROM nodes WHERE id LIKE '%/'");
  const orphanEdges = count(
    `SELECT count(*) AS n FROM edges
     WHERE from_id NOT IN (SELECT id FROM nodes)
        OR to_id NOT IN (SELECT id FROM nodes)`
  );
  const schemaVersion = db.getMetaValue("schema_version") ?? null;

  const hasFts =
    db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
    ) !== undefined;
  const ftsRows = hasFts
    ? (db.execSqlFirst("SELECT count(*) AS n FROM nodes_fts") as { n: number }).n
    : null;

  const hasVectors = count(
    "SELECT count(*) AS n FROM nodes WHERE embedding IS NOT NULL"
  );

  const legacy =
    schemaVersion !== MIGRATION_TARGET_SCHEMA_VERSION ||
    emptyIds > 0 ||
    trailingSlash > 0;

  return {
    integrity,
    nodes: count("SELECT count(*) AS n FROM nodes"),
    edges: count("SELECT count(*) AS n FROM edges"),
    empty_ids: emptyIds,
    trailing_slash_ids: trailingSlash,
    orphan_edges: orphanEdges,
    schema_version: schemaVersion,
    fts_rows: ftsRows,
    has_vectors: hasVectors,
    legacy,
  };
}

export interface AutoMigrationResult {
  performed: boolean;
  legacy: boolean;
  before: PreflightReport;
  after: PreflightReport | null;
  ids_repaired: Array<{ old: string; new: string }>;
  backup: string | null;
  reembed_required: boolean;
  warnings: string[];
  report_file: string | null;
}

/**
 * Convert a legacy database on first open. The whole conversion runs in one
 * transaction; a failed postflight verification rolls it back, so the file
 * on disk is never left half-migrated. Never runs reembed or digest
 * building — those are separate, slower commands.
 */
export async function autoMigrateIfNeeded(
  db: KnowledgeDB,
  dbPath: string
): Promise<AutoMigrationResult> {
  const before = preflight(db);

  const result: AutoMigrationResult = {
    performed: false,
    legacy: before.legacy,
    before,
    after: null,
    ids_repaired: [],
    backup: null,
    reembed_required: false,
    warnings: [],
    report_file: null,
  };

  if (!before.legacy) return result; // idempotent: nothing to do

  if (before.integrity !== "ok") {
    // F14.1: a corrupted database is not converted — conversion writes, and
    // writing to a corrupt file risks data loss. The caller decides whether
    // to continue in a degraded (text-search) mode.
    result.warnings.push(
      `integrity_check failed (${before.integrity}) — auto-migration skipped`
    );
    return result;
  }

  // F14.2: backup before conversion (always). wal_checkpoint makes the file
  // copy self-contained.
  db.pragma("wal_checkpoint(TRUNCATE)");
  result.backup = backupDb(dbPath);

  const report = emptyReport();
  let rollbackReason: string | null = null;
  try {
    db.runInTransaction(() => {
      // Renames touch parents, children and edges in several statements;
      // PRAGMA foreign_keys is a no-op inside a transaction, so FK checks
      // are deferred to COMMIT where the graph is consistent again.
      db.pragma("defer_foreign_keys = ON");
      ensureSchema(db, report);

      // Id repair is automatic here (top-down, aliases recorded).
      const plan = planIdRepair(db);
      const repair = applyIdRepair(db, plan);
      result.ids_repaired = plan.entries.map((e) => ({
        old: e.oldId,
        new: e.newId,
      }));
      report.repairedIds = repair.renamed;

      // FTS rebuilt over the fresh data.
      const hasFts =
        db.execSqlFirst(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
        ) !== undefined;
      if (hasFts) {
        db.execSql("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
      }

      // name_norm backfill for every row (may lag on old dbs).
      const pendingNorm = db.execSqlAll(
        "SELECT id, name FROM nodes WHERE name_norm = '' LIMIT 100000"
      ) as Array<{ id: string; name: string }>;
      for (const row of pendingNorm) {
        db.execSqlRun(
          "UPDATE nodes SET name_norm = ? WHERE id = ?",
          row.name.normalize("NFKD").toLowerCase().normalize("NFC"),
          row.id
        );
      }

      ensureEmbedMeta(db, report);

      db.setMetaValue("schema_version", MIGRATION_TARGET_SCHEMA_VERSION);

      // F14.3: postflight INSIDE the transaction — a failed verification
      // rolls everything back instead of restoring files under locks.
      const after = preflight(db);
      result.after = after;
      const ok =
        after.nodes === before.nodes &&
        after.empty_ids === 0 &&
        after.orphan_edges === 0 &&
        (!after.fts_rows || after.fts_rows === after.nodes);
      if (!ok) {
        rollbackReason =
          "migration failed verification, database rolled back (no changes written)";
        throw new Error(rollbackReason);
      }
    });
  } catch (err) {
    if (rollbackReason !== null) {
      result.performed = false;
      result.reembed_required = false;
      result.warnings.push(rollbackReason);
      result.warnings.push(...report.warnings);
      try {
        const dir = path.dirname(dbPath);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const reportPath = path.join(dir, `migration-report-${stamp}.json`);
        fs.writeFileSync(
          reportPath,
          JSON.stringify(
            {
              at: new Date().toISOString(),
              rolled_back: true,
              reason: rollbackReason,
              backup: result.backup,
            },
            null,
            2
          ),
          "utf8"
        );
        result.report_file = reportPath;
      } catch {
        // a failed report write must not mask the failure
      }
      throw new Error(rollbackReason);
    }
    throw err;
  }
  result.performed = true;
  result.reembed_required = report.reembedNeeded;
  result.warnings.push(...report.warnings);

  // F14.4: JSON report next to the database.
  try {
    const dir = path.dirname(dbPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(dir, `migration-report-${stamp}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          from_schema: before.schema_version,
          to_schema: Number(MIGRATION_TARGET_SCHEMA_VERSION),
          before: {
            nodes: before.nodes,
            edges: before.edges,
            empty_ids: before.empty_ids,
            orphan_edges: before.orphan_edges,
          },
          after: {
            nodes: result.after?.nodes,
            edges: result.after?.edges,
            empty_ids: result.after?.empty_ids,
            orphan_edges: result.after?.orphan_edges,
            fts_rows: result.after?.fts_rows,
          },
          ids_repaired: result.ids_repaired,
          aliases: result.ids_repaired.length,
          backup: result.backup,
          reembed_required: result.reembed_required,
          warnings: result.warnings,
        },
        null,
        2
      ),
      "utf8"
    );
    result.report_file = reportPath;
  } catch {
    // a failed report write must not fail the migration itself
  }

  return result;
}

/** One-line stderr summary for startup (F14.4). */
export function describeAutoMigration(r: AutoMigrationResult): string | null {
  if (!r.performed) return null;
  const parts = [`${r.after?.nodes ?? r.before.nodes} nodes`];
  if (r.ids_repaired.length > 0) parts.push(`${r.ids_repaired.length} ids repaired`);
  if (r.reembed_required) parts.push("reembed required");
  return `migrated: upstream schema → v${MIGRATION_TARGET_SCHEMA_VERSION} · ${parts.join(" · ")}`;
}
