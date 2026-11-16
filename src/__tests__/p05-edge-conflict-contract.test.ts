import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { MergeEngine } from "../merge.js";
import { listConflicts, resolveConflict } from "../tools.js";
import { addNode, auditFixture, sqlState } from "./helpers/audit.js";
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
  it.each(["removed_at", "description", "accepted_at"] as const)("re-merge cannot refresh the CAS pin after %s changed", async column => {
    const fixture = auditFixture();
    try {
      const left = source("Первая причина опоры", null), right = source("Вторая причина опоры", null);
      new MergeEngine().merge(left, right, fixture.file("first.db"));
      const first = fixture.db("first.db");
      const conflict = listConflicts(first).conflicts[0];
      const saved = JSON.parse(conflict.edge_conflicts![0].mapping_json);
      if (column === "removed_at") first.deleteEdge("decision", "support", "informed_by");
      else first.execSqlRun(`UPDATE edges SET ${column} = ? WHERE id = ?`, "Changed after conflict creation", saved.edge.id);
      const changed = sqlState(first);
      const choice = { merge_group: conflict.merge_group, prefer: "left" as const, reason: "Choose the original live edge", resolved: { summary: "Unused for edge-only conflict" } };
      await expect(resolveConflict(first, choice)).rejects.toThrow(/version_conflict/);
      expect(sqlState(first)).toEqual(changed);
      const empty = fixture.db("empty.db"), output = fixture.db("out.db");
      addNode(output, "sentinel");
      const before = sqlState(output);
      let rejection: unknown;
      try { new MergeEngine().merge(first.dbPath, empty.dbPath, output.dbPath); }
      catch (error) { rejection = error; }
      if (rejection !== undefined) {
        expect(rejection).toBeInstanceOf(Error);
        expect((rejection as Error).message).toMatch(/version_conflict/);
        expect(sqlState(output)).toEqual(before);
      } else {
        // A carried stale conflict may remain inspectable, but selecting the
        // saved side must not resurrect the edge or replace the new rationale.
        const merged = sqlState(output);
        await expect(resolveConflict(output, choice)).rejects.toThrow(/version_conflict/);
        expect(sqlState(output)).toEqual(merged);
        expect(JSON.parse(output.getMergeConflicts(conflict.merge_group)[0].mapping_json).edge.applied).toEqual(saved.edge.applied);
      }
    } finally { await fixture.close(); }
  });

  it("unchanged conflict pins remain verbatim and resolvable after an empty re-merge", async () => {
    const fixture = auditFixture();
    try {
      new MergeEngine().merge(source("Первая причина опоры", null), source("Вторая причина опоры", null), fixture.file("first.db"));
      const first = fixture.db("first.db"), empty = fixture.db("empty.db");
      const conflict = first.getMergeConflicts()[0];
      new MergeEngine().merge(first.dbPath, empty.dbPath, fixture.file("out.db"));
      const output = fixture.db("out.db");
      expect(JSON.parse(output.getMergeConflicts()[0].mapping_json).edge.applied).toEqual(JSON.parse(conflict.mapping_json).edge.applied);
      await expect(resolveConflict(output, { merge_group: conflict.merge_group, prefer: "right", reason: "Choose verified original side", resolved: { summary: "Unused for edge-only conflict" } })).resolves.toHaveProperty("message");
      expect(output.getOutgoingEdges("decision")[0]).toMatchObject({ description: "Вторая причина опоры", needs_merge: 0 });
    } finally { await fixture.close(); }
  });

  it.each([false, true])("technical identity remaps keep the saved pin and remain resolvable (endpoints=%s)", async endpoints => {
    const fixture = auditFixture();
    try {
      new MergeEngine().merge(source("Первая причина опоры", null), source("Вторая причина опоры", null), fixture.file("first.db"));
      const first = fixture.db("first.db"), other = fixture.db("other.db"), empty = fixture.db("empty.db");
      addNode(other, "marker");
      for (const node of first.getAllNodesRaw()) {
        other.insertNodeRaw({ ...node, embedding: node.embedding instanceof ArrayBuffer ? Buffer.from(node.embedding) : node.embedding,
          summary: endpoints ? `Other wording for ${node.id}` : node.summary });
      }
      other.insertEdge({ from_id: "marker", to_id: "support", relation: "connects_to", description: "Unrelated edge gets the first rowid" });
      const conflict = first.getMergeConflicts()[0];
      const pin = JSON.parse(conflict.mapping_json).edge.applied;
      new MergeEngine().merge(other.dbPath, first.dbPath, fixture.file("mapped.db"));
      const mapped = fixture.db("mapped.db");
      const mapping = JSON.parse(mapped.getMergeConflicts()[0].mapping_json);
      if (!endpoints) expect(mapping.edge.id).not.toBe(pin.id);
      expect(mapping.sides[0]).toMatchObject({ from_id: endpoints ? "decision::right" : "decision", to_id: endpoints ? "support::right" : "support" });
      expect(mapping.edge.applied).toEqual(pin);
      new MergeEngine().merge(mapped.dbPath, empty.dbPath, fixture.file("out.db"));
      const output = fixture.db("out.db");
      expect(JSON.parse(output.getMergeConflicts()[0].mapping_json).edge.applied).toEqual(pin);
      const unchanged = fixture.db("unchanged.db"), changedOutput = fixture.db("changed.db");
      new MergeEngine().merge(output.dbPath, empty.dbPath, unchanged.dbPath);
      const unchangedMapping = JSON.parse(unchanged.getMergeConflicts()[0].mapping_json);
      unchanged.execSqlRun("UPDATE edges SET description = ? WHERE id = ?", "New rationale after multiple identity remaps", unchangedMapping.edge.id);
      const before = sqlState(changedOutput);
      let rejection: unknown;
      try { new MergeEngine().merge(unchanged.dbPath, empty.dbPath, changedOutput.dbPath); }
      catch (error) { rejection = error; }
      if (rejection !== undefined) {
        expect((rejection as Error).message).toMatch(/version_conflict/);
        expect(sqlState(changedOutput)).toEqual(before);
      } else {
        await expect(resolveConflict(changedOutput, { merge_group: conflict.merge_group, prefer: "right", reason: "Old choice must stay stale", resolved: { summary: "Unused" } })).rejects.toThrow(/version_conflict/);
      }
      await expect(resolveConflict(output, { merge_group: conflict.merge_group, prefer: "right", reason: "Only identities changed", resolved: { summary: "Unused for edge-only conflict" } })).resolves.toHaveProperty("message");
      expect(output.getOutgoingEdges(endpoints ? "decision::right" : "decision")[0]).toMatchObject({ description: "Вторая причина опоры", needs_merge: 0 });
    } finally { await fixture.close(); }
  });

  it("re-merge retains resolved conflict history without repinning it", async () => {
    const fixture = auditFixture();
    try {
      new MergeEngine().merge(source("Первая причина опоры", null), source("Вторая причина опоры", null), fixture.file("first.db"));
      const first = fixture.db("first.db"), empty = fixture.db("empty.db");
      const conflict = first.getMergeConflicts()[0];
      await resolveConflict(first, { merge_group: conflict.merge_group, prefer: "right", reason: "Verified side", resolved: { summary: "Unused for edge-only conflict" } });
      const resolved = first.getMergeConflicts(conflict.merge_group, true)[0];
      new MergeEngine().merge(first.dbPath, empty.dbPath, fixture.file("out.db"));
      const output = fixture.db("out.db");
      const carried = output.getMergeConflicts(conflict.merge_group, true)[0];
      expect(carried).toMatchObject({ state: "resolved", resolution_json: resolved.resolution_json, mapping_json: resolved.mapping_json });
      expect(listConflicts(output).conflicts).toEqual([]);
    } finally { await fixture.close(); }
  });

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
