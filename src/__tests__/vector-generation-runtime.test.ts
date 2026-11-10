import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB, type VectorGeneration } from "../db.js";
import { reembed } from "../reembed.js";
import { hybridSearch } from "../search.js";
import { MODEL_NAME, embedForStorage, embeddingProfile, vectorSearchEnabled } from "../embeddings.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("P10_MODEL_DOWNLOAD_FORBIDDEN"); }),
}));

let db: KnowledgeDB | undefined;
let dir: string | undefined;
const profile = process.env.USERPROFILE ?? os.tmpdir();
const managedCleanup = path.basename(profile).startsWith("mm-new6-owned-");
const deferredCleanup = new Set<string>();
const vector = (...values: number[]) => {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
  return buffer;
};
function fresh(ids = ["first", "second"]) {
  dir = fs.mkdtempSync(path.join(managedCleanup ? profile : os.tmpdir(), "mm-p10-generation-"));
  db = new KnowledgeDB(path.join(dir, "owned.db"));
  for (const id of ids) db.insertNode({ id, name: id, kind: "feature", summary: "indexing text" });
  vi.stubEnv("MEGAMEMORY_SEARCH", "vector");
  return db;
}
function active(db: KnowledgeDB): VectorGeneration {
  const generation = db.getVectorGeneration();
  expect(generation).not.toBeNull();
  return generation!;
}
const ids = (hits: Array<{ id: string }>) => hits.map((hit) => hit.id);
async function index(db: KnowledgeDB, model: string, values = [1, 0]) {
  return reembed(db, { model, embedFn: async () => vector(...values) });
}
async function parity(db: KnowledgeDB, model: string, values: number[], expected: string[]) {
  const options = { model, embedFn: async () => vector(...values), topK: 20 };
  const native = await hybridSearch(db, "no matching phrase", options);
  const fallback = vi.spyOn(db, "vectorTopK").mockReturnValue(null);
  try {
    const js = await hybridSearch(db, "no matching phrase", options);
    expect(ids(native)).toEqual(expected);
    expect(ids(js)).toEqual(expected);
    expect(js.every((hit) => hit.via === "vector")).toBe(true);
  } finally { fallback.mockRestore(); }
}
function snapshot(db: KnowledgeDB) {
  return {
    meta: db.execSqlAll("SELECT key,value FROM meta ORDER BY key"),
    canonical: db.execSqlAll("SELECT id,hex(embedding) AS embedding,embedding_generation FROM nodes ORDER BY id"),
    native: db.execSqlAll("SELECT id,hex(embedding) AS embedding,generation FROM nodes_vec ORDER BY id"),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db?.close();
  db = undefined;
  if (!dir) return;
  const staleDir = dir;
  for (let i = 0; i < 40; i++) {
    (globalThis as { gc?: () => void }).gc?.();
    try { fs.rmSync(staleDir, { recursive: true, force: true }); dir = undefined; return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  deferredCleanup.add(staleDir);
  dir = undefined;
});

afterAll(async () => {
  for (const ownedDir of deferredCleanup) {
    (globalThis as { gc?: () => void }).gc?.();
    try { fs.rmSync(ownedDir, { recursive: true, force: true }); deferredCleanup.delete(ownedDir); }
    catch { /* Rejected native errors may retain handles until the worker exits. */ }
  }
  if (deferredCleanup.size === 0) return;
  if (!managedCleanup) throw new Error(`P10_OWNED_CLEANUP_FAILED ${[...deferredCleanup].join(",")}`);
  // The bounded supervisor owns this isolated profile and verifies deletion
  // after the process tree closes; the P_RESULT footer is part of acceptance.
  console.info(`P10_PARENT_CLEANUP_REQUIRED ${[...deferredCleanup].join(",")}`);
});

describe("P10 generation switch, partial coverage and resume", () => {
  it.each([2, 3])("model switch to dimension %i fails second, serves only current rows, resumes without laundering", async (dim) => {
    const db = fresh();
    await index(db, "p10-old");
    const old = active(db);
    const values = dim === 2 ? [0, 1] : [0, 1, 0];
    let calls = 0;
    await expect(reembed(db, { model: "p10-new", batch: 2, embedFn: async () => {
      if (++calls === 2) throw new Error("P10_SECOND_EMBED_FAILURE");
      return vector(...values);
    } })).rejects.toThrow("P10_SECOND_EMBED_FAILURE");
    const partial = active(db);
    expect(partial.generation).toBeGreaterThan(old.generation);
    expect(partial.model).toBe("p10-new");
    expect(partial.dim).toBe(dim);
    expect(JSON.parse(partial.profile).dim).toBe(dim);
    expect(db.getMetaValue("vector_generation_counter")).toBe(String(partial.generation));
    expect(ids(db.getAllActiveNodesWithEmbeddings())).toEqual(["first"]);
    expect(db.getNode("second")?.embedding).toBeNull();
    expect(db.execSqlFirst("SELECT embedding_generation FROM nodes WHERE id='second'")).toMatchObject({ embedding_generation: null });
    expect(db.execSqlFirst("SELECT id FROM nodes_vec WHERE id='second'")).toBeUndefined();
    if (dim === 2) expect(ids(db.vectorTopK(JSON.stringify(values), 20, partial)!)).toEqual(["first"]);
    else expect(db.vectorTopK(JSON.stringify(values), 20, partial)).toBeNull();
    await parity(db, "p10-new", values, ["first"]);
    const resumed = await index(db, "p10-new", values);
    expect(resumed).toMatchObject({ processed: 1, total: 2, dim, model: "p10-new" });
    expect(active(db).generation).toBe(partial.generation);
    expect(db.getMetaValue("last_reembed")).toBeTruthy();
    await parity(db, "p10-new", values, ["first", "second"]);
    expect((await index(db, "p10-new", values)).processed).toBe(0);
    expect(active(db).generation).toBe(partial.generation);
  });

  it("failure on the first row keeps both projections invalid and dim unknown until resume", async () => {
    const db = fresh();
    await index(db, "p10-old");
    await expect(reembed(db, { model: "p10-new", embedFn: async () => { throw new Error("P10_FIRST_FAILURE"); } })).rejects.toThrow("P10_FIRST_FAILURE");
    expect(active(db).dim).toBe(0);
    expect(db.getAllActiveNodesWithEmbeddings()).toEqual([]);
    expect(db.execSqlAll("SELECT id FROM nodes_vec")).toEqual([]);
    const generation = active(db).generation;
    expect((await index(db, "p10-new")).processed).toBe(2);
    expect(active(db).generation).toBe(generation);
  });

  it("corrupt current canonical vectors remain pending until actual resume repairs coverage", async () => {
    const db = fresh(["first"]);
    await index(db, "p10-new");
    const generation = active(db);
    db.execSqlRun("UPDATE nodes SET embedding=@embedding WHERE id='first'", { embedding: vector(NaN, 0) });
    expect(ids(db.getNodesNeedingReembed(generation, 10))).toEqual(["first"]);
    expect(db.finishVectorGeneration(generation)).toBe(false);
    expect((await index(db, "p10-new", [0, 1])).processed).toBe(1);
    expect(active(db).generation).toBe(generation.generation);
    await parity(db, "p10-new", [0, 1], ["first"]);
  });

  it("same-model changed actual preprocessing starts a fresh generation", async () => {
    const db = fresh();
    await index(db, MODEL_NAME);
    const old = active(db);
    const changed = JSON.parse(old.profile);
    changed.normalize = false;
    const next = db.beginVectorGeneration({ model: MODEL_NAME, dim: 2, profile: JSON.stringify(changed) });
    expect(next.generation).toBeGreaterThan(old.generation);
    expect(db.getAllActiveNodesWithEmbeddings()).toEqual([]);
    expect(vectorSearchEnabled(db)).toBe(false);
    await index(db, MODEL_NAME);
    expect(active(db).generation).toBeGreaterThan(next.generation);
    expect(vectorSearchEnabled(db)).toBe(true);
  });

  it("legacy model/dim stamps and NULL generations never authorize current vector hits", async () => {
    const db = fresh(["legacy"]);
    db.setMetaValue("embed_model", MODEL_NAME);
    db.setMetaValue("embed_dim", "2");
    db.execSqlRun("UPDATE nodes SET embedding=@embedding", { embedding: vector(1, 0) });
    expect(vectorSearchEnabled(db)).toBe(false);
    expect(db.getAllActiveNodesWithEmbeddings()).toEqual([]);
    const embedFn = vi.fn(async () => vector(1, 0));
    expect(await hybridSearch(db, "no matching phrase", { embedFn })).toEqual([]);
    expect(embedFn).not.toHaveBeenCalled();
    expect((await index(db, MODEL_NAME)).processed).toBe(1);
    expect(vectorSearchEnabled(db)).toBe(true);
  });
});

describe("P10 atomic invalidation/publication and afterawait CAS", () => {
  it("native clear fault rolls back both projections, counter and active profile", async () => {
    const db = fresh();
    await index(db, "p10-old");
    const before = snapshot(db);
    db.execSql("CREATE TRIGGER p10_clear_fault BEFORE DELETE ON nodes_vec BEGIN SELECT RAISE(ABORT,'P10_NATIVE_CLEAR_FAILURE'); END");
    await expect(index(db, "p10-new")).rejects.toThrow("P10_NATIVE_CLEAR_FAILURE");
    expect(snapshot(db)).toEqual(before);
    db.execSql("DROP TRIGGER p10_clear_fault");
    expect((await index(db, "p10-new")).processed).toBe(2);
  });

  it("native write fault rolls back canonical blob, generation and learned dim", async () => {
    const db = fresh();
    await index(db, "p10-old");
    const generation = db.beginVectorGeneration({ model: "p10-new", profile: embeddingProfile("p10-new"), dim: 0 });
    const before = snapshot(db);
    db.execSql("CREATE TRIGGER p10_publish_fault BEFORE INSERT ON nodes_vec BEGIN SELECT RAISE(ABORT,'P10_NATIVE_WRITE_FAILURE'); END");
    await expect(index(db, "p10-new")).rejects.toThrow("P10_NATIVE_WRITE_FAILURE");
    expect(snapshot(db)).toEqual(before);
    expect(active(db).generation).toBe(generation.generation);
    db.execSql("DROP TRIGGER p10_publish_fault");
    expect((await index(db, "p10-new")).processed).toBe(2);
  });

  it("native failure on the second row preserves only the committed first row and can resume", async () => {
    const db = fresh();
    await index(db, "p10-old");
    db.beginVectorGeneration({ model: "p10-new", profile: embeddingProfile("p10-new"), dim: 0 });
    db.execSql("CREATE TRIGGER p10_second_write_fault BEFORE INSERT ON nodes_vec WHEN new.id='second' BEGIN SELECT RAISE(ABORT,'P10_SECOND_NATIVE_FAILURE'); END");
    await expect(index(db, "p10-new", [0, 1])).rejects.toThrow("P10_SECOND_NATIVE_FAILURE");
    expect(ids(db.getAllActiveNodesWithEmbeddings())).toEqual(["first"]);
    expect(db.getNode("second")?.embedding).toBeNull();
    expect(active(db).dim).toBe(2);
    await parity(db, "p10-new", [0, 1], ["first"]);
    db.execSql("DROP TRIGGER p10_second_write_fault");
    expect((await index(db, "p10-new", [0, 1])).processed).toBe(1);
    await parity(db, "p10-new", [0, 1], ["first", "second"]);
  });

  it("generation switch while reembedding rejects publication and leaves new generation empty", async () => {
    const db = fresh(["first"]);
    await expect(reembed(db, { model: "p10-first", embedFn: async () => {
      db.beginVectorGeneration({ model: "p10-second", profile: embeddingProfile("p10-second"), dim: 0 });
      return vector(1, 0);
    } })).rejects.toThrow(/generation changed/);
    expect(active(db).model).toBe("p10-second");
    expect(db.getAllActiveNodesWithEmbeddings()).toEqual([]);
    expect(db.getMetaValue("last_reembed")).toBeUndefined();
  });

  it.each(["name", "kind", "summary"])("concurrent %s edit rejects the captured embedding then resume embeds current text", async (field) => {
    const db = fresh(["first"]);
    await expect(reembed(db, { model: "p10-new", embedFn: async () => {
      db.execSqlRun(`UPDATE nodes SET ${field}=@value WHERE id='first'`, { value: "new input" });
      return vector(1, 0);
    } })).rejects.toThrow(/input or vector generation changed/);
    expect(db.getNode("first")?.embedding).toBeNull();
    const embedFn = vi.fn(async (_text: string) => vector(0, 1));
    expect((await reembed(db, { model: "p10-new", embedFn })).processed).toBe(1);
    expect(embedFn.mock.calls[0][0]).toContain("new input");
  });

  it("soft-delete during inference rejects publish and resume does not embed removed nodes", async () => {
    const db = fresh(["first"]);
    await expect(reembed(db, { model: "p10-new", embedFn: async () => {
      db.softDeleteNode("first", "P10_TEST_REMOVE");
      return vector(1, 0);
    } })).rejects.toThrow(/input or vector generation changed/);
    const embedFn = vi.fn(async () => vector(1, 0));
    expect(await reembed(db, { model: "p10-new", embedFn })).toMatchObject({ processed: 0, total: 0 });
    expect(embedFn).not.toHaveBeenCalled();
  });

  it("a captured publication cannot target an id that was renamed during inference", async () => {
    const db = fresh(["first"]);
    await expect(reembed(db, { model: "p10-new", embedFn: async () => {
      db.execSql("UPDATE nodes SET id='renamed' WHERE id='first'");
      return vector(1, 0);
    } })).rejects.toThrow(/input or vector generation changed/);
    expect(db.getNode("renamed")?.embedding).toBeNull();
    expect(db.getNode("first")).toBeUndefined();
    expect((await index(db, "p10-new")).processed).toBe(1);
    await parity(db, "p10-new", [1, 0], ["renamed"]);
  });

  it("query generation switch during await disables vectors rather than comparing equal-dim spaces", async () => {
    const db = fresh(["first"]);
    await index(db, "p10-old");
    const native = vi.spyOn(db, "vectorTopK");
    const hits = await hybridSearch(db, "no matching phrase", { model: "p10-old", embedFn: async () => {
      await index(db, "p10-new", [0, 1]);
      return vector(1, 0);
    } });
    expect(hits).toEqual([]);
    expect(native).not.toHaveBeenCalled();
    expect(active(db).model).toBe("p10-new");
  });

  it("storage embed generation switch during await returns null without restamping", async () => {
    const db = fresh(["first"]);
    await index(db, MODEL_NAME);
    const result = await embedForStorage(db, "storage text", { embedFn: async () => {
      await index(db, "p10-new", [0, 1]);
      return vector(1, 0);
    } });
    expect(result).toBeNull();
    expect(active(db).model).toBe("p10-new");
    expect(await embedForStorage(db, "storage text")).toBeNull();
  });

  it("runtime storage embed keeps Buffer behavior and applies exactly one passage prefix", async () => {
    const db = fresh(["first"]);
    await index(db, MODEL_NAME);
    const before = active(db);
    const embedFn = vi.fn(async (_text: string) => vector(0, 1));
    const result = await embedForStorage(db, "storage text", { embedFn });
    expect(result).toEqual(vector(0, 1));
    expect(embedFn.mock.calls[0][0]).toBe(JSON.parse(before.profile).passage_prefix + "storage text");
    expect(active(db)).toEqual(before);
  });

  it("stale generation cannot stamp completion of a newer unfinished generation", async () => {
    const db = fresh();
    await index(db, "p10-old");
    const old = active(db);
    db.execSql("DELETE FROM meta WHERE key='last_reembed'");
    db.beginVectorGeneration({ model: "p10-new", profile: embeddingProfile("p10-new"), dim: 0 });
    expect(db.finishVectorGeneration(old)).toBe(false);
    expect(db.getMetaValue("last_reembed")).toBeUndefined();
  });
});

describe("P10 native/JS identical eligibility and graceful fallback", () => {
  it("old, NULL, removed, inactive, expired, refuted, abandoned and invalid rows never become vector hits", async () => {
    const names = ["good", "old", "null", "removed", "inactive", "expired", "refuted", "abandoned", "zero", "nan", "wrongdim"];
    const db = fresh(names);
    await index(db, "p10-new");
    const generation = active(db);
    db.execSqlRun("UPDATE nodes SET embedding_generation=@generation WHERE id='old'", { generation: generation.generation - 1 });
    db.execSql("UPDATE nodes SET embedding=NULL WHERE id='null'; UPDATE nodes SET removed_at='2020-01-01' WHERE id='removed'; UPDATE nodes SET status='superseded' WHERE id='inactive'; UPDATE nodes SET valid_until='2020-01-01' WHERE id='expired'; UPDATE nodes SET epistemic_status='refuted' WHERE id='refuted'; UPDATE nodes SET epistemic_status='abandoned' WHERE id='abandoned'");
    for (const [id, embedding] of [["zero", vector(0, 0)], ["nan", vector(NaN, 0)], ["wrongdim", vector(1, 0, 0)]] as const) {
      db.execSqlRun("UPDATE nodes SET embedding=@embedding WHERE id=@id", { id, embedding });
    }
    expect(ids(db.getAllActiveNodesWithEmbeddings(generation))).toEqual(["good"]);
    expect(ids(db.vectorTopK("[1,0]", 20, generation)!)).toEqual(["good"]);
    await parity(db, "p10-new", [1, 0], ["good"]);
    expect(db.getNodesNeedingReembed(generation, 20).some((node) => ["removed", "inactive", "expired", "refuted", "abandoned"].includes(node.id))).toBe(false);
  });

  it("a shadow count equal to canonical count does not hide a missing eligible identity", async () => {
    const db = fresh();
    await index(db, "p10-new");
    const generation = active(db);
    db.execSql("DELETE FROM nodes_vec WHERE id='second'");
    db.execSqlRun("INSERT INTO nodes_vec(id,embedding,generation) VALUES('ghost',vector32('[1,0]'),@generation)", { generation: generation.generation });
    expect(db.vectorTableCount()).toBe(2);
    expect(db.vectorTopK("[1,0]", 20, generation)).toBeNull();
    await parity(db, "p10-new", [1, 0], ["first", "second"]);
  });

  it("old-generation shadow for a current node forces canonical JS fallback", async () => {
    const db = fresh();
    await index(db, "p10-new");
    const generation = active(db);
    db.execSqlRun("UPDATE nodes_vec SET generation=@generation WHERE id='second'", { generation: generation.generation - 1 });
    expect(db.vectorTopK("[1,0]", 20, generation)).toBeNull();
    await parity(db, "p10-new", [1, 0], ["first", "second"]);
  });

  it("missing native capability permits atomic canonical publication and current-generation JS search", async () => {
    const db = fresh();
    vi.spyOn(db, "vectorSupportOk").mockReturnValue(false);
    expect((await index(db, "p10-new")).processed).toBe(2);
    expect(db.execSqlFirst("SELECT name FROM sqlite_master WHERE name='nodes_vec'")).toBeUndefined();
    expect(ids(await hybridSearch(db, "no matching phrase", { model: "p10-new", embedFn: async () => vector(1, 0) }))).toEqual(["first", "second"]);
  });

  it("a same-generation malformed native row cannot hide its valid canonical fallback", async () => {
    const db = fresh();
    await index(db, "p10-new");
    db.execSqlRun("UPDATE nodes_vec SET embedding=@embedding WHERE id='second'", { embedding: Buffer.alloc(0) });
    await parity(db, "p10-new", [1, 0], ["first", "second"]);
  });

  it("native capability failure falls back to JS without losing eligible current rows", async () => {
    const db = fresh();
    await index(db, "p10-new");
    vi.spyOn(db, "vectorTopK").mockImplementation(() => { throw new Error("P10_NATIVE_UNAVAILABLE"); });
    expect(ids(await hybridSearch(db, "no matching phrase", { model: "p10-new", embedFn: async () => vector(1, 0) }))).toEqual(["first", "second"]);
  });

  it("inconsistent generation/profile metadata fails closed without restamping old vectors", async () => {
    const db = fresh(["first"]);
    await index(db, MODEL_NAME);
    const generation = active(db);
    const before = db.execSqlAll("SELECT id,hex(embedding) AS embedding,embedding_generation FROM nodes");
    const profile = JSON.parse(generation.profile);
    profile.dim = 3;
    db.setMetaValue("embed_profile", JSON.stringify(profile));
    expect(vectorSearchEnabled(db)).toBe(false);
    expect(await hybridSearch(db, "no matching phrase", { embedFn: async () => vector(1, 0) })).toEqual([]);
    expect(db.execSqlAll("SELECT id,hex(embedding) AS embedding,embedding_generation FROM nodes")).toEqual(before);
  });

  it.each([{ values: [] }, { values: [0, 0] }, { values: [NaN, 1] }, { values: [Infinity, 1] }])("rejects invalid injected reembed vector $values without publishing", async ({ values }) => {
    const db = fresh(["first"]);
    await expect(index(db, "p10-new", values)).rejects.toThrow(/Invalid reembed/);
    expect(db.getAllActiveNodesWithEmbeddings()).toEqual([]);
    expect(active(db).dim).toBe(0);
  });

  it("query failure and wrong-dimension queries degrade to FTS without vector hits", async () => {
    const db = fresh(["first"]);
    await index(db, "p10-new");
    for (const embedFn of [async () => { throw new Error("P10_QUERY_FAILURE"); }, async () => vector(1, 0, 0)]) {
      const hits = await hybridSearch(db, "indexing", { model: "p10-new", embedFn });
      expect(hits).toMatchObject([{ id: "first", via: "fts" }]);
    }
  });
});
