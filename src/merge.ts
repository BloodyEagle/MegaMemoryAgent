import { randomUUID } from "crypto";
import fs from "node:fs";
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

    // S-04: output публикуется атомарно. Новый файл собирается в памяти и
    // выгружается одним VACUUM INTO — провал merge вообще не создаёт
    // outputPath. Для существующего output (--into) атомарность даёт
    // транзакция: откат оставляет файл байт-в-байт прежним.
    const existedBefore = fs.existsSync(outputPath);
    const leftDb = new KnowledgeDB(leftPath);
    const rightDb = new KnowledgeDB(rightPath);
    const outputDb = new KnowledgeDB(existedBefore ? outputPath : ":memory:");
    // Б10: the merged output must carry the fork schema (status/valid_from/
    // valid_until), otherwise lifecycle data is dropped during branch merges.
    ensureSchema(outputDb);

    try {
      const result = outputDb.runInTransaction(() => {
        // S-04: порядок записи родители-до-дети больше не нужен — проверки
        // FK отложены до COMMIT, поэтому повреждённый родитель из импорта
        // валит весь merge, а не одну вставку.
        outputDb.pragma("defer_foreign_keys = ON");
        const result = this.performMerge(leftDb, rightDb, outputDb, leftLabel, rightLabel);
        // Явная проверка даёт внятное сообщение вместо общего сбоя COMMIT.
        const violations = outputDb.pragma("foreign_key_check") as Array<unknown>;
        if (violations.length > 0) {
          throw new Error(
            `Merge rejected: the merged graph has ${violations.length} foreign key violation(s) ` +
              `(first: ${JSON.stringify(violations[0])}) — fix the source and retry. Nothing was published.`
          );
        }
        return result;
      });
      if (!existedBefore) {
        // Публикация готового снимка: VACUUM INTO вне транзакции пишет
        // полный файл целиком — частичный output невозможен, файл никем
        // не держится открытым (rename после close на Windows держит EBUSY).
        outputDb.execSqlRun("VACUUM INTO ?", outputPath);
      }
      return result;
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

    // Deferred edge operations — nodes are inserted first, then edges, so a
    // deferred edge never references a node that has not been inserted yet.
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

    // S-05: pre-existing копии едут в общий список вербатим — выбор
    // live/tombstone и версии rationale делает единая группировка при
    // вставке, «первый встретился» в дедуп-ключе больше не решает исход
    // (старый ключ без removed_at оживлял удалённое ребро).
    const deferPreexistingEdge = (
      e: EdgeRow,
      originSide: "left" | "right"
    ): void => {
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

    // ---- PASS 0: план идентичностей ДО любой записи (S-04) ----
    // Какая копия станет ::left/::right, какая останется чистой — решается
    // сразу для всех canonical id, поэтому parent_id ребёнка можно
    // перемапить на вариант своего родителя ещё до вставки, даже если
    // родитель идёт позже ребёнка в порядке входов.

    type NodeDecision =
      | { kind: "only"; row: NodeRow; side: "left" | "right"; finalId: string }
      | { kind: "identical"; row: NodeRow; finalId: string }
      | { kind: "conflict"; left: NodeRow; right: NodeRow; mergeGroup: string }
      | { kind: "preexisting"; rows: Array<{ row: NodeRow; side: "left" | "right" }> };

    const decisions = new Map<string, NodeDecision>();
    const conflictIds = new Set<string>();
    const idRemapping = new Map<string, string>(); // "side:canonicalId" → suffixedId

    for (const id of allIds) {
      const leftVariants = leftVariantsByCanonical.get(id) ?? [];
      const rightVariants = rightVariantsByCanonical.get(id) ?? [];
      const leftNode = leftNodeMap.get(id);
      const rightNode = rightNodeMap.get(id);

      // Pre-existing conflicts (nodes already carry ::left/::right from a prior merge).
      const preexistingLeft = leftVariants.filter(
        (n) => n.needs_merge === 1 && !!n.merge_group && hasMergeSuffix(n.id)
      );
      const preexistingRight = rightVariants.filter(
        (n) => n.needs_merge === 1 && !!n.merge_group && hasMergeSuffix(n.id)
      );

      if (preexistingLeft.length > 0 || preexistingRight.length > 0) {
        // Все неразрешённые копии едут как есть. Первая сторона выигрывает id
        // при вставке, но в решении остаются ВСЕ копии — рёбра каждой должны
        // переехать, иначе tombstone одной стороны потеряется (S-05).
        decisions.set(id, {
          kind: "preexisting",
          rows: [
            ...preexistingLeft.map((row) => ({ row, side: "left" as const })),
            ...preexistingRight.map((row) => ({ row, side: "right" as const })),
          ],
        });

        // Clean nodes remap onto a valid conflicted target.
        const preexistingAll = [...preexistingLeft, ...preexistingRight];
        const leftTarget =
          preexistingAll.find((n) => n.id.endsWith(MERGE_SUFFIX_LEFT)) ??
          preexistingAll[0];
        const rightTarget =
          preexistingAll.find((n) => n.id.endsWith(MERGE_SUFFIX_RIGHT)) ??
          preexistingAll[preexistingAll.length - 1] ??
          preexistingAll[0];

        if (leftTarget) idRemapping.set(`left:${id}`, leftTarget.id);
        if (rightTarget) idRemapping.set(`right:${id}`, rightTarget.id);

        conflictIds.add(id);
        continue;
      }

      if (!leftNode && rightNode) {
        decisions.set(id, { kind: "only", row: rightNode, side: "right", finalId: id });
        if (rightNode.removed_at) result.removedClean++;
        else result.clean++;
      } else if (leftNode && !rightNode) {
        decisions.set(id, { kind: "only", row: leftNode, side: "left", finalId: id });
        if (leftNode.removed_at) result.removedClean++;
        else result.clean++;
      } else if (leftNode && rightNode) {
        if (nodesAreIdentical(leftNode, rightNode)) {
          // Identical — left's copy is the keeper.
          decisions.set(id, { kind: "identical", row: leftNode, finalId: id });
          if (leftNode.removed_at) result.removedClean++;
          else result.clean++;
        } else {
          // Conflict — both copies with suffixed ids and a fresh group.
          const mergeGroup = randomUUID();
          result.mergeGroups.push(mergeGroup);
          result.conceptConflicts++;
          conflictIds.add(id);
          idRemapping.set(`left:${id}`, `${id}${MERGE_SUFFIX_LEFT}`);
          idRemapping.set(`right:${id}`, `${id}${MERGE_SUFFIX_RIGHT}`);
          decisions.set(id, { kind: "conflict", left: leftNode, right: rightNode, mergeGroup });
        }
      }
    }

    // ---- PASS 0b: финальные строки — parent_id перемаплен на вариант своей стороны ----
    const remapParent = (
      parentId: string | null,
      side: "left" | "right"
    ): string | null => {
      if (!parentId) return null;
      const canonical = stripMergeSuffix(parentId);
      if (!conflictIds.has(canonical)) return parentId;
      return (
        idRemapping.get(`${side}:${canonical}`) ??
        idRemapping.get(`${side === "left" ? "right" : "left"}:${canonical}`) ??
        parentId
      );
    };

    const insertedNodeIds = new Set<string>();
    const insertPlanned = (row: NodeRow): void => {
      if (insertedNodeIds.has(row.id)) return;
      this.insertNodeAsIs(outputDb, row);
      insertedNodeIds.add(row.id);
    };

    for (const [id, d] of decisions) {
      if (d.kind === "only") {
        insertPlanned({ ...d.row, id: d.finalId, parent_id: remapParent(d.row.parent_id, d.side) });
      } else if (d.kind === "identical") {
        insertPlanned({ ...d.row, id: d.finalId, parent_id: remapParent(d.row.parent_id, "left") });
      } else if (d.kind === "conflict") {
        this.insertConflictNode(
          outputDb,
          { ...d.left, parent_id: remapParent(d.left.parent_id, "left") },
          `${id}${MERGE_SUFFIX_LEFT}`,
          d.mergeGroup,
          leftLabel,
          now
        );
        insertedNodeIds.add(`${id}${MERGE_SUFFIX_LEFT}`);
        this.insertConflictNode(
          outputDb,
          { ...d.right, parent_id: remapParent(d.right.parent_id, "right") },
          `${id}${MERGE_SUFFIX_RIGHT}`,
          d.mergeGroup,
          rightLabel,
          now
        );
        insertedNodeIds.add(`${id}${MERGE_SUFFIX_RIGHT}`);
      } else {
        for (const { row, side } of d.rows) {
          insertPlanned({ ...row, parent_id: remapParent(row.parent_id, side) });
        }
      }
    }

    // ---- Отложенные рёбра конфликтных и pre-existing веток ----
    for (const [id, d] of decisions) {
      if (d.kind === "conflict") {
        const leftNodeEdges = leftEdgeMap.get(id) ?? [];
        const rightNodeEdges = rightEdgeMap.get(id) ?? [];
        const edgesConflict = !edgeSetsAreIdentical(leftNodeEdges, rightNodeEdges);

        if (edgesConflict && (leftNodeEdges.length > 0 || rightNodeEdges.length > 0)) {
          result.edgeConflicts++;
        }

        for (const e of leftNodeEdges) {
          deferredEdges.push({
            from_id: `${id}${MERGE_SUFFIX_LEFT}`,
            to_id: e.to_id, // will be remapped in pass 2
            relation: e.relation,
            description: e.description,
            created_at: e.created_at,
            merge_group: edgesConflict ? d.mergeGroup : null,
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
            from_id: `${id}${MERGE_SUFFIX_RIGHT}`,
            to_id: e.to_id, // will be remapped in pass 2
            relation: e.relation,
            description: e.description,
            created_at: e.created_at,
            merge_group: edgesConflict ? d.mergeGroup : null,
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
      } else if (d.kind === "preexisting") {
        for (const { row, side } of d.rows) {
          const edges = (side === "left" ? leftEdgeMap : rightEdgeMap).get(row.id) ?? [];
          for (const e of edges) {
            deferPreexistingEdge(e, side);
          }
        }
      }
    }

    // ---- PASS 2: Insert all edges ----

    // Collect the edges of non-conflict nodes verbatim — копии с обеих сторон
    // идут в общий список, политика выбора применяется в проходе вставки
    // (единая для обычных, конфликтных и pre-existing веток).
    for (const id of allIds) {
      if (conflictIds.has(id)) continue; // handled via deferred edges

      const leftNode = leftNodeMap.get(id);
      const rightNode = rightNodeMap.get(id);

      if (!leftNode && rightNode) {
        this.deferEdgesForNode(deferredEdges, rightEdgeMap, rightNode.id, idRemapping, "right");
      } else if (leftNode && !rightNode) {
        this.deferEdgesForNode(deferredEdges, leftEdgeMap, leftNode.id, idRemapping, "left");
      } else if (leftNode && rightNode) {
        // Identical nodes — edges of both sides travel; the unified grouping
        // below merges the copies by their final ends.
        this.deferEdgesForNode(deferredEdges, leftEdgeMap, leftNode.id, idRemapping, "left");
        this.deferEdgesForNode(deferredEdges, rightEdgeMap, rightNode.id, idRemapping, "right");
      }
    }

    // Now insert all deferred edges. S-05/F20: копии одного логического ребра
    // группируются ПО КОНЕЧНЫМ точкам уже после ремапа — «первый встретился»
    // больше не политика ни в одной ветке:
    //   - надгробие всегда бьёт живую копию, независимо от порядка входов
    //     (удалённая ссылка не воскрешается повторным merge);
    //   - расхождение копий (removed_at или rationale) — конфликт на
    //     выжившей строке (needs_merge), а не тихое замещение;
    //   - при одинаковом состоянии остаётся первая копия (левые входы
    //     раньше правых — детерминировано, содержимое совпадает).
    // F5: every source rowid maps to the output rowid it became — by
    // identity, never by ends — so the snapshot carry (§7) re-anchors each
    // baseline to ITS edge.
    type EdgeGroup = { copies: DeferredEdge[]; remappedToId: string };
    const edgeGroups = new Map<string, EdgeGroup>();
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

      const endsKey = JSON.stringify([edge.from_id, remappedToId, edge.relation]);
      let group = edgeGroups.get(endsKey);
      if (!group) {
        group = { copies: [], remappedToId };
        edgeGroups.set(endsKey, group);
      }
      group.copies.push(edge);
    }

    const outEdgeIdByEnds = new Map<string, number>();
    const edgeIdRemapping = new Map<string, number>(); // "side:srcEdgeId" → output rowid
    for (const [endsKey, group] of edgeGroups) {
      const isRemoved = (e: DeferredEdge) => e.removed_at !== null;
      let winner = group.copies[0];
      for (const copy of group.copies) {
        if (winner.removed_at === null && copy.removed_at !== null) {
          winner = copy;
          break;
        }
      }
      let diverged = false;
      const firstRemoved = isRemoved(group.copies[0]);
      const firstDescription = group.copies[0].description ?? "";
      for (const copy of group.copies) {
        if (isRemoved(copy) !== firstRemoved || (copy.description ?? "") !== firstDescription) {
          diverged = true;
          break;
        }
      }

      let mergeGroup = winner.merge_group;
      let needsMerge = winner.needs_merge;
      let sourceBranch = winner.source_branch;
      let mergeTimestamp = winner.merge_timestamp;
      if (diverged) {
        result.edgeConflicts++;
        mergeGroup = randomUUID();
        needsMerge = 1;
        sourceBranch = winner._originSide === "left" ? leftLabel : rightLabel;
        mergeTimestamp = now;
      }

      const res = outputDb.insertEdgeRaw({
        from_id: winner.from_id,
        to_id: group.remappedToId,
        relation: winner.relation,
        description: winner.description,
        created_at: winner.created_at,
        merge_group: mergeGroup,
        needs_merge: needsMerge,
        source_branch: sourceBranch,
        merge_timestamp: mergeTimestamp,
        removed_at: winner.removed_at,
        created_via: winner.created_via,
        accepted_at: winner.accepted_at,
      });
      // INSERT OR IGNORE: единственная вставка на группу; срабатывает только
      // когда пара уже была в существующем --into output. Source rowid,
      // отброшенный выше (мёртвое живое ребро), не мапится никуда: его
      // снимок честно остаётся со своим source edge_key («removed»).
      let outId = res.id;
      if (!res.inserted) {
        const existing = outEdgeIdByEnds.get(endsKey);
        if (existing === undefined) {
          throw new Error(
            `Merge error: ignored insert of ${winner.from_id} -> ${group.remappedToId} ` +
              `(${winner.relation}) has no earlier output row.`
          );
        }
        outId = existing;
      }
      outEdgeIdByEnds.set(endsKey, outId);
      for (const copy of group.copies) {
        for (const src of copy._srcEdgeIds) {
          edgeIdRemapping.set(`${src.side}:${src.id}`, outId);
        }
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

    // ---- F-02 (S-03): перенос workflow-состояния ----
    // Задачи (колонки узлов — выше), слоты, сохранённые цепочки с
    // отпечатками, артефакты, история статусов, алиасы. Left первым, right
    // заполняет только отсутствующее; расхождение содержимого — в отчёт
    // (workflowConflicts), молчаливого удаления нет. Телеметрия
    // (timeline/usage) не переносится: журнал операций не знание.
    const workflowLeft = this.carryWorkflowTables(leftDb, outputDb, "left", idRemapping);
    const workflowRight = this.carryWorkflowTables(rightDb, outputDb, "right", idRemapping);
    if (workflowLeft.carried + workflowRight.carried > 0) {
      result.workflowCarried = workflowLeft.carried + workflowRight.carried;
    }
    if (workflowLeft.conflicts + workflowRight.conflicts > 0) {
      result.workflowConflicts = workflowLeft.conflicts + workflowRight.conflicts;
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
      // 2.1.10 (v12): the origin travels with the row (undefined on sources
      // without the column — honestly unknown, never incriminating).
      created_via: node.created_via ?? null,
      // F-02 (S-03): задача с дедлайном остаётся задачей с дедлайном.
      task_state: node.task_state ?? null,
      due_at: node.due_at ?? null,
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
      // 2.1.10 (v12): a NEW row written by the MergeEngine itself — the
      // conflict copy is an import product, not an agent node.
      created_via: "import",
      // F-02 (S-03): состояние задачи каждого варианта едет со своей копией.
      task_state: node.task_state ?? null,
      due_at: node.due_at ?? null,
    });
  }

  /**
   * F-02 (план 03, S-03): перенос workflow-таблиц — слоты, сохранённые
   * цепочки с отпечатками участников, артефакты, история статусов, алиасы.
   * Merge непустой базы с пустой больше не теряет исполнителя роли,
   * участников цепочки и дедлайн.
   *
   * Политика для каждого сгустка детерминирована: left первым, right
   * заполняет только отсутствующее (PK уже занят — строка не трогается);
   * расхождение содержимого считается конфликтом и попадает в отчёт
   * (workflowConflicts), молчаливого удаления нет. node_id перемапливается
   * на вариант своей стороны; отпечатки участников и временные метки едут
   * вербатим — «перенести знание» не значит «переподтвердить его».
   * Телеметрия (timeline, usage) не переносится: это журнал операций,
   * а не знание.
   */
  private carryWorkflowTables(
    sourceDb: KnowledgeDB,
    outputDb: KnowledgeDB,
    side: "left" | "right",
    idRemapping: Map<string, string>
  ): { carried: number; conflicts: number } {
    let carried = 0;
    let conflicts = 0;

    const hasTable = (name: string): boolean =>
      sourceDb.execSqlFirst(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        name
      ) !== undefined;

    const resolveNodeId = (id: string): string => {
      if (outputDb.getNodeIncludingRemoved(id)) return id;
      const remapped = idRemapping.get(`${side}:${stripMergeSuffix(id)}`);
      return remapped ?? id;
    };

    // Слоты: (project, role) → node_id.
    if (hasTable("slots")) {
      const rows = sourceDb.execSqlAll(
        "SELECT project, role, node_id, updated_at FROM slots"
      ) as Array<{ project: string; role: string; node_id: string; updated_at: string }>;
      for (const row of rows) {
        const nodeId = resolveNodeId(row.node_id);
        const existing = outputDb.execSqlFirst(
          "SELECT node_id FROM slots WHERE project = ? AND role = ?",
          row.project,
          row.role
        ) as { node_id: string } | undefined;
        if (existing) {
          if (existing.node_id !== nodeId) conflicts++;
          continue;
        }
        outputDb.execSqlRun(
          "INSERT INTO slots (project, role, node_id, updated_at) VALUES (?, ?, ?, ?)",
          row.project,
          row.role,
          nodeId,
          row.updated_at
        );
        carried++;
      }
    }

    // Цепочки и участники: отпечатки остаются как сохранены.
    if (hasTable("trails")) {
      const trails = sourceDb.execSqlAll(
        "SELECT id, name, summary, stale, created_at, updated_at FROM trails"
      ) as Array<{
        id: string; name: string; summary: string; stale: number;
        created_at: string; updated_at: string | null;
      }>;
      for (const t of trails) {
        const existing = outputDb.execSqlFirst(
          "SELECT name, summary, stale FROM trails WHERE id = ?",
          t.id
        ) as { name: string; summary: string; stale: number } | undefined;
        if (existing) {
          if (existing.name !== t.name || existing.summary !== t.summary || existing.stale !== t.stale) {
            conflicts++;
          }
          continue;
        }
        outputDb.execSqlRun(
          "INSERT INTO trails (id, name, summary, stale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          t.id,
          t.name,
          t.summary,
          t.stale,
          t.created_at,
          t.updated_at
        );
        carried++;
      }
    }
    if (hasTable("trail_members")) {
      const members = sourceDb.execSqlAll(
        "SELECT trail_id, position, node_id, fingerprint FROM trail_members"
      ) as Array<{ trail_id: string; position: number; node_id: string; fingerprint: string }>;
      for (const m of members) {
        const nodeId = resolveNodeId(m.node_id);
        const existing = outputDb.execSqlFirst(
          "SELECT node_id, fingerprint FROM trail_members WHERE trail_id = ? AND position = ?",
          m.trail_id,
          m.position
        ) as { node_id: string; fingerprint: string } | undefined;
        if (existing) {
          if (existing.node_id !== nodeId || existing.fingerprint !== m.fingerprint) conflicts++;
          continue;
        }
        outputDb.execSqlRun(
          "INSERT INTO trail_members (trail_id, position, node_id, fingerprint) VALUES (?, ?, ?, ?)",
          m.trail_id,
          m.position,
          nodeId,
          m.fingerprint
        );
        carried++;
      }
    }

    // Артефакты: наблюдения внешних источников едут со своей нодой.
    if (hasTable("node_artifacts")) {
      const rows = sourceDb.execSqlAll("SELECT * FROM node_artifacts") as Array<Record<string, unknown>>;
      for (const row of rows) {
        const nodeId = resolveNodeId(String(row.node_id));
        const existing = outputDb.execSqlFirst(
          "SELECT 1 FROM node_artifacts WHERE node_id = ? AND kind = ? AND ref = ?",
          nodeId,
          String(row.kind),
          String(row.ref)
        );
        if (existing) {
          if ((row.digest ?? null) !== ((existing as { digest?: unknown }).digest ?? null)) conflicts++;
          continue;
        }
        outputDb.execSqlRun(
          `INSERT INTO node_artifacts (node_id, kind, ref, digest, prev_digest, size_bytes, checked_at, changed_at, checked_by, repo_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          nodeId,
          row.kind ?? null,
          row.ref ?? null,
          row.digest ?? null,
          row.prev_digest ?? null,
          row.size_bytes ?? null,
          row.checked_at ?? null,
          row.changed_at ?? null,
          row.checked_by ?? null,
          row.repo_path ?? null
        );
        carried++;
      }
    }

    // История статусов: один и тот же переход на обеих сторонах не дублируется.
    if (hasTable("status_history")) {
      const historyHasField = (sourceDb.pragma("table_info(status_history)") as Array<{ name: string }>)
        .some((c) => c.name === "field");
      const rows = sourceDb.execSqlAll(
        historyHasField
          ? "SELECT node_id, from_status, to_status, reason, field, at FROM status_history"
          : "SELECT node_id, from_status, to_status, reason, at FROM status_history"
      ) as Array<Record<string, unknown>>;
      const seen = new Set<string>();
      for (const row of rows) {
        const nodeId = resolveNodeId(String(row.node_id));
        const field = historyHasField ? String(row.field ?? "status") : "status";
        const key = JSON.stringify([nodeId, row.from_status, row.to_status, row.reason, field, row.at]);
        if (seen.has(key)) continue;
        seen.add(key);
        const duplicate = outputDb.execSqlFirst(
          "SELECT 1 FROM status_history WHERE node_id = ? AND from_status IS ? AND to_status = ? AND reason IS ? AND field = ? AND at = ?",
          nodeId,
          row.from_status ?? null,
          row.to_status,
          row.reason ?? null,
          field,
          row.at
        );
        if (duplicate) continue;
        outputDb.execSqlRun(
          "INSERT INTO status_history (node_id, from_status, to_status, reason, field, at) VALUES (?, ?, ?, ?, ?, ?)",
          nodeId,
          row.from_status ?? null,
          row.to_status,
          row.reason ?? null,
          field,
          row.at
        );
        carried++;
      }
    }

    // Алиасы: новый id перемапливается, старый остаётся разрешимым.
    if (hasTable("aliases")) {
      const rows = sourceDb.execSqlAll(
        "SELECT old_id, new_id, renamed_at FROM aliases"
      ) as Array<{ old_id: string; new_id: string; renamed_at: string }>;
      for (const row of rows) {
        const newId = resolveNodeId(row.new_id);
        const existing = outputDb.execSqlFirst(
          "SELECT new_id FROM aliases WHERE old_id = ?",
          row.old_id
        ) as { new_id: string } | undefined;
        if (existing) {
          if (existing.new_id !== newId) conflicts++;
          continue;
        }
        outputDb.execSqlRun(
          "INSERT INTO aliases (old_id, new_id, renamed_at) VALUES (?, ?, ?)",
          row.old_id,
          newId,
          row.renamed_at
        );
        carried++;
      }
    }

    return { carried, conflicts };
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
        // 2.1.3 F2: the confirmed artifacts state travels verbatim — a remap
        // must not re-observe the artifacts (the import never checks files).
        artifacts_digest: row.artifacts_digest ?? null,
      });
      // 2.1.3 F1: the journal is written where the snapshot is written — the
      // merge carry journals the carried version as an import entry. When the
      // edge was re-anchored (its rowid changed through the remap) the entry
      // says edge_relinked, otherwise the edge identity traveled verbatim.
      // ISO recorded_at: the journal orders and purges by it.
      outputDb.insertSupportRevision({
        decision_id: decisionId,
        support_id: supportId,
        edge_key: edgeKey,
        claim_digest: row.claim_digest,
        status_digest: row.status_digest,
        edge_digest: row.edge_digest,
        format_version: row.format_version,
        confirmed_at: row.confirmed_at,
        recorded_at: new Date().toISOString(),
        source: "import",
        reason:
          mappedEdge !== undefined && String(mappedEdge) !== row.edge_key
            ? "edge_relinked"
            : null,
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

}
