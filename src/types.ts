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
  | "contradicts"
  /** Plan 2 §1: provenance edge — "this conclusion is informed by that fact". */
  | "informed_by";

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
   * Plan 3 §4.1.1: provenance shortcut — pass the support together with the
   * node. `{node}` uses an existing node as evidence, `{ref}` resolves a file
   * against file_refs (creating a file-fact node when nothing matches); `why`
   * becomes the informed_by rationale. Support edges are written in the same
   * transaction as the node.
   */
  evidence?: EvidenceInput[];
  /**
   * IDs this concept replaces (T4): creates supersedes edges and marks the
   * old nodes superseded with valid_until = now.
   */
  supersedes?: string[];
  created_by_task?: string;
  /** Plan 1 §5.3: initial epistemic state; default `open`. */
  epistemic_status?: "open" | "validated" | "refuted" | "abandoned";
  /** Required when epistemic_status = validated (JSON: {env?,version?,dataset?,artifact?}). */
  status_scope?: Record<string, unknown>;
}

/** Plan 3 §4.1.1: one evidence item — exactly one of `ref` / `node`, plus `why`. */
export interface EvidenceInput {
  /** File path (+ optional line range) to resolve or create as a file-fact node. */
  ref?: string;
  /** Existing node id to lean on. */
  node?: string;
  /** Mandatory: what exactly in this support backs the new node. */
  why: string;
}

export interface UpdateConceptInput {
  id: string;
  changes: {
    name?: string;
    kind?: NodeKind;
    summary?: string;
    why?: string;
    file_refs?: string[];
    /**
     * Plan 1 §5.3: epistemic transition. `reason` is mandatory together with
     * it; `validated` additionally requires `status_scope` with an `artifact`.
     */
    epistemic_status?: "open" | "validated" | "refuted" | "abandoned";
    epistemic_reason?: string;
    status_scope?: Record<string, unknown>;
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
  /**
   * Plan 3 §4.3: only needed when live decisions still lean on the node.
   * Without it the removal is refused (refuse-and-redirect); with it the
   * node goes and every affected informed_by edge is tombstoned with a
   * report of who lost their support.
   */
  force?: boolean;
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
  /** Plan 1: epistemic axis + the scope of a `validated` (JSON). */
  epistemic_status?: string | null;
  status_scope?: Record<string, unknown> | null;
  /** Set for refuted nodes: why the verdict was made. */
  refuted_reason?: string | null;
  /** Plan 2 §1: chains this node participates in, with their state. */
  trails?: Array<{ id: string; name: string; state: "fresh" | "stale" | "broken" }>;
  /**
   * Plan 4 §4: what this node materially relies on — live outgoing
   * informed_by edges with their (mandatory) rationales. Present only when
   * non-empty, so cards without provenance stay unchanged.
   * Plan 3 §4.2: `weak: true` marks a weak link — the support is refuted,
   * abandoned, or ungrounded.
   */
  informed_by?: Array<{
    to: string;
    to_name: string;
    rationale: string | null;
    weak?: boolean;
  }>;
  /** Plan 4 §4: nodes that rely on this node (live incoming informed_by). */
  informed_by_incoming?: Array<{ from: string; from_name: string; rationale: string | null }>;
  /**
   * Plan 3 §4.2: this node is a decision whose every support is ungrounded —
   * it must not be quoted as proven knowledge.
   */
  weak_support?: boolean;
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
  /** Plan 1: epistemic axis, shown so refuted nodes are never mistaken for facts. */
  epistemic_status?: string | null;
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
   * Plan 1 §5.3: refuted nodes found by the query, always returned regardless
   * of include_inactive — antiknowledge must not disappear behind a filter.
   * CompactMatch in compact mode, full NodeWithContext in full mode.
   */
  refuted?: Array<CompactMatch | NodeWithContext>;
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
  /** Plan 2 §2: role slots — first in the startup digest. */
  slots?: Array<{ role: string; node_id: string; node_name: string }>;
  /** Plan 2 §3: top-5 of the open column by rot. */
  board_top?: Array<{ id: string; name: string; rot?: number; due_at?: string | null }>;
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
  // Plan 1 (v5): epistemic axis (open/validated/refuted/abandoned, NULL =
  // unknown) and the JSON scope of a `validated`.
  epistemic_status?: string | null;
  status_scope?: string | null;
  // Plan 2 (v6): task board axis — 'open' | 'done', NULL for non-tasks.
  // Deliberately NOT the lifecycle `status` or the epistemic axis.
  task_state?: string | null;
  due_at?: string | null;
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
  /** Plan 1 (v5): tombstone timestamp; NULL = active edge. */
  removed_at?: string | null;
}

// ---- Workflow tools (plan 2, v6) ----

export interface TrailSaveInput {
  node_ids: string[];
  summary: string;
  name?: string;
}

export interface TrailMemberView {
  position: number;
  node_id: string;
  node_name: string | null;
  fingerprint_at_save: string;
  fingerprint_now: string | null;
  /** fresh = meaning unchanged; stale = meaning changed or node removed; broken = node gone. */
  state: "fresh" | "stale" | "broken";
  reason: string | null;
}

export interface TrailView {
  id: string;
  name: string;
  summary: string;
  /** fresh / stale / broken for the chain as a whole. */
  state: "fresh" | "stale" | "broken";
  members: TrailMemberView[];
}

export interface SlotView {
  role: string;
  node_id: string;
  node_name: string;
  updated_at: string;
}

export interface BoardColumn {
  name: string;
  terminal: boolean;
  count: number;
  cards: Array<{ id: string; name: string; rot?: number; due_at?: string | null }>;
}

export interface BoardOutput {
  columns: BoardColumn[];
  overdue: number;
  open: number;
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
  /**
   * Plan 3 §2 (invariant 3): informed_by cycles that exist only in the union
   * of the two inputs. The merge is NOT aborted — the involved edges are
   * flagged needs_merge and listed here for the report.
   */
  informedByCycles?: string[][];
}

// ---- Provenance tools (plan 3 §4.2) ----

export interface ProvenanceTraceInput {
  node_id: string;
  /** ancestry = what supports this; impact = what relies on this. */
  direction?: "ancestry" | "impact";
  /** Traversal depth cap (default 6, plan 3 §10 decision 4). */
  depth?: number;
  /** Node cap (default 200). */
  max_nodes?: number;
  /** Return tombstoned edges too — "how we used to think". */
  retrospective?: boolean;
}

/**
 * `complete`: no live links AND the node never had any informed_by record;
 * `has_hidden`: no live links, but records exist (removed or filtered by the
 * current mode) — retrospective would return their metadata;
 * `truncated`: the depth/node limit was hit, the full closure was not checked.
 */
export type ProvenanceCompleteness = "complete" | "has_hidden" | "truncated";

export interface ProvenanceWeakLink {
  type: "refuted" | "abandoned" | "no_rationale" | "ungrounded_support" | "cycle";
  id?: string;
  from?: string;
  to?: string;
  note: string;
}

export interface ProvenanceNodeView {
  id: string;
  name: string | null;
  kind: string | null;
  status: string | null;
  epistemic_status: string | null;
  depth: number;
  /** Number of enumerated root→node paths containing this node (DAG repeats shown once). */
  in_paths: number;
  /** Stub entry for a tombstoned endpoint in retrospective mode. */
  removed?: boolean;
  /** audit only: epistemic_status != validated — this node is not trusted knowledge. */
  at_risk?: boolean;
}

export interface ProvenanceEdgeView {
  from: string;
  to: string;
  rationale: string | null;
  /** Tombstoned edge surfaced by retrospective mode. */
  removed?: boolean;
}

export interface ProvenanceTraceOutput {
  root: { id: string; name: string; kind: string; status: string; epistemic_status: string | null };
  direction: "ancestry" | "impact";
  /** Weak links first (plan 3 §4.2): refuted/abandoned, cycles, missing rationales. */
  weak_links: ProvenanceWeakLink[];
  nodes: ProvenanceNodeView[];
  edges: ProvenanceEdgeView[];
  limits: { depth: number; max_nodes: number };
  shown: number;
  total_reachable: number;
  completeness: ProvenanceCompleteness;
  params: { depth: number; max_nodes: number; retrospective: boolean };
}

export interface ProvenanceAuditOutput extends ProvenanceTraceOutput {
  /** Run persisted in provenance_audit_runs (plan 3 §10 decision 7). */
  audit_run_id: number;
}
