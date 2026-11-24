import type { KnowledgeDB } from "./db.js";
import { SCHEMA_VERSION } from "./db.js";
import { MODEL_NAME, isModelLoaded, vectorChannelState } from "./embeddings.js";
import { MIGRATION_TARGET_SCHEMA_VERSION } from "./migrate-schema.js";
import { isBrokenId } from "./migrate.js";
import { D3_CDN_FALLBACK_NOTE, d3Source } from "./d3-asset.js";
import { countStubSupports } from "./stub.js";
import { probeFtsHealth, type FtsHealth } from "./fts-health.js";
import { computeHealth, formatHealthSummary } from "./health.js";
import { digestPendingParents } from "./digest.js";
import { sessionize, timelineTsString } from "./sessions.js";

function noRecordsWarning(db: KnowledgeDB): string | undefined {
  if (!db.execSqlFirst("SELECT 1 FROM nodes WHERE removed_at IS NULL LIMIT 1")) return undefined;
  if (!db.execSqlFirst("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'timeline'")) return undefined;
  const now = Date.now();
  const rows = db.execSqlAll(
    `SELECT timestamp, tool, is_write, is_error FROM timeline
     WHERE timestamp >= ? AND timestamp < ? ORDER BY seq ASC`,
    timelineTsString(now - 14 * 86_400_000), timelineTsString(now)
  ) as Array<{ timestamp: string; tool: string; is_write: number; is_error: number }>;
  if (rows.some((row) => row.is_write === 1 && row.is_error === 0)) return undefined;
  const understandSessions = sessionize(rows).filter((session) =>
    session.entries.some((row) => row.tool === "understand" && row.is_error === 0)
  ).length;
  if (understandSessions < 3) return undefined;
  return `warn: ${understandSessions} сессии с understand и 0 записей за 14 дней — память читается, но не пополняется.\n` +
    "      Проверь: megamemory install --target kilo и next.record в ответе understand.";
}

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
  fts: FtsHealth;
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

  const ftsHealth = probeFtsHealth(db);

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
    fts: ftsHealth,
    digests: { count: digestCount, stale: digestStale },
    empty_ids: emptyIds,
    orphan_edges: orphanEdges,
    model_loaded: isModelLoaded(),
    rss_mb: Math.round(mem.rss / (1024 * 1024)),
  };
}

const EMBEDDING_MODEL_CHECK = "embedding model";

/**
 * The "embedding model" line: the text follows `vectorChannelState`, so a
 * model stamp without a generation never reads as "vector search on". A
 * missing generation is the normal state of a fresh base, not a problem.
 * @param db - knowledge base
 * @param vectors - live node vector counts, already collected by the caller
 * @returns the check to add to the report
 */
export function embeddingModelCheck(
  db: KnowledgeDB,
  vectors: { have: number; total: number }
): DoctorCheck {
  const channel = vectorChannelState(db);
  if (channel.state === "on") {
    return {
      name: EMBEDDING_MODEL_CHECK,
      ok: true,
      detail: `${MODEL_NAME} (dim=${db.getVectorGeneration()!.dim}, vectors ${vectors.have}/${vectors.total}, vector search on)`,
    };
  }
  if (channel.state === "partial") {
    return {
      name: EMBEDDING_MODEL_CHECK,
      ok: true,
      detail: `${MODEL_NAME} (vectors ${channel.total - channel.missing}/${channel.total}, ` +
        "vector search partial — run 'megamemory reembed')",
    };
  }
  switch (channel.reason) {
    case "no_generation":
      return {
        name: EMBEDDING_MODEL_CHECK,
        ok: true,
        detail: "vector search OFF — no generation: run 'megamemory reembed' (keyword search matches ALL query words)",
      };
    case "generation_without_vectors":
      return {
        name: EMBEDDING_MODEL_CHECK,
        ok: true,
        detail: "vector search OFF — generation without vectors (reembed ran on an empty base or stopped before its first row): " +
          "run 'megamemory reembed' (keyword search matches ALL query words)",
      };
    case "text_only_mode":
      return {
        name: EMBEDDING_MODEL_CHECK,
        ok: true,
        detail: "MEGAMEMORY_SEARCH=fts — keyword search only (configured)",
      };
    case "model_mismatch": {
      // F10: unknown-model vectors are a problem, not a note — exit 1 makes CI
      // and the acceptance flow catch a mixed vector space before it is served.
      const model = db.getMetaValue("embed_model");
      return {
        name: EMBEDDING_MODEL_CHECK,
        ok: false,
        detail: model === "unknown"
          ? `model unknown · vectors ${vectors.have}/${vectors.total} · run 'megamemory reembed'`
          : model
            ? `${model} != current ${MODEL_NAME} — vector search off, run 'megamemory reembed'`
            : "not recorded — run 'megamemory migrate --apply'",
      };
    }
  }
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

  const vectors = healthReport(db).vectors;
  checks.push(embeddingModelCheck(db, vectors));

  // Shared bounded read-only MATCH probe; external-content counts are not evidence.
  const ftsHealth = probeFtsHealth(db);
  add(
    "FTS index",
    ftsHealth.in_sync,
    ftsHealth.detail
      ? `${ftsHealth.detail} — run 'megamemory migrate --apply' (rebuilds the index)`
      : `${ftsHealth.rows}/${ftsHealth.nodes} rows indexed`
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
      : `${pending} node(s) await reembed (${vectorChannelState(db).state !== "off"
          ? "vector search covers indexed nodes, FTS covers the rest"
          : "search is keyword-only: every query word must occur"})`
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

  // digest sync: parents with enough ELIGIBLE children and no digest
  // (P4.3: единое правило количества детей с digest.ts — не размножается).
  const digestPending = digestPendingParents(db).length;
  add(
    "digests",
    true, // informational
    digestPending === 0
      ? "all large parent groups have digests"
      : `${digestPending} parent group(s) without digest — run 'megamemory digest --apply'`
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

  // ---- 2.1.12 F1: срок годности фактов ----
  // Просроченные факты уже не отдаются understand, но в графе они видны.
  // Доля больше 10% активных узлов — база гниёт: владелец либо продлевает
  // сроки, либо переводит узлы в superseded/refuted.
  const expiredCount = db.countExpiredNodes();
  const activeCount = (db.execSqlFirst(
    hasStatus
      ? `SELECT count(*) AS n FROM nodes WHERE removed_at IS NULL AND status = 'active'`
      : "SELECT 0 AS n"
  ) as { n: number }).n;
  const expiredRatio = activeCount > 0 ? expiredCount / activeCount : 0;
  add(
    "expired nodes",
    expiredRatio <= 0.1,
    expiredCount === 0
      ? "no expired facts"
      : `${expiredCount} of ${activeCount} active node(s) past valid_until (${Math.round(expiredRatio * 100)}%) — продли valid_until, переведи в superseded или refuted`
  );

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

  // ---- Этап A (план 20+21 v3 §6.A4): короткая информационная сводка ----
  // Один расчёт с stats (health.ts — общий module). Отсутствие записей
  // НИКОГДА не повышает problems и не меняет exit code: read-only задача и
  // успешное переиспользование памяти законны. Сбой расчёта — тоже
  // информационная строка, не проблема.
  try {
    const report = computeHealth(db, { window: "7d" });
    add("memory activity", true, formatHealthSummary(report));
  } catch (err) {
    add(
      "memory activity",
      true,
      `сводка активности недоступна: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const warning = noRecordsWarning(db);
  if (warning) add("memory recording", true, warning);

  return { checks, problems: checks.filter((c) => !c.ok).length };
}
