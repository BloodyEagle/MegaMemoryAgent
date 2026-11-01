// ---- Data model types ----

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  parent_id: string | null;
  created_by_task: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  merge_group: string | null;
  needs_merge: boolean;
  source_branch: string | null;
  merge_timestamp: string | null;
}

export type NodeKind =
  | "feature"
  | "module"
  | "pattern"
  | "config"
  | "decision"
  | "component"
  /** T6: derived node compressing a module's children into one payload. */
  | "digest";

export interface Edge {
  id: number;
  from_id: string;
  to_id: string;
  relation: RelationType;
  description: string | null;
  created_at: string;
  merge_group: string | null;
  needs_merge: boolean;
  source_branch: string | null;
  merge_timestamp: string | null;
}

export type RelationType =
  | "connects_to"
  | "depends_on"
  | "implements"
  | "calls"
  | "configured_by"
  | "supersedes"
  | "contradicts";

/** Node lifecycle (fork T4): active by default, soft-invalidated otherwise. */
export type NodeStatus = "active" | "superseded" | "deprecated";

// ---- Tool input types ----

export interface CreateConceptInput {
  name: string;
  kind: NodeKind;
  summary: string;
  why?: string;
  parent_id?: string;
  file_refs?: string[];
  edges?: Array<{
    to: string;
    relation: RelationType;
    description?: string;
  }>;
  /**
   * IDs this concept replaces (T4): creates supersedes edges and marks the
   * old nodes superseded with valid_until = now.
   */
  supersedes?: string[];
  created_by_task?: string;
}

export interface UpdateConceptInput {
  id: string;
  changes: {
    name?: string;
    kind?: NodeKind;
    summary?: string;
    why?: string;
    file_refs?: string[];
  };
}

export interface LinkInput {
  from: string;
  to: string;
  relation: RelationType;
  description?: string;
}

export interface RemoveConceptInput {
  id: string;
  reason: string;
}

// ---- Tool output types ----

export interface NodeWithContext {
  id: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  children: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    summary: string;
  }>;
  edges: Array<{
    to: string;
    to_name: string;
    relation: RelationType;
    description: string | null;
  }>;
  incoming_edges: Array<{
    from: string;
    from_name: string;
    relation: RelationType;
    description: string | null;
  }>;
  parent: { id: string; name: string } | null;
  similarity?: number;
  /** Why this node was found: hybrid search channel (T2). */
  via?: "vector" | "fts" | "both";
  /** Lifecycle status (T4); absent only in not-yet-migrated dbs. */
  status?: string;
  valid_until?: string | null;
}

export interface UnderstandOutput {
  matches: NodeWithContext[];
}

export interface UnderstandInput {
  query: string;
  top_k?: number;
  /** Token budget for the answer (default 1500). */
  max_tokens?: number;
  /**
   * compact (default): trimmed per-node payload under the token budget;
   * full: legacy verbose output (why, children/edges for every node).
   */
  mode?: "compact" | "full";
  /** Include superseded/deprecated nodes (T4). Default false. */
  include_inactive?: boolean;
}

/** One node in compact understand output — everything optional is dropped. */
export interface CompactMatch {
  id: string;
  name: string;
  kind: NodeKind;
  status: string;
  /** Truncated to <=240 chars at a word boundary. */
  summary: string;
  file_refs: string[] | null;
  score?: number;
  /** Alias of score, kept for explorer UI compatibility. */
  similarity?: number;
  via?: "vector" | "fts" | "both";
  /** Present only for the first 3 results (one level, names only). */
  children?: Array<{ id: string; name: string; kind: NodeKind }>;
  edges?: Array<{ to: string; to_name: string; relation: RelationType }>;
}

export interface UnderstandMeta {
  returned: number;
  dropped: number;
  tokens_estimated: number;
  /** U6: what the full-mode answer would have cost — drives "saved vs full". */
  estimated_full_tokens?: number;
}

export interface UnderstandOutput {
  matches: NodeWithContext[];
  /**
   * compact-mode rows (default mode). Present alongside `matches` being
   * empty/legacy for backward compatibility with older consumers.
   */
  compact?: CompactMatch[];
  /**
   * В14: relations between the returned nodes — graph structure without
   * pulling every node's full context.
   */
  edges_between?: Array<{ from: string; to: string; relation: string }>;
  meta?: UnderstandMeta;
}

export interface GetConceptInput {
  id: string;
}

export interface ListRootsInput {
  /** Token budget for the overview (default 1500). */
  max_tokens?: number;
}

export interface ListRootsOutput {
  roots: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    summary: string;
    children: string[];
  }>;
  /** true when roots_compact (budgeted overview) is the payload. */
  compact?: boolean;
  roots_compact?: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    child_count: number;
  }>;
  meta?: UnderstandMeta;
}

// ---- DB row types (raw from SQLite) ----

export interface NodeRow {
  id: string;
  name: string;
  kind: string;
  summary: string;
  why: string | null;
  file_refs: string | null; // JSON string
  parent_id: string | null;
  created_by_task: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  embedding: Buffer | ArrayBuffer | null;
  merge_group: string | null;
  needs_merge: number; // SQLite stores boolean as 0/1
  source_branch: string | null;
  merge_timestamp: string | null;
  // Fork columns (T0.5 migration) — absent only in not-yet-migrated dbs.
  status?: string;
  valid_from?: string | null;
  valid_until?: string | null;
}

export interface EdgeRow {
  id: number;
  from_id: string;
  to_id: string;
  relation: string;
  description: string | null;
  created_at: string;
  merge_group: string | null;
  needs_merge: number; // SQLite stores boolean as 0/1
  source_branch: string | null;
  merge_timestamp: string | null;
}

// ---- Merge types ----

export interface ConflictVersion {
  id: string;
  original_id: string;
  source_branch: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  edges: Array<{ to: string; relation: RelationType; description: string | null }>;
  removed_at: string | null;
  removed_reason: string | null;
}

export interface ConflictGroup {
  merge_group: string;
  merge_timestamp: string | null;
  versions: ConflictVersion[];
}

export interface ListConflictsOutput {
  conflicts: ConflictGroup[];
  /** T4: nodes with incoming `contradicts` edges and who contradicts them. */
  contradicted?: Array<{
    id: string;
    name: string;
    summary: string;
    contradicted_by: string[];
  }>;
}

export interface ResolveConflictInput {
  merge_group: string;
  resolved: {
    summary: string;
    why?: string;
    file_refs?: string[];
  };
  reason: string;
}

export interface MergeResult {
  clean: number;
  conceptConflicts: number;
  edgeConflicts: number;
  removedClean: number;
  mergeGroups: string[];
}
