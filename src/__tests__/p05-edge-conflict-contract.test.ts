import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { MergeEngine } from "../merge.js";
import { listConflicts } from "../tools.js";
import { runConflicts } from "../merge-cli.js";
import { vi } from "vitest";
import { cleanupDir } from "./helpers/cleanup.js";

// Agreed P05 seams: MergeEngine.merge + public listConflicts full edge DTO.
// Newly owned TEMP only; no native run before explicit coordinator grant.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-new6-p05-owned-"));
let serial = 0;
afterEach(() => { (globalThis as { gc?: () => void }).gc?.(); });
afterAll(async () => {
  (globalThis as { gc?: () => void }).gc?.();
  await cleanupDir(root);
});
function source(description: string, removed_at: string | null): string {
  const filename = path.join(root, `input-${serial++}.db`);
  const db = new KnowledgeDB(filename);
  try {
    ensureSchema(db);
    for (const id of ["decision", "support"]) {
      db.insertNodeRaw({ id, name: id, kind: "decision", summary: "Общее утверждение" });
    }
    db.insertEdgeRaw({ from_id: "decision", to_id: "support", relation: "informed_by",
      description, removed_at, created_at: "2026-01-01 00:00:00", created_via: "agent",
      accepted_at: "2026-02-01 00:00:00", merge_timestamp: "2026-02-02 00:00:00",
      source_branch: "original", merge_group: null, needs_merge: 0 });
  } finally { db.close(); }
  return filename;
}
function inspect<T>(filename: string, reader: (db: KnowledgeDB) => T): T {
  const db = new KnowledgeDB(filename, { readonly: true });
  try { return reader(db); } finally { db.close(); }
}

describe("P05 full edge-only conflicts", () => {
  it("lists the same edge-only full conflict through the public CLI JSON command", async () => {
    const left = source("Первая причина опоры", null), right = source("Вторая причина опоры", null);
    const output = path.join(root, `output-${serial++}.db`);
    new MergeEngine().merge(left, right, output);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runConflicts(["--db", output, "--json"]);
      const result = JSON.parse(String(log.mock.calls[0][0]));
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].versions).toEqual([]);
      expect(result.conflicts[0].edge_conflicts).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  it("keeps unresolved full payload and group through a merge with an empty source", () => {
    const left = source("Первая причина опоры", null);
    const right = source("Вторая причина опоры", "2026-03-01 00:00:00");
    const first = path.join(root, `output-${serial++}.db`);
    new MergeEngine().merge(left, right, first);
    const before = inspect(first, db => listConflicts(db).conflicts[0]);
    const empty = path.join(root, `empty-${serial++}.db`);
    const emptyDb = new KnowledgeDB(empty); emptyDb.close();
    const repeated = path.join(root, `output-${serial++}.db`);
    new MergeEngine().merge(first, empty, repeated);
    const after = inspect(repeated, db => listConflicts(db).conflicts[0]);
    expect(after?.merge_group).toBe(before.merge_group);
    expect(after?.edge_conflicts).toEqual([expect.objectContaining({ state: "unresolved",
      left_payload: before.edge_conflicts![0].left_payload,
      right_payload: before.edge_conflicts![0].right_payload })]);
  });

  it("publishes both full rationale/tombstone payloads through public list without inventing a conflict node", () => {
    const left = source("Первая причина опоры", null);
    const right = source("Вторая причина опоры", "2026-03-01 00:00:00");
    const output = path.join(root, `output-${serial++}.db`);
    new MergeEngine().merge(left, right, output);
    const groups = inspect(output, db => listConflicts(db).conflicts);
    expect(groups).toHaveLength(1);
    expect(groups[0].versions).toEqual([]);
    expect(groups[0].edge_conflicts).toHaveLength(1);
    const conflict = groups[0].edge_conflicts![0];
    expect(conflict.state).toBe("unresolved");
    expect(conflict.object_kind).toBe("edge");
    const sides = [JSON.parse(conflict.left_payload), JSON.parse(conflict.right_payload)];
    expect(sides.map(side => side.format)).toEqual(["megamemory-conflict/1", "megamemory-conflict/1"]);
    expect(sides.map(side => side.rows[0].description)).toEqual(["Первая причина опоры", "Вторая причина опоры"]);
    expect(sides.map(side => side.rows[0].removed_at)).toEqual([null, "2026-03-01 00:00:00"]);
    for (const side of sides) {
      expect(side.rows[0]).toMatchObject({ id: 1, from_id: "decision", to_id: "support",
        created_via: "agent", accepted_at: "2026-02-01 00:00:00",
        created_at: "2026-01-01 00:00:00", source_branch: "original",
        merge_timestamp: "2026-02-02 00:00:00", merge_group: null, needs_merge: 0 });
    }
  });
});
