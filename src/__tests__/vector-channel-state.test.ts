import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { reembed } from "../reembed.js";
import {
  MODEL_NAME,
  vectorChannelState,
  vectorSearchEnabled,
  type VectorChannelState,
} from "../embeddings.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("MODEL_DOWNLOAD_FORBIDDEN"); }),
}));

let db: KnowledgeDB | undefined;
let tmpDir: string | undefined;

const vector = () => {
  const buffer = Buffer.alloc(8);
  buffer.writeFloatLE(0, 0);
  buffer.writeFloatLE(1, 4);
  return buffer;
};
const embedFn = async () => vector();
const node = { id: "first", name: "first", kind: "feature", summary: "indexing text" };

async function fresh(prepare: (target: KnowledgeDB) => void | Promise<void>): Promise<KnowledgeDB> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-vector-channel-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  await prepare(db);
  return db;
}

const off = (reason: "text_only_mode" | "no_generation" | "generation_without_vectors" | "model_mismatch") =>
  ({ state: "off", reason }) as VectorChannelState;

const stages: Record<string, { prepare: (target: KnowledgeDB) => void | Promise<void>; expected: VectorChannelState }> = {
  "no generation": { prepare: () => {}, expected: off("no_generation") },
  "stamp without a generation": {
    prepare: (target) => { target.setMetaValue("embed_model", MODEL_NAME); },
    expected: off("no_generation"),
  },
  "reembed on an empty base": { prepare: async (target) => { await reembed(target, { embedFn }); }, expected: off("generation_without_vectors") },
  "first row published": {
    prepare: async (target) => { target.insertNode(node); await reembed(target, { embedFn }); },
    expected: { state: "on" },
  },
  "unknown model": { prepare: (target) => { target.setMetaValue("embed_model", "unknown"); }, expected: off("model_mismatch") },
  "another recorded model": { prepare: (target) => { target.setMetaValue("embed_model", "other-model"); }, expected: off("model_mismatch") },
  "generation of another model": {
    prepare: async (target) => { target.insertNode(node); await reembed(target, { model: "other-model", embedFn }); },
    expected: off("model_mismatch"),
  },
  "same model, other preprocessing": {
    prepare: async (target) => {
      target.insertNode(node);
      await reembed(target, { embedFn });
      const changed = JSON.parse(target.getVectorGeneration()!.profile);
      changed.normalize = false;
      target.beginVectorGeneration({ model: MODEL_NAME, dim: 2, profile: JSON.stringify(changed) });
    },
    expected: off("model_mismatch"),
  },
};

afterEach(async () => {
  vi.unstubAllEnvs();
  if (db && tmpDir) await closeAndCleanup(db, tmpDir);
  db = undefined;
  tmpDir = undefined;
});

describe("vectorChannelState", () => {
  it("fresh base carries no model stamp and no generation", async () => {
    const target = await fresh(() => {});
    expect(target.getMetaValue("embed_model")).toBeUndefined();
    expect(target.getVectorGeneration()).toBeNull();
  });

  it.each(Object.entries(stages))("%s is reported honestly", async (_name, { prepare, expected }) => {
    const target = await fresh(prepare);
    expect(vectorChannelState(target)).toEqual(expected);
  });

  it.each(Object.entries(stages))("%s: on exactly when vectorSearchEnabled holds", async (_name, { prepare }) => {
    const target = await fresh(prepare);
    expect(vectorChannelState(target).state === "on").toBe(vectorSearchEnabled(target));
  });

  it("reembed on an empty base leaves dim = 0 behind", async () => {
    const target = await fresh(async (inner) => { await reembed(inner, { embedFn }); });
    expect(target.getVectorGeneration()?.dim).toBe(0);
  });

  it.each(["no generation", "reembed on an empty base", "first row published", "another recorded model"])(
    "MEGAMEMORY_SEARCH=fts overrides the %s state",
    async (name) => {
      vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
      const target = await fresh(stages[name].prepare);
      expect(vectorChannelState(target)).toEqual(off("text_only_mode"));
    }
  );

  it("judges against the expected model, not only the package default", async () => {
    const target = await fresh(stages["generation of another model"].prepare);
    expect(vectorChannelState(target)).toEqual(off("model_mismatch"));
    expect(vectorChannelState(target, "other-model")).toEqual({ state: "on" });
  });
});
