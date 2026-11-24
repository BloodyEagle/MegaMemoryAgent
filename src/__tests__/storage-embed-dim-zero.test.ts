import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { reembed } from "../reembed.js";
import { vectorChannelState, vectorSearchEnabled, type StorageEmbeddingOptions } from "../embeddings.js";
import { createConcept } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("MODEL_DOWNLOAD_FORBIDDEN"); }),
}));

const { vector } = vi.hoisted(() => ({
  vector: () => {
    const buffer = Buffer.alloc(8);
    buffer.writeFloatLE(0, 0);
    buffer.writeFloatLE(1, 4);
    return buffer;
  },
}));

// The real embedForStorage with an injected embedder: the tool path under test
// is production code, only the model inference is replaced.
vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embedForStorage: (db: KnowledgeDB, text: string, opts: StorageEmbeddingOptions = {}) =>
      actual.embedForStorage(db, text, { ...opts, embedFn: async () => vector() }),
  };
});

let db: KnowledgeDB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-storage-dim-zero-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

afterEach(async () => {
  await closeAndCleanup(db, tmpDir);
});

const storedHex = (id: string): string =>
  (db.execSqlFirst("SELECT hex(embedding) AS embedding FROM nodes WHERE id=?", id) as { embedding: string })
    .embedding;

describe("B1: storage write into a generation with dim = 0", () => {
  it("no generation: createConcept still stores no vector", async () => {
    const result = await createConcept(db, {
      name: "No Generation",
      kind: "module",
      summary: "A node written while the base has no vector generation keeps no embedding.",
    });
    expect(storedHex(result.id ?? "")).toBe("");
    expect(vectorChannelState(db)).toEqual({ state: "off", reason: "no_generation" });
  });

  it("reembed on an empty base, then createConcept: the node carries a vector and the channel is on", async () => {
    expect(await reembed(db, { embedFn: async () => vector() })).toMatchObject({ processed: 0, dim: 0 });
    expect(vectorChannelState(db)).toEqual({ state: "off", reason: "generation_without_vectors" });

    const result = await createConcept(db, {
      name: "First Node",
      kind: "module",
      summary: "The first node written into a generation that still has dim = 0 publishes its vector and fixes the dimension.",
    });

    expect(storedHex(result.id ?? "")).toBe(vector().toString("hex").toUpperCase());
    expect(db.getVectorGeneration()?.dim).toBe(2);
    expect(vectorChannelState(db)).toEqual({ state: "on" });
    expect(vectorSearchEnabled(db)).toBe(true);
  });
});
