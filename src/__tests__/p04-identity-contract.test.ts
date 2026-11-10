import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { runResolve } from "../merge-cli.js";
import { addNode, sqlState } from "./helpers/audit.js";
import { cleanupDir } from "./helpers/cleanup.js";

// Agreed P04 seam: public CLI keep-both and published SQL state.
// A fault at the second public rename boundary is deliberate failure injection.
// No native execution until stable schema handoff + coordinator slot.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-new6-p04-owned-"));
const owned: KnowledgeDB[] = [];
let serial = 0;
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of owned.splice(0)) db.close();
  (globalThis as { gc?: () => void }).gc?.();
});
afterAll(async () => {
  (globalThis as { gc?: () => void }).gc?.();
  await cleanupDir(root);
});
function database(): { db: KnowledgeDB; filename: string } {
  const filename = path.join(root, `resolve-${serial++}.db`);
  const db = new KnowledgeDB(filename); owned.push(db); ensureSchema(db);
  for (const [id, branch] of [["claim::left", "left"], ["claim::right", "right"]]) {
    db.insertNodeRaw({ id, name: "Утверждение", kind: "decision", summary: `Вариант ${branch}`,
      merge_group: "group", needs_merge: 1, source_branch: branch });
    db.setSlot(branch, "review", id);
    db.insertTrail({ id: `trail-${branch}`, name: branch, summary: "Историческая цепочка", node_ids: [id] });
    db.recordAlias(`historic-${branch}`, id);
  }
  return { db, filename };
}

describe("P04 keep-both aggregate atomicity", () => {
  it("rolls back the first complete remap and flags if the second public remap fails", async () => {
    const { db, filename } = database();
    const before = sqlState(db);
    const original = KnowledgeDB.prototype.renameNodeId;
    let calls = 0;
    vi.spyOn(KnowledgeDB.prototype, "renameNodeId").mockImplementation(function (this: KnowledgeDB, oldId, newId) {
      calls++;
      if (calls === 2) throw new Error("P04_INJECTED_SECOND_REMAP_FAILURE");
      return original.call(this, oldId, newId);
    });
    await expect(runResolve(["group", "--keep", "both", "--db", filename])).rejects.toThrow("P04_INJECTED_SECOND_REMAP_FAILURE");
    expect(calls).toBe(2);
    expect(sqlState(db)).toEqual(before);
  });
});

describe("P04 inventory scoped references", () => {
  it("remaps the v2 digest_sources envelope and module identity under public rename", () => {
    const db = new KnowledgeDB(":memory:");
    owned.push(db);
    ensureSchema(db);
    addNode(db, "old");
    addNode(db, "support");
    db.ensureDigestSourcesTable();
    db.execSqlRun(
      "INSERT INTO digest_sources(digest_id,sources,format_version) VALUES (?,?,2)",
      "old",
      JSON.stringify({ format: "digest-sources/2", module: { id: "old" }, sources: [{ node_id: "old", version: "v1" }] }),
    );
    expect(db.renameNodeId("old", "new")).toBe(true);
    const row = db.execSqlFirst("SELECT digest_id, sources FROM digest_sources") as { digest_id: string; sources: string };
    expect(row.digest_id).toBe("new");
    const parsed = JSON.parse(row.sources) as { module: { id: string }; sources: Array<{ node_id: string; version: string }> };
    expect(parsed.module.id).toBe("new");
    expect(parsed.sources).toEqual([{ node_id: "new", version: "v1" }]);
  });
});
