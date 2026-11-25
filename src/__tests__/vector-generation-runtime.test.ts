import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB, type VectorGeneration } from "../db.js";
import { reembed } from "../reembed.js";
import * as autoReembed from "../auto-reembed.js";
import { createConcept, updateConcept } from "../tools.js";
import { auditFixture, deferred } from "./helpers/audit.js";
import { hybridSearch } from "../search.js";
import { MODEL_NAME, embedForStorage, embeddingProfile, passageText, vectorChannelState, vectorSearchEnabled } from "../embeddings.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("P10_MODEL_DOWNLOAD_FORBIDDEN"); }),
}));

let db: KnowledgeDB | undefined;
let dir: string | undefined;
const profile = process.env.USERPROFILE ?? os.tmpdir();
const managedCleanup = path.basename(profile).startsWith("mm-new6-owned-");
const deferredCleanup = new Set<string>();
const scheduleFirstGeneration = autoReembed.scheduleFirstGeneration;
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
    native: db.execSqlFirst("SELECT name FROM sqlite_master WHERE name='nodes_vec'")
      ? db.execSqlAll("SELECT id,hex(embedding) AS embedding,generation FROM nodes_vec ORDER BY id")
      : null,
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

describe("D02 reembed warmup before generation changes", () => {
  it.each(["indexed", "fresh", "empty"])("warmup failure leaves %s generation and both projections unchanged", async (state) => {
    const db = fresh(state === "empty" ? [] : ["first", "second"]);
    if (state === "indexed") await index(db, "p10-old");
    const beforeGeneration = db.getVectorGeneration();
    const before = snapshot(db);
    if (state === "indexed") {
      expect(beforeGeneration?.model).toBe("p10-old");
      expect(before.canonical).toHaveLength(2);
      expect(ids(db.getAllActiveNodesWithEmbeddings())).toEqual(["first", "second"]);
      expect(before.native).toHaveLength(2);
    } else {
      expect(beforeGeneration).toBeNull();
      expect(db.getMetaValue("vector_generation_counter")).toBeUndefined();
    }
    const begin = vi.spyOn(db, "beginVectorGeneration");
    const embedFn = vi.fn(async (_text: string): Promise<Buffer> => {
      expect(snapshot(db)).toEqual(before);
      expect(begin).not.toHaveBeenCalled();
      throw new Error("D02_WARMUP_FAILURE");
    });

    await expect(reembed(db, { embedFn })).rejects.toThrow("D02_WARMUP_FAILURE");

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith(passageText("warmup", MODEL_NAME));
    expect(begin).not.toHaveBeenCalled();
    expect(db.getVectorGeneration()).toEqual(beforeGeneration);
    expect(snapshot(db)).toEqual(before);
    if (state !== "indexed") expect(db.getVectorGeneration()).toBeNull();
  });

  it("awaits prefixed warmup before switching and learns dimension only from actual rows", async () => {
    const db = fresh();
    await index(db, "p10-old");
    const beforeGeneration = active(db);
    const before = snapshot(db);
    const begin = vi.spyOn(db, "beginVectorGeneration");
    let calls = 0;
    const embedFn = vi.fn(async (_text: string): Promise<Buffer> => {
      if (++calls === 1) {
        await Promise.resolve();
        expect(begin).not.toHaveBeenCalled();
        expect(active(db)).toEqual(beforeGeneration);
        expect(snapshot(db)).toEqual(before);
        return vector(1, 0, 0);
      }
      expect(begin).toHaveBeenCalledTimes(1);
      expect(active(db).model).toBe(MODEL_NAME);
      return vector(0, 1);
    });

    expect(await reembed(db, { embedFn })).toEqual({ processed: 2, total: 2, dim: 2, model: MODEL_NAME });

    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(embedFn.mock.calls[0][0]).toBe(passageText("warmup", MODEL_NAME));
    expect(embedFn.mock.calls.slice(1).every(([text]) => text.startsWith("passage: "))).toBe(true);
    expect(active(db).generation).toBeGreaterThan(beforeGeneration.generation);
    expect(active(db).dim).toBe(2);
    const after = snapshot(db);
    expect(after.canonical).not.toEqual(before.canonical);
    expect(after.native).not.toEqual(before.native);
    expect(after.native).toHaveLength(2);
    await parity(db, MODEL_NAME, [0, 1], ["first", "second"]);
  });

  it("successful warmup of an empty database leaves generation dimension unknown", async () => {
    const db = fresh([]);
    const before = snapshot(db);
    expect(db.getVectorGeneration()).toBeNull();
    const embedFn = vi.fn(async (_text: string): Promise<Buffer> => vector(1, 0, 0));

    expect(await reembed(db, { embedFn })).toEqual({ processed: 0, total: 0, dim: 0, model: MODEL_NAME });

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith(passageText("warmup", MODEL_NAME));
    expect(active(db).dim).toBe(0);
    expect(JSON.parse(active(db).profile).dim).toBe(0);
    expect(db.getMetaValue("embed_dim")).toBe("0");
    expect(snapshot(db).canonical).toEqual(before.canonical);
    expect(snapshot(db).native).toEqual(before.native);
    expect(vectorChannelState(db)).toEqual({ state: "off", reason: "generation_without_vectors" });
  });

  it("validates arguments before warmup or generation writes", async () => {
    const db = fresh();
    await index(db, "p10-old");
    const beforeGeneration = active(db);
    const before = snapshot(db);
    const begin = vi.spyOn(db, "beginVectorGeneration");
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));

    await expect(reembed(db, { batch: 0, embedFn })).rejects.toThrow("Invalid reembed batch");
    await expect(reembed(db, { model: "p10-new" })).rejects.toThrow("Alternate model requires embedFn");

    expect(embedFn).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(active(db)).toEqual(beforeGeneration);
    expect(snapshot(db)).toEqual(before);
  });
});

describe("P10 generation switch, partial coverage and resume", () => {
  it.each([2, 3])("model switch to dimension %i fails second, serves only current rows, resumes without laundering", async (dim) => {
    const db = fresh();
    await index(db, "p10-old");
    const old = active(db);
    const before = snapshot(db);
    expect(before.canonical).toHaveLength(2);
    expect(before.native).toHaveLength(2);
    const values = dim === 2 ? [0, 1] : [0, 1, 0];
    let calls = 0;
    await expect(reembed(db, { model: "p10-new", batch: 2, embedFn: async () => {
      if (++calls === 3) throw new Error("P10_SECOND_EMBED_FAILURE");
      return vector(...values);
    } })).rejects.toThrow("P10_SECOND_EMBED_FAILURE");
    expect(calls).toBe(3);
    const after = snapshot(db);
    expect(after.canonical).not.toEqual(before.canonical);
    expect(after.native).not.toEqual(before.native);
    expect(after.native).toHaveLength(dim === 2 ? 1 : 0);
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
    const old = active(db);
    const before = snapshot(db);
    expect(before.canonical).toHaveLength(2);
    expect(before.native).toHaveLength(2);
    let calls = 0;
    await expect(reembed(db, { model: "p10-new", embedFn: async () => {
      if (++calls === 2) throw new Error("P10_FIRST_FAILURE");
      return vector(1, 0);
    } })).rejects.toThrow("P10_FIRST_FAILURE");
    expect(calls).toBe(2);
    const after = snapshot(db);
    expect(after.canonical).not.toEqual(before.canonical);
    expect(after.native).toEqual([]);
    expect(active(db).generation).toBeGreaterThan(old.generation);
    expect(active(db).model).toBe("p10-new");
    expect(active(db).dim).toBe(0);
    expect(db.getAllActiveNodesWithEmbeddings()).toEqual([]);
    expect(db.execSqlAll("SELECT id FROM nodes_vec")).toEqual([]);
    expect(db.execSqlAll("SELECT embedding,embedding_generation FROM nodes ORDER BY id")).toEqual([
      { embedding: null, embedding_generation: null },
      { embedding: null, embedding_generation: null },
    ]);
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
    let calls = 0;
    await expect(reembed(db, { model: "p10-first", embedFn: async () => {
      if (++calls === 1) return vector(1, 0);
      db.beginVectorGeneration({ model: "p10-second", profile: embeddingProfile("p10-second"), dim: 0 });
      return vector(1, 0);
    } })).rejects.toThrow(/generation changed/);
    expect(calls).toBe(2);
    expect(active(db).model).toBe("p10-second");
    expect(db.getAllActiveNodesWithEmbeddings()).toEqual([]);
    expect(db.getMetaValue("last_reembed")).toBeUndefined();
  });

  it.each(["name", "kind", "summary"])("concurrent %s edit rejects the captured embedding then resume embeds current text", async (field) => {
    const db = fresh(["first"]);
    let calls = 0;
    await expect(reembed(db, { model: "p10-new", embedFn: async () => {
      if (++calls === 1) return vector(1, 0);
      db.execSqlRun(`UPDATE nodes SET ${field}=@value WHERE id='first'`, { value: "new input" });
      return vector(1, 0);
    } })).rejects.toThrow(/input or vector generation changed/);
    expect(calls).toBe(2);
    expect(db.getNode("first")?.embedding).toBeNull();
    const embedFn = vi.fn(async (_text: string) => vector(0, 1));
    expect((await reembed(db, { model: "p10-new", embedFn })).processed).toBe(1);
    expect(embedFn).toHaveBeenCalledTimes(2);
    expect(embedFn.mock.calls[0][0]).toBe(passageText("warmup", "p10-new"));
    expect(embedFn.mock.calls[1][0]).toContain("new input");
  });

  it("soft-delete during inference rejects publish and resume does not embed removed nodes", async () => {
    const db = fresh(["first"]);
    let calls = 0;
    await expect(reembed(db, { model: "p10-new", embedFn: async () => {
      if (++calls === 1) return vector(1, 0);
      db.softDeleteNode("first", "P10_TEST_REMOVE");
      return vector(1, 0);
    } })).rejects.toThrow(/input or vector generation changed/);
    expect(calls).toBe(2);
    const embedFn = vi.fn(async (_text: string) => vector(1, 0));
    expect(await reembed(db, { model: "p10-new", embedFn })).toMatchObject({ processed: 0, total: 0 });
    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith(passageText("warmup", "p10-new"));
  });

  it("a captured publication cannot target an id that was renamed during inference", async () => {
    const db = fresh(["first"]);
    let calls = 0;
    await expect(reembed(db, { model: "p10-new", embedFn: async () => {
      if (++calls === 1) return vector(1, 0);
      db.execSql("UPDATE nodes SET id='renamed' WHERE id='first'");
      return vector(1, 0);
    } })).rejects.toThrow(/input or vector generation changed/);
    expect(calls).toBe(2);
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

  it("a same-model generation with dim = 0 accepts storage embeds without stamping the dimension", async () => {
    const db = fresh([]);
    expect((await index(db, MODEL_NAME)).processed).toBe(0);
    expect(vectorChannelState(db)).toEqual({ state: "off", reason: "generation_without_vectors" });
    const embedFn = vi.fn(async (_text: string) => vector(1, 0));
    const stored = await embedForStorage(db, "storage text", { embedFn });
    expect(stored).toEqual(vector(1, 0));
    expect(embedFn.mock.calls[0][0]).toBe(JSON.parse(active(db).profile).passage_prefix + "storage text");
    expect(active(db).dim).toBe(0);
  });

  it("a row published during the await fixes the dimension and keeps the pending storage embed valid", async () => {
    const db = fresh([]);
    await index(db, MODEL_NAME);
    const result = await embedForStorage(db, "storage text", { embedFn: async () => {
      db.insertNode({ id: "first", name: "first", kind: "feature", summary: "indexing text" });
      expect(db.publishNodeEmbedding({ ...active(db), id: "first", name: "first", kind: "feature", summary: "indexing text" }, vector(1, 0))).toBe(true);
      return vector(1, 0);
    } });
    expect(result).toEqual(vector(1, 0));
    expect(vectorChannelState(db)).toEqual({ state: "on" });
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

describe("B2 automatic first-generation reembed", () => {
  function background(): { defer: (run: () => void) => void; run: () => void; jobs: Array<() => void> } {
    const jobs: Array<() => void> = [];
    const defer = vi.fn((run: () => void): void => { jobs.push(run); });
    return { defer, jobs, run: (): void => {
      expect(jobs).toHaveLength(1);
      jobs.shift()!();
    } };
  }

  it("test opt-out schedules nothing, performs no DB reads and cannot load the model", () => {
    const db = fresh();
    const before = snapshot(db);
    expect(process.env.MEGAMEMORY_AUTO_REEMBED).toBe("0");
    const queued = background();
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));
    const generation = vi.spyOn(db, "getVectorGeneration");
    const count = vi.spyOn(db, "getReembedEligibleCount");

    expect(scheduleFirstGeneration(db, { defer: queued.defer, embedFn })).toBeUndefined();
    expect(scheduleFirstGeneration(db)).toBeUndefined();

    expect(generation).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(queued.defer).not.toHaveBeenCalled();
    expect(embedFn).not.toHaveBeenCalled();
    expect(snapshot(db)).toEqual(before);
  });

  it("defers work and deduplicates repeated calls and connections to the same normalized path", async () => {
    const db = fresh();
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const other = new KnowledgeDB(path.join(path.dirname(db.dbPath), ".", path.basename(db.dbPath)));
    try {
      const before = snapshot(db);
      const queued = background();
      const embedFn = vi.fn(async (_text: string): Promise<Buffer> => vector(1, 0));
      const options = { defer: queued.defer, embedFn };
      const pending = scheduleFirstGeneration(db, options);
      expect(pending).toBeInstanceOf(Promise);
      expect(scheduleFirstGeneration(db, options)).toBe(pending);
      expect(scheduleFirstGeneration(other, options)).toBe(pending);
      expect(queued.defer).toHaveBeenCalledTimes(1);
      expect(embedFn).not.toHaveBeenCalled();
      expect(snapshot(db)).toEqual(before);
      expect(db.getVectorGeneration()).toBeNull();

      queued.run();
      expect(embedFn).toHaveBeenCalledTimes(1);
      expect(db.getVectorGeneration()).toBeNull();
      await expect(pending).resolves.toBeUndefined();

      expect(embedFn).toHaveBeenCalledTimes(3);
      expect(embedFn.mock.calls[0][0]).toBe(passageText("warmup", MODEL_NAME));
      expect(vectorChannelState(db)).toEqual({ state: "on" });
      expect(other.getVectorGeneration()).toEqual(active(db));
      expect(ids(db.getAllActiveNodesWithEmbeddings())).toEqual(["first", "second"]);
      expect(snapshot(db).canonical).not.toEqual(before.canonical);
      expect(snapshot(db).native).toHaveLength(2);
      expect(scheduleFirstGeneration(other, options)).toBeUndefined();
      expect(queued.defer).toHaveBeenCalledTimes(1);
    } finally { other.close(); }
  });

  it("retains a successful attempt for this process even if generation metadata is reset", async () => {
    const db = fresh(["first"]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const queued = background();
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));
    let now = 1000;
    const options = { defer: queued.defer, embedFn, now: () => now };
    const pending = scheduleFirstGeneration(db, options);
    queued.run();
    await pending;
    expect(vectorChannelState(db)).toEqual({ state: "on" });
    expect(embedFn).toHaveBeenCalledTimes(2);

    db.execSql("DELETE FROM meta WHERE key IN ('active_vector_generation','vector_generation_counter','embed_model','embed_dim','embed_profile','last_reembed')");
    expect(vectorChannelState(db)).toEqual({ state: "off", reason: "no_generation" });
    expect(db.getReembedEligibleCount()).toBe(1);
    const before = snapshot(db);
    now += 10 * 60 * 1000;

    expect(scheduleFirstGeneration(db, options)).toBeUndefined();

    expect(queued.defer).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledTimes(2);
    expect(snapshot(db)).toEqual(before);
  });

  it("uses the default background immediate without embedding in the scheduling call", async () => {
    const db = fresh(["first"]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));
    const pending = scheduleFirstGeneration(db, { embedFn });
    expect(pending).toBeInstanceOf(Promise);
    expect(embedFn).not.toHaveBeenCalled();
    expect(db.getVectorGeneration()).toBeNull();

    await pending;

    expect(embedFn).toHaveBeenCalledTimes(2);
    expect(vectorChannelState(db)).toEqual({ state: "on" });
  });

  it("logs warmup failure without changing vectors or generation and retries only after ten minutes", async () => {
    const db = fresh();
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const before = snapshot(db);
    const queued = background();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const embedFn = vi.fn(async (_text: string): Promise<Buffer> => { throw new Error("B2_WARMUP_FAILURE"); });
    let now = 1000;
    const options = { defer: queued.defer, embedFn, now: () => now };
    const pending = scheduleFirstGeneration(db, options);
    queued.run();
    await expect(pending).resolves.toBeUndefined();

    expect(db.getVectorGeneration()).toBeNull();
    expect(snapshot(db)).toEqual(before);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("B2_WARMUP_FAILURE"));
    expect(db.execSqlAll("SELECT tool,is_write,is_error,result_summary FROM timeline WHERE tool='auto_reembed'")).toEqual([
      { tool: "auto_reembed", is_write: 1, is_error: 1, result_summary: "B2_WARMUP_FAILURE" },
    ]);
    expect(scheduleFirstGeneration(db, options)).toBeUndefined();
    now += 10 * 60 * 1000 - 1;
    expect(scheduleFirstGeneration(db, options)).toBeUndefined();
    expect(queued.defer).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledTimes(1);

    now += 1;
    embedFn.mockResolvedValue(vector(1, 0));
    const retry = scheduleFirstGeneration(db, options);
    expect(retry).toBeInstanceOf(Promise);
    expect(scheduleFirstGeneration(db, options)).toBe(retry);
    queued.run();
    await retry;

    expect(queued.defer).toHaveBeenCalledTimes(2);
    expect(embedFn).toHaveBeenCalledTimes(4);
    expect(vectorChannelState(db)).toEqual({ state: "on" });
    expect(db.execSqlAll("SELECT tool FROM timeline WHERE tool='auto_reembed'")).toHaveLength(1);
  });

  it("catches up a partial channel and embeds only the missing node", async () => {
    const db = fresh();
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    await index(db, MODEL_NAME);
    db.execSql("UPDATE nodes SET embedding=NULL WHERE id='second'");
    expect(vectorChannelState(db)).toEqual({ state: "partial", missing: 1, total: 2 });
    const before = snapshot(db);
    const queued = background();
    const embedFn = vi.fn(async (_text: string): Promise<Buffer> => vector(1, 0));

    const pending = scheduleFirstGeneration(db, { defer: queued.defer, embedFn });
    expect(pending).toBeInstanceOf(Promise);
    expect(snapshot(db)).toEqual(before);
    queued.run();
    await pending;

    expect(queued.defer).toHaveBeenCalledTimes(1);
    // Warmup plus exactly one missing node — published vectors are not recomputed.
    expect(embedFn).toHaveBeenCalledTimes(2);
    expect(embedFn.mock.calls[0][0]).toBe(passageText("warmup", MODEL_NAME));
    expect(vectorChannelState(db)).toEqual({ state: "on" });
    expect(ids(db.getAllActiveNodesWithEmbeddings())).toEqual(["first", "second"]);
  });

  it("keeps published vectors and waits out the cooldown when a partial catch-up fails", async () => {
    const db = fresh();
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    await index(db, MODEL_NAME);
    db.execSql("UPDATE nodes SET embedding=NULL WHERE id='second'");
    const queued = background();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 1000;
    let calls = 0;
    const embedFn = vi.fn((_text: string): Promise<Buffer> =>
      ++calls === 1 ? Promise.resolve(vector(1, 0)) : Promise.reject(new Error("B2_PARTIAL_FAILURE")));
    const options = { defer: queued.defer, embedFn, now: () => now };
    const pending = scheduleFirstGeneration(db, options);
    queued.run();
    await expect(pending).resolves.toBeUndefined();

    // The generation and the published vector survive the failed catch-up.
    expect(vectorChannelState(db)).toEqual({ state: "partial", missing: 1, total: 2 });
    expect(db.execSqlFirst("SELECT embedding IS NOT NULL AS has FROM nodes WHERE id='first'")).toMatchObject({ has: 1 });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("B2_PARTIAL_FAILURE"));
    expect(db.execSqlAll("SELECT tool,is_write,is_error,result_summary FROM timeline WHERE tool='auto_reembed'")).toEqual([
      { tool: "auto_reembed", is_write: 1, is_error: 1, result_summary: "B2_PARTIAL_FAILURE" },
    ]);

    expect(scheduleFirstGeneration(db, options)).toBeUndefined();
    now += 10 * 60 * 1000 - 1;
    expect(scheduleFirstGeneration(db, options)).toBeUndefined();
    expect(queued.defer).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledTimes(2);

    now += 1;
    embedFn.mockResolvedValue(vector(1, 0));
    const retry = scheduleFirstGeneration(db, options);
    expect(retry).toBeInstanceOf(Promise);
    queued.run();
    await retry;

    expect(vectorChannelState(db)).toEqual({ state: "on" });
    expect(ids(db.getAllActiveNodesWithEmbeddings())).toEqual(["first", "second"]);
  });

  it("pauses after three failures, doubling the cooldown up to the cap", async () => {
    const db = fresh();
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const queued = background();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const embedFn = vi.fn(async (): Promise<Buffer> => { throw new Error("B2_STRIKE"); });
    let now = 1000;
    const options = { defer: queued.defer, embedFn, now: () => now };

    for (let strike = 1; strike <= 3; strike += 1) {
      const pending = scheduleFirstGeneration(db, options);
      expect(pending).toBeInstanceOf(Promise);
      queued.run();
      await expect(pending).resolves.toBeUndefined();
      // The next attempt waits out the doubled cooldown: 10, 20, 40 minutes.
      now += 10 * 60 * 1000 * 2 ** (strike - 1) - 1;
      expect(scheduleFirstGeneration(db, options)).toBeUndefined();
      now += 1;
    }

    expect(queued.defer).toHaveBeenCalledTimes(3);
    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(stderr).toHaveBeenCalledTimes(3);

    // Three strikes pause the automatic catch-up for this process: every
    // further trigger says so on stderr and schedules nothing.
    expect(scheduleFirstGeneration(db, options)).toBeUndefined();
    expect(scheduleFirstGeneration(db, options)).toBeUndefined();
    expect(queued.defer).toHaveBeenCalledTimes(3);
    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(stderr).toHaveBeenCalledTimes(5);
    expect(stderr.mock.calls.filter((call) => String(call).includes("paused after 3 failures"))).toHaveLength(2);
    expect(stderr.mock.calls.filter((call) => String(call).includes("run 'megamemory reembed' manually"))).toHaveLength(2);
  });

  it("retries after the cooldown when a finished run still leaves the channel partial", async () => {
    const db = fresh();
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    await index(db, MODEL_NAME);
    db.execSql("UPDATE nodes SET embedding=NULL WHERE id='second'");
    const queued = background();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const realFinish = db.finishVectorGeneration.bind(db);
    let registered = false;
    const finish = vi.spyOn(db, "finishVectorGeneration").mockImplementation((generation) => {
      const ok = realFinish(generation);
      if (!registered) {
        registered = true;
        // A node registered while the run was publishing: the index is partial again.
        db.insertNode({ id: "third", name: "third", kind: "feature", summary: "indexing text" });
      }
      return ok;
    });
    let now = 1000;
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));
    const options = { defer: queued.defer, embedFn, now: () => now };
    const pending = scheduleFirstGeneration(db, options);
    queued.run();
    await pending;

    // The run itself is clean — no error report — but it was not successful:
    // the next eligible trigger may retry after the cooldown.
    expect(finish).toHaveBeenCalledTimes(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(db.execSqlAll("SELECT tool FROM timeline WHERE tool='auto_reembed'")).toEqual([]);
    expect(vectorChannelState(db)).toEqual({ state: "partial", missing: 1, total: 3 });
    expect(scheduleFirstGeneration(db, options)).toBeUndefined();

    now += 10 * 60 * 1000;
    const retry = scheduleFirstGeneration(db, options);
    expect(retry).toBeInstanceOf(Promise);
    queued.run();
    await retry;

    expect(vectorChannelState(db)).toEqual({ state: "on" });
    expect(ids(db.getAllActiveNodesWithEmbeddings())).toEqual(["first", "second", "third"]);
    // Both runs stay clean: no failed attempt hides behind the data-level state.
    expect(stderr).not.toHaveBeenCalled();
    expect(db.execSqlAll("SELECT tool FROM timeline WHERE tool='auto_reembed'")).toEqual([]);
  });

  // Plan 34: a partial channel now schedules (catch-up tests above), so it is
  // no longer part of this list.
  it.each(["on", "model_mismatch", "text_only"])("never schedules the %s channel", async (state) => {
    const db = fresh();
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    if (state === "model_mismatch") await index(db, "b2-foreign");
    else if (state !== "text_only") await index(db, MODEL_NAME);
    if (state === "text_only") vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
    const before = snapshot(db);
    const channel = vectorChannelState(db);
    if (state === "on") expect(channel).toEqual({ state: "on" });
    else expect(channel).toEqual({ state: "off", reason: state === "text_only" ? "text_only_mode" : state });
    const queued = background();
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));

    expect(scheduleFirstGeneration(db, { defer: queued.defer, embedFn })).toBeUndefined();

    expect(queued.defer).not.toHaveBeenCalled();
    expect(embedFn).not.toHaveBeenCalled();
    expect(snapshot(db)).toEqual(before);
  });

  it.each(["empty", "removed", "inactive", "expired", "refuted", "abandoned"])("does not schedule when only %s nodes remain", (state) => {
    const db = fresh(state === "empty" ? [] : ["first"]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const patches: Record<string, string> = {
      removed: "UPDATE nodes SET removed_at='2020-01-01'",
      inactive: "UPDATE nodes SET status='superseded'",
      expired: "UPDATE nodes SET valid_until='2020-01-01'",
      refuted: "UPDATE nodes SET epistemic_status='refuted'",
      abandoned: "UPDATE nodes SET epistemic_status='abandoned'",
    };
    if (state !== "empty") db.execSql(patches[state]);
    expect(db.getReembedEligibleCount()).toBe(0);
    const before = snapshot(db);
    const queued = background();
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));

    expect(scheduleFirstGeneration(db, { defer: queued.defer, embedFn })).toBeUndefined();

    expect(queued.defer).not.toHaveBeenCalled();
    expect(embedFn).not.toHaveBeenCalled();
    expect(db.getVectorGeneration()).toBeNull();
    expect(snapshot(db)).toEqual(before);
  });

  it("reuses a dimension-zero generation once its first eligible node appears", async () => {
    const db = fresh([]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    await index(db, MODEL_NAME);
    const empty = active(db);
    expect(empty.dim).toBe(0);
    const queued = background();
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));
    const options = { defer: queued.defer, embedFn };
    expect(scheduleFirstGeneration(db, options)).toBeUndefined();
    db.insertNode({ id: "first", name: "first", kind: "feature", summary: "indexing text" });
    const before = snapshot(db);

    const pending = scheduleFirstGeneration(db, options);
    expect(active(db)).toEqual(empty);
    expect(snapshot(db)).toEqual(before);
    queued.run();
    await pending;

    expect(embedFn).toHaveBeenCalledTimes(2);
    expect(active(db).generation).toBe(empty.generation);
    expect(active(db).dim).toBe(2);
    expect(vectorChannelState(db)).toEqual({ state: "on" });
    expect(snapshot(db).canonical).not.toEqual(before.canonical);
  });

  it.each(["opt_out", "removed", "foreign", "complete"])("rechecks %s before queued work starts", async (change) => {
    const db = fresh(["first"]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const queued = background();
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));
    const pending = scheduleFirstGeneration(db, { defer: queued.defer, embedFn });
    if (change === "opt_out") vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "0");
    if (change === "removed") db.softDeleteNode("first", "B2_QUEUED_REMOVE");
    if (change === "foreign") await index(db, "b2-foreign");
    if (change === "complete") await index(db, MODEL_NAME);
    const before = snapshot(db);

    queued.run();
    await pending;

    expect(embedFn).not.toHaveBeenCalled();
    expect(snapshot(db)).toEqual(before);
    expect(db.execSqlAll("SELECT tool FROM timeline WHERE tool='auto_reembed'")).toEqual([]);
  });

  it("does not replace a foreign generation published while automatic warmup is awaiting", async () => {
    const db = fresh(["first"]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const queued = background();
    const warmup = deferred<Buffer>();
    const started = deferred();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const embedFn = vi.fn(async (): Promise<Buffer> => { started.resolve(undefined); return warmup.promise; });
    const pending = scheduleFirstGeneration(db, { defer: queued.defer, embedFn });
    queued.run();
    await started.promise;
    expect(db.getVectorGeneration()).toBeNull();
    await index(db, "b2-foreign", [0, 1]);
    const foreign = active(db);
    const before = snapshot(db);

    warmup.resolve(vector(1, 0));
    await pending;

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(active(db)).toEqual(foreign);
    expect(snapshot(db)).toEqual(before);
    expect(stderr).not.toHaveBeenCalled();
    expect(db.execSqlAll("SELECT tool FROM timeline WHERE tool='auto_reembed'")).toEqual([]);
  });

  it("B2 preserves generation published between warmup guard and generation begin", async () => {
    const db = fresh(["first"]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const queued = background();
    const warmup = deferred<Buffer>();
    const eligible = vi.spyOn(db, "getReembedEligibleCount");
    const begin = vi.spyOn(db, "beginVectorGeneration");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const embedFn = vi.fn((_text: string): Promise<Buffer> =>
      ++calls === 1 ? warmup.promise : Promise.resolve(vector(1, 0)));
    const pending = scheduleFirstGeneration(db, { defer: queued.defer, embedFn });
    queued.run();
    let foreign!: VectorGeneration;
    let before!: ReturnType<typeof snapshot>;
    // Registered after the wrapper's await: runs after its guard, before reembed resumes.
    const published = warmup.promise.then(() => {
      expect(eligible).toHaveBeenCalledTimes(3);
      expect(begin).not.toHaveBeenCalled();
      const generation = db.beginVectorGeneration({ model: "b2-foreign", profile: embeddingProfile("b2-foreign"), dim: 0 });
      expect(db.publishNodeEmbedding({ ...generation, id: "first", name: "first", kind: "feature", summary: "indexing text" }, vector(0, 1))).toBe(true);
      foreign = active(db);
      expect(db.finishVectorGeneration(foreign)).toBe(true);
      before = snapshot(db);
    });

    warmup.resolve(vector(1, 0));
    await published;
    await pending;

    expect(active(db)).toEqual(foreign);
    expect(snapshot(db)).toEqual(before);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(db.execSqlAll("SELECT tool FROM timeline WHERE tool='auto_reembed'")).toEqual([]);
  });

  it.each(["before_dispatch", "during_warmup"])("closing the DB %s safely ends background work without mutations", async (when) => {
    const source = fresh(["first"]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const observer = new KnowledgeDB(source.dbPath);
    const queued = background();
    const warmup = deferred<Buffer>();
    const started = deferred();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const embedFn = vi.fn(async (): Promise<Buffer> => { started.resolve(undefined); return warmup.promise; });
    try {
      const before = snapshot(observer);
      const pending = scheduleFirstGeneration(source, { defer: queued.defer, embedFn });
      if (when === "during_warmup") { queued.run(); await started.promise; }
      source.close();
      db = undefined;
      if (when === "before_dispatch") queued.run();
      warmup.resolve(vector(1, 0));
      await expect(pending).resolves.toBeUndefined();

      expect(embedFn).toHaveBeenCalledTimes(when === "during_warmup" ? 1 : 0);
      expect(observer.getVectorGeneration()).toBeNull();
      expect(snapshot(observer)).toEqual(before);
      expect(observer.execSqlAll("SELECT tool FROM timeline WHERE tool='auto_reembed'")).toEqual([]);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally { observer.close(); }
  });

  it.each(["create", "update"])("%s response is unchanged and returns before its injected background attempt", async (operation) => {
    const db = fresh(operation === "create" ? [] : ["first"]);
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const queued = background();
    const embedFn = vi.fn(async (): Promise<Buffer> => vector(1, 0));
    const schedule = vi.spyOn(autoReembed, "scheduleFirstGeneration").mockImplementation((target) =>
      scheduleFirstGeneration(target, { defer: queued.defer, embedFn }));
    const summary = "A verified background indexing fixture with concrete generation ownership and deterministic publication.";

    if (operation === "create") {
      expect(await createConcept(db, { name: "Background Create", kind: "feature", summary })).toEqual({
        id: "background-create", message: 'Created concept "background-create"',
      });
    } else {
      expect(await updateConcept(db, { id: "first", changes: { summary } })).toEqual({ message: 'Updated concept "first".' });
    }

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(queued.defer).toHaveBeenCalledTimes(1);
    expect(embedFn).not.toHaveBeenCalled();
    expect(db.getVectorGeneration()).toBeNull();
    expect(db.getReembedEligibleCount()).toBe(1);
    queued.run();
    await schedule.mock.results[0].value;
    expect(embedFn).toHaveBeenCalledTimes(2);
    expect(vectorChannelState(db)).toEqual({ state: "on" });
  });

  it("audit profiles force subprocess opt-out and isolated home restores the prior setting", async () => {
    vi.stubEnv("MEGAMEMORY_AUTO_REEMBED", "1");
    const fixture = auditFixture();
    try {
      expect(fixture.profile().env.MEGAMEMORY_AUTO_REEMBED).toBe("0");
      expect(process.env.MEGAMEMORY_AUTO_REEMBED).toBe("1");
      expect(fixture.isolateHome().env.MEGAMEMORY_AUTO_REEMBED).toBe("0");
      expect(process.env.MEGAMEMORY_AUTO_REEMBED).toBe("0");
    } finally { await fixture.close(); }
    expect(process.env.MEGAMEMORY_AUTO_REEMBED).toBe("1");
  });
});
