import type { KnowledgeDB } from "./db.js";
import { MODEL_NAME, vectorSearchEnabled } from "./embeddings.js";
import { MIGRATION_TARGET_SCHEMA_VERSION } from "./migrate-schema.js";
import { isBrokenId } from "./migrate.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Read-only health check (plan T9): migration state, embedding model
 * consistency, FTS presence, legacy ids, pending reembed, digest sync,
 * orphan edges. Problems set exitCode 1 in the CLI (CI-friendly).
 */
export function runDoctor(db: KnowledgeDB): {
  checks: DoctorCheck[];
  problems: number;
} {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // Non-migrated dbs lack fork columns — queries must degrade gracefully.
  const hasColumn = (table: string, col: string): boolean =>
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(
      (c) => c.name === col
    );
  const hasStatus = hasColumn("nodes", "status");

  // schema_version
  const version = db.getMetaValue("schema_version");
  add(
    "schema_version",
    version === MIGRATION_TARGET_SCHEMA_VERSION,
    version
      ? version === MIGRATION_TARGET_SCHEMA_VERSION
        ? `v${version} (fork)`
        : `v${version}, expected ${MIGRATION_TARGET_SCHEMA_VERSION} — run 'megamemory migrate --apply'`
      : "missing — run 'megamemory migrate --apply'"
  );

  // embedding model
  const model = db.getMetaValue("embed_model");
  const dim = db.getMetaValue("embed_dim");
  const vectorOk = vectorSearchEnabled(db);
  add(
    "embedding model",
    model === MODEL_NAME,
    model
      ? model === MODEL_NAME
        ? `${model} (dim=${dim ?? "?"}, vector search on)`
        : `${model} != current ${MODEL_NAME} — vector search off, run 'megamemory reembed'`
      : "not recorded — run 'megamemory migrate --apply'"
  );

  // FTS index
  const fts = db.execSqlFirst(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
  );
  let ftsCount = -1;
  let nodesCount = -1;
  if (fts) {
    ftsCount = (db.execSqlFirst("SELECT count(*) AS n FROM nodes_fts") as { n: number }).n;
    nodesCount = (db.execSqlFirst(
      "SELECT count(*) AS n FROM nodes WHERE removed_at IS NULL"
    ) as { n: number }).n;
  }
  add(
    "FTS index",
    Boolean(fts) && ftsCount === nodesCount,
    fts ? `${ftsCount}/${nodesCount} rows indexed` : "missing — run 'megamemory migrate --apply'"
  );

  // legacy ids
  const broken = (db.execSqlFirst(
    `SELECT count(*) AS n FROM nodes WHERE id = '' OR id LIKE '%/'`
  ) as { n: number }).n;
  add(
    "node ids",
    broken === 0,
    broken === 0 ? "no empty/trailing-slash ids" : `${broken} broken — run 'megamemory repair-ids --apply'`
  );

  // active nodes without embedding
  const statusFilter = hasStatus ? " AND status = 'active'" : "";
  const pending = (db.execSqlFirst(
    `SELECT count(*) AS n FROM nodes WHERE embedding IS NULL AND removed_at IS NULL${statusFilter}`
  ) as { n: number }).n;
  add(
    "embeddings",
    true, // informational — reembed pending is a normal state, not an error
    pending === 0
      ? "all active nodes have vectors"
      : `${pending} node(s) await reembed (search still works via FTS)`
  );

  // orphan edges
  const orphans = (db.execSqlFirst(
    `SELECT count(*) AS n FROM edges
     WHERE from_id NOT IN (SELECT id FROM nodes)
        OR to_id NOT IN (SELECT id FROM nodes)`
  ) as { n: number }).n;
  add("edges", orphans === 0, orphans === 0 ? "no orphans" : `${orphans} orphaned edge(s)`);

  // digest sync: parents with >=5 children and no digest
  const digestPending = (db.execSqlFirst(
    `SELECT count(*) AS n FROM nodes p
     WHERE p.removed_at IS NULL
       AND (SELECT count(*) FROM nodes c
            WHERE c.parent_id = p.id AND c.removed_at IS NULL AND c.kind != 'digest') >= 5
       AND NOT EXISTS (
         SELECT 1 FROM nodes d
         WHERE d.parent_id = p.id AND d.kind = 'digest' AND d.removed_at IS NULL
       )`
  ) as { n: number }).n;
  add(
    "digests",
    true, // informational
    digestPending === 0
      ? "all large modules have digests"
      : `${digestPending} module(s) without digest — run 'megamemory digest --apply'`
  );

  return { checks, problems: checks.filter((c) => !c.ok).length };
}
