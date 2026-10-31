import { describe, it, expect, afterEach } from "vitest";
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
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-embed-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
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
  it("is disabled on model mismatch and enabled after matching meta", () => {
    const db = freshDb();
    // Upstream-shaped db: vectors but no meta record of the model.
    expect(vectorSearchEnabled(db)).toBe(false);

    db.setMetaValue("embed_model", "Xenova/all-MiniLM-L6-v2");
    expect(vectorSearchEnabled(db)).toBe(false);

    db.setMetaValue("embed_model", MODEL_NAME);
    expect(vectorSearchEnabled(db)).toBe(true);
  });
});

describe("reembed", () => {
  it("fills embeddings in batches, stamps meta, resumable after failure", async () => {
    const db = freshDb();
    for (let i = 1; i <= 7; i++) {
      db.insertNode({
        id: `n${i}`,
        name: `Node ${i}`,
        kind: "feature",
        summary: `summary ${i}`,
      });
    }
    db.setMetaValue("embed_model", "Xenova/all-MiniLM-L6-v2"); // mismatch

    // First attempt dies mid-way (after 3 nodes) — like an interrupted run.
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
    // Cursor persisted up to the last COMPLETED batch (nodes 1-2); node 3
    // was mid-batch and will be re-embedded on resume (idempotent).
    expect(db.getMetaValue("reembed_cursor")).toBe("2");
    // Model not stamped yet — vector search stays disabled.
    expect(vectorSearchEnabled(db)).toBe(false);

    // Resume: re-embeds node 3, completes the rest, stamps meta.
    const fake = fakeEmbed("passage: ");
    const result = await reembed(db, { batch: 2, embedFn: fake.fn });
    expect(result.processed).toBe(5);
    expect(result.total).toBe(7);
    expect(result.dim).toBe(FAKE_DIM);
    expect(result.model).toBe(MODEL_NAME);
    expect(db.getMetaValue("embed_model")).toBe(MODEL_NAME);
    expect(db.getMetaValue("embed_dim")).toBe(String(FAKE_DIM));
    expect(db.getMetaValue("reembed_cursor")).toBeUndefined();
    expect(db.getMetaValue("last_reembed")).toBeTruthy();
    expect(vectorSearchEnabled(db)).toBe(true);

    // All 7 embeddings now exist and are FAKE_DIM floats (Buffer-normalized).
    const withVec = db.getAllActiveNodesWithEmbeddings();
    expect(withVec).toHaveLength(7);
    expect(withVec.every((n) => n.embedding.length === FAKE_DIM * 4)).toBe(true);
  });
});
