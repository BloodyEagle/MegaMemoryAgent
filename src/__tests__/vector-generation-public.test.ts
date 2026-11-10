import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { reembed } from "../reembed.js";
import { hybridSearch } from "../search.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("P10_MODEL_DOWNLOAD_FORBIDDEN"); }),
}));

let db: KnowledgeDB | undefined;
let dir: string | undefined;
const vector = (...values: number[]) => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  return bytes;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  const owned = db;
  db = undefined;
  owned?.close();
  if (!dir) return;
  const staleDir = dir;
  for (let i = 0; i < 40; i++) {
    (globalThis as { gc?: () => void }).gc?.();
    try { fs.rmSync(staleDir, { recursive: true, force: true }); dir = undefined; return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`P10_OWNED_CLEANUP_FAILED ${dir}`);
});

describe("P10 public reembed A-01", () => {
  it("same-dimension switch with second-row failure must not retain old native vectors", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p10-old-public-"));
    db = new KnowledgeDB(path.join(dir, "owned.db"));
    for (const id of ["first", "second"]) db.insertNode({ id, name: id, kind: "feature", summary: "indexing text" });
    db.setMetaValue("embed_model", "p10-old-space");
    db.setMetaValue("embed_dim", "2");
    const old = vector(1, 0);
    db.execSqlRun("UPDATE nodes SET embedding = @embedding", { embedding: old });
    db.upsertVector("first", old);
    db.upsertVector("second", old);
    expect(db.vectorSupportOk()).toBe(true);
    expect(db.vectorTableCount()).toBe(2);
    let calls = 0;
    await expect(reembed(db, { embedFn: async () => {
      if (++calls === 2) throw new Error("P10_SECOND_EMBED_FAILURE");
      return vector(0, 1);
    } })).rejects.toThrow("P10_SECOND_EMBED_FAILURE");
    expect(db.getNode("second")?.embedding).toBeNull();
    vi.stubEnv("MEGAMEMORY_SEARCH", "vector");
    const hits = await hybridSearch(db, "no text match", { embedFn: async () => vector(0, 1) });
    expect(hits.map((hit) => hit.id)).toEqual(["first"]);
    expect(db.execSqlAll("SELECT id FROM nodes_vec ORDER BY id")).toEqual([{ id: "first" }]);
  });
});
