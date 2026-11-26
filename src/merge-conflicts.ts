// План 38 T3: перенесены дословно из merge.ts (те же тела, те же публичные
// имена). Модуль без рантайм-зависимостей — только type-импорты: цикл из
// tools→merge не переезжает сюда, merge.ts реэкспортит имена для
// merge-cli.ts и внешних потребителей.
import type { KnowledgeDB } from "./db.js";
import type { EdgeRow } from "./types.js";

export const MERGE_SUFFIX_LEFT = "::left";
export const MERGE_SUFFIX_RIGHT = "::right";

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

// The saved applied row is immutable content evidence. A technical carry may
// change only its address: compare identities through the mapping, never by
// replacing the pin with a new observation of the edge.
export function conflictEdgeMatches(
  current: EdgeRow | undefined,
  mapping: { edge: { id: number; applied: Record<string, unknown> }; sides: Array<{ from_id: string; to_id: string }> }
): boolean {
  const applied = mapping.edge?.applied;
  const address = mapping.sides?.[0];
  if (!current || !applied || typeof applied !== "object" || Array.isArray(applied) || !address) return false;
  const expected = { ...applied, id: mapping.edge.id, from_id: address.from_id, to_id: address.to_id };
  const snapshotKeys = Object.keys(applied).filter(key => key !== "_metadata");
  return !snapshotKeys.some(key => (current as unknown as Record<string, unknown>)[key] !== (expected as Record<string, unknown>)[key]) &&
    !Object.keys(current).some(key => key !== "_metadata" && !snapshotKeys.includes(key));
}

export function resolveEdgeConflicts(
  db: KnowledgeDB,
  input: { merge_group: string; prefer: "left" | "right"; reason: string }
): { message: string } {
  return db.runInTransaction(() => {
    const conflicts = db.getMergeConflicts(input.merge_group);
    if (conflicts.length === 0 || conflicts.some(row => row.object_kind !== "edge" || row.format_version !== 1)) {
      throw new Error("Unsupported or missing edge conflict group; nothing was written.");
    }
    for (const conflict of conflicts) {
      const mapping = JSON.parse(conflict.mapping_json);
      const side = JSON.parse(input.prefer === "left" ? conflict.left_payload : conflict.right_payload);
      if (mapping.format !== "megamemory-conflict-map/1" || side.format !== "megamemory-conflict/1" || side.rows?.length !== 1) {
        throw new Error("Unsupported edge conflict payload; nothing was written.");
      }
      const current = db.getEdgeById(mapping.edge.id);
      if (!current || !conflictEdgeMatches(current, mapping)) {
        throw new Error("version_conflict: the conflict edge changed; nothing was written.");
      }
      const address = mapping.sides[input.prefer === "left" ? 0 : 1];
      const selected: EdgeRow = side.rows[0];
      if (!address || !db.getNodeIncludingRemoved(address.from_id) || !db.getNodeIncludingRemoved(address.to_id)) {
        throw new Error("Missing mapped conflict endpoints; nothing was written.");
      }
      db.execSqlRun(
        `UPDATE edges SET from_id=?,to_id=?,relation=?,description=?,created_at=?,merge_group=?,needs_merge=?,source_branch=?,merge_timestamp=?,removed_at=?,created_via=?,accepted_at=? WHERE id=?`,
        address.from_id, address.to_id, selected.relation, selected.description, selected.created_at,
        selected.merge_group, selected.needs_merge, selected.source_branch, selected.merge_timestamp,
        selected.removed_at ?? null, selected.created_via ?? "unknown", selected.accepted_at ?? null, current.id
      );
      if (!db.markMergeConflictResolved(conflict.id, { prefer: input.prefer, reason: input.reason, edge_id: current.id })) {
        throw new Error("version_conflict: the conflict was already resolved; nothing was written.");
      }
    }
    if (db.informedByCycleComponents().length > 0) throw new Error("Resolution would leave an informed_by cycle; nothing was written.");
    return { message: `Resolved edge conflicts in "${input.merge_group}". Reason: ${input.reason}` };
  });
}
