import fs from "node:fs";
import path from "node:path";
import { KnowledgeDB } from "./db.js";
import {
  MIGRATION_TARGET_SCHEMA_VERSION,
  ensureSchema,
  ensureEmbedMeta,
  ensureFtsTriggers,
  ensureTrigramTriggers,
  emptyReport,
  type MigrationReport,
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
  /**
   * 2.3.2 (plan 16): schema-completeness signals. The 2.3.1 fresh-db marker
   * removed the only startup caller of ensureSchema along with the spurious
   * legacy conversion, and new dbs were created without FTS, trigram and
   * embed meta (search silently degraded to LIKE). These fields make the
   * gap visible and repairable on open.
   */
  fts_tri: boolean;
  fts_triggers: number;
  embed_model: string | null;
  schema_complete: boolean;
}

/**
 * Cheap completeness probe: one sqlite_master read for every FTS-related
 * object plus one count inside the index. Read-only — safe on any
 * connection, no locks. Shared by preflight() and the repair transaction
 * (re-check under the write lock: a second process may have repaired first).
 *
 * Deliberate deviation from plan 16 §2.1's sketch formula (see the report):
 * - embed_model is REPORTED but does not gate completeness — healthy dbs
 *   without it (the demo fixture, dbs converted before 2.3.1 without a
 *   first embedding) must not be written to on open; it self-heals lazily
 *   on first embedding and is stamped eagerly whenever a repair runs.
 * - nodes_fts_tri is required only when MEGAMEMORY_FTS_TOKENIZER=trigram
 *   requests it (ensureTrigramFts is env-gated); but a trigram table that
 *   exists must have its three triggers — it stops being maintained
 *   otherwise.
 */
function readSchemaCompleteness(db: KnowledgeDB): {
  fts: boolean;
  tri: boolean;
  triggers: number;
  triTriggers: number;
  complete: boolean;
} {
  const rows = db.execSqlAll(
    `SELECT type, name FROM sqlite_master
     WHERE name IN ('nodes_fts','nodes_fts_tri',
                    'nodes_ai','nodes_ad','nodes_au',
                    'nodes_tri_ai','nodes_tri_ad','nodes_tri_au')`
  ) as Array<{ type: string; name: string }>;
  const has = (type: string, name: string): boolean =>
    rows.some((r) => r.type === type && r.name === name);
  const triggerCount = (names: string[]): number =>
    rows.filter((r) => r.type === "trigger" && names.includes(r.name)).length;

  const fts = has("table", "nodes_fts");
  const tri = has("table", "nodes_fts_tri");
  const triggers = triggerCount(["nodes_ai", "nodes_ad", "nodes_au"]);
  const triTriggers = triggerCount([
    "nodes_tri_ai",
    "nodes_tri_ad",
    "nodes_tri_au",
  ]);
  const trigramRequested =
    (process.env.MEGAMEMORY_FTS_TOKENIZER ?? "").toLowerCase() === "trigram";
  const complete =
    fts &&
    triggers === 3 &&
    (!trigramRequested || tri) &&
    (!tri || triTriggers === 3);
  return { fts, tri, triggers, triTriggers, complete };
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

  const completeness = readSchemaCompleteness(db);
  const ftsRows = completeness.fts
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
    fts_tri: completeness.tri,
    fts_triggers: completeness.triggers,
    embed_model: db.getMetaValue("embed_model") ?? null,
    schema_complete: completeness.complete,
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
  /**
   * 2.3.2 (plan 16): true when a schema-completeness repair ran (FTS
   * objects missing on a non-legacy db — the 2.3.1 regression). This is
   * NOT a legacy conversion: `performed` stays false, no backup, no
   * migration report.
   */
  repaired: boolean;
  repair_steps: string[];
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
    repaired: false,
    repair_steps: [],
  };

  // 2.3.2 (plan 16): a non-legacy db with an incomplete schema (no FTS
  // table/triggers — every db created by 2.3.1) is repaired in place before
  // serving. Additive objects only: no backup, no migration report, no
  // legacy conversion semantics.
  if (!before.legacy && !before.schema_complete) {
    repairSchemaCompleteness(db, before, result);
  }

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

  // F14.2: backup before conversion (always). backupDb() snapshots through
  // SQLite (VACUUM INTO): committed WAL frames are included, so no checkpoint
  // runs here — a "TRUNCATE for form's sake" could be busy and proves nothing.
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

/**
 * 2.3.2 (plan 16): repair an incomplete schema on a non-legacy db.
 *
 * ensureFts() creates the sync triggers only together with the table, so a
 * db whose FTS objects were lost (every db created by 2.3.1) gets them all
 * back here: ensureSchema for the missing tables/meta, explicit trigger
 * restoration for the gap case (table present, triggers gone — ensureSchema
 * alone would report alreadyOk and leave the index unmaintained, and the
 * completeness check would re-trigger repair on every start), a rebuild
 * when the index could have gone stale, and ensureEmbedMeta so a repaired
 * db records its embedding model eagerly.
 *
 * Failure policy (plan 16 §2.2): a repair exception is swallowed with a
 * warning — startup continues in the degraded LIKE-search mode. Unlike the
 * legacy conversion this branch touches no data objects, so it must never
 * be fatal: an MCP server dying because FTS could not be created is worse
 * than an MCP server without ranking.
 */
function repairSchemaCompleteness(
  db: KnowledgeDB,
  before: PreflightReport,
  result: AutoMigrationResult
): void {
  if (before.integrity !== "ok") {
    // Same policy as the legacy path (F14.1): never write to a corrupt file.
    result.warnings.push(
      `integrity_check failed (${before.integrity}) — schema repair skipped`
    );
    return;
  }
  // The repair lives in RW paths only (plan 16 §2.4): auto-migration is not
  // even called on readonly connections today, but a future caller must not
  // get SQLITE_READONLY out of a repair attempt.
  const queryOnly = db.pragma("query_only") as Array<{ query_only: number }>;
  if (queryOnly.length > 0 && queryOnly[0].query_only === 1) return;

  const report = emptyReport();
  let repairedHere = false;
  try {
    db.runInTransaction(() => {
      // Another process may have repaired the base between preflight and
      // the write lock: re-read the cheap signals and exit silently.
      const now = readSchemaCompleteness(db);
      if (now.complete) return;
      const { fts: ftsBefore, tri: triBefore } = now;

      ensureSchema(db, report);
      ensureMissingFtsTriggers(db, report);

      // ensureFts rebuilds the index when it creates the table; a table that
      // lost its triggers has been missing updates for that window — rebuild.
      if (ftsBefore && now.triggers < 3 && hasRealTable(db, "nodes_fts")) {
        db.execSql("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
        report.applied.push("rebuilt nodes_fts (restored triggers)");
      }
      if (triBefore && now.triTriggers < 3 && hasRealTable(db, "nodes_fts_tri")) {
        db.execSql("INSERT INTO nodes_fts_tri(nodes_fts_tri) VALUES('rebuild')");
        report.applied.push("rebuilt nodes_fts_tri (restored triggers)");
      }

      ensureEmbedMeta(db, report);

      // Verify before COMMIT: repair touches schema objects, never data.
      // A failed verification rolls everything back.
      const nodesNow = (
        db.execSqlFirst("SELECT count(*) AS n FROM nodes") as { n: number }
      ).n;
      if (nodesNow !== before.nodes) {
        throw new Error(
          `schema repair changed the node count (${before.nodes} -> ${nodesNow})`
        );
      }
      if (!hasRealTable(db, "nodes_fts")) {
        throw new Error("nodes_fts still missing after repair");
      }
      repairedHere = true;
    });
  } catch (err) {
    result.warnings.push(
      `schema repair failed: ${
        err instanceof Error ? err.message : String(err)
      } — search falls back to LIKE until 'megamemory migrate --apply'`
    );
    return;
  }
  if (!repairedHere) return; // another process repaired first — stay silent
  result.repaired = true;
  result.repair_steps = report.applied;
  result.warnings.push(...report.warnings);
}

/**
 * ensureFts()/ensureTrigramFts() only create their sync triggers together
 * with the table. A db that lost the triggers but kept the table would
 * never regain them through ensureSchema — recreate the missing sets
 * explicitly. The DDL itself lives in the one shared source
 * (migrate-schema.ts, plan 17); this wrapper only decides which sets were
 * missing and words the report.
 */
function ensureMissingFtsTriggers(
  db: KnowledgeDB,
  report: MigrationReport
): void {
  const existing = new Set(
    (
      db.execSqlAll(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN " +
          "('nodes_ai','nodes_ad','nodes_au','nodes_tri_ai','nodes_tri_ad','nodes_tri_au')"
      ) as Array<{ name: string }>
    ).map((r) => r.name)
  );
  if (hasRealTable(db, "nodes_fts") && !existing.has("nodes_ai")) {
    ensureFtsTriggers(db);
    report.applied.push("restored nodes_ai/ad/au triggers");
  }
  if (hasRealTable(db, "nodes_fts_tri") && !existing.has("nodes_tri_ai")) {
    ensureTrigramTriggers(db);
    report.applied.push("restored nodes_tri_ai/ad/au triggers");
  }
}

/** Real FTS table (a view with the same name must not count — plan 16 R9). */
function hasRealTable(db: KnowledgeDB, name: string): boolean {
  return (
    db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
      name
    ) !== undefined
  );
}

/**
 * One-line stderr summary for the schema repair (plan 16 §2.3). Never
 * reuses the `migrated:` wording — that line means an upstream conversion.
 */
export function describeSchemaRepair(r: AutoMigrationResult): string | null {
  if (!r.repaired) return null;
  const parts: string[] = [];
  for (const step of r.repair_steps) {
    if (step.startsWith("created nodes_fts + triggers")) {
      // nodes_fts mirrors the nodes table (external content): the rebuilt
      // index holds exactly as many rows as the verified node count.
      parts.push(`created nodes_fts + triggers (${r.before.nodes} rows)`);
    } else if (step.startsWith("created nodes_fts_tri")) {
      parts.push("created nodes_fts_tri (+triggers)");
    } else if (step.startsWith("set meta.embed_model")) {
      parts.push("embed meta");
    } else {
      parts.push(step);
    }
  }
  if (parts.length === 0) parts.push("schema objects restored");
  return `schema repair: ${parts.join(", ")}`;
}

/** One-line stderr summary for startup (F14.4). */
export function describeAutoMigration(r: AutoMigrationResult): string | null {
  if (!r.performed) return null;
  const parts = [`${r.after?.nodes ?? r.before.nodes} nodes`];
  if (r.ids_repaired.length > 0) parts.push(`${r.ids_repaired.length} ids repaired`);
  if (r.reembed_required) parts.push("reembed required");
  return `migrated: upstream schema → v${MIGRATION_TARGET_SCHEMA_VERSION} · ${parts.join(" · ")}`;
}
