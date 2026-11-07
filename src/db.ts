import Database from "libsql";
import path from "path";
import fs from "fs";
import { createHash } from "node:crypto";
import type {
  NodeRow,
  EdgeRow,
  NodeArtifactRow,
  SupportBaselineRow,
  SupportRevisionRow,
} from "./types.js";
import { normalizeName } from "./norm.js";
import { looksLikeFileRefAnchor } from "./stub.js";

/** Plan 4 (informed_by provenance slice, schema v7); v8 baselines, v11 revisions
 * + artifacts, v12 nodes.created_via (anchor vs agent-node). */
// 2.1.12: v13 — node_artifacts.repo_path (F2, где резолвился git:-ref);
// nodes.valid_until для срока годности фактов (F1) существует с v5 — v13
// его структуру не трогает, только семантику чтения.
export const SCHEMA_VERSION = 13;

/**
 * 2.1.12 F1: просрочен ли факт. Просрочен = жив, активен, valid_until в
 * прошлом. Superseded/deprecated узлы не «просрочены» — их старость уже
 * выражена собственным статусом; удалённые не считаются вовсе. Неразбираемая
 * дата никогда не объявляется просрочкой — молчаливая ложь хуже явной.
 */
export function isNodeExpired(
  node: { status?: string | null; valid_until?: string | null; removed_at?: string | null },
  now: Date = new Date()
): boolean {
  if (node.removed_at) return false;
  if ((node.status ?? "active") !== "active") return false;
  if (!node.valid_until) return false;
  const t = Date.parse(node.valid_until);
  return !Number.isNaN(t) && t < now.getTime();
}

/**
 * 2.1.3 F1: support revision journal defaults. The journal keeps the history
 * of confirmed versions per pair "decision — support": at most
 * SUPPORT_REVISIONS_MAX_PER_PAIR revisions per pair and no row older than
 * SUPPORT_REVISIONS_RETENTION_DAYS. The per-pair cap is trimmed on every
 * write to that pair (one indexed DELETE); the day-based purge rides on
 * writes at most once per SUPPORT_REVISIONS_PRUNE_INTERVAL inserts.
 */
export const SUPPORT_REVISIONS_MAX_PER_PAIR = 50;
export const SUPPORT_REVISIONS_RETENTION_DAYS = 365;
export const SUPPORT_REVISIONS_PRUNE_INTERVAL = 200;

/**
 * F5 (2.1.1): timeline retention defaults. The call journal is service
 * telemetry — useful, but not worth an unbounded file. Configured via
 * MEGAMEMORY_TIMELINE_RETENTION_DAYS / MEGAMEMORY_TIMELINE_MAX_ENTRIES;
 * 0 disables a rule. Unlike the provenance audit journal, which keeps its
 * own 200-runs/90-days rule, this one is trimmed right here.
 */
export const TIMELINE_RETENTION_DAYS_DEFAULT = 90;
export const TIMELINE_MAX_ENTRIES_DEFAULT = 50_000;
/** Automatic prune rides on writes, at most once per this many inserts. */
export const TIMELINE_PRUNE_INTERVAL = 500;
/** Rows deleted per statement — no long write lock over a big backlog. */
export const TIMELINE_PRUNE_BATCH = 1000;

/** Integer from the environment (per call, plan 3 §11), or the default. */
function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
}

export class KnowledgeDB {
  private db: Database.Database;
  private dbFile: string;
  private _txDepth = 0;
  private _hasStatusColumn: boolean | undefined;
  /** F5: inserts since the last automatic timeline prune. */
  private timelineWritesSincePrune = 0;
  /** 2.1.3 F1: revision inserts since the last automatic retention purge. */
  private supportRevisionWritesSincePrune = 0;

  /** Absolute path of the backing file; config flags are read per call (plan 3 §11). */
  get dbPath(): string {
    return this.dbFile;
  }

  /**
   * Fork dbs have nodes.status (T0.5 migration); upstream dbs do not.
   * Queried once so read paths never break on an un-migrated database.
   */
  /** Fork lifecycle columns present (public: tools check before status writes). */
  get hasStatusColumn(): boolean {
    if (this._hasStatusColumn === undefined) {
      const cols = this.db.pragma("table_info(nodes)") as Array<{ name: string }>;
      this._hasStatusColumn = cols.some((c) => c.name === "status");
    }
    return this._hasStatusColumn;
  }

  private _hasNameNormColumn: boolean | undefined;

  private get hasNameNormColumn(): boolean {
    if (this._hasNameNormColumn === undefined) {
      const cols = this.db.pragma("table_info(nodes)") as Array<{ name: string }>;
      this._hasNameNormColumn = cols.some((c) => c.name === "name_norm");
    }
    return this._hasNameNormColumn;
  }

  /**
   * Keep the JS-normalized copy of the name in sync (patch А5): SQL lower()
   * is ASCII-only, so case-insensitive LIKE for cyrillic needs this column.
   * No-op on dbs where the fork migration has not added the column yet.
   */
  private syncNameNorm(id: string, name: string): void {
    if (!this.hasNameNormColumn) return;
    const norm = normalizeName(name);
    this.db
      .prepare("UPDATE nodes SET name_norm = ? WHERE id = ?")
      .run(norm, id);
  }

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.dbFile = path.resolve(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
    this.backfillCreatedViaV2();
  }

  /** Public: the doctor checks user_version against SCHEMA_VERSION (plan 1 §6). */
  getUserVersion(): number {
    const pragmaResult = this.db.pragma("user_version", { simple: true });
    // libsql returns { user_version: N } instead of raw N like better-sqlite3
    return (
      typeof pragmaResult === "object" && pragmaResult !== null
        ? (pragmaResult as Record<string, unknown>).user_version
        : pragmaResult
    ) as number;
  }

  private migrate(): void {
    const version = this.getUserVersion();
    if (version >= SCHEMA_VERSION) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check after acquiring the write lock in case another process migrated first.
      const currentVersion = this.getUserVersion();
      if (currentVersion >= SCHEMA_VERSION) {
        this.db.exec("COMMIT");
        return;
      }

      if (currentVersion < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            summary TEXT NOT NULL,
            why TEXT,
            file_refs TEXT,
            parent_id TEXT,
            created_by_task TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            removed_at TEXT,
            removed_reason TEXT,
            embedding BLOB,
            merge_group TEXT,
            needs_merge INTEGER DEFAULT 0,
            source_branch TEXT,
            merge_timestamp TEXT,
            -- Parity with migrate-schema.ts columns (plan 1, B2): fresh and
            -- migrated dbs must have the same column set/order for SELECT *.
            status TEXT NOT NULL DEFAULT 'active',
            valid_from TEXT,
            valid_until TEXT,
            name_norm TEXT NOT NULL DEFAULT '',
            epistemic_status TEXT,
            status_scope TEXT,
            -- Plan 2 (v6): task board columns, NULL for non-task nodes.
            task_state TEXT,
            due_at TEXT,
            -- Plan 4 (v8): the confirmed wording digest of the decision.
            -- Written only by confirm_supports; content writes never touch it
            -- (a mismatch against the current summary IS the signal).
            claim_digest TEXT,
            claim_digest_at TEXT,
            -- 2.1.10 (v12): which write path created the node. 'agent' —
            -- create_concept/task_add, 'file_ref' — server-built file-fact
            -- anchors (evidence: [{ref}]), 'import' — MergeEngine rows,
            -- 'auto' — other server writes (digest). NULL only on rows
            -- written before v12 outside the backfill (merge from an older
            -- source): unknown origin never incriminates the node.
            created_via TEXT,
            FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE SET NULL
          );

          CREATE TABLE IF NOT EXISTS edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            relation TEXT NOT NULL,
            description TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            merge_group TEXT,
            needs_merge INTEGER DEFAULT 0,
            source_branch TEXT,
            merge_timestamp TEXT,
            removed_at TEXT DEFAULT NULL,
            -- Plan 4 (v8): which server write path created the row. Assigned
            -- by the server, never accepted from the caller: link/evidence ->
            -- 'agent', auto-derivation -> 'auto', pre-v8 rows and every
            -- import/merge -> 'unknown' (the column default).
            created_via TEXT NOT NULL DEFAULT 'unknown',
            -- Plan 4 (v8): when the agent explicitly accepted an auto-derived
            -- edge. A separate event: it never rewrites created_via.
            accepted_at TEXT,
            FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
          CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
          CREATE INDEX IF NOT EXISTS idx_nodes_removed ON nodes(removed_at);
          CREATE INDEX IF NOT EXISTS idx_nodes_merge_group ON nodes(merge_group);
          CREATE INDEX IF NOT EXISTS idx_nodes_needs_merge ON nodes(needs_merge);
          CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
          CREATE INDEX IF NOT EXISTS idx_nodes_name_norm ON nodes(name_norm);
          CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
          CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
          CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
          CREATE INDEX IF NOT EXISTS idx_edges_merge_group ON edges(merge_group);
          CREATE INDEX IF NOT EXISTS idx_edges_needs_merge ON edges(needs_merge);
          CREATE INDEX IF NOT EXISTS idx_edges_removed ON edges(removed_at);
        `);
      }

      if (currentVersion < 2) {
        // Add merge-related columns for existing v1 databases
        const nodeColumns = this.db
          .prepare("PRAGMA table_info(nodes)")
          .all() as Array<{ name: string }>;
        const nodeColNames = new Set(nodeColumns.map((c) => c.name));

        if (!nodeColNames.has("merge_group")) {
          this.db.exec(`
            ALTER TABLE nodes ADD COLUMN merge_group TEXT;
            ALTER TABLE nodes ADD COLUMN needs_merge INTEGER DEFAULT 0;
            ALTER TABLE nodes ADD COLUMN source_branch TEXT;
            ALTER TABLE nodes ADD COLUMN merge_timestamp TEXT;
            CREATE INDEX IF NOT EXISTS idx_nodes_merge_group ON nodes(merge_group);
            CREATE INDEX IF NOT EXISTS idx_nodes_needs_merge ON nodes(needs_merge);
          `);
        }

        const edgeColumns = this.db
          .prepare("PRAGMA table_info(edges)")
          .all() as Array<{ name: string }>;
        const edgeColNames = new Set(edgeColumns.map((c) => c.name));

        if (!edgeColNames.has("merge_group")) {
          this.db.exec(`
            ALTER TABLE edges ADD COLUMN merge_group TEXT;
            ALTER TABLE edges ADD COLUMN needs_merge INTEGER DEFAULT 0;
            ALTER TABLE edges ADD COLUMN source_branch TEXT;
            ALTER TABLE edges ADD COLUMN merge_timestamp TEXT;
            CREATE INDEX IF NOT EXISTS idx_edges_merge_group ON edges(merge_group);
            CREATE INDEX IF NOT EXISTS idx_edges_needs_merge ON edges(needs_merge);
          `);
        }
      }

      if (currentVersion < 3) {
        // Add timeline table for version 3
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS timeline (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT DEFAULT (datetime('now')),
            tool TEXT NOT NULL,
            params TEXT NOT NULL,
            result_summary TEXT NOT NULL,
            is_write INTEGER NOT NULL,
            is_error INTEGER NOT NULL,
            affected_ids TEXT NOT NULL
          );
          
          CREATE INDEX IF NOT EXISTS idx_timeline_timestamp ON timeline(timestamp);
          CREATE INDEX IF NOT EXISTS idx_timeline_tool ON timeline(tool);
          CREATE INDEX IF NOT EXISTS idx_timeline_is_write ON timeline(is_write);
          CREATE INDEX IF NOT EXISTS idx_timeline_is_error ON timeline(is_error);
        `);
      }

      if (currentVersion < 4) {
        this.db.exec(`
          DELETE FROM edges
          WHERE id NOT IN (
            SELECT MIN(id)
            FROM edges
            GROUP BY from_id, to_id, relation
          )
        `);
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
          ON edges(from_id, to_id, relation)
        `);
      }

      if (currentVersion < 5) {
        // Plan 1: edge tombstones + epistemic status. All steps guarded by
        // PRAGMA table_info so the migration is idempotent (fresh dbs already
        // have every column from CREATE TABLE — the ALTERs no-op there).
        const ecols = new Set(
          this.db.prepare("PRAGMA table_info(edges)").all().map((c: any) => c.name)
        );
        if (!ecols.has("removed_at")) {
          this.db.exec(
            "ALTER TABLE edges ADD COLUMN removed_at TEXT;" +
            "CREATE INDEX IF NOT EXISTS idx_edges_removed ON edges(removed_at);"
          );
        }
        const ncols = new Set(
          this.db.prepare("PRAGMA table_info(nodes)").all().map((c: any) => c.name)
        );
        if (!ncols.has("epistemic_status")) {
          this.db.exec("ALTER TABLE nodes ADD COLUMN epistemic_status TEXT");
        }
        if (!ncols.has("status_scope")) {
          // JSON: {env?, version?, dataset?, artifact?} — scope of a `validated`.
          this.db.exec("ALTER TABLE nodes ADD COLUMN status_scope TEXT");
        }
        // status_history is created lazily (ensureStatusHistoryTable), so the
        // field column is only added here when the table already exists.
        const hasStatusHistory = this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='status_history'")
          .get();
        if (hasStatusHistory) {
          const scols = new Set(
            this.db.prepare("PRAGMA table_info(status_history)").all().map((c: any) => c.name)
          );
          if (!scols.has("field")) {
            this.db.exec(
              "ALTER TABLE status_history ADD COLUMN field TEXT NOT NULL DEFAULT 'status'"
            );
          }
        }
      }

      if (currentVersion < 6) {
        // Plan 2: workflow tables (trails, trail_members, slots) + the task
        // board columns. Every step is guarded so the migration is idempotent
        // (fresh dbs already have task_state/due_at from CREATE TABLE).
        const ncols6 = new Set(
          this.db.prepare("PRAGMA table_info(nodes)").all().map((c: any) => c.name)
        );
        if (!ncols6.has("task_state")) {
          this.db.exec("ALTER TABLE nodes ADD COLUMN task_state TEXT");
        }
        if (!ncols6.has("due_at")) {
          this.db.exec("ALTER TABLE nodes ADD COLUMN due_at TEXT");
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_nodes_task ON nodes(task_state) WHERE task_state IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_nodes_due  ON nodes(due_at)     WHERE due_at IS NOT NULL;

          CREATE TABLE IF NOT EXISTS trails (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            summary TEXT NOT NULL,
            stale INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT
          );
          CREATE TABLE IF NOT EXISTS trail_members (
            trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            node_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            PRIMARY KEY (trail_id, position)
          );
          CREATE TABLE IF NOT EXISTS slots (
            project TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL,
            node_id TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (project, role)
          );
        `);
      }

      if (currentVersion < 7) {
        // Plan 4 (v7): provenance slice — the informed_by cycle check hops per
        // (relation, endpoint); these composite indexes keep it and the node
        // cards off full edge scans. No new columns: relation is TEXT,
        // idx_edges_unique(from_id,to_id,relation) exists since v4 and
        // removed_at since v5.
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_edges_relation_from ON edges(relation, from_id);
          CREATE INDEX IF NOT EXISTS idx_edges_relation_to   ON edges(relation, to_id);
        `);
      }

      if (currentVersion < 8) {
        // Plan 4 (v8): support baselines — a snapshot of the justification,
        // one row per confirmed pair "decision — support". Every step guarded
        // by PRAGMA table_info so the migration is idempotent (fresh dbs
        // already carry the columns from CREATE TABLE).
        const ncols8 = new Set(
          this.db.prepare("PRAGMA table_info(nodes)").all().map((c: any) => c.name)
        );
        if (!ncols8.has("claim_digest")) {
          this.db.exec("ALTER TABLE nodes ADD COLUMN claim_digest TEXT");
        }
        if (!ncols8.has("claim_digest_at")) {
          this.db.exec("ALTER TABLE nodes ADD COLUMN claim_digest_at TEXT");
        }
        const ecols8 = new Set(
          this.db.prepare("PRAGMA table_info(edges)").all().map((c: any) => c.name)
        );
        if (!ecols8.has("created_via")) {
          // NOT NULL DEFAULT 'unknown': pre-v8 rows (and every import) are
          // honestly unknown — they must not inflate the "created by agent"
          // metric (plan 4 v8 §1.3, test 16).
          this.db.exec(
            "ALTER TABLE edges ADD COLUMN created_via TEXT NOT NULL DEFAULT 'unknown'"
          );
        }
        if (!ecols8.has("accepted_at")) {
          this.db.exec("ALTER TABLE edges ADD COLUMN accepted_at TEXT");
        }
        // NO foreign keys and NO cascade on purpose: a baseline row survives
        // the removal of the edge and of the support node — deletion hygiene
        // must not destroy exactly the information this table exists to keep
        // (plan 4 v8 §1.1, test 5: the row stays, the check reports "removed").
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS support_baselines (
            decision_id     TEXT NOT NULL,
            support_id      TEXT NOT NULL,
            edge_key        TEXT NOT NULL,
            claim_digest    TEXT NOT NULL,
            status_digest   TEXT NOT NULL,
            edge_digest     TEXT NOT NULL,
            format_version  INTEGER NOT NULL,
            confirmed_at    TEXT NOT NULL,
            confirmed_by    TEXT NOT NULL,
            superseded_at   TEXT,
            -- 2.1.3 F2: digest of the support's observed artifacts at the
            -- confirmation moment; NULL = no artifacts were observed yet
            -- (nothing to compare — honestly no signal).
            artifacts_digest TEXT,
            PRIMARY KEY (decision_id, support_id, edge_key)
          );
          CREATE INDEX IF NOT EXISTS idx_baselines_decision
            ON support_baselines(decision_id);
          CREATE INDEX IF NOT EXISTS idx_edges_created_via ON edges(created_via);
        `);
      }

      if (currentVersion < 9) {
        // plan-4-fixes-6 (F7): the explicit "no supports" confirmation no
        // longer deletes dead anchor rows — it marks them superseded_at, so
        // "confirmed and later removed" stays readable as history. Guarded by
        // PRAGMA table_info: fresh dbs already have the column from CREATE
        // TABLE, existing v8 dbs get the ALTER.
        const bcols9 = new Set(
          this.db.prepare("PRAGMA table_info(support_baselines)").all().map((c: any) => c.name)
        );
        if (bcols9.has("confirmed_by") && !bcols9.has("superseded_at")) {
          this.db.exec(
            "ALTER TABLE support_baselines ADD COLUMN superseded_at TEXT"
          );
        }
      }

      if (currentVersion < 10) {
        // plan-4-fixes-7 (F2): the live-support pagination used to page with
        // ORDER BY to_id LIMIT/OFFSET, so every page re-sorted ALL live edges
        // of the node — a 20 000-support star with a budget of 1 paid for the
        // whole star. This index gives the keyset walk (to_id > last ORDER BY
        // to_id LIMIT n) a prefix to read in order: equality on from_id,
        // relation, removed_at, then to_id in index order — no temp b-tree,
        // work proportional to the page, not the star. Old dbs get the same
        // index as fresh ones (CREATE INDEX IF NOT EXISTS — idempotent).
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS idx_edges_live_from_to ON edges(from_id, relation, removed_at, to_id)"
        );
      }

      if (currentVersion < 11) {
        // 2.1.3 F1: the revision journal of confirmed support versions —
        // written by the SAME paths that write support_baselines
        // (confirm_supports, the create_concept evidence carve-out, the merge
        // carry). No foreign keys and no cascades, same reason as the
        // baselines: deletion hygiene must not destroy the history.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS support_revisions (
            id             INTEGER PRIMARY KEY,
            decision_id    TEXT NOT NULL,
            support_id     TEXT NOT NULL,
            edge_key       TEXT NOT NULL,
            claim_digest   TEXT NOT NULL,
            status_digest  TEXT NOT NULL,
            edge_digest    TEXT NOT NULL,
            format_version INTEGER NOT NULL,
            confirmed_at   TEXT NOT NULL,
            recorded_at    TEXT NOT NULL,
            source         TEXT NOT NULL,
            reason         TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_support_revisions_pair
            ON support_revisions(decision_id, support_id, recorded_at);
        `);
        // 2.1.3 F2: digests of the external artifacts a node references
        // (files, git blobs). Written ONLY by the explicit check_artifacts —
        // reads never hash files. digest is nullable ON PURPOSE: null = the
        // file was missing at the last check. prev_digest/changed_at exist
        // for the warning text only, the verdict compares snapshots.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS node_artifacts (
            node_id       TEXT NOT NULL,
            kind          TEXT NOT NULL,
            ref           TEXT NOT NULL,
            digest        TEXT,
            prev_digest   TEXT,
            size_bytes    INTEGER,
            checked_at    TEXT NOT NULL,
            changed_at    TEXT,
            checked_by    TEXT NOT NULL,
            PRIMARY KEY (node_id, kind, ref)
          );
        `);
        // 2.1.3 F2: the confirmed artifacts state INSIDE the snapshot —
        // artifact_changed is derived by content (snapshot vs the current
        // observation), never by comparing clocks. Guarded: fresh dbs get
        // the column from CREATE TABLE, v10 dbs get the ALTER.
        const bcols11 = new Set(
          this.db.prepare("PRAGMA table_info(support_baselines)").all().map((c: any) => c.name)
        );
        if (bcols11.has("superseded_at") && !bcols11.has("artifacts_digest")) {
          this.db.exec(
            "ALTER TABLE support_baselines ADD COLUMN artifacts_digest TEXT"
          );
        }
      }

      if (currentVersion < 12) {
        // 2.1.10 F1: anchors are not stubs. nodes.created_via separates the
        // write paths: the template "File-fact node for ..." summary is what
        // evidence: [{ref}] anchors are SUPPOSED to look like — only
        // agent-written placeholder summaries remain stubs. Guarded ALTER
        // (fresh dbs already carry the column from CREATE TABLE), then a
        // one-time backfill: a row is an anchor when ALL three hold — the
        // file-fact summary template, file_refs[0] === name, and a name
        // shaped like "path:line" / "path:start-end". Everything else is a
        // hand-written node ('agent') — the backfill never leaves NULL behind.
        const ncols12 = new Set(
          this.db.prepare("PRAGMA table_info(nodes)").all().map((c: any) => c.name)
        );
        if (!ncols12.has("created_via")) {
          this.db.exec("ALTER TABLE nodes ADD COLUMN created_via TEXT");
        }
        const legacyRows = this.db
          .prepare(
            "SELECT id, name, summary, file_refs FROM nodes WHERE created_via IS NULL"
          )
          .all() as Array<{
          id: string;
          name: string;
          summary: string;
          file_refs: string | null;
        }>;
        const backfill = this.db.prepare(
          "UPDATE nodes SET created_via = ? WHERE id = ?"
        );
        for (const row of legacyRows) {
          let refs: string[] | null = null;
          try {
            const parsed = row.file_refs ? JSON.parse(row.file_refs) : null;
            if (Array.isArray(parsed)) refs = parsed.map(String);
          } catch {
            refs = null;
          }
          backfill.run(
            looksLikeFileRefAnchor(row.summary, row.name, refs) ? "file_ref" : "agent",
            row.id
          );
        }
      }

      if (currentVersion < 13) {
        // 2.1.12 F2: the repository a git: ref was resolved against is pinned
        // on the row at the FIRST resolution — later checks reuse it instead
        // of depending on the cwd the server happened to run in. Additive,
        // guarded: fresh dbs already carry the column from CREATE TABLE.
        const hasArtifacts13 = this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_artifacts'")
          .get();
        if (hasArtifacts13) {
          const acols13 = new Set(
            this.db.prepare("PRAGMA table_info(node_artifacts)").all().map((c: any) => c.name)
          );
          if (!acols13.has("repo_path")) {
            this.db.exec("ALTER TABLE node_artifacts ADD COLUMN repo_path TEXT");
          }
        }
        // F1: nodes.valid_until exists since v5 and keeps its values (written
        // by supersedes). v13 adds the expiry READING semantics — the column
        // itself and the existing data are deliberately left alone: no
        // backfill, no default. A migrated db looks exactly like it did on
        // v12 (test 8: migration fills nothing).
      }

      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 2.1.11 F1: повторный проход бэкфилла created_via. Миграция v11→v12
   * выполняется один раз, и базы, уже сидящие на v12, старое правило
   * (имя обязано кончаться «:строка») прошлись по ним с занесённым
   * `agent` — ссылки на файл целиком (`plans/report.md`) легитимны, но
   * остались помечены как ручные заглушки. Правка данных, не структуры:
   * SCHEMA_VERSION не поднимается, вместо этого идемпотентный шаг при
   * открытии базы на v12 — перевести на `file_ref` строки `agent`, у
   * которых все три признака якоря (по ослабленному предикату) выполнены.
   * Однократность — флаг `created_via_backfill_v2 = done` в meta.
   */
  private backfillCreatedViaV2(): void {
    if (this.getUserVersion() !== SCHEMA_VERSION) return;
    if (this.getMetaValue("created_via_backfill_v2") === "done") return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check after acquiring the write lock in case another process
      // finished the pass first (mirror of migrate()).
      if (this.getMetaValue("created_via_backfill_v2") === "done") {
        this.db.exec("COMMIT");
        return;
      }
      const rows = this.db
        .prepare(
          "SELECT id, name, summary, file_refs FROM nodes WHERE created_via = 'agent'"
        )
        .all() as Array<{
        id: string;
        name: string;
        summary: string | null;
        file_refs: string | null;
      }>;
      const flip = this.db.prepare(
        "UPDATE nodes SET created_via = 'file_ref' WHERE id = ?"
      );
      for (const row of rows) {
        let refs: string[] | null = null;
        try {
          const parsed = row.file_refs ? JSON.parse(row.file_refs) : null;
          if (Array.isArray(parsed)) refs = parsed.map(String);
        } catch {
          refs = null;
        }
        if (looksLikeFileRefAnchor(row.summary, row.name, refs)) flip.run(row.id);
      }
      this.setMetaValue("created_via_backfill_v2", "done");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  runInTransaction<T>(fn: () => T): T {
    if (this._txDepth > 0) {
      // Already inside a transaction — just run the function
      this._txDepth++;
      try {
        return fn();
      } finally {
        this._txDepth--;
      }
    }

    this._txDepth++;
    try {
      return this.runWithRetry(() => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const result = fn();
          this.db.exec("COMMIT");
          return result;
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
      });
    } finally {
      this._txDepth--;
    }
  }

  runWithRetry<T>(fn: () => T, maxRetries = 3): T {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (err: unknown) {
        const isBusy =
          err instanceof Error &&
          (err.message.includes("SQLITE_BUSY") ||
            err.message.includes("database is locked"));
        if (!isBusy || attempt >= maxRetries) {
          throw err;
        }
        const delayMs = 50 * Math.pow(2, attempt);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
    }
  }

  // ---- Node CRUD ----

  insertNode(node: {
    id: string;
    name: string;
    kind: string;
    summary: string;
    why?: string | null;
    file_refs?: string[] | null;
    parent_id?: string | null;
    created_by_task?: string | null;
    embedding?: Buffer | null;
    // Plan 1 §5.3: initial epistemic state, default open (NULL on legacy dbs).
    epistemic_status?: string | null;
    status_scope?: string | null;
    // 2.1.10 (v12): node origin — 'agent' | 'file_ref' | 'import' | 'auto'.
    // Every write path must state its own; NULL stays for rows carried over
    // from sources that predate the column.
    created_via?: string | null;
    // 2.1.12 F1: срок годности факта (ISO-8601). NULL = бессрочно. Задаётся
    // агентом, сервер никогда не выставляет его сам.
    valid_until?: string | null;
  }): void {
    // Fork columns exist only on migrated dbs (same guard as insertNodeRaw).
    const untilCols = this.hasStatusColumn ? ", valid_until" : "";
    const untilParams = this.hasStatusColumn ? ", @valid_until" : "";
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id, created_by_task, embedding, epistemic_status, status_scope, created_via${untilCols})
      VALUES (@id, @name, @kind, @summary, @why, @file_refs, @parent_id, @created_by_task, @embedding, @epistemic_status, @status_scope, @created_via${untilParams})
    `);
    stmt.run({
      id: node.id,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why ?? null,
      file_refs: node.file_refs ? JSON.stringify(node.file_refs) : null,
      parent_id: node.parent_id ?? null,
      created_by_task: node.created_by_task ?? null,
      embedding: node.embedding ?? null,
      epistemic_status: node.epistemic_status ?? "open",
      status_scope: node.status_scope ?? null,
      created_via: node.created_via ?? null,
      valid_until: node.valid_until ?? null,
    });
    this.syncNameNorm(node.id, node.name);
  }

  insertNodeAndEdges(
    node: {
      id: string;
      name: string;
      kind: string;
      summary: string;
      why: string | null;
      file_refs: string | null;
      parent_id: string | null;
      created_by_task: string | null;
      embedding: Buffer | null;
      epistemic_status?: string | null;
      status_scope?: string | null;
      created_via?: string | null;
      valid_until?: string | null;
    },
    edges: Array<{
      to_id: string;
      relation: string;
      description: string | null;
      /** Plan 4 (v8) §1.3: per-edge origin — evidence is 'agent', auto-ground is 'auto'. */
      via?: "agent" | "auto" | "unknown";
    }>
  ): void {
    this.runInTransaction(() => {
      this.insertNode({
        id: node.id,
        name: node.name,
        kind: node.kind,
        summary: node.summary,
        why: node.why,
        file_refs: node.file_refs
          ? (JSON.parse(node.file_refs) as string[])
          : null,
        parent_id: node.parent_id,
        created_by_task: node.created_by_task,
        embedding: node.embedding,
        epistemic_status: node.epistemic_status,
        status_scope: node.status_scope,
        created_via: node.created_via,
        valid_until: node.valid_until,
      });

      for (const edge of edges) {
        if (edge.relation === "informed_by") {
          // Plan 4 §2 (invariant 6): never a silent skip for informed_by —
          // the validation inside insertEdge rejects a missing/removed target
          // (and any other violation) and the whole batch rolls back.
          this.insertEdge({
            from_id: node.id,
            to_id: edge.to_id,
            relation: edge.relation,
            description: edge.description,
            via: edge.via,
          });
        } else if (this.nodeExists(edge.to_id)) {
          this.insertEdge({
            from_id: node.id,
            to_id: edge.to_id,
            relation: edge.relation,
            description: edge.description,
            via: edge.via,
          });
        }
      }
    });
  }

  getNode(id: string): NodeRow | undefined {
    return this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND removed_at IS NULL")
      .get(id) as NodeRow | undefined;
  }

  getNodeIncludingRemoved(id: string): NodeRow | undefined {
    return this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | NodeRow
      | undefined;
  }

  updateNode(
    id: string,
    changes: {
      name?: string;
      kind?: string;
      summary?: string;
      why?: string;
      file_refs?: string[];
      // null clears the vector (used when the embed model changes and
      // reembed is pending); undefined leaves it untouched.
      embedding?: Buffer | null;
      // 2.1.12 F1: срок годности факта. undefined = не трогать, null = снять
      // (факт снова бессрочный), строка = выставить (ISO-8601).
      valid_until?: string | null;
    }
  ): boolean {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (changes.name !== undefined) {
      fields.push("name = @name");
      values.name = changes.name;
    }
    if (changes.kind !== undefined) {
      fields.push("kind = @kind");
      values.kind = changes.kind;
    }
    if (changes.summary !== undefined) {
      fields.push("summary = @summary");
      values.summary = changes.summary;
    }
    if (changes.why !== undefined) {
      fields.push("why = @why");
      values.why = changes.why;
    }
    if (changes.file_refs !== undefined) {
      fields.push("file_refs = @file_refs");
      values.file_refs = JSON.stringify(changes.file_refs);
    }
    if (changes.embedding !== undefined) {
      fields.push("embedding = @embedding");
      values.embedding = changes.embedding;
    }
    if (changes.valid_until !== undefined) {
      fields.push("valid_until = @valid_until");
      values.valid_until = changes.valid_until;
    }

    if (fields.length === 0) return false;

    fields.push("updated_at = datetime('now')");

    const stmt = this.db.prepare(
      `UPDATE nodes SET ${fields.join(", ")} WHERE id = @id AND removed_at IS NULL`
    );
    const result = stmt.run(values);
    if (changes.name !== undefined) {
      this.syncNameNorm(id, changes.name);
    }
    return result.changes > 0;
  }

  softDeleteNode(id: string, reason: string): boolean {
    let changed = false;
    this.runInTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE nodes SET removed_at = datetime('now'), removed_reason = @reason, updated_at = datetime('now')
        WHERE id = @id AND removed_at IS NULL
      `);
      const result = stmt.run({ id, reason });

      if (result.changes > 0) {
        changed = true;
        // Plan 1: tombstone the edges instead of deleting them. Removing a
        // node must not silently destroy its neighbours' provenance; restore
        // brings the links back.
        this.db
          .prepare(
            "UPDATE edges SET removed_at = datetime('now') " +
            "WHERE (from_id = ? OR to_id = ?) AND removed_at IS NULL"
          )
          .run(id, id);
      }
    });
    return changed;
  }

  // ---- Edge CRUD ----

  /**
   * Plan 4 §2 (invariant 1): for informed_by the validation and the write
   * share one BEGIN IMMEDIATE — otherwise two parallel batches could both
   * pass on the same snapshot and both commit a cycle. runInTransaction
   * nests, so batch callers (insertNodeAndEdges, supersedeNodes, ...) join
   * their already-open transaction instead of opening a second one.
   */
  insertEdge(edge: {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string | null;
    /**
     * Plan 4 (v8) §1.3: which server write path creates the row. Assigned by
     * the CALLING CODE PATH, never accepted from the MCP caller: 'agent' for
     * explicit tool writes (link, evidence), 'auto' for server-derived edges
     * (auto-ground), 'unknown' for everything else — the safe default, so an
     * un-mapped path can never inflate the "created by agent" metric.
     */
    via?: "agent" | "auto" | "unknown";
  }): { id: number; inserted: boolean } {
    if (edge.relation === "informed_by") {
      return this.runInTransaction(() => {
        this.assertInformedByWritable(edge.from_id, edge.to_id, edge.description);
        return this.insertEdgeRow(edge);
      });
    }
    return this.insertEdgeRow(edge);
  }

  /**
   * Plan 4 §1/§2, carried over as-is: informed_by is a strict DAG over live
   * edges with a mandatory rationale.
   *   - self-loop u == v is rejected;
   *   - the rationale (description) is mandatory and non-empty: what exactly
   *     in `to` supports `from` — a link without it is unreadable and thus
   *     useless;
   *   - both ends must be alive: an active edge onto a tombstoned node is an
   *     error, not a silent break (invariant 6);
   *   - acyclicity: `to` must not reach `from` over live informed_by edges.
   *     supersedes/contradicts are a separate layer and take no part in this
   *     check; parent_id does not either. The revive of a tombstoned row goes
   *     through this same check (invariant 2): a tombstoned u→v is not live,
   *     so a v→…→u path added in the meantime rejects the revival.
   */
  private assertInformedByWritable(
    fromId: string,
    toId: string,
    description: string | null | undefined
  ): void {
    if (fromId === toId) {
      throw new Error(
        `informed_by self-loop "${fromId}" is rejected: the relation is a strict DAG.`
      );
    }
    if (!description || description.trim().length === 0) {
      throw new Error(
        `informed_by: рационал обязателен — что именно в узле-to поддерживает from.`
      );
    }
    if (!this.nodeExists(fromId)) {
      throw new Error(
        `informed_by source "${fromId}" does not exist (or is removed) — ` +
          `an active edge onto a tombstoned node is rejected, not silently broken.`
      );
    }
    if (!this.nodeExists(toId)) {
      throw new Error(
        `informed_by target "${toId}" does not exist (or is removed) — ` +
          `an active edge onto a tombstoned node is rejected, not silently broken.`
      );
    }
    if (this.informedByReaches(toId, fromId)) {
      throw new Error(
        `informed_by cycle rejected: "${toId}" already reaches "${fromId}" over live ` +
          `informed_by edges — adding "${fromId} -> ${toId}" would close a cycle.`
      );
    }
    // Plan 3 §2 (invariant 16), plan-3-fixes-2 F18: a component that kept its
    // cycle after a needs_merge merge is closed for new INCOMING informed_by
    // until the conflict is resolved — the DAG invariant must not be papered
    // over by fresh writes. An OUTGOING edge (from inside the component to a
    // node outside it) closes no cycle and passes; cycle closure is already
    // rejected by the reachability check above.
    const cycleNodes = this.informedByCycleNodeSet();
    if (cycleNodes.has(toId)) {
      throw new Error(
        `informed_by write rejected: "${toId}" sits inside an unresolved ` +
          `informed_by cycle (needs_merge). Resolve the merge conflict first, ` +
          `then retry.`
      );
    }
  }

  /**
   * Plan 4 §2 (invariant 5): cycle-safe reachability over LIVE informed_by
   * edges only. Iterative walk with a visited set — a pre-existing cycle
   * (e.g. brought in by a merge) must not hang any new write. Only the
   * informed_by layer is followed; supersedes/contradicts never leak in.
   */
  private informedByReaches(start: string, target: string): boolean {
    if (start === target) return true;
    const visited = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const rows = this.db
        .prepare(
          "SELECT to_id FROM edges WHERE from_id = ? AND relation = 'informed_by' AND removed_at IS NULL"
        )
        .all(current) as Array<{ to_id: string }>;
      for (const row of rows) {
        if (row.to_id === target) return true;
        if (!visited.has(row.to_id)) {
          visited.add(row.to_id);
          stack.push(row.to_id);
        }
      }
    }
    return false;
  }

  /**
   * Plan 3 §2 (invariant 3/16): every live informed_by cycle as a node list —
   * an SCC with more than one member (self-loops cannot exist live, the
   * insert check rejects them). Iterative Tarjan over the whole live
   * informed_by layer. Shared by the post-merge re-validation (marks
   * needs_merge instead of aborting), the write ban into an unresolved
   * cyclic component, and the weak-links block of provenance_trace.
   */
  informedByCycleComponents(): string[][] {
    const rows = this.db
      .prepare(
        "SELECT from_id, to_id FROM edges WHERE relation = 'informed_by' AND removed_at IS NULL"
      )
      .all() as Array<{ from_id: string; to_id: string }>;

    const adj = new Map<string, string[]>();
    const nodes = new Set<string>();
    for (const e of rows) {
      nodes.add(e.from_id);
      nodes.add(e.to_id);
      if (!adj.has(e.from_id)) adj.set(e.from_id, []);
      adj.get(e.from_id)!.push(e.to_id);
    }

    // Iterative Tarjan: index/lowlink arrays, explicit DFS stack.
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    let counter = 0;

    for (const start of nodes) {
      if (index.has(start)) continue;
      // Frames: [node, iterator position into adj.get(node)]
      const callStack: Array<{ node: string; pos: number }> = [
        { node: start, pos: 0 },
      ];
      index.set(start, counter);
      lowlink.set(start, counter);
      counter++;
      stack.push(start);
      onStack.add(start);

      while (callStack.length > 0) {
        const frame = callStack[callStack.length - 1];
        const successors = adj.get(frame.node) ?? [];
        if (frame.pos < successors.length) {
          const next = successors[frame.pos];
          frame.pos++;
          if (!index.has(next)) {
            index.set(next, counter);
            lowlink.set(next, counter);
            counter++;
            stack.push(next);
            onStack.add(next);
            callStack.push({ node: next, pos: 0 });
          } else if (onStack.has(next)) {
            lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(next)!));
          }
        } else {
          callStack.pop();
          if (callStack.length > 0) {
            const parent = callStack[callStack.length - 1];
            lowlink.set(
              parent.node,
              Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!)
            );
          }
          if (lowlink.get(frame.node) === index.get(frame.node)) {
            // Root of an SCC — pop the component off the Tarjan stack.
            const component: string[] = [];
            for (;;) {
              const w = stack.pop()!;
              onStack.delete(w);
              component.push(w);
              if (w === frame.node) break;
            }
            if (component.length > 1) components.push(component);
          }
        }
      }
    }
    return components;
  }

  /** Flat set of nodes sitting on a live informed_by cycle. */
  informedByCycleNodeSet(): Set<string> {
    const set = new Set<string>();
    for (const component of this.informedByCycleComponents()) {
      for (const n of component) set.add(n);
    }
    return set;
  }

  private insertEdgeRow(edge: {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string | null;
    via?: "agent" | "auto" | "unknown";
  }): { id: number; inserted: boolean } {
    // Plan 1 §4.4: idx_edges_unique(from_id,to_id,relation) does not know
    // about removed_at, so a re-link after a tombstone would be silently
    // dropped by INSERT OR IGNORE. Revive the tombstoned row instead —
    // one row per (pair, relation), no duplicates, history preserved.
    const existing = this.db
      .prepare(
        "SELECT id, removed_at FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?"
      )
      .get(edge.from_id, edge.to_id, edge.relation) as
      | { id: number; removed_at: string | null }
      | undefined;

    if (existing) {
      if (existing.removed_at !== null) {
        // Revive keeps the original created_via: it is the same row coming
        // back, not a new creation (plan 4 v8 §1.3 — the metric counts
        // creations, and rewriting the origin would launder the history).
        this.db
          .prepare(
            "UPDATE edges SET removed_at = NULL, description = COALESCE(?, description) WHERE id = ?"
          )
          .run(edge.description ?? null, existing.id);
        return { id: existing.id, inserted: true };
      }
      return { id: existing.id, inserted: false };
    }

    const stmt = this.db.prepare(`
      INSERT INTO edges (from_id, to_id, relation, description, created_via)
      VALUES (@from_id, @to_id, @relation, @description, @created_via)
    `);
    const result = stmt.run({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      description: edge.description ?? null,
      created_via: edge.via ?? "unknown",
    });
    return {
      id: Number(result.lastInsertRowid),
      inserted: result.changes > 0,
    };
  }

  deleteEdge(fromId: string, to_id: string, relation: string): boolean {
    // Plan 1 §4.2: unlink tombstones the edge instead of erasing it — the
    // link history must survive an explicit unlink.
    const result = this.db
      .prepare(
        "UPDATE edges SET removed_at = datetime('now') " +
        "WHERE from_id = ? AND to_id = ? AND relation = ? AND removed_at IS NULL"
      )
      .run(fromId, to_id, relation);
    return result.changes > 0;
  }

  // ---- Lifecycle status (fork T4) ----

  /**
   * Set a node's lifecycle status. Only superseded nodes get valid_until.
   * Idempotent: setting the same status again is a harmless rewrite.
   */
  private statusHistoryReady = false;

  private ensureStatusHistoryTable(): void {
    if (this.statusHistoryReady) return;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS status_history (\
        id INTEGER PRIMARY KEY AUTOINCREMENT,\
        node_id TEXT NOT NULL,\
        from_status TEXT,\
        to_status TEXT NOT NULL,\
        reason TEXT,\
        field TEXT NOT NULL DEFAULT 'status',\
        at TEXT NOT NULL DEFAULT (datetime('now'))\
      )"
    );
    // Self-heal for tables created before plan 1: the field column separates
    // the lifecycle axis (status) from the epistemic axis (epistemic_status).
    const cols = this.db.pragma("table_info(status_history)") as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "field")) {
      this.db.exec(
        "ALTER TABLE status_history ADD COLUMN field TEXT NOT NULL DEFAULT 'status'"
      );
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_status_history_node ON status_history(node_id)"
    );
    this.statusHistoryReady = true;
  }

  setNodeStatus(
    id: string,
    status: string,
    validUntil?: string,
    reason?: string
  ): boolean {
    // U5: record every real transition (active -> superseded, ...).
    const previous = (
      this.execSqlFirst(
        "SELECT status FROM nodes WHERE id = ?",
        id
      ) as { status?: string } | undefined
    )?.status;

    const result = this.db
      .prepare(
        `UPDATE nodes SET status = @status,
           valid_until = COALESCE(@validUntil, valid_until),
           updated_at = datetime('now')
         WHERE id = @id`
      )
      .run({ status, validUntil: validUntil ?? null, id });

    if (result.changes > 0 && previous !== status) {
      this.recordStatusHistory(id, previous ?? null, status, reason);
    }
    return result.changes > 0;
  }

  // ---- Epistemic status (plan 1 §5) ----

  /**
   * Set the epistemic axis (open/validated/refuted/abandoned) — separate from
   * the lifecycle `status`. NO transition validation here on purpose: internal
   * callers (soft-delete, merge) must never be blocked by epistemic rules.
   * Validation of agent-driven transitions lives in the MCP tool handler.
   * Every real transition is recorded in status_history with field =
   * 'epistemic_status' and a non-empty reason.
   */
  setEpistemicStatus(
    id: string,
    to: string,
    reason: string,
    scope?: Record<string, unknown> | null
  ): boolean {
    const previous = (
      this.execSqlFirst(
        "SELECT epistemic_status FROM nodes WHERE id = ?",
        id
      ) as { epistemic_status?: string | null } | undefined
    )?.epistemic_status;

    const result = this.db
      .prepare(
        `UPDATE nodes SET epistemic_status = @to,
           status_scope = @scope,
           updated_at = datetime('now')
         WHERE id = @id`
      )
      .run({ to, scope: scope ? JSON.stringify(scope) : null, id });

    if (result.changes > 0 && previous !== to) {
      this.recordStatusHistory(id, previous ?? null, to, reason, "epistemic_status");
    }
    return result.changes > 0;
  }

  /** Epistemic breakdown for doctor: open/validated/refuted/abandoned/NULL. */
  getEpistemicStatusCounts(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT COALESCE(epistemic_status, 'null') AS s, count(*) AS n FROM nodes GROUP BY s"
      )
      .all() as Array<{ s: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.s] = row.n;
    return counts;
  }

  /** Latest epistemic transition reason for a node (shown next to [refuted]). */
  getLatestEpistemicReason(nodeId: string, toStatus: string): string | null {
    const has = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='status_history'")
      .get();
    if (!has) return null;
    const row = this.db
      .prepare(
        "SELECT reason FROM status_history WHERE node_id = ? AND to_status = ? AND field = 'epistemic_status' ORDER BY id DESC LIMIT 1"
      )
      .get(nodeId, toStatus) as { reason: string | null } | undefined;
    return row?.reason ?? null;
  }

  /** U5: append a status transition row (table self-heals on legacy dbs). */
  recordStatusHistory(
    nodeId: string,
    fromStatus: string | null,
    toStatus: string,
    reason?: string,
    field: "status" | "epistemic_status" = "status"
  ): void {
    this.ensureStatusHistoryTable();
    this.db
      .prepare(
        "INSERT INTO status_history (node_id, from_status, to_status, reason, field) VALUES (?, ?, ?, ?, ?)"
      )
      .run(nodeId, fromStatus, toStatus, reason ?? null, field);
  }

  /** U5: transitions of one node, newest first. */
  getStatusHistory(nodeId: string, limit = 5): Array<{
    from_status: string | null;
    to_status: string;
    reason: string | null;
    at: string;
  }> {
    const has = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='status_history'")
      .get();
    if (!has) return [];
    return this.db
      .prepare(
        "SELECT from_status, to_status, reason, at FROM status_history WHERE node_id = ? ORDER BY id DESC LIMIT ?"
      )
      .all(nodeId, limit) as Array<{
      from_status: string | null;
      to_status: string;
      reason: string | null;
      at: string;
    }>;
  }

  /** U5: all status transitions, newest first (timeline). */
  getAllStatusHistory(limit = 200): Array<{
    node_id: string;
    from_status: string | null;
    to_status: string;
    reason: string | null;
    at: string;
  }> {
    const has = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='status_history'")
      .get();
    if (!has) return [];
    return this.db
      .prepare(
        "SELECT node_id, from_status, to_status, reason, at FROM status_history ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as Array<{
      node_id: string;
      from_status: string | null;
      to_status: string;
      reason: string | null;
      at: string;
    }>;
  }

  /**
   * Mark old nodes superseded and link them from the replacement
   * (new --supersedes--> old). Returns the ids that were actually
   * superseded; unknown ids are reported and skipped.
   */
  supersedeNodes(newId: string, oldIds: string[]): { superseded: string[]; missing: string[] } {
    const superseded: string[] = [];
    const missing: string[] = [];
    this.runInTransaction(() => {
      for (const oldId of oldIds) {
        if (!this.nodeExists(oldId)) {
          missing.push(oldId);
          continue;
        }
        this.insertEdge({
          from_id: newId,
          to_id: oldId,
          relation: "supersedes",
          // Reached only from create_concept(supersedes) — an explicit agent
          // call (plan 4 v8 §1.3).
          via: "agent",
        });
        this.setNodeStatus(
          oldId,
          "superseded",
          new Date().toISOString(),
          `superseded by ${newId}`
        );
        superseded.push(oldId);
      }
    });
    return { superseded, missing };
  }

  /** Nodes with incoming `contradicts` edges — contradicted facts. */
  getContradictedNodes(): NodeRow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT n.* FROM nodes n
         JOIN edges e ON e.to_id = n.id
         WHERE e.relation = 'contradicts' AND e.removed_at IS NULL AND n.removed_at IS NULL`
      )
      .all() as NodeRow[];
  }

  /** Status breakdown for stats/doctor. */
  getStatusCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, count(*) AS n FROM nodes GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  // ---- Token usage accounting (fork T8) ----

  private usageReady = false;

  /** Usage table appears with the fork migration; self-heal for older dbs. */
  private ensureUsageTable(): void {
    if (this.usageReady) return;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS usage (\
        id INTEGER PRIMARY KEY AUTOINCREMENT,\
        at TEXT DEFAULT (datetime('now')),\
        tool TEXT NOT NULL,\
        query TEXT,\
        nodes INTEGER NOT NULL,\
        returned_chars INTEGER NOT NULL,\
        returned_tokens INTEGER NOT NULL\
      )"
    );
    // В15: compact-vs-full economy measured in the same row.
    const cols = this.db.pragma("table_info(usage)") as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "estimated_full_tokens")) {
      this.db.exec(
        "ALTER TABLE usage ADD COLUMN estimated_full_tokens INTEGER NOT NULL DEFAULT 0"
      );
    }
    this.usageReady = true;
  }

  insertUsage(entry: {
    tool: string;
    query?: string | null;
    nodes: number;
    returnedChars: number;
    returnedTokens: number;
    /** В15: what the full-mode answer would have cost. */
    estimatedFullTokens?: number;
  }): void {
    this.ensureUsageTable();
    this.db
      .prepare(
        `INSERT INTO usage (tool, query, nodes, returned_chars, returned_tokens, estimated_full_tokens)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.tool,
        entry.query ?? null,
        entry.nodes,
        entry.returnedChars,
        entry.returnedTokens,
        entry.estimatedFullTokens ?? entry.returnedTokens
      );
  }

  /**
   * Usage aggregates for the last `days` days: totals, average tokens per
   * answer, top-5 queries and a per-day series for the explorer chart.
   */
  getUsageStats(
    days = 7
  ): {
    total_queries: number;
    total_tokens: number;
    avg_tokens: number;
    saved_tokens: number;
    top_queries: Array<{ query: string; n: number }>;
    daily: Array<{ day: string; queries: number; tokens: number }>;
  } {
    const hasUsage = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage'")
      .get();
    if (!hasUsage) {
      return { total_queries: 0, total_tokens: 0, avg_tokens: 0, saved_tokens: 0, top_queries: [], daily: [] };
    }
    const since = `datetime('now', '-${Number(days)} days')`;

    const hasFull = (this.db.pragma("table_info(usage)") as Array<{ name: string }>).some(
      (c) => c.name === "estimated_full_tokens"
    );
    const totals = hasFull
      ? (this.db
          .prepare(
            `SELECT count(*) AS q, COALESCE(sum(returned_tokens), 0) AS t,
                    COALESCE(sum(estimated_full_tokens), 0) AS f
             FROM usage WHERE at >= ${since}`
          )
          .get() as { q: number; t: number; f: number })
      : ((this.db
          .prepare(
            `SELECT count(*) AS q, COALESCE(sum(returned_tokens), 0) AS t
             FROM usage WHERE at >= ${since}`
          )
          .get() as { q: number; t: number }) as { q: number; t: number; f: number });

    const top = this.db
      .prepare(
        `SELECT query, count(*) AS n FROM usage
         WHERE query IS NOT NULL AND at >= ${since}
         GROUP BY query ORDER BY n DESC LIMIT 5`
      )
      .all() as Array<{ query: string; n: number }>;

    const daily = this.db
      .prepare(
        `SELECT date(at) AS day, count(*) AS queries, COALESCE(sum(returned_tokens), 0) AS tokens
         FROM usage WHERE at >= ${since}
         GROUP BY date(at) ORDER BY day`
      )
      .all() as Array<{ day: string; queries: number; tokens: number }>;

    return {
      total_queries: totals.q,
      total_tokens: totals.t,
      avg_tokens: totals.q > 0 ? Math.round(totals.t / totals.q) : 0,
      // В15: how many tokens compact answers saved vs the full estimate.
      saved_tokens: Math.max(0, totals.f - totals.t),
      top_queries: top,
      daily,
    };
  }

  // ---- Provenance (plan 3) ----

  /**
   * Has this node EVER had an informed_by record — live or tombstoned, either
   * direction? The `complete` verdict of trace/audit is unreachable when this
   * returns true: "no links" is not allowed to lie (plan 3 §4.2).
   */
  hasAnyInformedByRecord(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM edges
         WHERE relation = 'informed_by' AND (from_id = ? OR to_id = ?)
         LIMIT 1`
      )
      .get(id, id);
    return row !== undefined;
  }

  /**
   * Live informed_by edges touching a node in one direction. `retrospective`
   * returns tombstones too (plan 3 §1.3) — the caller decides what to do with
   * filtered endpoints, no dangling edges may survive that filter.
   */
  getInformedByEdges(
    id: string,
    direction: "ancestry" | "impact",
    retrospective: boolean
  ): Array<EdgeRow & { other_id: string }> {
    const column = direction === "ancestry" ? "from_id" : "to_id";
    const other = direction === "ancestry" ? "to_id" : "from_id";
    return this.db
      .prepare(
        `SELECT e.*, e.${other} AS other_id FROM edges e
         WHERE e.${column} = ? AND e.relation = 'informed_by'
           ${retrospective ? "" : "AND e.removed_at IS NULL"}`
      )
      .all(id) as Array<EdgeRow & { other_id: string }>;
  }

  private provenanceAuditReady = false;

  /** Plan 3 §3 / §10 (decision 7): audit runs persist so a later re-run of a
   * shifted graph can be compared against what was actually found. The table
   * is created lazily like status_history/usage — no schema bump needed. */
  private ensureProvenanceAuditTable(): void {
    if (this.provenanceAuditReady) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provenance_audit_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        params TEXT,
        result TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_root ON provenance_audit_runs(root_id, created_at);
    `);
    this.provenanceAuditReady = true;
  }

  /**
   * Persist one audit run and apply the retention rule (plan 3 §10): the last
   * 200 runs per root, none older than 90 days.
   */
  insertProvenanceAuditRun(entry: {
    root_id: string;
    direction: string;
    params: unknown;
    result: unknown;
  }): number {
    this.ensureProvenanceAuditTable();
    const id = this.runInTransaction(() => {
      const res = this.db
        .prepare(
          `INSERT INTO provenance_audit_runs (root_id, direction, params, result)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          entry.root_id,
          entry.direction,
          JSON.stringify(entry.params ?? null),
          JSON.stringify(entry.result ?? null)
        );
      const rowid = Number(res.lastInsertRowid);
      this.db
        .prepare(
          `DELETE FROM provenance_audit_runs
           WHERE root_id = ?
             AND (created_at < datetime('now', '-90 days')
                  OR id NOT IN (
                    SELECT id FROM provenance_audit_runs
                    WHERE root_id = ?
                    ORDER BY id DESC LIMIT 200
                  ))`
        )
        .run(entry.root_id, entry.root_id);
      return rowid;
    });
    return id;
  }

  getProvenanceAuditRuns(rootId: string, limit = 5): Array<{
    id: number;
    root_id: string;
    direction: string;
    params: string | null;
    result: string | null;
    created_at: string;
  }> {
    this.ensureProvenanceAuditTable();
    return this.db
      .prepare(
        `SELECT id, root_id, direction, params, result, created_at
         FROM provenance_audit_runs WHERE root_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(rootId, limit) as Array<{
      id: number;
      root_id: string;
      direction: string;
      params: string | null;
      result: string | null;
      created_at: string;
    }>;
  }

  // ---- Support baselines (plan 4 v8) ----

  /**
   * The snapshot lives in its own table with NO foreign keys: rows survive
   * node/edge removal on purpose (deletion hygiene must not destroy the
   * divergence signal). Guard for reading a database opened by an older
   * build — the v8 migration runs on open, but merge double-checks.
   */
  hasSupportBaselinesTable(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_baselines'"
        )
        .get() !== undefined
    );
  }

  getSupportBaselines(decisionId: string): SupportBaselineRow[] {
    if (!this.hasSupportBaselinesTable()) return [];
    return this.db
      .prepare(
        `SELECT decision_id, support_id, edge_key, claim_digest, status_digest,
                edge_digest, format_version, confirmed_at, confirmed_by, superseded_at,
                artifacts_digest
         FROM support_baselines WHERE decision_id = ?
         ORDER BY support_id, confirmed_at, edge_key`
      )
      .all(decisionId) as SupportBaselineRow[];
  }

  /** Active (not superseded) rows only — the ones a check compares against. */
  getActiveSupportBaselines(decisionId: string): SupportBaselineRow[] {
    if (!this.hasSupportBaselinesTable()) return [];
    return this.db
      .prepare(
        `SELECT decision_id, support_id, edge_key, claim_digest, status_digest,
                edge_digest, format_version, confirmed_at, confirmed_by, superseded_at,
                artifacts_digest
         FROM support_baselines WHERE decision_id = ? AND superseded_at IS NULL
         ORDER BY support_id, confirmed_at, edge_key`
      )
      .all(decisionId) as SupportBaselineRow[];
  }

  /**
   * 2.1.2 F8: a PK point lookup — the one active row written for THIS edge
   * (decision, support, edge_key). The old fallback read the pair's whole
   * active history and filtered in JS: under a tiny budget that materialized
   * thousands of rows to find one anchor.
   */
  getSupportBaselineRow(
    decisionId: string,
    supportId: string,
    edgeKey: string
  ): SupportBaselineRow | undefined {
    if (!this.hasSupportBaselinesTable()) return undefined;
    return this.db
      .prepare(
        `SELECT decision_id, support_id, edge_key, claim_digest, status_digest,
                edge_digest, format_version, confirmed_at, confirmed_by, superseded_at,
                artifacts_digest
         FROM support_baselines
         WHERE decision_id = ? AND support_id = ? AND edge_key = ? AND superseded_at IS NULL`
      )
      .get(decisionId, supportId, edgeKey) as SupportBaselineRow | undefined;
  }

  getAllSupportBaselines(): SupportBaselineRow[] {
    if (!this.hasSupportBaselinesTable()) return [];
    return this.db
      .prepare(
        `SELECT decision_id, support_id, edge_key, claim_digest, status_digest,
                edge_digest, format_version, confirmed_at, confirmed_by, superseded_at,
                artifacts_digest
         FROM support_baselines
         ORDER BY decision_id, support_id, confirmed_at, edge_key`
      )
      .all() as SupportBaselineRow[];
  }

  /** F2: counts BEFORE any list is materialized (COUNT over the PK index). */
  countSupportBaselines(decisionId: string): { active: number; superseded: number } {
    if (!this.hasSupportBaselinesTable()) return { active: 0, superseded: 0 };
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN superseded_at IS NULL THEN 1 ELSE 0 END) AS active
         FROM support_baselines WHERE decision_id = ?`
      )
      .get(decisionId) as { total: number; active: number | null };
    const total = Number(row.total);
    const active = Number(row.active ?? 0);
    return { active, superseded: total - active };
  }

  /** F7: MAX(confirmed_at) over active rows; null when none are active. */
  lastActiveBaselineAt(decisionId: string): string | null {
    if (!this.hasSupportBaselinesTable()) return null;
    const row = this.db
      .prepare(
        `SELECT MAX(confirmed_at) AS at FROM support_baselines
         WHERE decision_id = ? AND superseded_at IS NULL`
      )
      .get(decisionId) as { at: string | null };
    return row.at ?? null;
  }

  upsertSupportBaseline(row: SupportBaselineRow): void {
    this.db
      .prepare(
        `INSERT INTO support_baselines
           (decision_id, support_id, edge_key, claim_digest, status_digest,
            edge_digest, format_version, confirmed_at, confirmed_by, superseded_at,
            artifacts_digest)
         VALUES (@decision_id, @support_id, @edge_key, @claim_digest, @status_digest,
                 @edge_digest, @format_version, @confirmed_at, @confirmed_by, @superseded_at,
                 @artifacts_digest)
         ON CONFLICT(decision_id, support_id, edge_key) DO UPDATE SET
           claim_digest = excluded.claim_digest,
           status_digest = excluded.status_digest,
           edge_digest = excluded.edge_digest,
           format_version = excluded.format_version,
           confirmed_at = excluded.confirmed_at,
           confirmed_by = excluded.confirmed_by,
           -- 2.1.3 F2: the confirmation re-read the artifacts, the stored
           -- state moves to what the agent has just seen (or stays NULL when
           -- none were observed).
           artifacts_digest = excluded.artifacts_digest,
           -- a fresh confirmation of the same pair un-supersedes it (F7)
           superseded_at = NULL`
      )
      .run({
        ...(row as unknown as Record<string, unknown>),
        superseded_at: row.superseded_at ?? null,
        artifacts_digest: row.artifacts_digest ?? null,
      });
  }

  /**
   * Acknowledge the dead anchors with an explicit "no supports" confirmation
   * (plan-4-fixes-5, changed by plan-4-fixes-6 F7): the empty confirm_supports
   * is accepted only when the decision has zero live informed_by edges, so
   * every active row of the decision is a dead anchor whose "removed" signal
   * the agent has just acknowledged. The rows are NOT deleted — they are
   * marked superseded_at, so "confirmed and later removed" stays
   * distinguishable from "supports never existed". No other path touches
   * dead anchors: no cascade on remove_concept, deletion hygiene or
   * consolidate, and a confirmation of live supports never marks them.
   */
  markSupportBaselinesSuperseded(decisionId: string, at: string): number {
    if (!this.hasSupportBaselinesTable()) return 0;
    const result = this.db
      .prepare(
        `UPDATE support_baselines SET superseded_at = ?
         WHERE decision_id = ? AND superseded_at IS NULL`
      )
      .run(at, decisionId);
    return Number(result.changes);
  }

  // ---- 2.1.3 F1: the support revision journal ----
  // Written by the same paths that write support_baselines (confirm_supports,
  // the create_concept evidence carve-out, the merge carry). Mutations and
  // reads never journal: "a mutation never confirms" stays intact.

  hasSupportRevisionsTable(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_revisions'"
        )
        .get() !== undefined
    );
  }

  /**
   * Append one revision and apply the per-pair cap right away: a single
   * indexed DELETE over idx_support_revisions_pair keeps the pair at
   * SUPPORT_REVISIONS_MAX_PER_PAIR rows — the "batched cleanup on write"
   * rule (2.1.3 F1), paid per written pair, not by every reader.
   */
  insertSupportRevision(row: SupportRevisionRow): void {
    if (!this.hasSupportRevisionsTable()) return;
    this.db
      .prepare(
        `INSERT INTO support_revisions
           (decision_id, support_id, edge_key, claim_digest, status_digest,
            edge_digest, format_version, confirmed_at, recorded_at, source, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.decision_id,
        row.support_id,
        row.edge_key,
        row.claim_digest,
        row.status_digest,
        row.edge_digest,
        row.format_version,
        row.confirmed_at,
        row.recorded_at,
        row.source,
        row.reason ?? null
      );
    this.db
      .prepare(
        `DELETE FROM support_revisions
         WHERE decision_id = ? AND support_id = ? AND id NOT IN (
           SELECT id FROM support_revisions
           WHERE decision_id = ? AND support_id = ?
           ORDER BY recorded_at DESC, id DESC
           LIMIT ?
         )`
      )
      .run(
        row.decision_id,
        row.support_id,
        row.decision_id,
        row.support_id,
        SUPPORT_REVISIONS_MAX_PER_PAIR
      );
    this.supportRevisionWritesSincePrune += 1;
    this.maybePruneSupportRevisions(row.recorded_at);
  }

  /**
   * Day-based retention (365 days): one DELETE over recorded_at. Rides on
   * writes at most once per SUPPORT_REVISIONS_PRUNE_INTERVAL inserts — the
   * scan is paid by writers in batches, never by the history reader.
   * Public for tests; called automatically from insertSupportRevision.
   */
  pruneSupportRevisions(now: string): number {
    if (!this.hasSupportRevisionsTable()) return 0;
    const cutoff = new Date(
      new Date(now).getTime() - SUPPORT_REVISIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const result = this.db
      .prepare("DELETE FROM support_revisions WHERE recorded_at < ?")
      .run(cutoff);
    return Number(result.changes);
  }

  maybePruneSupportRevisions(now: string): void {
    if (this.supportRevisionWritesSincePrune >= SUPPORT_REVISIONS_PRUNE_INTERVAL) {
      this.supportRevisionWritesSincePrune = 0;
      this.pruneSupportRevisions(now);
    }
  }

  /** A page of the pair's (or the whole decision's) revisions, newest first.
   * The caller asks for limit+1 to detect has_more. */
  getSupportRevisions(
    decisionId: string,
    supportId: string | null,
    limit: number
  ): SupportRevisionRow[] {
    if (!this.hasSupportRevisionsTable()) return [];
    if (supportId !== null) {
      return this.db
        .prepare(
          `SELECT id, decision_id, support_id, edge_key, claim_digest, status_digest,
                  edge_digest, format_version, confirmed_at, recorded_at, source, reason
           FROM support_revisions
           WHERE decision_id = ? AND support_id = ?
           ORDER BY recorded_at DESC, id DESC LIMIT ?`
        )
        .all(decisionId, supportId, limit) as SupportRevisionRow[];
    }
    return this.db
      .prepare(
        `SELECT id, decision_id, support_id, edge_key, claim_digest, status_digest,
                edge_digest, format_version, confirmed_at, recorded_at, source, reason
         FROM support_revisions
         WHERE decision_id = ?
         ORDER BY recorded_at DESC, id DESC LIMIT ?`
      )
      .all(decisionId, limit) as SupportRevisionRow[];
  }

  countSupportRevisions(): number {
    if (!this.hasSupportRevisionsTable()) return 0;
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM support_revisions").get() as { n: number }).n
    );
  }

  /** Distinct supports of a decision that carry journal history (2.1.3 F1). */
  getSupportRevisionSupportIds(decisionId: string): string[] {
    if (!this.hasSupportRevisionsTable()) return [];
    return (
      this.db
        .prepare(
          "SELECT DISTINCT support_id FROM support_revisions WHERE decision_id = ? ORDER BY support_id"
        )
        .all(decisionId) as Array<{ support_id: string }>
    ).map((r) => r.support_id);
  }

  // ---- 2.1.3 F2: node artifacts ----
  // Rows are written ONLY by the explicit check_artifacts; reads (including
  // the support check) never hash files.

  hasNodeArtifactsTable(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_artifacts'"
        )
        .get() !== undefined
    );
  }

  /** All observed artifacts of one node, deterministic (kind, ref) order. */
  getNodeArtifacts(nodeId: string): NodeArtifactRow[] {
    if (!this.hasNodeArtifactsTable()) return [];
    return this.db
      .prepare(
        `SELECT node_id, kind, ref, digest, prev_digest, size_bytes,
                checked_at, changed_at, checked_by, repo_path
         FROM node_artifacts WHERE node_id = ?
         ORDER BY kind, ref`
      )
      .all(nodeId) as NodeArtifactRow[];
  }

  /** Insert or replace one observation row. The caller computes digest /
   * prev_digest / changed_at (the compare logic lives in check_artifacts). */
  upsertNodeArtifact(row: NodeArtifactRow): void {
    if (!this.hasNodeArtifactsTable()) return;
    this.db
      .prepare(
        `INSERT INTO node_artifacts
           (node_id, kind, ref, digest, prev_digest, size_bytes, checked_at, changed_at, checked_by, repo_path)
         VALUES (@node_id, @kind, @ref, @digest, @prev_digest, @size_bytes,
                 @checked_at, @changed_at, @checked_by, @repo_path)
         ON CONFLICT(node_id, kind, ref) DO UPDATE SET
           digest = excluded.digest,
           prev_digest = excluded.prev_digest,
           size_bytes = excluded.size_bytes,
           checked_at = excluded.checked_at,
           changed_at = excluded.changed_at,
           checked_by = excluded.checked_by,
           repo_path = excluded.repo_path`
      )
      .run({
        node_id: row.node_id,
        kind: row.kind,
        ref: row.ref,
        digest: row.digest ?? null,
        prev_digest: row.prev_digest ?? null,
        size_bytes: row.size_bytes ?? null,
        checked_at: row.checked_at,
        changed_at: row.changed_at ?? null,
        checked_by: row.checked_by,
        repo_path: row.repo_path ?? null,
      });
  }

  countNodeArtifacts(): number {
    if (!this.hasNodeArtifactsTable()) return 0;
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM node_artifacts").get() as { n: number }).n
    );
  }

  /**
   * Plan 4 (v8) §1.2: record the confirmed wording of the decision. Written
   * ONLY here (confirm_supports) — update_concept and every other content
   * write leave it alone, so a later rewrite shows up as claim_changed.
   */
  setClaimDigest(id: string, digest: string, at: string): void {
    this.db
      .prepare("UPDATE nodes SET claim_digest = ?, claim_digest_at = ? WHERE id = ?")
      .run(digest, at, id);
  }

  /**
   * Plan 4 (v8) §1.3: the agent explicitly accepted auto-derived edges by
   * confirming them. A separate event on a separate column — created_via is
   * never rewritten (test 17). Idempotent: the first acceptance moment wins.
   */
  acceptEdges(edgeIds: number[], at: string): number {
    if (edgeIds.length === 0) return 0;
    let n = 0;
    for (const id of edgeIds) {
      const result = this.db
        .prepare("UPDATE edges SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL")
        .run(at, id);
      n += Number(result.changes);
    }
    return n;
  }

  getEdgeById(id: number): EdgeRow | undefined {
    return this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as
      | EdgeRow
      | undefined;
  }

  // ---- Budgeted support reads (plan-4-fixes-6 F2) ----
  // The check must COUNT its work before doing it: a budget too small for the
  // star must not pay for the star. Counts go over the indexes; rows come in
  // deterministic pages whose total size the caller keeps within the budget.

  /** Live informed_by support count of a node (ancestry direction). */
  countLiveInformedByEdges(decisionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges
         WHERE from_id = ? AND relation = 'informed_by' AND removed_at IS NULL`
      )
      .get(decisionId) as { n: number };
    return Number(row.n);
  }

  /**
   * A deterministic page of live supports (ancestry), ordered by the
   * support's id — the budget cuts the list, so the cut must be stable.
   *
   * F2 (2.1.1): keyset pagination, not OFFSET. `ORDER BY to_id LIMIT/OFFSET`
   * re-sorted every remaining live edge on each page — with a budget of 1 a
   * 20 000-support star still paid for the whole star per page. `to_id > ?
   * ORDER BY to_id LIMIT ?` walks the idx_edges_live_from_to prefix instead:
   * per-page work is the page itself. to_id is unique per (from_id,
   * relation) — idx_edges_unique — so the cursor cannot skip a row.
   */
  getLiveSupportEdgesPage(
    decisionId: string,
    afterToId: string,
    limit: number
  ): Array<EdgeRow & { other_id: string }> {
    return this.db
      .prepare(
        `SELECT e.*, e.to_id AS other_id FROM edges e
         WHERE e.from_id = ? AND e.relation = 'informed_by' AND e.removed_at IS NULL
           AND e.to_id > ?
         ORDER BY e.to_id LIMIT ?`
      )
      .all(decisionId, afterToId, limit) as Array<EdgeRow & { other_id: string }>;
  }

  /**
   * A deterministic page of dead anchors: active snapshot rows whose support
   * has no live informed_by edge left (node removed or edge tombstoned).
   * One row per support — the latest confirmation wins.
   *
   * 2.1.2 F11: keyset pagination (cursor = the last seen support_id), not
   * OFFSET — a LIMIT/OFFSET page re-walked its whole prefix every time, so a
   * star with many dead anchors paid quadratic work across pages. The PK
   * prefix (decision_id, support_id) makes the keyset walk a straight index
   * read: per-page work is the page itself.
   */
  getDeadBaselineSupportsPage(
    decisionId: string,
    afterSupportId: string,
    limit: number
  ): Array<{ support_id: string; confirmed_at: string }> {
    if (!this.hasSupportBaselinesTable()) return [];
    return this.db
      .prepare(
        `SELECT b.support_id, MAX(b.confirmed_at) AS confirmed_at
         FROM support_baselines b
         WHERE b.decision_id = ? AND b.superseded_at IS NULL
           AND b.support_id > ?
           AND NOT EXISTS (
             SELECT 1 FROM edges e
             WHERE e.from_id = b.decision_id AND e.to_id = b.support_id
               AND e.relation = 'informed_by' AND e.removed_at IS NULL
           )
         GROUP BY b.support_id
         ORDER BY b.support_id LIMIT ?`
      )
      .all(decisionId, afterSupportId, limit) as Array<{
      support_id: string;
      confirmed_at: string;
    }>;
  }

  // ---- 2.1.2 F9: the metrics decision scan is paginated ----
  // The whole list used to materialize in one SELECT before the budget got a
  // say; now the caller pulls keyset pages whose size the budget sizes, and
  // probes whether anything is left past the cursor.

  /** Predicate shared by the metrics page query and its probe: decisions that
   * carry a claim anchor, a live informed_by edge or an active snapshot row —
   * exactly the inputs computeSupportCheck needs for a verdict. */
  private metricDecisionsQuery(tail: string): string {
    const baselineClause = this.hasSupportBaselinesTable()
      ? `OR EXISTS (SELECT 1 FROM support_baselines b
                     WHERE b.decision_id = n.id AND b.superseded_at IS NULL)`
      : "";
    return `SELECT n.id,
            EXISTS (SELECT 1 FROM edges e
                    WHERE e.from_id = n.id AND e.relation = 'informed_by'
                      AND e.removed_at IS NULL) AS has_live
     FROM nodes n
     WHERE n.removed_at IS NULL AND n.kind = 'decision'
       AND n.id > ?
       AND (n.claim_digest IS NOT NULL
         OR EXISTS (SELECT 1 FROM edges e
                    WHERE e.from_id = n.id AND e.relation = 'informed_by'
                      AND e.removed_at IS NULL)
         ${baselineClause})
     ${tail}`;
  }

  /** A keyset page of metric decisions (ordered by id, cursor = last id). */
  getMetricDecisionsPage(
    afterId: string,
    limit: number
  ): Array<{ id: string; has_live: number }> {
    return this.db
      .prepare(this.metricDecisionsQuery("ORDER BY n.id LIMIT ?"))
      .all(afterId, limit) as Array<{ id: string; has_live: number }>;
  }

  /** Cheap probe: is there another metric decision past the cursor? */
  hasMetricDecisionsAfter(afterId: string): boolean {
    const row = this.db
      .prepare(this.metricDecisionsQuery("ORDER BY n.id LIMIT 1"))
      .get(afterId) as { id: string } | undefined;
    return row !== undefined;
  }

  // ---- Query methods ----

  getChildren(parentId: string): NodeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM nodes WHERE parent_id = ? AND removed_at IS NULL"
      )
      .all(parentId) as NodeRow[];
  }

  getOutgoingEdges(
    nodeId: string
  ): Array<EdgeRow & { to_name: string; to_summary: string }> {
    return this.db
      .prepare(
        `
      SELECT e.*, n.name as to_name, n.summary as to_summary
      FROM edges e
      JOIN nodes n ON e.to_id = n.id
      WHERE e.from_id = ? AND e.removed_at IS NULL AND n.removed_at IS NULL
    `
      )
      .all(nodeId) as Array<EdgeRow & { to_name: string; to_summary: string }>;
  }

  getIncomingEdges(
    nodeId: string
  ): Array<EdgeRow & { from_name: string; from_summary: string }> {
    return this.db
      .prepare(
        `
      SELECT e.*, n.name as from_name, n.summary as from_summary
      FROM edges e
      JOIN nodes n ON e.from_id = n.id
      WHERE e.to_id = ? AND e.removed_at IS NULL AND n.removed_at IS NULL
    `
      )
      .all(nodeId) as Array<
      EdgeRow & { from_name: string; from_summary: string }
    >;
  }

  getParent(parentId: string): NodeRow | undefined {
    return this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND removed_at IS NULL")
      .get(parentId) as NodeRow | undefined;
  }

  getRootNodes(): NodeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM nodes WHERE parent_id IS NULL AND removed_at IS NULL ORDER BY name"
      )
      .all() as NodeRow[];
  }

  getAllActiveNodesWithEmbeddings(): Array<{
    id: string;
    name: string;
    kind: string;
    summary: string;
    embedding: Buffer | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT id, name, kind, summary, embedding FROM nodes WHERE removed_at IS NULL AND embedding IS NOT NULL"
      )
      .all() as Array<any>;
    
    return rows.map((row) => ({
      ...row,
      embedding: row.embedding ? Buffer.from(row.embedding) : null
    }));
  }

  nodeExists(id: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM nodes WHERE id = ? AND removed_at IS NULL"
      )
      .get(id);
    return row !== undefined;
  }

  // ---- Web API query methods ----

  getAllActiveNodes(): Array<Omit<NodeRow, "embedding">> {
    return this.db
      .prepare(
        `SELECT id, name, kind, summary, why, file_refs, parent_id,
                created_by_task, created_at, updated_at, removed_at, removed_reason${this.hasStatusColumn ? ", status" : ""}
         FROM nodes WHERE removed_at IS NULL ORDER BY name`
      )
      .all() as Array<Omit<NodeRow, "embedding">>;
  }

  getAllEdges(): EdgeRow[] {
    return this.db
      .prepare(
        `SELECT e.*
         FROM edges e
         JOIN nodes n1 ON e.from_id = n1.id
         JOIN nodes n2 ON e.to_id = n2.id
         WHERE e.removed_at IS NULL
           AND n1.removed_at IS NULL AND n2.removed_at IS NULL`
      )
      .all() as EdgeRow[];
  }

  getKindsBreakdown(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT kind, COUNT(*) as count FROM nodes WHERE removed_at IS NULL GROUP BY kind"
      )
      .all() as Array<{ kind: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.kind] = row.count;
    }
    return result;
  }

  getStats(): { nodes: number; edges: number; removed: number; edges_removed: number } {
    const nodes = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM nodes WHERE removed_at IS NULL")
        .get() as { count: number }
    ).count;
    const edges = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM edges WHERE removed_at IS NULL")
        .get() as {
        count: number;
      }
    ).count;
    const removed = (
      this.db
        .prepare(
          "SELECT COUNT(*) as count FROM nodes WHERE removed_at IS NOT NULL"
        )
        .get() as { count: number }
    ).count;
    // Plan 1 §4.5: tombstoned edges counted separately (doctor consumes it).
    const edgesRemoved = (
      this.db
        .prepare(
          "SELECT COUNT(*) as count FROM edges WHERE removed_at IS NOT NULL"
        )
        .get() as { count: number }
    ).count;
    return { nodes, edges, removed, edges_removed: edgesRemoved };
  }

  /**
   * 2.1.12 F1: active, live nodes past their valid_until — факты, которые
   * ещё в графе, но уже не знания. Сравнение по Date.parse, не по строке:
   * агент может записать дату в любом ISO-варианте (дата без времени,
   * смещение +03:00), лексикографика тут врёт. На базах без fork-колонок
   * (upstream до миграции) — 0: колонки нет, нечего и считать.
   */
  countExpiredNodes(now: Date = new Date()): number {
    if (!this.hasStatusColumn) return 0;
    const rows = this.db
      .prepare(
        "SELECT valid_until FROM nodes WHERE removed_at IS NULL AND status = 'active' AND valid_until IS NOT NULL"
      )
      .all() as Array<{ valid_until: string }>;
    let n = 0;
    for (const { valid_until } of rows) {
      const t = Date.parse(valid_until);
      if (!Number.isNaN(t) && t < now.getTime()) n += 1;
    }
    return n;
  }

  // ---- Workflow (plan 2, schema v6): slots, tasks, trails ----

  /**
   * Take a role slot. Rules (plan 2 §2): the role has exactly one live
   * holder; taking it with a NEW node supersedes the old holder via a
   * `supersedes` edge (the old one is never revoked — yesterday's handoff
   * stays truthful); re-taking by the SAME node is a no-op (an idempotent
   * retry must not bury the live node). Atomicity comes from the
   * serialized write, not from check-then-insert.
   */
  setSlot(
    project: string,
    role: string,
    nodeId: string
  ): { taken: boolean; noop: boolean; previous_node: string | null } {
    if (!this.nodeExists(nodeId)) {
      throw new Error(`Node "${nodeId}" does not exist (or is removed).`);
    }
    let result = { taken: false, noop: false, previous_node: null as string | null };
    this.runInTransaction(() => {
      const current = this.db
        .prepare("SELECT node_id FROM slots WHERE project = ? AND role = ?")
        .get(project, role) as { node_id: string } | undefined;
      const previous = current?.node_id ?? null;

      if (previous === nodeId) {
        result = { taken: false, noop: true, previous_node: previous };
        return;
      }
      // The old holder is demoted with a supersedes edge — only while it is
      // still alive; a removed holder keeps no active edge to bury.
      if (previous !== null && this.nodeExists(previous)) {
        this.insertEdge({
          from_id: nodeId,
          to_id: previous,
          relation: "supersedes",
          description: `slot ${role}: handoff`,
          // slot_set is an explicit agent call (plan 4 v8 §1.3).
          via: "agent",
        });
      }
      this.db
        .prepare(
          `INSERT INTO slots (project, role, node_id, updated_at) VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(project, role) DO UPDATE SET node_id = excluded.node_id, updated_at = datetime('now')`
        )
        .run(project, role, nodeId);
      result = { taken: true, noop: false, previous_node: previous };
    });
    return result;
  }

  getSlot(project: string, role: string): { node_id: string; node_name: string; updated_at: string } | undefined {
    return this.cleanRow(
      this.db
        .prepare(
          `SELECT s.node_id, n.name AS node_name, s.updated_at
           FROM slots s JOIN nodes n ON n.id = s.node_id AND n.removed_at IS NULL
           WHERE s.project = ? AND s.role = ?`
        )
        .get(project, role) as { node_id: string; node_name: string; updated_at: string } | undefined
    );
  }

  /** Release the role without touching the node itself (plan 2 §2 rule 4). */
  releaseSlot(project: string, role: string): boolean {
    const result = this.db
      .prepare("DELETE FROM slots WHERE project = ? AND role = ?")
      .run(project, role);
    return result.changes > 0;
  }

  listSlots(project: string): Array<{ role: string; node_id: string; node_name: string; updated_at: string }> {
    return this.db
      .prepare(
        `SELECT s.role, s.node_id, n.name AS node_name, s.updated_at
         FROM slots s JOIN nodes n ON n.id = s.node_id AND n.removed_at IS NULL
         WHERE s.project = ? ORDER BY s.role`
      )
      .all(project) as Array<{ role: string; node_id: string; node_name: string; updated_at: string }>;
  }

  // ---- Task board (plan 2 §3) ----

  setTaskState(id: string, taskState: "open" | "done" | null, dueAt: string | null | undefined): boolean {
    const result = this.db
      .prepare(
        `UPDATE nodes SET task_state = @taskState,
           due_at = CASE WHEN @clearDue = 1 THEN NULL ELSE COALESCE(@dueAt, due_at) END,
           updated_at = datetime('now')
         WHERE id = @id AND removed_at IS NULL`
      )
      .run({
        taskState,
        // `done` clears due_at — a closed task must not hang overdue.
        clearDue: taskState === "done" ? 1 : 0,
        dueAt: dueAt ?? null,
        id,
      });
    return result.changes > 0;
  }

  /**
   * Open tasks with the inputs of the rot score (plan 2 §3): age in days,
   * overdue flag, isolation (no live edges either way).
   */
  getOpenTasks(): Array<{
    id: string;
    name: string;
    summary: string;
    created_at: string;
    due_at: string | null;
    live_edges: number;
  }> {
    return this.db
      .prepare(
        `SELECT n.id, n.name, n.summary, n.created_at, n.due_at,
           (SELECT COUNT(*) FROM edges e
            WHERE (e.from_id = n.id OR e.to_id = n.id) AND e.removed_at IS NULL) AS live_edges
         FROM nodes n
         WHERE n.task_state = 'open' AND n.removed_at IS NULL`
      )
      .all() as Array<{
      id: string;
      name: string;
      summary: string;
      created_at: string;
      due_at: string | null;
      live_edges: number;
    }>;
  }

  /** Recently closed tasks for the terminal board column (fresh first). */
  getDoneTasks(limit = 20): Array<{ id: string; name: string; summary: string; updated_at: string }> {
    return this.db
      .prepare(
        `SELECT id, name, summary, updated_at FROM nodes
         WHERE task_state = 'done' AND removed_at IS NULL
         ORDER BY updated_at DESC, rowid DESC LIMIT ?`
      )
      .all(limit) as Array<{ id: string; name: string; summary: string; updated_at: string }>;
  }

  // ---- Trails (plan 2 §1) ----

  /**
   * Fingerprint of a node's MEANING (plan 2 §1): summary + epistemic_status +
   * the sorted set of live outgoing `informed_by` edges with their rationales.
   * name, parent_id and timestamps are deliberately excluded — a rename or a
   * merge-timestamp rewrite must not rot every chain at once. Returns null
   * for a removed node (the fingerprint of a dead node is not computed).
   */
  nodeFingerprint(id: string): string | null {
    const node = this.db
      .prepare("SELECT summary, epistemic_status FROM nodes WHERE id = ? AND removed_at IS NULL")
      .get(id) as { summary: string; epistemic_status: string | null } | undefined;
    if (!node) return null;
    const informedBy = (
      this.db
        .prepare(
          `SELECT to_id, description FROM edges
           WHERE from_id = ? AND relation = 'informed_by' AND removed_at IS NULL
           ORDER BY to_id`
        )
        .all(id) as Array<{ to_id: string; description: string | null }>
    )
      .map((e) => `${e.to_id}::${e.description ?? ""}`)
      .sort();
    return createHash("sha1")
      .update(node.summary + "\n" + (node.epistemic_status ?? "") + "\n" + informedBy.join("\n"))
      .digest("hex");
  }

  insertTrail(trail: {
    id: string;
    name: string;
    summary: string;
    node_ids: string[];
  }): void {
    this.runInTransaction(() => {
      this.db
        .prepare(
          "INSERT INTO trails (id, name, summary) VALUES (?, ?, ?)"
        )
        .run(trail.id, trail.name, trail.summary);
      const stmt = this.db.prepare(
        "INSERT INTO trail_members (trail_id, position, node_id, fingerprint) VALUES (?, ?, ?, ?)"
      );
      trail.node_ids.forEach((nodeId, i) => {
        const fp = this.nodeFingerprint(nodeId);
        if (fp === null) {
          throw new Error(`Node "${nodeId}" does not exist (or is removed) — trail not saved.`);
        }
        stmt.run(trail.id, i, nodeId, fp);
      });
    });
  }

  getTrail(id: string): { id: string; name: string; summary: string; stale: number; created_at: string; updated_at: string | null } | undefined {
    return this.cleanRow(
      this.db
        .prepare("SELECT * FROM trails WHERE id = ?")
        .get(id) as { id: string; name: string; summary: string; stale: number; created_at: string; updated_at: string | null } | undefined
    );
  }

  getTrailMembers(trailId: string): Array<{ position: number; node_id: string; fingerprint: string }> {
    return (
      this.db
        .prepare(
          "SELECT position, node_id, fingerprint FROM trail_members WHERE trail_id = ? ORDER BY position"
        )
        .all(trailId) as Array<{ position: number; node_id: string; fingerprint: string }>
    ).map((m) => this.cleanRow(m)!);
  }

  /**
   * libsql вешает на каждую строку `_metadata: { duration }` — шум
   * профилировщика statement'а, а не данные. В JSON-ответах он выглядит как
   * поле записи и ломает сравнение сохранённого и прочитанного состояния
   * (F-02, S-03: перенос цепочек/слотов вербатим).
   */
  private cleanRow<T>(row: T | undefined | null): T | undefined {
    if (row === undefined || row === null) return undefined;
    const { _metadata, ...rest } = row as T & { _metadata?: unknown };
    return rest as T;
  }

  /** Trails that reference a node — used by removal notes and node cards. */
  getTrailsForNode(nodeId: string): Array<{ id: string; name: string }> {
    return this.db
      .prepare(
        `SELECT t.id, t.name FROM trails t
         JOIN trail_members m ON m.trail_id = t.id
         WHERE m.node_id = ? ORDER BY t.id`
      )
      .all(nodeId) as Array<{ id: string; name: string }>;
  }

  setTrailStale(trailId: string, stale: boolean): void {
    this.db
      .prepare(
        `UPDATE trails SET stale = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(stale ? 1 : 0, trailId);
  }

  /** trail_refresh: overwrite all member fingerprints with the current ones. */
  refreshTrailFingerprints(trailId: string): void {
    this.runInTransaction(() => {
      const members = this.getTrailMembers(trailId);
      const stmt = this.db.prepare(
        "UPDATE trail_members SET fingerprint = ? WHERE trail_id = ? AND position = ?"
      );
      for (const m of members) {
        const fp = this.nodeFingerprint(m.node_id);
        if (fp === null) {
          throw new Error(`Member "${m.node_id}" no longer exists — chain is broken, refresh impossible.`);
        }
        stmt.run(fp, trailId, m.position);
      }
      this.setTrailStale(trailId, false);
    });
  }

  /** trail_extend: append members with fresh fingerprints. */
  appendTrailMembers(trailId: string, nodeIds: string[]): void {
    this.runInTransaction(() => {
      const maxRow = this.db
        .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM trail_members WHERE trail_id = ?")
        .get(trailId) as { p: number };
      const stmt = this.db.prepare(
        "INSERT INTO trail_members (trail_id, position, node_id, fingerprint) VALUES (?, ?, ?, ?)"
      );
      nodeIds.forEach((nodeId, i) => {
        const fp = this.nodeFingerprint(nodeId);
        if (fp === null) {
          throw new Error(`Node "${nodeId}" does not exist (or is removed) — not added.`);
        }
        stmt.run(trailId, maxRow.p + 1 + i, nodeId, fp);
      });
      this.db
        .prepare("UPDATE trails SET updated_at = datetime('now') WHERE id = ?")
        .run(trailId);
    });
  }



  // ---- Merge-related methods ----

  getConflictNodes(): NodeRow[] {
    // Don't filter by removed_at — removal conflicts are valid (one side removed, other didn't)
    return this.db
      .prepare("SELECT * FROM nodes WHERE needs_merge = 1")
      .all() as NodeRow[];
  }

  getConflictEdges(): EdgeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM edges WHERE needs_merge = 1 AND removed_at IS NULL"
      )
      .all() as EdgeRow[];
  }

  getNodesByMergeGroup(mergeGroup: string): NodeRow[] {
    return this.db
      .prepare("SELECT * FROM nodes WHERE merge_group = ?")
      .all(mergeGroup) as NodeRow[];
  }

  getEdgesByMergeGroup(mergeGroup: string): EdgeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM edges WHERE merge_group = ? AND removed_at IS NULL"
      )
      .all(mergeGroup) as EdgeRow[];
  }

  clearNodeMergeFlags(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE nodes SET merge_group = NULL, needs_merge = 0, source_branch = NULL,
         merge_timestamp = NULL, updated_at = datetime('now') WHERE id = ?`
      )
      .run(id);
    return result.changes > 0;
  }

  clearEdgeMergeFlagsByGroup(mergeGroup: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE edges SET merge_group = NULL, needs_merge = 0, source_branch = NULL,
         merge_timestamp = NULL WHERE merge_group = ?`
      )
      .run(mergeGroup);
    return result.changes > 0;
  }

  renameNodeId(oldId: string, newId: string): boolean {
    // FK checks are DEFERRED to COMMIT instead of pragma foreign_keys=OFF:
    // the pragma is a no-op inside a transaction, and renameNodeId is also
    // called from inside one (resolveConflict) — where the old approach
    // left enforcement on and the rename of a node that edges still
    // reference failed with "FOREIGN KEY constraint failed". All the
    // updates below run in one transaction, so the graph is consistent
    // again by the time the deferral is checked.
    this.db.pragma("defer_foreign_keys = ON");
    try {
      let changed = false;
      this.runInTransaction(() => {
        const result = this.db
          .prepare("UPDATE nodes SET id = @newId, updated_at = datetime('now') WHERE id = @oldId")
          .run({ oldId, newId });

        if (result.changes > 0) {
          changed = true;
          // Update parent_id references in children
          this.db
            .prepare("UPDATE nodes SET parent_id = @newId WHERE parent_id = @oldId")
            .run({ oldId, newId });
          // Update edge references
          this.db
            .prepare("UPDATE edges SET from_id = @newId WHERE from_id = @oldId")
            .run({ oldId, newId });
          this.db
            .prepare("UPDATE edges SET to_id = @newId WHERE to_id = @oldId")
            .run({ oldId, newId });
          // Plan 4 (v8) §7: a technical id remap carries the snapshot keys
          // along — the snapshot content itself is not touched. OR IGNORE:
          // a pathological pre-existing row under the new id must not break
          // the rename.
          if (this.hasSupportBaselinesTable()) {
            this.db
              .prepare(
                "UPDATE OR IGNORE support_baselines SET decision_id = @newId WHERE decision_id = @oldId"
              )
              .run({ oldId, newId });
            this.db
              .prepare(
                "UPDATE OR IGNORE support_baselines SET support_id = @newId WHERE support_id = @oldId"
              )
              .run({ oldId, newId });
          }
        }
      });
      return changed;
    } finally {
      this.db.pragma("defer_foreign_keys = OFF");
    }
  }

  getAllNodesRaw(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes").all() as NodeRow[];
  }

  getAllEdgesRaw(): EdgeRow[] {
    // No tombstone filter on purpose: this is the raw export for merge/backup,
    // callers decide what to do with removed_at (plan 1 §4.5).
    return this.db.prepare("SELECT * FROM edges").all() as EdgeRow[];
  }

  deleteEdgesForNode(nodeId: string): void {
    // Physical delete is correct here, not a bug: the only caller is
    // hardDeleteNode (merge/consolidate full removal), where an edge without
    // an endpoint cannot exist. Soft removals go through softDeleteNode,
    // which tombstones instead.
    this.db
      .prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?")
      .run(nodeId, nodeId);
  }

  hardDeleteNode(id: string): boolean {
    let changed = false;
    this.runInTransaction(() => {
      this.deleteEdgesForNode(id);
      this.deleteVector(id);
      const result = this.db
        .prepare("DELETE FROM nodes WHERE id = ?")
        .run(id);
      changed = result.changes > 0;
    });
    return changed;
  }

  private _hasEpistemicColumns: boolean | undefined;

  /** Plan 1 columns (v5); false only on dbs opened before the v5 migration. */
  private get hasEpistemicColumns(): boolean {
    if (this._hasEpistemicColumns === undefined) {
      const cols = this.db.pragma("table_info(nodes)") as Array<{ name: string }>;
      this._hasEpistemicColumns = cols.some((c) => c.name === "epistemic_status");
    }
    return this._hasEpistemicColumns;
  }

  /** Plan 4 (v8) claim-confirmation columns; false only on pre-v8 dbs. */
  private _hasClaimColumns: boolean | undefined;

  private get hasClaimColumns(): boolean {
    if (this._hasClaimColumns === undefined) {
      const cols = this.db.pragma("table_info(nodes)") as Array<{ name: string }>;
      this._hasClaimColumns = cols.some((c) => c.name === "claim_digest");
    }
    return this._hasClaimColumns;
  }

  /** 2.1.10 (v12): nodes.created_via present (self-heal for older dbs). */
  private _hasCreatedViaColumn: boolean | undefined;

  private get hasCreatedViaColumn(): boolean {
    if (this._hasCreatedViaColumn === undefined) {
      const cols = this.db.pragma("table_info(nodes)") as Array<{ name: string }>;
      this._hasCreatedViaColumn = cols.some((c) => c.name === "created_via");
    }
    return this._hasCreatedViaColumn;
  }

  /** Plan 2 (v6): task board columns — merge carries them with the row (F-02, S-03). */
  private _hasTaskColumns: boolean | undefined;

  private get hasTaskColumns(): boolean {
    if (this._hasTaskColumns === undefined) {
      const cols = this.db.pragma("table_info(nodes)") as Array<{ name: string }>;
      this._hasTaskColumns =
        cols.some((c) => c.name === "task_state") && cols.some((c) => c.name === "due_at");
    }
    return this._hasTaskColumns;
  }

  insertNodeRaw(node: {
    id: string;
    name: string;
    kind: string;
    summary: string;
    why?: string | null;
    file_refs?: string | null;
    parent_id?: string | null;
    created_by_task?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    removed_at?: string | null;
    removed_reason?: string | null;
    embedding?: Buffer | null;
    merge_group?: string | null;
    needs_merge?: number;
    source_branch?: string | null;
    merge_timestamp?: string | null;
    // Б10: fork lifecycle columns — preserved across branch merges.
    status?: string | null;
    valid_from?: string | null;
    valid_until?: string | null;
    // Plan 1 (v5): epistemic axis — preserved across branch merges.
    epistemic_status?: string | null;
    status_scope?: string | null;
    // Plan 4 (v8): the confirmed wording digest — preserved across merges so
    // a carried-over snapshot keeps pointing at the wording it confirmed.
    claim_digest?: string | null;
    claim_digest_at?: string | null;
    // 2.1.10 (v12): node origin travels with the row (MergeEngine carry).
    created_via?: string | null;
    // F-02 (S-03): task board state travels with the row — merge непустой
    // базы с пустой больше не превращает задачу с дедлайном в ноду с NULL.
    task_state?: string | null;
    due_at?: string | null;
  }): void {
    // Б10: fork columns exist only on migrated dbs — compose the column
    // list conditionally so upstream dbs keep working.
    const forkCols = this.hasStatusColumn
      ? ", status, valid_from, valid_until"
      : "";
    const forkParams = this.hasStatusColumn
      ? ", @status, @valid_from, @valid_until"
      : "";
    const epiCols = this.hasEpistemicColumns
      ? ", epistemic_status, status_scope"
      : "";
    const epiParams = this.hasEpistemicColumns
      ? ", @epistemic_status, @status_scope"
      : "";
    const claimCols = this.hasClaimColumns ? ", claim_digest, claim_digest_at" : "";
    const claimParams = this.hasClaimColumns ? ", @claim_digest, @claim_digest_at" : "";
    const viaCols = this.hasCreatedViaColumn ? ", created_via" : "";
    const viaParams = this.hasCreatedViaColumn ? ", @created_via" : "";
    const taskCols = this.hasTaskColumns ? ", task_state, due_at" : "";
    const taskParams = this.hasTaskColumns ? ", @task_state, @due_at" : "";
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id, created_by_task,
        created_at, updated_at, removed_at, removed_reason, embedding,
        merge_group, needs_merge, source_branch, merge_timestamp${forkCols}${epiCols}${claimCols}${viaCols}${taskCols})
      VALUES (@id, @name, @kind, @summary, @why, @file_refs, @parent_id, @created_by_task,
        @created_at, @updated_at, @removed_at, @removed_reason, @embedding,
        @merge_group, @needs_merge, @source_branch, @merge_timestamp${forkParams}${epiParams}${claimParams}${viaParams}${taskParams})
    `);
    const values: Record<string, unknown> = {
      id: node.id,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why ?? null,
      file_refs: node.file_refs ?? null,
      parent_id: node.parent_id ?? null,
      created_by_task: node.created_by_task ?? null,
      created_at: node.created_at ?? null,
      updated_at: node.updated_at ?? null,
      removed_at: node.removed_at ?? null,
      removed_reason: node.removed_reason ?? null,
      embedding: node.embedding ?? null,
      merge_group: node.merge_group ?? null,
      needs_merge: node.needs_merge ?? 0,
      source_branch: node.source_branch ?? null,
      merge_timestamp: node.merge_timestamp ?? null,
    };
    if (this.hasStatusColumn) {
      values.status = node.status ?? "active";
      values.valid_from = node.valid_from ?? null;
      values.valid_until = node.valid_until ?? null;
    }
    if (this.hasEpistemicColumns) {
      values.epistemic_status = (node as { epistemic_status?: string | null }).epistemic_status ?? null;
      values.status_scope = (node as { status_scope?: string | null }).status_scope ?? null;
    }
    if (this.hasClaimColumns) {
      values.claim_digest = (node as { claim_digest?: string | null }).claim_digest ?? null;
      values.claim_digest_at = (node as { claim_digest_at?: string | null }).claim_digest_at ?? null;
    }
    if (this.hasCreatedViaColumn) {
      values.created_via = (node as { created_via?: string | null }).created_via ?? null;
    }
    if (this.hasTaskColumns) {
      values.task_state = (node as { task_state?: string | null }).task_state ?? null;
      values.due_at = (node as { due_at?: string | null }).due_at ?? null;
    }
    stmt.run(values);
    this.syncNameNorm(node.id, node.name);
  }

  insertEdgeRaw(edge: {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string | null;
    created_at?: string | null;
    merge_group?: string | null;
    needs_merge?: number;
    source_branch?: string | null;
    merge_timestamp?: string | null;
    removed_at?: string | null;
    // plan-4-fixes-6 (F9): edge provenance travels with the row — an origin
    // lost in a merge would inflate the "unknown" bucket and drop the
    // accepted/declined distinction. Sources without these columns (older
    // dbs read raw) honestly become 'unknown'/null at the caller.
    created_via?: string | null;
    accepted_at?: string | null;
  }): { id: number; inserted: boolean } {
    // Plan 1 §4.6: removed_at is carried over verbatim, otherwise a merge
    // would silently revive tombstoned edges. INSERT (not OR IGNORE-revive):
    // the raw merge path must preserve history exactly as it was on the
    // source; callers filter duplicate pairs beforehand. `inserted` tells the
    // two apart — lastInsertRowid alone is stale for an ignored insert.
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO edges (from_id, to_id, relation, description, created_at,
        merge_group, needs_merge, source_branch, merge_timestamp, removed_at,
        created_via, accepted_at)
      VALUES (@from_id, @to_id, @relation, @description, @created_at,
        @merge_group, @needs_merge, @source_branch, @merge_timestamp, @removed_at,
        @created_via, @accepted_at)
    `);
    const result = stmt.run({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      description: edge.description ?? null,
      created_at: edge.created_at ?? null,
      merge_group: edge.merge_group ?? null,
      needs_merge: edge.needs_merge ?? 0,
      source_branch: edge.source_branch ?? null,
      merge_timestamp: edge.merge_timestamp ?? null,
      removed_at: edge.removed_at ?? null,
      created_via: edge.created_via ?? "unknown",
      accepted_at: edge.accepted_at ?? null,
    });
    return {
      id: Number(result.lastInsertRowid),
      inserted: result.changes > 0,
    };
  }

  // ---- Timeline Methods ----

  insertTimelineEntry(entry: {
    tool: string;
    params: string;
    result_summary: string;
    is_write: boolean;
    is_error: boolean;
    affected_ids: string[];
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO timeline (tool, params, result_summary, is_write, is_error, affected_ids)
      VALUES (@tool, @params, @result_summary, @is_write, @is_error, @affected_ids)
    `);
    const result = stmt.run({
      tool: entry.tool,
      params: entry.params,
      result_summary: entry.result_summary,
      is_write: entry.is_write ? 1 : 0,
      is_error: entry.is_error ? 1 : 0,
      affected_ids: JSON.stringify(entry.affected_ids),
    });
    // F5 (2.1.1): the journal is written on every tool call and nothing used
    // to trim it — on an active base it grew unbounded inside the very file
    // the agent carries around. Prune piggybacks on writes, at most once per
    // TIMELINE_PRUNE_INTERVAL inserts so the common call pays nothing.
    this.timelineWritesSincePrune += 1;
    if (this.timelineWritesSincePrune >= TIMELINE_PRUNE_INTERVAL) {
      this.timelineWritesSincePrune = 0;
      try {
        this.pruneTimeline();
      } catch (err) {
        // Retention must never break tool execution — the entry above is
        // already safely stored.
        console.error(
          "Timeline prune failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return Number(result.lastInsertRowid);
  }

  /**
   * F5 (2.1.1): enforce the timeline retention rules.
   *
   * - age: rows older than timeline_retention_days go;
   * - count: rows beyond timeline_max_entries (oldest first) go;
   * - 0 (or negative) in a setting disables that rule entirely — the default
   *   for anyone who needs the whole journal.
   *
   * Both rules delete in batches of TIMELINE_PRUNE_BATCH, each its own
   * statement: no long write lock over a huge backlog, a concurrent reader
   * (web explorer) never sees the timeline disappear in one lump.
   *
   * Automatic runs (piggybacking on writes) are throttled by the write
   * counter in insertTimelineEntry — at most once per TIMELINE_PRUNE_INTERVAL
   * inserts; this method itself always prunes, which is what the manual
   * `stats --prune` CLI path uses. The provenance audit journal
   * (provenance_audit_runs) is NOT touched here — it has its own retention
   * rule (200 runs per root / 90 days, plan 3 §10).
   */
  pruneTimeline(): { byAge: number; byCount: number } {
    const retentionDays = envInt(
      "MEGAMEMORY_TIMELINE_RETENTION_DAYS",
      TIMELINE_RETENTION_DAYS_DEFAULT
    );
    const maxEntries = envInt(
      "MEGAMEMORY_TIMELINE_MAX_ENTRIES",
      TIMELINE_MAX_ENTRIES_DEFAULT
    );

    let byAge = 0;
    if (retentionDays > 0) {
      // datetime('now') stamps rows in "YYYY-MM-DD HH:MM:SS" (UTC); SQLite
      // computes the cutoff in the same format, so plain string comparison
      // is exact.
      for (;;) {
        const res = this.db
          .prepare(
            `DELETE FROM timeline WHERE seq IN (
               SELECT seq FROM timeline
               WHERE timestamp < datetime('now', ?)
               LIMIT ${TIMELINE_PRUNE_BATCH}
             )`
          )
          .run(`-${retentionDays} days`);
        const deleted = Number(res.changes);
        byAge += deleted;
        if (deleted < TIMELINE_PRUNE_BATCH) break;
      }
    }

    let byCount = 0;
    if (maxEntries > 0) {
      for (;;) {
        const count = Number(
          (
            this.db.prepare("SELECT COUNT(*) AS n FROM timeline").get() as {
              n: number;
            }
          ).n
        );
        const excess = count - maxEntries;
        if (excess <= 0) break;
        const batch = Math.min(excess, TIMELINE_PRUNE_BATCH);
        const res = this.db
          .prepare(
            `DELETE FROM timeline WHERE seq IN (
               SELECT seq FROM timeline ORDER BY seq ASC LIMIT ?
             )`
          )
          .run(batch);
        byCount += Number(res.changes);
        if (Number(res.changes) < batch) break;
      }
    }

    return { byAge, byCount };
  }

  getTimelineBounds(): { first: string | null; last: string | null; count: number } {
    const stmt = this.db.prepare(`
      SELECT 
        MIN(timestamp) as first,
        MAX(timestamp) as last,
        COUNT(*) as count
      FROM timeline
    `);
    const result = stmt.get() as { first: string | null; last: string | null; count: number };
    return {
      first: result.first,
      last: result.last,
      count: result.count,
    };
  }

  getTimelineEntries(options: {
    limit?: number;
    tool?: string;
    writesOnly?: boolean;
    since?: string;
    until?: string;
  } = {}): Array<{
    seq: number;
    timestamp: string;
    tool: string;
    params: string;
    result_summary: string;
    is_write: number;
    is_error: number;
    affected_ids: string;
  }> {
    let query = `SELECT * FROM timeline WHERE 1=1`;
    const params: Record<string, unknown> = {};

    if (options.tool) {
      query += ` AND tool = @tool`;
      params.tool = options.tool;
    }

    if (options.writesOnly) {
      query += ` AND is_write = 1`;
    }

    if (options.since) {
      query += ` AND timestamp >= @since`;
      params.since = options.since;
    }

    if (options.until) {
      query += ` AND timestamp <= @until`;
      params.until = options.until;
    }

    query += ` ORDER BY seq`;

    if (options.limit) {
      query += ` LIMIT @limit`;
      params.limit = options.limit;
    }

    const stmt = this.db.prepare(query);
    return stmt.all(params) as Array<{
      seq: number;
      timestamp: string;
      tool: string;
      params: string;
      result_summary: string;
      is_write: number;
      is_error: number;
      affected_ids: string;
    }>;
  }

  getTimelineTicks(n: number): Array<{
    seq: number;
    timestamp: string;
    tool: string;
    params: string;
    result_summary: string;
    is_write: number;
    is_error: number;
    affected_ids: string;
  }> {
    const totalCount = this.getTimelineBounds().count;
    
    if (totalCount === 0 || n >= totalCount) {
      return this.getTimelineEntries();
    }

    // Sample entries evenly distributed across the timeline
    // We want to select n entries from the range [1, totalCount]
    const step = totalCount / (n - 1); // -1 to ensure we include the last entry
    const selectedSeqs: number[] = [];
    
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        selectedSeqs.push(1); // Always start with the first entry
      } else if (i === n - 1 && n > 1) {
        selectedSeqs.push(totalCount); // Always end with the last entry
      } else {
        selectedSeqs.push(Math.round(1 + i * step));
      }
    }

    // Remove duplicates and sort
    const uniqueSeqs = [...new Set(selectedSeqs)].sort((a, b) => a - b);
    
    const placeholders = uniqueSeqs.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT * FROM timeline 
      WHERE seq IN (${placeholders})
      ORDER BY seq
    `);
    return stmt.all(...uniqueSeqs) as Array<{
      seq: number;
      timestamp: string;
      tool: string;
      params: string;
      result_summary: string;
      is_write: number;
      is_error: number;
      affected_ids: string;
    }>;
  }

  getNodesAtTime(timestamp: string): NodeRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM nodes
      WHERE created_at <= @timestamp
        AND (removed_at IS NULL OR removed_at > @timestamp)
    `);
    return stmt.all({ timestamp }) as NodeRow[];
  }

  getEdgesAtTime(timestamp: string): EdgeRow[] {
    // Point-in-time read: an edge existed at @timestamp when it was created
    // before it and not yet tombstoned (removed_at NULL or later) — plan 1 §4.5.
    const stmt = this.db.prepare(`
      SELECT e.* FROM edges e
      INNER JOIN nodes nf ON e.from_id = nf.id
      INNER JOIN nodes nt ON e.to_id = nt.id
      WHERE e.created_at <= @timestamp
        AND (e.removed_at IS NULL OR e.removed_at > @timestamp)
        AND nf.created_at <= @timestamp
        AND nt.created_at <= @timestamp
        AND (nf.removed_at IS NULL OR nf.removed_at > @timestamp)
        AND (nt.removed_at IS NULL OR nt.removed_at > @timestamp)
    `);
    return stmt.all({ timestamp }) as EdgeRow[];
  }

  /** Direct SQL access for migration helpers (DDL, FTS setup). */
  execSql(sql: string): void {
    this.db.exec(sql);
  }

  /** Parameterized single-row query for migration/doctor helpers. */
  execSqlFirst(sql: string, ...params: unknown[]): unknown {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  /** Parameterized multi-row query for migration/reembed helpers. */
  execSqlAll(sql: string, ...params: unknown[]): unknown[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as unknown[];
  }

  /** Parameterized statement execution for migration/reembed helpers. */
  execSqlRun(sql: string, ...params: unknown[]): void {
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  /** Pragma access for migration helpers; returns libsql's pragma result. */
  pragma(sql: string): unknown {
    return this.db.pragma(sql);
  }

  private metaTableExists(): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'"
      )
      .get();
    return row !== undefined;
  }

  /** Value from the fork meta table, or undefined when absent. */
  getMetaValue(key: string): string | undefined {
    if (!this.metaTableExists()) return undefined;
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** Upsert into the fork meta table (creates it when missing). */
  setMetaValue(key: string, value: string): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }


  // ---- Id aliases (patch Б12): old ids stay resolvable after repair ----

  /** Remember old_id -> new_id; chains are followed at resolve time. */
  recordAlias(oldId: string, newId: string): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS aliases (\
        old_id TEXT PRIMARY KEY,\
        new_id TEXT NOT NULL,\
        renamed_at TEXT NOT NULL DEFAULT (datetime('now'))\
      )"
    );
    this.db
      .prepare(
        "INSERT INTO aliases(old_id, new_id) VALUES (?, ?) ON CONFLICT(old_id) DO UPDATE SET new_id = excluded.new_id"
      )
      .run(oldId, newId);
  }

  /** Resolve an old id through the aliases table (up to 8 hops). */
  getAliasTarget(oldId: string): string | undefined {
    const hasAliases = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='aliases'")
      .get();
    if (!hasAliases) return undefined;
    let current = oldId;
    for (let hop = 0; hop < 8; hop++) {
      const row = this.db
        .prepare("SELECT new_id FROM aliases WHERE old_id = ?")
        .get(current) as { new_id: string } | undefined;
      if (!row) return current === oldId ? undefined : current;
      current = row.new_id;
    }
    return current;
  }


  // ---- Native vector search (patch В17): libsql F32_BLOB + vector_distance_cos ----
  // Keeps the JS cosine as a fallback; the SQL path scales past thousands of nodes.

  private _vectorSupport: boolean | undefined;

  /** One-shot probe of libsql's native vector functions. */
  vectorSupportOk(): boolean {
    if (this._vectorSupport === undefined) {
      try {
        this.db
          .prepare("SELECT vector_distance_cos(vector32('[0.5]'), vector32('[0.5]')) AS d")
          .get();
        this._vectorSupport = true;
      } catch {
        this._vectorSupport = false;
      }
    }
    return this._vectorSupport;
  }

  private vectorTableReady(dim: number): boolean {
    if (!this.vectorSupportOk() || dim <= 0) return false;
    const has = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_vec'")
      .get();
    if (!has) {
      this.db.exec(
        `CREATE TABLE nodes_vec (id TEXT PRIMARY KEY, embedding F32_BLOB(${dim}))`
      );
    }
    return true;
  }

  /** Upsert the native vector copy (buffer = float32 bytes). */
  upsertVector(id: string, buffer: Buffer): void {
    const dim = buffer.length / Float32Array.BYTES_PER_ELEMENT;
    if (!this.vectorTableReady(dim)) return;
    // buffer may be a pooled Buffer with unaligned byteOffset — copy via ArrayBuffer.slice
    const clean = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const json = JSON.stringify([...new Float32Array(clean)]);
    this.db
      .prepare(
        "INSERT INTO nodes_vec (id, embedding) VALUES (?, vector32(?)) ON CONFLICT(id) DO UPDATE SET embedding = vector32(?)"
      )
      .run(id, json, json);
  }

  deleteVector(id: string): void {
    if (!this.vectorSupportOk()) return;
    const has = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_vec'")
      .get();
    if (!has) return;
    this.db.prepare("DELETE FROM nodes_vec WHERE id = ?").run(id);
  }

  vectorTableCount(): number {
    if (!this.vectorSupportOk()) return -1;
    const has = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_vec'")
      .get();
    if (!has) return 0;
    return (this.db.prepare("SELECT count(*) AS n FROM nodes_vec").get() as { n: number }).n;
  }

  countActiveWithEmbeddings(): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM nodes WHERE embedding IS NOT NULL AND removed_at IS NULL")
        .get() as { n: number }
    ).n;
  }

  /**
   * Native top-k by cosine distance. Returns null when the shadow table is
   * not populated for every embedded node — caller falls back to JS cosine.
   */
  vectorTopK(queryJson: string, limit: number): Array<{ id: string; similarity: number }> | null {
    const count = this.vectorTableCount();
    if (count <= 0 || count < this.countActiveWithEmbeddings()) return null;
    const rows = this.db
      .prepare(
        "SELECT id, vector_distance_cos(embedding, vector32(?)) AS d FROM nodes_vec ORDER BY d LIMIT ?"
      )
      .all(queryJson, limit) as Array<{ id: string; d: number }>;
    return rows.map((r) => ({ id: r.id, similarity: 1 - r.d }));
  }


  /**
   * Б10: lifecycle merge rule — superseded/deprecated beats active (losing
   * the fact that a node is outdated is worse than keeping it), valid_until
   * is the later of the two.
   */
  static mergeLifecycleStatus(
    a: { status?: string; valid_until?: string | null },
    b: { status?: string; valid_until?: string | null }
  ): { status: string; valid_until: string | null } {
    const rank = (s?: string): number => (s === "superseded" ? 2 : s === "deprecated" ? 1 : 0);
    const status = rank(a.status) >= rank(b.status) ? (a.status ?? "active") : (b.status ?? "active");
    const valid_until =
      [a.valid_until, b.valid_until]
        .filter((v): v is string => Boolean(v))
        .sort()
        .pop() ?? null;
    return { status, valid_until };
  }

  close(): void {
    this.db.close();
  }
}
