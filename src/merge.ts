import { randomUUID } from "crypto";
import { KnowledgeDB } from "./db.js";
import { ensureSchema } from "./migrate-schema.js";
import type { NodeRow, EdgeRow, MergeResult } from "./types.js";

export const MERGE_SUFFIX_LEFT = "::left";
export const MERGE_SUFFIX_RIGHT = "::right";

/**
 * F5: prefix for a carried snapshot row whose edge did not survive the merge.
 * Never equals a numeric edges.id, so the row can no longer anchor a live
 * pair by accident.
 */
export const DEAD_EDGE_KEY_PREFIX = "dead:";

export interface MergeOptions {
  leftLabel?: string;
  rightLabel?: string;
}

/**
 * Convert ArrayBuffer or Buffer to Buffer for libsql compatibility.
 * libsql returns ArrayBuffer for BLOBs but expects Buffer when binding parameters.
 */
function toBuffer(data: Buffer | ArrayBuffer | null): Buffer | null {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

/**
 * Strip the merge suffix (::left or ::right) from an ID.
 */
export function stripMergeSuffix(id: string): string {
  if (id.endsWith(MERGE_SUFFIX_LEFT)) return id.slice(0, -MERGE_SUFFIX_LEFT.length);
  if (id.endsWith(MERGE_SUFFIX_RIGHT)) return id.slice(0, -MERGE_SUFFIX_RIGHT.length);
  return id;
}

/**
 * Check if an ID has a merge suffix.
 */
export function hasMergeSuffix(id: string): boolean {
  return id.endsWith(MERGE_SUFFIX_LEFT) || id.endsWith(MERGE_SUFFIX_RIGHT);
}

/**
 * Deep comparison of two nodes' content fields (ignoring timestamps, embedding, merge metadata).
 */
export function nodesAreIdentical(left: NodeRow, right: NodeRow): boolean {
  if (left.name !== right.name) return false;
  if (left.kind !== right.kind) return false;
  if (left.summary !== right.summary) return false;
  if ((left.why ?? "") !== (right.why ?? "")) return false;
  if ((left.parent_id ?? "") !== (right.parent_id ?? "")) return false;

  // Deep-compare file_refs (stored as JSON strings)
  const leftRefs = left.file_refs ? JSON.parse(left.file_refs) : null;
  const rightRefs = right.file_refs ? JSON.parse(right.file_refs) : null;
  if (JSON.stringify(leftRefs) !== JSON.stringify(rightRefs)) return false;

  // Check removed state
  const leftRemoved = left.removed_at !== null;
  const rightRemoved = right.removed_at !== null;
  if (leftRemoved !== rightRemoved) return false;

  // Plan 3 §5: lifecycle and epistemic axes must match — otherwise an
  // open/refuted divergence silently loses the refuted verdict when one
  // side's copy wins.
  if ((left.status ?? "active") !== (right.status ?? "active")) return false;
  if ((left.epistemic_status ?? null) !== (right.epistemic_status ?? null)) return false;

  return true;
}

/**
 * Create a normalized edge key for comparison (ignoring IDs and timestamps).
 * JSON array, not `${a}|${b}` — pipe-joined keys collide for ("a|b", "c") and
 * ("a", "b|c") (plan-3-fixes-2 F11).
 */
export function edgeKey(e: EdgeRow): string {
  return JSON.stringify([e.from_id, e.to_id, e.relation, e.description ?? ""]);
}

/**
 * Compare two sets of edges by their content (from_id, to_id, relation, description).
 */
export function edgeSetsAreIdentical(left: EdgeRow[], right: EdgeRow[]): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = new Set(left.map(edgeKey));
  const rightKeys = new Set(right.map(edgeKey));
  if (leftKeys.size !== rightKeys.size) return false;
  for (const k of leftKeys) {
    if (!rightKeys.has(k)) return false;
  }
  return true;
}

/**
 * MergeEngine: Merges two knowledge.db files into an output file.
 *
 * Opens left and right DBs read-only, writes to a fresh output DB.
 * Detects conflicts, assigns merge_group UUIDs, and sets needs_merge flags.
 */
export class MergeEngine {
  merge(
    leftPath: string,
    rightPath: string,
    outputPath: string,
    options?: MergeOptions
  ): MergeResult {
    const leftLabel = options?.leftLabel ?? "left";
    const rightLabel = options?.rightLabel ?? "right";

    const leftDb = new KnowledgeDB(leftPath);
    const rightDb = new KnowledgeDB(rightPath);
    const outputDb = new KnowledgeDB(outputPath);
    // Б10: the merged output must carry the fork schema (status/valid_from/
    // valid_until), otherwise lifecycle data is dropped during branch merges.
    ensureSchema(outputDb);

    try {
      return this.performMerge(leftDb, rightDb, outputDb, leftLabel, rightLabel);
    } finally {
      leftDb.close();
      rightDb.close();
      outputDb.close();
    }
  }

  private performMerge(
    leftDb: KnowledgeDB,
    rightDb: KnowledgeDB,
    outputDb: KnowledgeDB,
    leftLabel: string,
    rightLabel: string
  ): MergeResult {
    const leftNodes = leftDb.getAllNodesRaw();
    const rightNodes = rightDb.getAllNodesRaw();
    const leftEdges = leftDb.getAllEdgesRaw();
    const rightEdges = rightDb.getAllEdgesRaw();

    // Plan 4 §5 (import): a live informed_by cycle expressible in a single
    // row (u -> u) rejects the whole file BEFORE any write — the output must
    // not contain half-written data. Tombstoned rows are history and are not
    // a violation.
    for (const e of [...leftEdges, ...rightEdges]) {
      if (
        e.relation === "informed_by" &&
        e.removed_at === null &&
        e.from_id === e.to_id
      ) {
        throw new Error(
          `Merge rejected: live informed_by self-loop "${e.from_id}" in a source file — ` +
            `the relation is a strict DAG. Fix the source and retry.`
        );
      }
    }

    const leftNodeMap = new Map<string, NodeRow>();
    const rightNodeMap = new Map<string, NodeRow>();
    const leftVariantsByCanonical = new Map<string, NodeRow[]>();
    const rightVariantsByCanonical = new Map<string, NodeRow[]>();

    for (const n of leftNodes) {
      leftNodeMap.set(n.id, n);
      const canonical = stripMergeSuffix(n.id);
      if (!leftVariantsByCanonical.has(canonical)) leftVariantsByCanonical.set(canonical, []);
      leftVariantsByCanonical.get(canonical)!.push(n);
    }
    for (const n of rightNodes) {
      rightNodeMap.set(n.id, n);
      const canonical = stripMergeSuffix(n.id);
      if (!rightVariantsByCanonical.has(canonical)) rightVariantsByCanonical.set(canonical, []);
      rightVariantsByCanonical.get(canonical)!.push(n);
    }

    // Build edge maps keyed by node ID
    const leftEdgeMap = new Map<string, EdgeRow[]>();
    const rightEdgeMap = new Map<string, EdgeRow[]>();

    for (const e of leftEdges) {
      if (!leftEdgeMap.has(e.from_id)) leftEdgeMap.set(e.from_id, []);
      leftEdgeMap.get(e.from_id)!.push(e);
    }
    for (const e of rightEdges) {
      if (!rightEdgeMap.has(e.from_id)) rightEdgeMap.set(e.from_id, []);
      rightEdgeMap.get(e.from_id)!.push(e);
    }

    // Collect all unique IDs (strip any existing merge suffixes to get canonical IDs)
    const allIds = new Set<string>();
    for (const id of leftNodeMap.keys()) allIds.add(stripMergeSuffix(id));
    for (const id of rightNodeMap.keys()) allIds.add(stripMergeSuffix(id));

    const result: MergeResult = {
      clean: 0,
      conceptConflicts: 0,
      edgeConflicts: 0,
      removedClean: 0,
      mergeGroups: [],
    };

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    // Track which IDs were suffixed (for edge remapping)
    const idRemapping = new Map<string, string>(); // "side:originalId" → suffixedId

    // Deferred edge operations — we insert all nodes first, then edges,
    // to avoid FOREIGN KEY constraint failures when edges reference nodes
    // that haven't been inserted yet.
    type DeferredEdge = {
      from_id: string;
      to_id: string;
      relation: string;
      description: string | null;
      created_at: string | null;
      merge_group: string | null;
      needs_merge: number;
      source_branch: string | null;
      merge_timestamp: string | null;
      removed_at: string | null;
      _originSide: "left" | "right"; // tracks which input DB this edge came from
      // F5: every SOURCE row this deferred edge represents — the winner of a
      // dedup plus the copies it absorbed. The support-baseline carry maps
      // edge_key through these, so a snapshot never migrates to an unrelated
      // edge just because the ends match.
      _srcEdgeIds: Array<{ side: "left" | "right"; id: number }>;
      // F9: edge provenance travels with the row (sources without the
      // columns honestly become 'unknown'/null).
      created_via: string | null;
      accepted_at: string | null;
    };
    const deferredEdges: DeferredEdge[] = [];
    const insertedNodeIds = new Set<string>();
    const seenPreexistingEdgeKeys = new Set<string>();

    const insertNodeOnce = (node: NodeRow): void => {
      if (insertedNodeIds.has(node.id)) return;
      this.insertNodeAsIs(outputDb, node);
      insertedNodeIds.add(node.id);
    };

    const deferPreexistingEdge = (
      e: EdgeRow,
      originSide: "left" | "right"
    ): void => {
      // JSON array, not pipe-joined — ids containing "|" must not collide (F11).
      const key = JSON.stringify([
        e.from_id,
        e.to_id,
        e.relation,
        e.description ?? "",
        e.merge_group ?? "",
        e.needs_merge,
        e.source_branch ?? "",
        e.merge_timestamp ?? "",
      ]);
      if (seenPreexistingEdgeKeys.has(key)) return;
      seenPreexistingEdgeKeys.add(key);

      deferredEdges.push({
        from_id: e.from_id,
        to_id: e.to_id,
        relation: e.relation,
        description: e.description,
        created_at: e.created_at,
        merge_group: e.merge_group,
        needs_merge: e.needs_merge,
        source_branch: e.source_branch,
        merge_timestamp: e.merge_timestamp,
        removed_at: e.removed_at ?? null,
        _originSide: originSide,
        _srcEdgeIds: [{ side: originSide, id: e.id }],
        created_via: e.created_via ?? "unknown",
        accepted_at: e.accepted_at ?? null,
      });
    };

    // ---- PASS 1: Insert all nodes ----

    // Track which canonical IDs were processed as conflicts vs clean
    const conflictIds = new Set<string>();

    for (const id of allIds) {
      const leftVariants = leftVariantsByCanonical.get(id) ?? [];
      const rightVariants = rightVariantsByCanonical.get(id) ?? [];
      const leftNode = leftNodeMap.get(id);
      const rightNode = rightNodeMap.get(id);

      // Handle pre-existing conflicts (nodes already have ::left/::right IDs from prior merge).
      const preexistingLeft = leftVariants.filter(
        (n) => n.needs_merge === 1 && !!n.merge_group && hasMergeSuffix(n.id)
      );
      const preexistingRight = rightVariants.filter(
        (n) => n.needs_merge === 1 && !!n.merge_group && hasMergeSuffix(n.id)
      );

      if (preexistingLeft.length > 0 || preexistingRight.length > 0) {
        const preexistingAll = [...preexistingLeft, ...preexistingRight];

        // Carry forward all unresolved versions as-is.
        for (const node of preexistingAll) {
          insertNodeOnce(node);
        }

        // Ensure edges from clean nodes can still remap to a valid conflicted target.
        const leftTarget =
          preexistingAll.find((n) => n.id.endsWith(MERGE_SUFFIX_LEFT)) ??
          preexistingAll[0];
        const rightTarget =
          preexistingAll.find((n) => n.id.endsWith(MERGE_SUFFIX_RIGHT)) ??
          preexistingAll[preexistingAll.length - 1] ??
          preexistingAll[0];

        if (leftTarget) idRemapping.set(`left:${id}`, leftTarget.id);
        if (rightTarget) idRemapping.set(`right:${id}`, rightTarget.id);

        // Carry forward outgoing edges from conflicted source nodes.
        for (const node of preexistingLeft) {
          const edges = leftEdgeMap.get(node.id) ?? [];
          for (const e of edges) {
            deferPreexistingEdge(e, "left");
          }
        }
        for (const node of preexistingRight) {
          const edges = rightEdgeMap.get(node.id) ?? [];
          for (const e of edges) {
            deferPreexistingEdge(e, "right");
          }
        }

        conflictIds.add(id);
        continue;
      }

      if (!leftNode && rightNode) {
        // Only in right
        insertNodeOnce(rightNode);
        if (rightNode.removed_at) {
          result.removedClean++;
        } else {
          result.clean++;
        }
      } else if (leftNode && !rightNode) {
        // Only in left
        insertNodeOnce(leftNode);
        if (leftNode.removed_at) {
          result.removedClean++;
        } else {
          result.clean++;
        }
      } else if (leftNode && rightNode) {
        if (nodesAreIdentical(leftNode, rightNode)) {
          // Identical — keep left's copy
          insertNodeOnce(leftNode);
          if (leftNode.removed_at) {
            result.removedClean++;
          } else {
            result.clean++;
          }
        } else {
          // Conflict — insert both with suffixed IDs
          conflictIds.add(id);
          const mergeGroup = randomUUID();
          result.mergeGroups.push(mergeGroup);
          result.conceptConflicts++;

          const leftSuffixed = `${id}${MERGE_SUFFIX_LEFT}`;
          const rightSuffixed = `${id}${MERGE_SUFFIX_RIGHT}`;

          idRemapping.set(`left:${id}`, leftSuffixed);
          idRemapping.set(`right:${id}`, rightSuffixed);

          this.insertConflictNode(outputDb, leftNode, leftSuffixed, mergeGroup, leftLabel, now);
          this.insertConflictNode(outputDb, rightNode, rightSuffixed, mergeGroup, rightLabel, now);

          // Defer edge handling for conflicting nodes
          const leftNodeEdges = leftEdgeMap.get(id) ?? [];
          const rightNodeEdges = rightEdgeMap.get(id) ?? [];
          const edgesConflict = !edgeSetsAreIdentical(leftNodeEdges, rightNodeEdges);

          if (edgesConflict && (leftNodeEdges.length > 0 || rightNodeEdges.length > 0)) {
            result.edgeConflicts++;
          }

          for (const e of leftNodeEdges) {
            deferredEdges.push({
              from_id: leftSuffixed,
              to_id: e.to_id, // will be remapped in pass 2
              relation: e.relation,
              description: e.description,
              created_at: e.created_at,
              merge_group: edgesConflict ? mergeGroup : null,
              needs_merge: edgesConflict ? 1 : 0,
              source_branch: edgesConflict ? leftLabel : null,
              merge_timestamp: edgesConflict ? now : null,
              removed_at: e.removed_at ?? null,
              _originSide: "left",
              _srcEdgeIds: [{ side: "left", id: e.id }],
              created_via: e.created_via ?? "unknown",
              accepted_at: e.accepted_at ?? null,
            });
          }

          for (const e of rightNodeEdges) {
            deferredEdges.push({
              from_id: rightSuffixed,
              to_id: e.to_id, // will be remapped in pass 2
              relation: e.relation,
              description: e.description,
              created_at: e.created_at,
              merge_group: edgesConflict ? mergeGroup : null,
              needs_merge: edgesConflict ? 1 : 0,
              source_branch: edgesConflict ? rightLabel : null,
              merge_timestamp: edgesConflict ? now : null,
              removed_at: e.removed_at ?? null,
              _originSide: "right",
              _srcEdgeIds: [{ side: "right", id: e.id }],
              created_via: e.created_via ?? "unknown",
              accepted_at: e.accepted_at ?? null,
            });
          }
        }
      }
    }

    // ---- PASS 2: Insert all edges ----

    // First, collect non-conflict edges
    for (const id of allIds) {
      if (conflictIds.has(id)) continue; // handled via deferred edges

      const leftNode = leftNodeMap.get(id);
      const rightNode = rightNodeMap.get(id);

      // Skip pre-existing conflicts
      if (leftNode && leftNode.needs_merge && leftNode.merge_group) continue;

      if (!leftNode && rightNode) {
        this.deferEdgesForNode(deferredEdges, rightEdgeMap, rightNode.id, idRemapping, "right");
      } else if (leftNode && !rightNode) {
        this.deferEdgesForNode(deferredEdges, leftEdgeMap, leftNode.id, idRemapping, "left");
      } else if (leftNode && rightNode) {
        // Identical nodes — union of edges from both sides
        this.deferEdgesClean(
          deferredEdges,
          leftEdgeMap,
          rightEdgeMap,
          leftNode.id,
          idRemapping,
          result,
          now,
          leftLabel,
          rightLabel
        );
      }
    }

    // Now insert all deferred edges, remapping target IDs where needed.
    // F5: every source rowid maps to the output rowid it became — by
    // identity, never by ends — so the snapshot carry (§7) re-anchors each
    // baseline to ITS edge.
    const outEdgeIdByEnds = new Map<string, number>();
    const edgeIdRemapping = new Map<string, number>(); // "side:srcEdgeId" → output rowid
    for (const edge of deferredEdges) {
      // Remap to_id if the target was conflicted — use _originSide to determine
      // which suffixed version to point at (not from_id suffix, which may be absent
      // for edges from non-conflicted nodes)
      const remappedToId = idRemapping.get(`${edge._originSide}:${edge.to_id}`) ?? edge.to_id;

      // Plan 4 §2 (invariant 6) / §5: after a merge there is no u == v and no
      // LIVE informed_by edge onto a tombstoned node — such rows are caught
      // here and dropped, not silently alive in the output. Tombstoned
      // informed_by rows carry over verbatim (history preservation).
      if (edge.relation === "informed_by" && edge.removed_at === null) {
        if (edge.from_id === remappedToId) continue;
        const fromRow = outputDb.getNodeIncludingRemoved(edge.from_id);
        const toRow = outputDb.getNodeIncludingRemoved(remappedToId);
        if (
          !fromRow ||
          fromRow.removed_at !== null ||
          !toRow ||
          toRow.removed_at !== null
        ) {
          continue;
        }
      }

      const res = outputDb.insertEdgeRaw({
        from_id: edge.from_id,
        to_id: remappedToId,
        relation: edge.relation,
        description: edge.description,
        created_at: edge.created_at,
        merge_group: edge.merge_group,
        needs_merge: edge.needs_merge,
        source_branch: edge.source_branch,
        merge_timestamp: edge.merge_timestamp,
        removed_at: edge.removed_at,
        created_via: edge.created_via,
        accepted_at: edge.accepted_at,
      });
      const endsKey = JSON.stringify([edge.from_id, remappedToId, edge.relation]);
      // INSERT OR IGNORE: same ends were inserted earlier in this pass (e.g.
      // two rationales for one pair) — the surviving row anchors every copy.
      // A source rowid dropped above (dead live edge) maps to nothing: its
      // snapshot keeps the source edge_key and honestly reports "removed".
      let outId = res.id;
      if (!res.inserted) {
        const existing = outEdgeIdByEnds.get(endsKey);
        if (existing === undefined) {
          throw new Error(
            `Merge error: ignored insert of ${edge.from_id} -> ${remappedToId} ` +
              `(${edge.relation}) has no earlier output row.`
          );
        }
        outId = existing;
      }
      outEdgeIdByEnds.set(endsKey, outId);
      for (const src of edge._srcEdgeIds) {
        edgeIdRemapping.set(`${src.side}:${src.id}`, outId);
      }
    }

    // ---- Plan 4 (v8) §7: carry the support snapshots over ----
    // After every edge row exists in the output, so edge_key can be remapped
    // to the new rowids. Left side first, then right (deterministic).
    const carriedLeft = this.carrySupportBaselines(
      leftDb,
      outputDb,
      "left",
      idRemapping,
      edgeIdRemapping
    );
    const carriedRight = this.carrySupportBaselines(
      rightDb,
      outputDb,
      "right",
      idRemapping,
      edgeIdRemapping
    );
    if (carriedLeft + carriedRight > 0) {
      result.baselinesCarried = carriedLeft + carriedRight;
    }

    // ---- PASS 3: re-validate the informed_by DAG over the combined graph ----
    // Plan 3 §2 (invariants 2, 3): two individually-acyclic inputs can form a
    // cycle in their union. A cycle brought in by a merge does NOT abort the
    // merge (a rollback after a long merge with a manual retry would lose the
    // work) — the edges are flagged needs_merge and reported instead.
    const cycleComponents = outputDb.informedByCycleComponents();
    if (cycleComponents.length > 0) {
      result.informedByCycles = cycleComponents;
      const all = new Set<string>();
      for (const component of cycleComponents) {
        for (const n of component) all.add(n);
      }
      const ids = [...all];
      const placeholders = ids.map(() => "?").join(",");
      outputDb.execSqlRun(
        `UPDATE edges SET needs_merge = 1
         WHERE relation = 'informed_by' AND removed_at IS NULL
           AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`,
        ...ids,
        ...ids
      );
    }

    return result;
  }

  private insertNodeAsIs(db: KnowledgeDB, node: NodeRow): void {
    db.insertNodeRaw({
      id: node.id,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why,
      file_refs: node.file_refs,
      parent_id: node.parent_id,
      created_by_task: node.created_by_task,
      created_at: node.created_at,
      updated_at: node.updated_at,
      removed_at: node.removed_at,
      removed_reason: node.removed_reason,
      embedding: toBuffer(node.embedding),
      merge_group: node.merge_group,
      needs_merge: node.needs_merge,
      source_branch: node.source_branch,
      merge_timestamp: node.merge_timestamp,
      // Б10: lifecycle columns travel with the row.
      status: node.status,
      valid_from: node.valid_from,
      valid_until: node.valid_until,
      // Plan 1 (v5): epistemic axis travels with the row.
      epistemic_status: node.epistemic_status ?? null,
      status_scope: node.status_scope ?? null,
      // Plan 4 (v8): the confirmed wording digest travels with the row so a
      // carried-over snapshot keeps pointing at the wording it confirmed.
      claim_digest: node.claim_digest ?? null,
      claim_digest_at: node.claim_digest_at ?? null,
    });
  }

  private insertConflictNode(
    db: KnowledgeDB,
    node: NodeRow,
    suffixedId: string,
    mergeGroup: string,
    sourceLabel: string,
    timestamp: string
  ): void {
    db.insertNodeRaw({
      id: suffixedId,
      name: node.name,
      kind: node.kind,
      summary: node.summary,
      why: node.why,
      file_refs: node.file_refs,
      parent_id: node.parent_id,
      created_by_task: node.created_by_task,
      created_at: node.created_at,
      updated_at: node.updated_at,
      removed_at: node.removed_at,
      removed_reason: node.removed_reason,
      embedding: toBuffer(node.embedding),
      merge_group: mergeGroup,
      needs_merge: 1,
      source_branch: sourceLabel,
      merge_timestamp: timestamp,
      // Б10: lifecycle columns travel with the row.
      status: node.status,
      valid_from: node.valid_from,
      valid_until: node.valid_until,
      // Plan 1 (v5): epistemic axis travels with the row.
      epistemic_status: node.epistemic_status ?? null,
      status_scope: node.status_scope ?? null,
      // Plan 4 (v8): confirmed wording digest travels with the row.
      claim_digest: node.claim_digest ?? null,
      claim_digest_at: node.claim_digest_at ?? null,
    });
  }

  /**
   * Plan 4 (v8) §7: carry the support snapshot over with the decision.
   * - ids are remapped consistently with the graph (suffixed conflict copies
   *   get the snapshots of their own side);
   * - F5: edge_key is recomputed through the identity map built while the
   *   edges were transferred (source rowid → the output rowid THAT row
   *   became). The old ends-and-min-id lookup could not tell a tombstone
   *   from a live edge with the same ends, so a confirmation could migrate
   *   onto a link nobody confirmed;
   * - the saved CONTENT (digests, format_version, confirmed_at) is carried
   *   verbatim — a remap must not replace the stored digests with current
   *   values, otherwise a clean remap would produce mass false "changed"
   *   (test 15) and a real divergence could hide;
   * - confirmed_by is rewritten to 'import' (§7): the import never confirms
   *   by itself, and a row that came through a merge must be distinguishable
   *   from one the agent confirmed in this database.
   * When the edge did not survive the merge (dropped live edge onto a removed
   * node) the row is still carried with the source edge_key: the pair then
   * reports "removed" instead of silently losing the anchor.
   */
  private carrySupportBaselines(
    sourceDb: KnowledgeDB,
    outputDb: KnowledgeDB,
    side: "left" | "right",
    idRemapping: Map<string, string>,
    edgeIdRemapping: Map<string, number>
  ): number {
    if (!sourceDb.hasSupportBaselinesTable() || !outputDb.hasSupportBaselinesTable()) {
      return 0;
    }
    const resolve = (id: string): string | null => {
      if (outputDb.getNodeIncludingRemoved(id)) return id;
      const canonical = stripMergeSuffix(id);
      const remapped = idRemapping.get(`${side}:${canonical}`);
      if (remapped && outputDb.getNodeIncludingRemoved(remapped)) return remapped;
      if (canonical !== id && outputDb.getNodeIncludingRemoved(canonical)) return canonical;
      return null;
    };
    let carried = 0;
    for (const row of sourceDb.getAllSupportBaselines()) {
      const decisionId = resolve(row.decision_id);
      const supportId = resolve(row.support_id);
      if (!decisionId || !supportId) continue; // an endpoint did not survive
      const mappedEdge = edgeIdRemapping.get(`${side}:${row.edge_key}`);
      // F5: a row whose edge did not survive can never anchor a live edge —
      // keeping the raw source rowid would risk colliding with a NEW output
      // rowid (the first inserted edge becomes id 1 again), which would
      // silently re-confirm a pair nobody confirmed. The "dead:" prefix
      // cannot equal any numeric rowid: the anchor stays with the dead row.
      const edgeKey =
        mappedEdge !== undefined
          ? String(mappedEdge)
          : row.edge_key.startsWith(DEAD_EDGE_KEY_PREFIX)
            ? row.edge_key
            : `${DEAD_EDGE_KEY_PREFIX}${row.edge_key}`;
      const exists = outputDb.execSqlFirst(
        `SELECT 1 FROM support_baselines
         WHERE decision_id = ? AND support_id = ? AND edge_key = ?`,
        decisionId,
        supportId,
        edgeKey
      );
      if (exists) continue; // left side already carried this pair — left first
      outputDb.upsertSupportBaseline({
        decision_id: decisionId,
        support_id: supportId,
        edge_key: edgeKey,
        claim_digest: row.claim_digest,
        status_digest: row.status_digest,
        edge_digest: row.edge_digest,
        format_version: row.format_version,
        confirmed_at: row.confirmed_at,
        confirmed_by: "import",
        superseded_at: row.superseded_at ?? null,
      });
      carried++;
    }
    return carried;
  }

  /**
   * Defer edges for a non-conflicting node into the deferred list.
   */
  private deferEdgesForNode(
    deferred: Array<{
      from_id: string; to_id: string; relation: string;
      description: string | null; created_at: string | null;
      merge_group: string | null; needs_merge: number;
      source_branch: string | null; merge_timestamp: string | null;
      removed_at: string | null;
      _originSide: "left" | "right";
      _srcEdgeIds: Array<{ side: "left" | "right"; id: number }>;
      created_via: string | null;
      accepted_at: string | null;
    }>,
    edgeMap: Map<string, EdgeRow[]>,
    nodeId: string,
    _idRemapping: Map<string, string>,
    side: "left" | "right"
  ): void {
    const edges = edgeMap.get(nodeId) ?? [];
    for (const e of edges) {
      deferred.push({
        from_id: e.from_id,
        to_id: e.to_id,
        relation: e.relation,
        description: e.description,
        created_at: e.created_at,
        merge_group: null,
        needs_merge: 0,
        source_branch: null,
        merge_timestamp: null,
        removed_at: e.removed_at ?? null,
        _originSide: side,
        _srcEdgeIds: [{ side, id: e.id }],
        created_via: e.created_via ?? "unknown",
        accepted_at: e.accepted_at ?? null,
      });
    }
  }

  /**
   * For identical nodes, defer the union of edges from both sides
   * (deduplicated). F20: when the same edge pair is tombstoned in one input
   * and live in the other, the TOMBSTONE wins — a removed link must not
   * resurrect just because the other branch still has it; restoring it is an
   * explicit `link` call.
   *
   * 2.1.2 F2: the dedup key is the SAME one the unique index enforces —
   * (from_id, to_id, relation), no description. With the old content key a
   * live copy and a tombstone of one pair looked like two different edges:
   * the second INSERT OR IGNORE was silently dropped and the surviving side
   * depended on the input order (live on the left -> live wins, live on the
   * right -> tombstone wins). Now the divergence between copies (removed_at
   * or description) is registered as a needs_merge conflict instead of being
   * settled by order; the tombstone rule applies within the single key.
   */
  private deferEdgesClean(
    deferred: Array<{
      from_id: string; to_id: string; relation: string;
      description: string | null; created_at: string | null;
      merge_group: string | null; needs_merge: number;
      source_branch: string | null; merge_timestamp: string | null;
      removed_at: string | null;
      _originSide: "left" | "right";
      _srcEdgeIds: Array<{ side: "left" | "right"; id: number }>;
      created_via: string | null;
      accepted_at: string | null;
    }>,
    leftEdgeMap: Map<string, EdgeRow[]>,
    rightEdgeMap: Map<string, EdgeRow[]>,
    nodeId: string,
    _idRemapping: Map<string, string>,
    result: MergeResult,
    now: string,
    leftLabel: string,
    rightLabel: string
  ): void {
    const leftEdges = leftEdgeMap.get(nodeId) ?? [];
    const rightEdges = rightEdgeMap.get(nodeId) ?? [];

    const byEnds = new Map<
      string,
      {
        edge: EdgeRow;
        side: "left" | "right";
        sources: Array<{ side: "left" | "right"; id: number }>;
        diverged: boolean;
      }
    >();
    const put = (e: EdgeRow, side: "left" | "right"): void => {
      const key = JSON.stringify([e.from_id, e.to_id, e.relation]);
      const prev = byEnds.get(key);
      if (!prev) {
        byEnds.set(key, { edge: e, side, sources: [{ side, id: e.id }], diverged: false });
        return;
      }
      // F5: the losing copy still maps to the winning output row — its
      // snapshot (if any) must follow the same edge, not dangle on a raw
      // source rowid.
      prev.sources.push({ side, id: e.id });
      // 2.1.2 F2: copies of one pair that disagree in removal state or
      // rationale are a conflict — flagged on the surviving row, counted in
      // the merge report, never settled by the order of the inputs.
      const removedDiffers = (prev.edge.removed_at === null) !== (e.removed_at === null);
      const descriptionDiffers = (prev.edge.description ?? "") !== (e.description ?? "");
      if (removedDiffers || descriptionDiffers) prev.diverged = true;
      // Left first, then right; a colliding live copy never overrides a tombstone.
      if (prev.edge.removed_at === null && e.removed_at !== null) {
        prev.edge = e;
        prev.side = side;
      }
    };
    for (const e of leftEdges) put(e, "left");
    for (const e of rightEdges) put(e, "right");

    for (const { edge, side, sources, diverged } of byEnds.values()) {
      if (diverged) {
        result.edgeConflicts++;
      }
      deferred.push({
        from_id: edge.from_id,
        to_id: edge.to_id,
        relation: edge.relation,
        description: edge.description,
        created_at: edge.created_at,
        merge_group: diverged ? randomUUID() : null,
        needs_merge: diverged ? 1 : 0,
        source_branch: diverged ? (side === "left" ? leftLabel : rightLabel) : null,
        merge_timestamp: diverged ? now : null,
        removed_at: edge.removed_at ?? null,
        _originSide: side,
        _srcEdgeIds: sources,
        created_via: edge.created_via ?? "unknown",
        accepted_at: edge.accepted_at ?? null,
      });
    }
  }

}
