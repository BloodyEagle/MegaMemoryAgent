import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { listConflicts, resolveConflict } from "../tools.js";

// Agreed P05 seam: existing public resolveConflict, explicit edge-only prefer.
// Seed the approved DB writer; no synthetic DDL and no embedding/model work.
const owned: KnowledgeDB[] = [];
afterEach(() => {
  for (const db of owned.splice(0)) db.close();
  (globalThis as { gc?: () => void }).gc?.();
});

describe("P05 public edge-only explicit resolution", () => {
  it("selects the requested original side atomically and retains both full historical payloads", async () => {
    const db = new KnowledgeDB(":memory:"); owned.push(db); ensureSchema(db);
    for (const id of ["decision", "support"]) db.insertNode({ id, name: id, kind: "decision", summary: "Общее утверждение" });
    const inserted = db.insertEdgeRaw({ from_id: "decision", to_id: "support", relation: "informed_by",
      description: "Правая причина", removed_at: "2026-03-01", created_via: "agent",
      accepted_at: "2026-02-01", merge_group: "edge-group", needs_merge: 1 });
    const applied = db.getEdgeById(inserted.id)!;
    const left = { ...applied, id: 19, description: "Левая причина", removed_at: null,
      merge_group: null, needs_merge: 0, source_branch: "left-history" };
    const right = { ...applied, id: 29, merge_group: null, needs_merge: 0, source_branch: "right-history" };
    const envelope = (side: string, row: unknown) => JSON.stringify({ format: "megamemory-conflict/1",
      origin: { side }, object_kind: "edge", object_key: '["decision","support","informed_by"]',
      rows: [row], related_history: { support_baselines: [], support_revisions: [] }, qualification: { confirmed: false } });
    const leftPayload = envelope("left", left), rightPayload = envelope("right", right);
    const id = db.insertMergeConflict({ merge_group: "edge-group", object_kind: "edge",
      object_key: '["decision","support","informed_by"]', format_version: 1,
      left_payload: leftPayload, right_payload: rightPayload,
      mapping_json: JSON.stringify({ format: "megamemory-conflict-map/1", edge: { id: inserted.id, applied },
        sides: [{ side: "left", from_id: "decision", to_id: "support", edge_ids: [{ side: "left", id: 19 }] },
          { side: "right", from_id: "decision", to_id: "support", edge_ids: [{ side: "right", id: 29 }] }] }) });
    expect(listConflicts(db).conflicts[0].edge_conflicts).toHaveLength(1);
    await resolveConflict(db, { merge_group: "edge-group", prefer: "left", resolved: { summary: "Edge-only selection" }, reason: "Явный выбор левой причины" });
    expect(db.getEdgeById(inserted.id)).toMatchObject({ description: "Левая причина", removed_at: null,
      accepted_at: "2026-02-01", created_via: "agent", needs_merge: 0, merge_group: null, source_branch: "left-history" });
    expect(listConflicts(db).conflicts).toEqual([]);
    expect(db.getMergeConflicts("edge-group", true)).toEqual([expect.objectContaining({ id,
      state: "resolved", left_payload: leftPayload, right_payload: rightPayload,
      resolution_json: expect.stringContaining("Явный выбор левой причины") })]);
  });
});
