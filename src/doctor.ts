import type { KnowledgeDB } from "./db.js";
import { SCHEMA_VERSION } from "./db.js";
import { MODEL_NAME, isModelLoaded, vectorSearchEnabled } from "./embeddings.js";
import { MIGRATION_TARGET_SCHEMA_VERSION } from "./migrate-schema.js";
import { isBrokenId } from "./migrate.js";
import { D3_CDN_FALLBACK_NOTE, d3Source } from "./d3-asset.js";
import { countStubSupports } from "./stub.js";

/**
 * F13 helper: turn probe counts into a drift message. Exported for tests —
 * libsql auto-syncs external-content FTS on writes, so real drift is hard
 * to reproduce in a fixture.
 */
export function summarizeFtsProbe(
  probes: number,
  misses: number
): string | null {
  if (probes === 0 || misses === 0) return null;
  return misses === probes
    ? `all ${probes} sampled node(s) missing from the index`
    : `${misses}/${probes} sampled node(s) missing from the index`;
}

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
  const hasEpistemic = hasColumn("nodes", "epistemic_status");
  const hasEdgesRemovedAt = hasColumn("edges", "removed_at");

  // Plan 1 §6.0: PRAGMA user_version is a SECOND version stamp, independent
  // of meta.schema_version above. Without this check "the migration ran" and
  // "the doctor is green" would be unrelated claims.
  const userVersion = db.getUserVersion();
  add(
    "user_version",
    userVersion === SCHEMA_VERSION,
    userVersion === SCHEMA_VERSION
      ? `v${userVersion} (matches SCHEMA_VERSION)`
      : `v${userVersion}, expected ${SCHEMA_VERSION} — reopen the db (migration runs on open)`
  );

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
  // F10: unknown-model vectors are a problem, not a note — exit 1 makes CI
  // and the acceptance flow catch a mixed vector space before it is served.
  const vectors = healthReport(db).vectors;
  add(
    "embedding model",
    model === MODEL_NAME,
    model === "unknown"
      ? `model unknown · vectors ${vectors.have}/${vectors.total} · run 'megamemory reembed'`
      : model
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
  // F13: count equality is not enough after a VACUUM (rowids can shift).
  // FTS5 ships a built-in verification command that compares the index
  // with the content table and throws on any mismatch (stale rowids too).
  let ftsDrift: string | null = null;
  if (fts) {
    // Sample nodes: a MATCH on the name's first token must surface the
    // node's own rowid. After a VACUUM the index keeps stale rowids,
    // so the probe misses the moved node.
    const sample = db.execSqlAll(
      "SELECT rowid, name FROM nodes WHERE removed_at IS NULL ORDER BY rowid DESC LIMIT 20"
    ) as Array<{ rowid: number; name: string }>;
    let probes = 0;
    let misses = 0;
    for (const node of sample) {
      const token = node.name.trim().split(/\s+/)[0];
      if (!token) continue;
      try {
        const phrase = `"\${token.replace(/\"/g, '""')}"*`;
        const hits = db.execSqlAll(
          "SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 1000",
          phrase
        ) as Array<{ rowid: number }>;
        probes += 1;
        if (!hits.some((h) => h.rowid === node.rowid)) misses += 1;
      } catch {
        // an unparseable token is not a drift signal
      }
    }
    ftsDrift = summarizeFtsProbe(probes, misses);
  }
  const ftsOk = Boolean(fts) && ftsCount === nodesCount && ftsDrift === null;
  add(
    "FTS index",
    ftsOk,
    !fts
      ? "missing — run 'megamemory migrate --apply'"
      : ftsDrift
        ? `${ftsDrift} — run 'megamemory migrate --apply' (rebuilds the index)`
        : `${ftsCount}/${nodesCount} rows indexed`
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

  // ---- Plan 1 §6: tombstones and the epistemic axis ----

  if (hasEdgesRemovedAt) {
    // §6.1: tombstoned edges — count them, and flag tombstones between two
    // live nodes (a likely pointless unlink).
    const tombstoned = (db.execSqlFirst(
      "SELECT count(*) AS n FROM edges WHERE removed_at IS NOT NULL"
    ) as { n: number }).n;
    const tombstonedBetweenLive = (db.execSqlFirst(
      `SELECT count(*) AS n FROM edges e
       WHERE e.removed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM nodes f WHERE f.id = e.from_id AND f.removed_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM nodes t WHERE t.id = e.to_id AND t.removed_at IS NOT NULL)`
    ) as { n: number }).n;
    add(
      "edge tombstones",
      true, // informational — tombstones are history, not damage
      `${tombstoned} tombstoned edge(s)` +
        (tombstonedBetweenLive > 0 ? `, ${tombstonedBetweenLive} between live nodes (check why)` : "")
    );

    // §6.2: live edges pointing at a soft-removed node — desync, must be 0.
    const liveAtRemoved = (db.execSqlFirst(
      `SELECT count(*) AS n FROM edges e
       WHERE e.removed_at IS NULL
         AND (EXISTS (SELECT 1 FROM nodes f WHERE f.id = e.from_id AND f.removed_at IS NOT NULL)
           OR EXISTS (SELECT 1 FROM nodes t WHERE t.id = e.to_id AND t.removed_at IS NOT NULL))`
    ) as { n: number }).n;
    add(
      "edge/node removal sync",
      liveAtRemoved === 0,
      liveAtRemoved === 0 ? "no live edges at removed nodes" : `${liveAtRemoved} live edge(s) at removed node(s) — run 'megamemory repair' or re-remove the node`
    );
  }

  if (hasEpistemic) {
    // §6.3: both axes reported separately — lifecycle and epistemic.
    const epiCounts = db.getEpistemicStatusCounts();
    const epiSummary = ["open", "validated", "refuted", "abandoned", "stub", "null"]
      .filter((k) => epiCounts[k] !== undefined)
      .map((k) => `${k}=${epiCounts[k]}`)
      .join(", ");
    const statusSummary = hasStatus
      ? Object.entries(db.getStatusCounts())
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "n/a";
    add("status axes", true, `lifecycle: ${statusSummary || "none"} · epistemic: ${epiSummary || "none"}`);

    // §6.3a: validated without a scope, or without an artifact in it —
    // by plan rules it must not be trusted as confirmed.
    const unscoped = (db.execSqlFirst(
      `SELECT count(*) AS n FROM nodes
       WHERE epistemic_status = 'validated'
         AND (status_scope IS NULL OR status_scope NOT LIKE '%"artifact"%')`
    ) as { n: number }).n;
    add(
      "validated scope",
      unscoped === 0,
      unscoped === 0
        ? "all validated nodes carry a scope with an artifact"
        : `${unscoped} validated node(s) without status_scope.artifact — treat as open`
    );

    // §6.4: epistemic transitions without a reason (legacy rows excluded —
    // they predate the field column and have no reason by design). The table
    // is created lazily, so it may not exist yet on a fresh db.
    const hasHistory =
      db.execSqlFirst(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='status_history'"
      ) !== undefined;
    const hasHistoryField =
      hasHistory &&
      (db.pragma("table_info(status_history)") as Array<{ name: string }>).some(
        (c) => c.name === "field"
      );
    const noReason = hasHistoryField
      ? (db.execSqlFirst(
          `SELECT count(*) AS n FROM status_history
           WHERE field = 'epistemic_status' AND (reason IS NULL OR reason = '')`
        ) as { n: number }).n
      : 0;
    add(
      "epistemic history",
      noReason === 0,
      noReason === 0
        ? "all epistemic transitions carry a reason"
        : `${noReason} transition(s) without reason (legacy rows are exempt)`
    );
  }

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

  // ---- 2.1.3 F1/F2: revision journal and artifact observations ----
  // Both tables are created by the v11 migration on open, so a missing one
  // means real damage, not an old db. Counts are informational.
  const hasRevisions = db.hasSupportRevisionsTable();
  const hasArtifacts = db.hasNodeArtifactsTable();
  if (hasRevisions && hasArtifacts) {
    add(
      "provenance journal",
      true,
      `${db.countSupportRevisions()} revision(s), ${db.countNodeArtifacts()} artifact observation(s)`
    );
  } else {
    const missing = [
      ...(hasRevisions ? [] : ["support_revisions"]),
      ...(hasArtifacts ? [] : ["node_artifacts"]),
    ].join(", ");
    add(
      "provenance journal",
      false,
      `missing table(s): ${missing} — reopen the db (migration runs on open)`
    );
  }

  // ---- 2.1.9 F1/F2: d3 source and support stubs ----

  // The same line serve prints at startup: local file, env override, or the
  // CDN fallback note. Informational — the fallback works, it just must not
  // pass silently.
  const d3 = d3Source();
  add(
    "d3 asset",
    true,
    d3 === "local"
      ? "local web/vendor/d3.min.js"
      : d3 === "env"
        ? "MEGAMEMORY_D3_URL"
        : D3_CDN_FALLBACK_NOTE
  );

  // Support nodes whose summary is a template / too short to be a claim —
  // they look like confirmation in stats and weak_links while proving nothing.
  const stubSupports = countStubSupports(db);
  add(
    "stub supports",
    true, // informational — already recorded stubs are marked, not deleted
    stubSupports === 0
      ? "no stub supports"
      : `${stubSupports} support node(s) without a claim — replace with a ref or a real summary`
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
