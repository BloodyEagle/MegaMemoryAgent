import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { reembed } from "../reembed.js";
import { MODEL_NAME } from "../embeddings.js";
import { runDoctor, type DoctorCheck } from "../doctor.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("MODEL_DOWNLOAD_FORBIDDEN"); }),
}));

let db: KnowledgeDB | undefined;
let tmpDir: string | undefined;

const embedFn = async () => {
  const buffer = Buffer.alloc(8);
  buffer.writeFloatLE(0, 0);
  buffer.writeFloatLE(1, 4);
  return buffer;
};
const node = { id: "first", name: "first", kind: "feature", summary: "indexing text" };

async function fresh(prepare: (target: KnowledgeDB) => void | Promise<void>): Promise<KnowledgeDB> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-doctor-vector-channel-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  await prepare(db);
  return db;
}

function check(target: KnowledgeDB, name: string): DoctorCheck {
  const found = runDoctor(target).checks.find((candidate) => candidate.name === name);
  expect(found, `check "${name}" missing`).toBeDefined();
  return found!;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (db && tmpDir) await closeAndCleanup(db, tmpDir);
  db = undefined;
  tmpDir = undefined;
});

describe("doctor: the embedding model line follows the vector channel", () => {
  it.each([
    ["a fresh base without a model stamp", () => {}],
    ["a stamped base without a generation", (target: KnowledgeDB) => { target.setMetaValue("embed_model", MODEL_NAME); }],
  ])("%s never reads as vector search on", async (_name, prepare) => {
    const target = await fresh(prepare);
    const line = check(target, "embedding model");
    expect(line).toMatchObject({ ok: true });
    expect(line.detail).toContain("vector search OFF — no generation");
    expect(line.detail).toContain("megamemory reembed");
    expect(line.detail).not.toContain("vector search on");
    expect(line.detail).not.toContain("migrate");
  });

  it("a generation without vectors names both ways to get there", async () => {
    const target = await fresh(async (inner) => { await reembed(inner, { embedFn }); });
    const line = check(target, "embedding model");
    expect(line).toMatchObject({ ok: true });
    expect(line.detail).toContain("generation without vectors");
    expect(line.detail).toContain("empty base");
    expect(line.detail).toContain("megamemory reembed");
    expect(line.detail).not.toContain("vector search on");
  });

  it("the first published row turns the line to vector search on with counts", async () => {
    const target = await fresh(async (inner) => { inner.insertNode(node); await reembed(inner, { embedFn }); });
    expect(check(target, "embedding model")).toEqual({
      name: "embedding model",
      ok: true,
      detail: `${MODEL_NAME} (dim=2, vectors 1/1, vector search on)`,
    });
  });

  it.each(["unknown", "other-model"])("a recorded %s model stays a problem", async (model) => {
    const target = await fresh((inner) => { inner.setMetaValue("embed_model", model); });
    const line = check(target, "embedding model");
    expect(line).toMatchObject({ ok: false });
    expect(line.detail).toContain(model === "unknown" ? "model unknown" : `!= current ${MODEL_NAME}`);
    expect(line.detail).not.toContain("vector search on");
  });

  it.each(["fresh", "indexed"])("MEGAMEMORY_SEARCH=fts reports keyword-only search on an %s base", async (stage) => {
    vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
    const target = await fresh(async (inner) => {
      if (stage === "indexed") { inner.insertNode(node); await reembed(inner, { embedFn }); }
    });
    expect(check(target, "embedding model")).toEqual({
      name: "embedding model",
      ok: true,
      detail: "MEGAMEMORY_SEARCH=fts — keyword search only (configured)",
    });
  });
});

describe("doctor: the pending embeddings line names what search is left", () => {
  it("without a generation the pending line says the search is keyword-only", async () => {
    const target = await fresh((inner) => { inner.insertNode(node); });
    expect(check(target, "embeddings").detail).toBe(
      "1 node(s) await reembed (search is keyword-only: every query word must occur)"
    );
  });

  it("with vectors online the pending line says FTS covers the rest", async () => {
    const target = await fresh(async (inner) => {
      inner.insertNode(node);
      await reembed(inner, { embedFn });
      inner.insertNode({ ...node, id: "second", name: "second" });
    });
    expect(check(target, "embeddings").detail).toBe(
      "1 node(s) await reembed (vector search covers indexed nodes, FTS covers the rest)"
    );
  });
});
