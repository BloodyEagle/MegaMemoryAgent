import type { KnowledgeDB } from "./db.js";
import { MODEL_NAME, isModelLoaded, vectorSearchEnabled } from "./embeddings.js";
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

// ---- U3: machine-readable health metrics (shared by doctor and web) ----

export interface HealthReport {
  schema_version: string;
  embed_model: string;
  embed_dim: number;
  nodes: number;
  vectors: { have: number; total: number };
  fts: { rows: number; nodes: number; in_sync: boolean };
  digests: { count: number; stale: number };
  empty_ids: number;
  orphan_edges: number;
  model_loaded: boolean;
  rss_mb: number;
}

/** Collect all metrics in one pass — read-only, safe on any db state. */
export function healthReport(db: KnowledgeDB): HealthReport {
  const nodesCount = (
    db.execSqlFirst(
      "SELECT count(*) AS n FROM nodes WHERE removed_at IS NULL"
    ) as { n: number }
  ).n;

  const vectorsHave = (
    db.execSqlFirst(
      "SELECT count(*) AS n FROM nodes WHERE embedding IS NOT NULL AND removed_at IS NULL"
    ) as { n: number }
  ).n;

  const ftsExists =
    db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
    ) !== undefined;
  const ftsRows = ftsExists
    ? (db.execSqlFirst("SELECT count(*) AS n FROM nodes_fts") as { n: number }).n
    : 0;

  const digestCount = (
    db.execSqlFirst(
      "SELECT count(*) AS n FROM nodes WHERE kind = 'digest' AND removed_at IS NULL"
    ) as { n: number }
  ).n;
  // Stale digest: some child was updated after the digest itself.
  const digestStale = (
    db.execSqlFirst(`
      SELECT count(*) AS n FROM nodes d
      WHERE d.kind = 'digest' AND d.removed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM nodes c
          WHERE c.parent_id = d.parent_id AND c.id != d.id
            AND c.removed_at IS NULL AND c.kind != 'digest'
            AND c.updated_at > d.updated_at
        )
    `) as { n: number }
  ).n;

  const emptyIds = (
    db.execSqlFirst(
      "SELECT count(*) AS n FROM nodes WHERE removed_at IS NULL AND (id = '' OR id LIKE '%/')"
    ) as { n: number }
  ).n;

  const orphanEdges = (
    db.execSqlFirst(
      `SELECT count(*) AS n FROM edges
       WHERE from_id NOT IN (SELECT id FROM nodes)
          OR to_id NOT IN (SELECT id FROM nodes)`
    ) as { n: number }
  ).n;

  const mem = process.memoryUsage();

  return {
    schema_version: db.getMetaValue("schema_version") ?? "",
    embed_model: db.getMetaValue("embed_model") ?? "",
    embed_dim: Number(db.getMetaValue("embed_dim") ?? 0),
    nodes: nodesCount,
    vectors: { have: vectorsHave, total: nodesCount },
    fts: { rows: ftsRows, nodes: nodesCount, in_sync: ftsRows === nodesCount },
    digests: { count: digestCount, stale: digestStale },
    empty_ids: emptyIds,
    orphan_edges: orphanEdges,
    model_loaded: isModelLoaded(),
    rss_mb: Math.round(mem.rss / (1024 * 1024)),
  };
}

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

  // ---- В18: graph health (informational) ----

  // Nodes without any edge — isolated facts, hard to navigate.
  const noEdges = (db.execSqlFirst(`
    SELECT count(*) AS n FROM nodes n
    WHERE n.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_id = n.id OR e.to_id = n.id)
  `) as { n: number }).n;
  add(
    "edge coverage",
    true,
    `${noEdges} node(s) without edges`
  );

  // Stale share (superseded/deprecated).
  const stale = (db.execSqlFirst(
    hasStatus
      ? `SELECT count(*) AS n FROM nodes WHERE removed_at IS NULL AND status != 'active'`
      : "SELECT 0 AS n"
  ) as { n: number }).n;
  add("stale nodes", true, `${stale} superseded/deprecated`);

  // М8: ids differing only by case collide on case-insensitive filesystems
  // (macOS, Windows) in the markdown export.
  const idRows = db.execSqlAll(
    "SELECT id FROM nodes WHERE removed_at IS NULL"
  ) as Array<{ id: string }>;
  const seenLower = new Map<string, string>();
  let caseClash = 0;
  for (const { id } of idRows) {
    const lower = id.toLowerCase();
    const existing = seenLower.get(lower);
    if (existing !== undefined && existing !== id) caseClash += 1;
    else seenLower.set(lower, id);
  }
  add(
    "id case clashes",
    caseClash === 0,
    caseClash === 0
      ? "no ids differing only by case"
      : `${caseClash} pair(s) — markdown export collides on case-insensitive filesystems`
  );

  // ---- F9.8: memory metrics ----

  const mem = process.memoryUsage();
  const modelLoaded = isModelLoaded();
  const rssMb = Math.round(mem.rss / (1024 * 1024));
  // RSS far above the model+graph budget with the session loaded smells like
  // a leak or an oversized batch.
  const memoryOk = !modelLoaded || rssMb <= 800;
  add(
    "memory",
    memoryOk,
    "rss " + rssMb + " MB, heapUsed " + Math.round(mem.heapUsed / (1024 * 1024)) +
      " MB, external " + Math.round(mem.external / (1024 * 1024)) +
      " MB, model loaded: " + (modelLoaded ? "yes" : "no")
  );

  return { checks, problems: checks.filter((c) => !c.ok).length };
}
