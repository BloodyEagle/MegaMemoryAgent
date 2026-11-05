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
  /**
   * 2.1.9 F2: conscious bypass of the stub-summary rejection. The node is
   * written with epistemic_status = "stub" and shows up as a weak link —
   * a deliberate placeholder, never mistaken for a confirmation.
   */
  allow_stub?: boolean;
  /**
   * 2.1.10 F4: create anyway when the dedupe check finds a semantic or
   * name-level duplicate. Without it a near-duplicate request is refused
   * with duplicate_of — update that node or pass force consciously.
   */
  force?: boolean;
  /**
   * 2.1.12 F1: срок годности факта (ISO-8601, напр. "2026-12-31" или
   * "2026-12-31T23:59:59Z"). Обязателен для утверждений о состоянии
   * («смержено», «PR открыт») — без него запись о состоянии со временем
   * тихо врёт. Сервер срок не придумывает: не передал — узел бессрочный.
   */
  valid_until?: string;
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
    /**
     * 2.1.12 F1: срок годности факта (ISO-8601). null снимает срок (факт
     * снова бессрочный), отсутствие поля оставляет как есть.
     */
    valid_until?: string | null;
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
  /**
   * 2.1.12 F1: факт просрочен (valid_until в прошлом). Ставится только при
   * include_stale: true — по умолчанию такие узлы из выдачи исключены.
   */
  expired?: boolean;
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
  /**
   * Plan 4 v8 §4: the support check next to the epistemic verdict on the node
   * card (get_concept only — search results must not pay for it). Present
   * whenever there is anything to check.
   */
  support_check?: SupportCheckView;
  /**
   * 2.1.7 F1: the digests the agent can pass straight into confirm_supports
   * — no hand-reproduction of the hash algorithm. get_concept only (compact
   * understand must not grow). null for a removed node: a tombstone exposes
   * no digests.
   */
  current_digests?: CurrentDigestsView | null;
}

/**
 * 2.1.7 F1: the current digests of one node's wording. `claim` comes from the
 * confirmed snapshot when one exists (source: "snapshot" — the confirmation
 * belongs to the wording the agent saw; a rewritten summary refuses this
 * value with version_conflict, which is the point), otherwise it is computed
 * from the live summary (source: "computed" — the value a FIRST confirmation
 * needs). `status` is always the current status-axes digest: the node-level
 * snapshot tracks the claim only, there is nothing to take it from.
 */
export interface CurrentDigestsView {
  claim: string;
  status: string;
  format_version: number;
  source: "computed" | "snapshot";
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
  /**
   * 2.1.12 F1: вернуть и просроченные факты (valid_until в прошлом) — с
   * пометкой expired: true. По умолчанию они исключены из выдачи
   * (meta.stale_excluded считает исключённых).
   */
  include_stale?: boolean;
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
  /**
   * 2.1.7 F2: live informed_by supports of THIS node that the same query
   * also returned. They are folded here (depth 1 — a nested support carries
   * no supports of its own) instead of competing for a top slot: a support
   * shares the query terms with its decision and used to push the decision
   * off rank 1. Does not occupy a top_k slot; its tokens ARE counted in
   * tokens_estimated.
   */
  supports?: Array<{ id: string; name: string; summary: string }>;
  /**
   * 2.1.12 F1: the match is past its valid_until — present only when the
   * caller asked include_stale: true.
   */
  expired?: boolean;
}

export interface UnderstandMeta {
  returned: number;
  dropped: number;
  tokens_estimated: number;
  /** U6: what the full-mode answer would have cost — drives "saved vs full". */
  estimated_full_tokens?: number;
  /**
   * 2.1.7 F2: how many nodes were folded under their decisions instead of
   * sitting on the top level. `returned` counts the top level only; the id
   * set of the answer is preserved — folded nodes travel nested.
   */
  supports_inlined?: number;
  /**
   * 2.1.12 F1: сколько просроченных фактов (valid_until в прошлом, активных)
   * найдено запросом, но исключено из выдачи. Ноль — тоже честное число:
   * молчаливый фильтр выглядел бы как «запрос ничего не нашёл».
   */
  stale_excluded?: number;
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
    /** 2.1.12 F1: срок годности корня, если агент его ставил. */
    valid_until?: string | null;
  }>;
  /** true when roots_compact (budgeted overview) is the payload. */
  compact?: boolean;
  roots_compact?: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    child_count: number;
    /** 2.1.12 F1: срок годности корня, если агент его ставил. */
    valid_until?: string | null;
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
  // Plan 4 v8: the digest of the decision's own wording AS CONFIRMED (written
  // only by confirm_supports, never by content writes) + when. A rewrite of
  // the summary does not touch this column — the mismatch IS the signal that
  // the old confirmation does not extend to the new wording.
  claim_digest?: string | null;
  claim_digest_at?: string | null;
  // 2.1.10 (v12): which write path created the node — 'agent' | 'file_ref' |
  // 'import' | 'auto'. Anchors ('file_ref') never count as stubs; NULL means
  // the origin is unknown (rows carried over from pre-v12 sources).
  created_via?: string | null;
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
  // Plan 4 v8: which server write path created the row — assigned by the
  // server, never accepted from the caller. 'agent' = explicit tool call
  // (link/evidence), 'auto' = server-derived (auto-ground), 'unknown' =
  // pre-v8 rows and every import/merge. Explicit acceptance does NOT rewrite it.
  created_via?: string;
  /** Plan 4 v8: when the agent explicitly accepted an auto-derived edge (confirm_supports). */
  accepted_at?: string | null;
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
  /**
   * Plan 4 v8 §7: support-baseline rows carried over from the inputs
   * (confirmed_by rewritten to 'import'). Absent when there was nothing.
   */
  baselinesCarried?: number;
}

// ---- Provenance tools (plan 3 §4.2) ----

export interface ProvenanceTraceInput {
  node_id: string;
  /** ancestry = what supports this; impact = what relies on this. */
  direction?: "ancestry" | "impact";
  /** Traversal depth cap (default 6, plan 3 §10 decision 4). */
  depth?: number;
  /** Node cap (default 200); the root does not occupy a slot. */
  max_nodes?: number;
  /**
   * Scan budget (default 5000, plan-3-fixes-2 contract 5): limits not only
   * the output but the WORK — the walk stops expanding once this many nodes
   * have been fetched, and the result is marked total_exact: false.
   */
  max_scan_nodes?: number;
  /** Return tombstoned edges too — "how we used to think". */
  retrospective?: boolean;
  /**
   * Plan 4 v8 §6: the support-baseline check is bounded by EDGES, not only
   * nodes — a decision can have tens of thousands of direct supports. When
   * the budget runs out the verdict is `incomplete`, never `unchanged`.
   */
  max_check_edges?: number;
  /** Plan 4 v8 §6: byte budget for one check call (default 2 MB). */
  max_check_bytes?: number;
}

/**
 * `complete`: no live links AND the node never had any informed_by record;
 * `has_hidden`: no live links, but records exist (removed or filtered by the
 * current mode) — retrospective would return their metadata;
 * `truncated`: the depth/node limit was hit, the full closure was not checked.
 */
export type ProvenanceCompleteness = "complete" | "has_hidden" | "truncated";

export interface ProvenanceWeakLink {
  type:
    | "refuted"
    | "abandoned"
    /**
     * 2.1.12 F1: узел просрочен — valid_until в прошлом, но узел всё ещё
     * активен и в графе. Выдача его уже не показывает; в цепочке он виден
     * пометкой expired.
     */
    | "expired"
    | "no_rationale"
    | "ungrounded_support"
    | "missing_support"
    | "no_support"
    | "cycle"
    /**
     * Plan 4 v8 §4: the supports diverge from the confirmed snapshot (or the
     * decision's own wording was rewritten after the confirmation).
     */
    | "support_changed"
    /**
     * 2.1.3 F2: the observed state of a support's external artifact (file /
     * git blob) diverges from the one saved in the snapshot. Not a
     * support_changed — the summary may be untouched, the source moved.
     */
    | "artifact_changed"
    /**
     * Plan 4 v8 §3: no snapshot, or live supports the snapshot does not cover
     * — `unknown`/`incomplete` are not cleanliness and must not be silent.
     */
    | "support_unreviewed"
    /**
     * plan-3-fixes-3 D2.2: the support check is bounded by max_scan_nodes —
     * this record reports how many supports of the decision were actually
     * verified (checked/total) instead of silently skipping the rest.
     */
    | "support_check_truncated"
    /**
     * 2.1.9 F2: the decision leans on support nodes whose summary is a
     * template or too short to be a claim. Already-recorded stubs are marked,
     * never deleted — but they must not read as confirmation.
     */
    | "stub_support"
    /** plan-3-fixes-3 D2.4: weak_links were cut to fit the 8 KB response cap. */
    | "weak_links_truncated";
  id?: string;
  from?: string;
  to?: string;
  /** Absent only on the truncation markers, which carry numbers instead. */
  note?: string;
  /** D2.3: numeric size of the flagged set — agents never parse the note. */
  count?: number;
  /** D2.3: first ≤5 ids of the flagged set; the full list is never returned. */
  sample?: string[];
  /** D2.2: supports actually verified vs. declared (support_check_truncated). */
  checked?: number;
  total?: number;
  /** D2.4: records kept vs. produced (weak_links_truncated). */
  shown?: number;
  /**
   * Plan 4 v8 §4: priority orders the cut, it does not suppress — when
   * weak_links are truncated, this carries the per-reason counts over ALL
   * produced records, not only the kept ones.
   */
  reason_counts?: Record<string, number>;
}

// ---- Support baselines (plan 4 v8: snapshot of the justification) ----

/** One confirmed pair "decision — support" (support_baselines row). */
export interface SupportBaselineRow {
  decision_id: string;
  support_id: string;
  /** Stable edge identity: edges.id (the rowid); recomputed on merge. */
  edge_key: string;
  /** Digest of the tracked claim fields of the support (summary, v1). */
  claim_digest: string;
  /** Digest of the support's status axes (lifecycle + epistemic, v1). */
  status_digest: string;
  /** Digest of the rationale (v1). */
  edge_digest: string;
  format_version: number;
  confirmed_at: string;
  /** 'agent' | 'import' | 'cli' — who confirmed; imports never confirm by themselves. */
  confirmed_by: string;
  /**
   * plan-4-fixes-6 F7: set ONLY by the explicit "no supports" confirmation —
   * it acknowledges the dead anchors instead of erasing them, so "confirmed
   * and later removed" stays distinguishable from "supports never existed".
   * A fresh confirmation of the same pair clears the flag again.
   */
  superseded_at?: string | null;
  /**
   * 2.1.3 F2: sha256 over the support's observed artifacts sorted by
   * (kind, ref, digest), taken at the confirmation moment. NULL = no
   * artifacts were observed when the pair was confirmed — honestly no
   * signal, never a false "changed".
   */
  artifacts_digest?: string | null;
}

// ---- 2.1.3 F2: node artifacts ----

/** One observed external artifact of a node (node_artifacts row). */
export interface NodeArtifactRow {
  node_id: string;
  /**
   * 'file' (path) | 'git_blob' (<rev>:<path>) | 'git_ref' (git:tag|commit|branch:<name>,
   * digest = resolved commit sha). URLs are out of scope.
   */
  kind: "file" | "git_blob" | "git_ref";
  ref: string;
  /** sha256 of the content / resolved sha; null = missing at the last check. */
  digest: string | null;
  /** Previous observed digest — warning text only ("was → became"). */
  prev_digest: string | null;
  size_bytes: number | null;
  /** Last check time (moves on every check, even a matching one). */
  checked_at: string;
  /** When a divergence was last noticed — warning text only. */
  changed_at: string | null;
  /** 'agent' | 'cli'. */
  checked_by: string;
  /**
   * 2.1.12 F2: репозиторий, в котором git:-ref резолвился в первый раз.
   * Записывается при разрешении, чтобы повторные проверки не зависели от
   * cwd сервера. Для file/git_blob всегда null.
   */
  repo_path?: string | null;
}

/** check_artifacts input (2.1.3 F2). */
export interface CheckArtifactsInput {
  node_ids: string[];
  /** Cap on checked (node, ref) pairs; more => truncated: true. Default 50. */
  max_files?: number;
  /** Base dir for relative refs and the git working tree (default cwd). */
  cwd?: string;
  /**
   * 2.1.12 F2: репозиторий для разрешения git:tag/commit/branch (по
   * умолчанию — каталог базы). При первом разрешении путь пишется в
   * node_artifacts.repo_path, последующие проверки идут в него даже из
   * другого cwd.
   */
  repo?: string;
}

/** One missing ref in the check_artifacts answer. */
export interface MissingArtifact {
  node_id: string;
  ref: string;
  kind: string;
  digest: null;
  missing: true;
}

export interface CheckArtifactsOutput {
  /** Number of (node, ref) pairs actually hashed. */
  checked: number;
  /** Observed divergences: old digest → new digest. */
  changed: Array<{ node_id: string; ref: string; old: string | null; new: string | null }>;
  missing: MissingArtifact[];
  /** true when more (node, ref) pairs were waiting than max_files allowed. */
  truncated: boolean;
}

/** Why a confirmed support no longer matches (plan 4 v8 §4). */
export type SupportChangeReason = "summary" | "status" | "rationale" | "removed";

// ---- 2.1.3 F1: the support revision journal (support_revisions rows) ----

/** Who wrote the journal entry: the confirming agent, the merge carry, or a
 * version transition (superseded by a re-confirmation / removed). */
export type SupportRevisionSource = "agent" | "import" | "superseded";

/**
 * Why the entry landed: the pair was confirmed for the first time, an older
 * version was replaced by a re-confirmation, the support was acknowledged as
 * gone, or the merge re-anchored the snapshot to a new edge row.
 */
export type SupportRevisionReason = "confirmed" | "reconfirmed" | "removed" | "edge_relinked";

/** One journal row: a confirmed version of a pair, past or superseded. */
export interface SupportRevisionRow {
  id?: number;
  decision_id: string;
  support_id: string;
  edge_key: string;
  claim_digest: string;
  status_digest: string;
  edge_digest: string;
  format_version: number;
  /** When THIS version was confirmed (not when the entry landed). */
  confirmed_at: string;
  /** When the entry landed in the journal. */
  recorded_at: string;
  source: SupportRevisionSource;
  reason: SupportRevisionReason | null;
}

/** One chain entry as provenance_history returns it: digests are 12-char
 * previews, no node bodies (the answer must stay small). */
export interface SupportRevisionEntry {
  edge_key: string;
  confirmed_at: string;
  source: string;
  reason: string | null;
  claim_digest: string;
  status_digest: string;
  edge_digest: string;
  format_version: number;
  recorded_at: string;
  /** true for the row taken from the live snapshot (support_baselines). */
  is_current: boolean;
}

/** The chain of one pair "decision — support". */
export interface SupportHistoryPair {
  support_id: string;
  revisions: SupportRevisionEntry[];
  /** true when the pair had more revisions than the limit allowed. */
  revisions_truncated?: boolean;
}

export interface ProvenanceHistoryOutput {
  decision_id: string;
  pairs: SupportHistoryPair[];
  /** true when more pairs carry history than fit the response. */
  pairs_truncated?: boolean;
}

/** One diverged pair "decision — support" in the support_check block. */
export interface SupportPairChange {
  support: string;
  /** Array, not a single value: summary AND status can both move at once. */
  reasons: SupportChangeReason[];
  /** The confirmation time (baseline_at), not the edit time — the db keeps no edit log. */
  since: string;
  /**
   * 2.1.3 F2: the observed artifact state of the support diverges from the
   * one saved in the snapshot. NOT a support change: the summary may be
   * untouched, the source moved. True also when content reasons fired.
   */
  artifact_changed?: boolean;
  /** ≤3 observed artifact changes behind the flag — warning text only. */
  artifacts?: SupportArtifactChange[];
}

/** 2.1.3 F2: one observed artifact divergence, digests are 12-char previews. */
export interface SupportArtifactChange {
  ref: string;
  kind: string;
  prev_digest: string | null;
  digest: string | null;
  changed_at: string;
}

/**
 * Plan 4 v8 §3: four states, per pair and for the node as a whole.
 * `unknown` and `incomplete` are NOT cleanliness — a node without a snapshot
 * is never shown as verified.
 */
export interface SupportCheckView {
  state: "unchanged" | "changed" | "unknown" | "incomplete";
  /** Pairs that diverged from the confirmed snapshot (state = changed). */
  changed?: SupportPairChange[];
  /** Honest total when the changed list was capped for the response. */
  changed_count?: number;
  /**
   * 2.1.3 F2: honest total of pairs whose observed artifacts diverge from
   * the snapshot — full-set, counted before the response cap. Lets the
   * weak-links layer size the support_changed record without the artifact
   * only pairs.
   */
  artifact_changed_count?: number;
  /** Live supports the snapshot does not cover (never confirmed). */
  unknown?: string[];
  /** Honest total when the unknown list was capped for the response. */
  unknown_count?: number;
  /** true when the check ran out of the edge/byte budget. */
  incomplete?: boolean;
  /** The confirmation time of the snapshot (max over its rows); null = never confirmed. */
  baseline_at: string | null;
  /**
   * The decision's own wording was rewritten after the confirmation — the old
   * confirmation does not extend to the new wording (plan 4 v8 §1.2).
   */
  claim_changed?: boolean;
  /**
   * plan-4-fixes-6 F7: the snapshot holds superseded rows — this decision HAD
   * confirmed supports that were later acknowledged as gone. Absent for a
   * decision that never had any.
   */
  had_supports?: boolean;
}

export interface ConfirmSupportsItem {
  support_id: string;
  /** The support's summary digest as the agent read it. */
  expected_claim_digest: string;
  /**
   * The support's status-axes digest as the agent read it. plan-4-fixes-6 F3:
   * mandatory in practice — a confirmation without it (or with a stale one)
   * is refused with version_conflict; an agent must never confirm a status
   * it has not seen.
   */
  expected_status_digest?: string;
  /** The rationale digest as the agent read it. */
  expected_edge_digest: string;
}

export interface ConfirmSupportsInput {
  decision_id: string;
  /** The decision's own wording digest as the agent saw it. */
  expected_claim_digest: string;
  /**
   * Confirms exactly the listed supports; live supports missing from the list
   * stay `unknown`, never "confirmed by default". An EMPTY list is valid: it
   * asserts "this node has no supports" — distinct from "never checked".
   */
  items: ConfirmSupportsItem[];
  note?: string;
}

export interface ConfirmSupportsOutput {
  decision_id: string;
  /** Number of baseline rows written (0 for a valid empty confirmation). */
  confirmed: number;
  claim_digest: string;
  baseline_at: string;
  /** Auto-derived edges explicitly accepted by this confirmation. */
  accepted_auto_edges: number;
  message: string;
}

export interface ProvenanceNodeView {
  id: string;
  name: string | null;
  kind: string | null;
  status: string | null;
  epistemic_status: string | null;
  depth: number;
  /**
   * Root→node paths within the SHOWN subgraph (plan-3-fixes-2 contract 4) —
   * not a confirmation count. null when every path crosses an unresolved
   * SCC: an honest unknown beats a lying number.
   */
  in_paths: number | null;
  /** true when in_paths hit PATH_COUNT_CAP — the true count is ≥ the shown value. */
  in_paths_capped?: boolean;
  /** Stub entry for a tombstoned endpoint in retrospective mode. */
  removed?: boolean;
  /**
   * 2.1.12 F1: узел просрочен (valid_until в прошлом, активен). Цепочку не
   * обрывает — предшественник остаётся в обходе и в счёте путей, но читать
   * его как факт нельзя.
   */
  expired?: boolean;
  /** audit only: epistemic_status != validated — this node is not trusted knowledge. */
  at_risk?: boolean;
  /**
   * Plan 4 v8 §4/§5: the node's own support check. On the root it is present
   * whenever there is anything to check; on inner nodes only when the state
   * is `changed` — the local divergence travels together with the dependency
   * path (§5), while clean/unknown nodes keep the response small.
   */
  support_check?: SupportCheckView;
}

export interface ProvenanceEdgeView {
  from: string;
  to: string;
  rationale: string | null;
  /** Tombstoned edge surfaced by retrospective mode. */
  removed?: boolean;
}

/**
 * 2.1.7 F1: one live informed_by support of the trace root with its FULL
 * current digests — the exact values confirm_supports compares against, not
 * the 12-char previews provenance_history keeps. Null digests mean the
 * support node is gone while the edge lives: the pair is reported `removed`
 * in support_check, there is nothing to hash.
 */
export interface ProvenanceSupportDigest {
  support_id: string;
  claim_digest: string | null;
  status_digest: string | null;
  edge_digest: string;
  /**
   * 2.1.9 F2: "stub" — the support's summary is a template / too short to be
   * a claim (it can never honestly confirm anything); "claim" — a real
   * assertion. A missing support node (null digests) is "stub" too.
   */
  quality: "stub" | "claim";
}

export interface ProvenanceTraceOutput {
  /**
   * One contract for the root and every other node (plan-3-fixes-2 F15): a
   * removed node's attributes are hidden (null), status is never invented as
   * "active"; a removed root is shown as a removed stub, not an error.
   */
  root: {
    id: string;
    name: string | null;
    kind: string | null;
    status: string | null;
    epistemic_status: string | null;
    removed?: boolean;
  };
  direction: "ancestry" | "impact";
  /** Weak links first (plan 3 §4.2): refuted/abandoned, cycles, missing rationales. */
  weak_links: ProvenanceWeakLink[];
  nodes: ProvenanceNodeView[];
  edges: ProvenanceEdgeView[];
  shown: number;
  /**
   * Nodes within the depth limit (plan-3-fixes-2 contract 3). A lower
   * estimate when total_exact is false (the scan budget cut the walk).
   */
  total_within_depth: number;
  /** false when the scan budget (max_scan_nodes) cut the closure walk. */
  total_exact: boolean;
  /** Always present (F21); true whenever truncated_by is not null. */
  truncated: boolean;
  truncated_by: "depth" | "nodes" | "scan" | null;
  completeness: ProvenanceCompleteness;
  /**
   * Plan 4 v8 §4: the root's support check, next to the epistemic verdict —
   * otherwise search keeps returning "verified" decisions whose supports
   * have long since drifted. Present whenever there is anything to check.
   */
  support_check?: SupportCheckView;
  /**
   * 2.1.7 F1: the root's own digests, the same block get_concept carries —
   * pass `current_digests.claim` straight into confirm_supports. null for a
   * removed root: a tombstone exposes no digests.
   */
  current_digests?: CurrentDigestsView | null;
  /**
   * 2.1.7 F1: the root's live supports with their FULL current digests —
   * what confirm_supports items[] expects, no previews and no hand hashing.
   * Sorted by support_id; capped like the other digest lists, the honest
   * total travels in supports_count when the cap cut anything.
   */
  supports?: ProvenanceSupportDigest[];
  supports_count?: number;
  /**
   * plan-4-fixes-6 F11: inner (non-root) nodes of any kind whose own support
   * check ran out of the shared budget. Present only when > 0; the verdict
   * also degrades completeness to "truncated" — an unverified inner node must
   * not hide behind a clean-looking answer.
   */
  inner_nodes_incomplete?: number;
  limits: {
    depth: number;
    max_nodes: number;
    max_scan_nodes: number;
    max_check_edges: number;
    max_check_bytes: number;
  };
  params: {
    depth: number;
    max_nodes: number;
    max_scan_nodes: number;
    retrospective: boolean;
    max_check_edges: number;
    max_check_bytes: number;
  };
}

export interface ProvenanceAuditOutput extends ProvenanceTraceOutput {
  /** Run persisted in provenance_audit_runs (plan 3 §10 decision 7). */
  audit_run_id: number;
}
