import Database from "libsql";
import path from "path";
import fs from "fs";
import type { NodeRow, EdgeRow } from "./types.js";
import { normalizeName } from "./norm.js";

/** Plan 1 (tombstones + epistemic status). Exported for the doctor check. */
export const SCHEMA_VERSION = 5;

export class KnowledgeDB {
  private db: Database.Database;
  private _txDepth = 0;
  private _hasStatusColumn: boolean | undefined;

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
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
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

      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
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
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id, created_by_task, embedding, epistemic_status, status_scope)
      VALUES (@id, @name, @kind, @summary, @why, @file_refs, @parent_id, @created_by_task, @embedding, @epistemic_status, @status_scope)
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
    },
    edges: Array<{ to_id: string; relation: string; description: string | null }>
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
      });

      for (const edge of edges) {
        if (this.nodeExists(edge.to_id)) {
          this.insertEdge({
            from_id: node.id,
            to_id: edge.to_id,
            relation: edge.relation,
            description: edge.description,
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

  insertEdge(edge: {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string | null;
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
      INSERT INTO edges (from_id, to_id, relation, description)
      VALUES (@from_id, @to_id, @relation, @description)
    `);
    const result = stmt.run({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      description: edge.description ?? null,
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
    // Temporarily disable foreign keys for the rename operation,
    // since self-referencing FKs (parent_id → id) would block the update.
    // Wrapped in a transaction so all 4 updates succeed or none do.
    this.db.pragma("foreign_keys = OFF");
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
        }
      });
      return changed;
    } finally {
      this.db.pragma("foreign_keys = ON");
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
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, kind, summary, why, file_refs, parent_id, created_by_task,
        created_at, updated_at, removed_at, removed_reason, embedding,
        merge_group, needs_merge, source_branch, merge_timestamp${forkCols}${epiCols})
      VALUES (@id, @name, @kind, @summary, @why, @file_refs, @parent_id, @created_by_task,
        @created_at, @updated_at, @removed_at, @removed_reason, @embedding,
        @merge_group, @needs_merge, @source_branch, @merge_timestamp${forkParams}${epiParams})
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
  }): number {
    // Plan 1 §4.6: removed_at is carried over verbatim, otherwise a merge
    // would silently revive tombstoned edges. INSERT (not OR IGNORE-revive):
    // the raw merge path must preserve history exactly as it was on the
    // source; callers filter duplicate pairs beforehand.
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO edges (from_id, to_id, relation, description, created_at,
        merge_group, needs_merge, source_branch, merge_timestamp, removed_at)
      VALUES (@from_id, @to_id, @relation, @description, @created_at,
        @merge_group, @needs_merge, @source_branch, @merge_timestamp, @removed_at)
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
    });
    return Number(result.lastInsertRowid);
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
    return Number(result.lastInsertRowid);
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
