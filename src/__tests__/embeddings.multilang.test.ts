import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { reembed } from "../reembed.js";
import {
  MODEL_NAME,
  passageText,
  queryText,
  vectorSearchEnabled,
} from "../embeddings.js";

let tmpDir: string;
let db: KnowledgeDB | undefined;
const profile = process.env.USERPROFILE ?? os.tmpdir();
const managedCleanup = path.basename(profile).startsWith("mm-new6-owned-");
const deferredCleanup = new Set<string>();

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(managedCleanup ? profile : os.tmpdir(), "mm-embed-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  return db;
}

afterEach(async () => {
  db?.close();
  db = undefined;
  if (!tmpDir) return;
  for (let i = 0; i < 40; i++) {
    (globalThis as { gc?: () => void }).gc?.();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  deferredCleanup.add(tmpDir);
});

afterAll(() => {
  for (const ownedDir of deferredCleanup) {
    (globalThis as { gc?: () => void }).gc?.();
    try { fs.rmSync(ownedDir, { recursive: true, force: true }); deferredCleanup.delete(ownedDir); }
    catch { /* The supervisor removes its isolated profile after worker exit. */ }
  }
  if (!deferredCleanup.size) return;
  if (!managedCleanup) throw new Error(`P10_OWNED_CLEANUP_FAILED ${[...deferredCleanup].join(",")}`);
  console.info(`P10_PARENT_CLEANUP_REQUIRED ${[...deferredCleanup].join(",")}`);
});

const FAKE_DIM = 8;

function fakeEmbed(expectedPrefix?: string) {
  let calls = 0;
  const fn = async (text: string): Promise<Buffer> => {
    if (expectedPrefix !== undefined && !text.startsWith(expectedPrefix)) {
      throw new Error(`expected prefix "${expectedPrefix}", got: ${text}`);
    }
    calls += 1;
    const vec = new Float32Array(FAKE_DIM).fill(calls);
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  };
  return { fn, getCalls: () => calls };
}

describe("e5 input prefixes", () => {
  it("adds passage:/query: for e5 models and nothing for MiniLM", () => {
    const e5 = "Xenova/multilingual-e5-small";
    const mini = "Xenova/all-MiniLM-L6-v2";
    expect(passageText("hello", e5)).toBe("passage: hello");
    expect(queryText("привет", e5)).toBe("query: привет");
    expect(passageText("hello", mini)).toBe("hello");
    expect(queryText("hello", mini)).toBe("hello");
  });
});

describe("vector search gating", () => {
  it("is disabled on model-only stamps and enabled only after explicit active-generation reembed", async () => {
    const db = freshDb();
    // Upstream-shaped db: vectors but no meta record of the model.
    expect(vectorSearchEnabled(db)).toBe(false);

    db.setMetaValue("embed_model", "Xenova/all-MiniLM-L6-v2");
    expect(vectorSearchEnabled(db)).toBe(false);

    db.setMetaValue("embed_model", MODEL_NAME);
    expect(vectorSearchEnabled(db)).toBe(false);
    db.insertNode({ id: "indexed", name: "Indexed", kind: "feature", summary: "generation fixture" });
    await reembed(db, { embedFn: fakeEmbed().fn });
    expect(vectorSearchEnabled(db)).toBe(true);
  });
});

describe("reembed", () => {
  it("nulls old vectors on model switch, fills WHERE embedding IS NULL, stamps meta", async () => {
    const db = freshDb();
    for (let i = 1; i <= 7; i++) {
      db.insertNode({
        id: `n${i}`,
        name: `Node ${i}`,
        kind: "feature",
        summary: `summary ${i}`,
      });
    }
    // Old-model vectors present.
    db.setMetaValue("embed_model", "Xenova/all-MiniLM-L6-v2");
    const stale = new Float32Array(FAKE_DIM).fill(99);
    db.execSqlRun("UPDATE nodes SET embedding = @e", {
      e: Buffer.from(stale.buffer, stale.byteOffset, stale.byteLength),
    });

    // First attempt dies mid-way — like an interrupted run.
    let calls = 0;
    const failing = async (text: string): Promise<Buffer> => {
      calls += 1;
      if (calls > 3) throw new Error("interrupted");
      const vec = new Float32Array(FAKE_DIM).fill(calls);
      return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    };
    await expect(
      reembed(db, { batch: 2, embedFn: failing })
    ).rejects.toThrow("interrupted");

    // Old vectors were nulled up front; the 3 filled rows are new-model.
    const withVec = db.getAllActiveNodesWithEmbeddings();
    expect(withVec).toHaveLength(3);
    expect(db.getMetaValue("embed_model")).toBe(MODEL_NAME);
    expect(vectorSearchEnabled(db)).toBe(true);

    // Resume: fills the remaining 4 and stamps meta.
    const fake = fakeEmbed("passage: ");
    const result = await reembed(db, { batch: 2, embedFn: fake.fn });
    expect(result.processed).toBe(4);
    expect(result.total).toBe(7);
    expect(result.dim).toBe(FAKE_DIM);
    expect(result.model).toBe(MODEL_NAME);
    expect(db.getMetaValue("embed_dim")).toBe(String(FAKE_DIM));
    expect(db.getMetaValue("last_reembed")).toBeTruthy();
    expect(vectorSearchEnabled(db)).toBe(true);

    // All 7 embeddings exist and are FAKE_DIM floats (Buffer-normalized).
    const all = db.getAllActiveNodesWithEmbeddings();
    expect(all).toHaveLength(7);
    expect(all.every((n) => n.embedding !== null && n.embedding.length === FAKE_DIM * 4)).toBe(true);
  });
});
