import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { hybridSearch, rrfMerge, hasCjk } from "../search.js";
import { ensureSchema } from "../migrate-schema.js";
import { reembed } from "../reembed.js";

let tmpDir: string;
let db: KnowledgeDB | undefined;
const profile = process.env.USERPROFILE ?? os.tmpdir();
const managedCleanup = path.basename(profile).startsWith("mm-new6-owned-");
const deferredCleanup = new Set<string>();

function freshDb(withTrigram = false): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(managedCleanup ? profile : os.tmpdir(), "mm-search-"));
  if (withTrigram) {
    process.env.MEGAMEMORY_FTS_TOKENIZER = "trigram";
  }
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  delete process.env.MEGAMEMORY_FTS_TOKENIZER;
  return db;
}

afterEach(async () => {
  delete process.env.MEGAMEMORY_SEARCH;
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

function insertNode(db: KnowledgeDB, id: string, name: string, summary: string): void {
  db.insertNode({ id, name, kind: "feature", summary });
}

const fakeEmbed = (vec: number[]) => async (): Promise<Buffer> => {
  const v = new Float32Array(vec);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
};

describe("hybridSearch (vector disabled — no meta stamp)", () => {
  it("finds russian node by exact word, with via=fts", async () => {
    const db = freshDb();
    insertNode(db, "книга", "Книга", "рецепты кулинария и тесто");
    insertNode(db, "модуль", "Модуль платежей", "платёжный шлюз");

    const hits = await hybridSearch(db, "кулинария", { topK: 5 });
    expect(hits[0]?.id).toBe("книга");
    expect(hits[0]?.via).toBe("fts");
  });

  it("finds chinese node via trigram table (>=3 chars)", async () => {
    const db = freshDb(true);
    insertNode(db, "模块", "模块设计", "支付模块");
    insertNode(db, "book", "Book", "english summary");

    const hits = await hybridSearch(db, "模块设计", { topK: 5 });
    expect(hits[0]?.id).toBe("模块");
    expect(hits[0]?.via).toBe("fts");
  });

  it("short CJK query falls back to LIKE", async () => {
    const db = freshDb(true);
    insertNode(db, "模块", "模块设计", "支付模块");

    const hits = await hybridSearch(db, "模块", { topK: 5 });
    expect(hits[0]?.id).toBe("模块");
  });

  it("empty index returns empty result without throwing", async () => {
    const db = freshDb();
    const hits = await hybridSearch(db, "что-то", { topK: 5 });
    expect(hits).toEqual([]);
  });
});

describe("hybridSearch (vector enabled)", () => {
  it("merges both channels and marks via=both for double hits", async () => {
    const db = freshDb();
    insertNode(db, "alpha", "Alpha Book", "reading");
    insertNode(db, "beta", "Beta Pen", "writing");
    // Explicit indexing establishes the fixture's active generation; model-only
    // stamps must never launder unknown historical vectors.
    await reembed(db, { embedFn: fakeEmbed([1, 0, 0, 0]) });

    const hits = await hybridSearch(db, "book", {
      topK: 5,
      embedFn: fakeEmbed([1, 0, 0, 0]),
    });
    expect(hits.length).toBeGreaterThan(0);
    const alpha = hits.find((h) => h.id === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.via).toBe("both");
  });
});

describe("rrfMerge", () => {
  it("ranks shared hits above single-channel hits", () => {
    const merged = rrfMerge(
      [
        { hits: [{ id: "a" }, { id: "b" }, { id: "c" }], via: "fts" },
        { hits: [{ id: "b" }, { id: "d" }], via: "vector" },
      ],
      60,
      10
    );
    expect(merged[0].id).toBe("b"); // present in both pools
    expect(merged[0].via).toBe("both");
  });
});

describe("hasCjk", () => {
  it("detects CJK and ignores cyrillic/latin", () => {
    expect(hasCjk("模块设计")).toBe(true);
    expect(hasCjk("ひらがな")).toBe(true);
    expect(hasCjk("книга")).toBe(false);
    expect(hasCjk("book")).toBe(false);
  });
});

describe("patches v1.1: prefix morphology (М3), sanitization (М1), native vectors (В17)", () => {
  it("prefix query finds nodes by incomplete word: книг -> Книга", async () => {
    const db = freshDb();
    insertNode(db, "книга", "Книга", "рецепты и заметки");
    const hits = await hybridSearch(db, "книг", { topK: 5 });
    expect(hits[0]?.id).toBe("книга");
  });

  it("raw quotes in query do not throw (М1 sanitization)", async () => {
    const db = freshDb();
    insertNode(db, "quoted", 'Say "hi" now', "greeting");
    const hits = await hybridSearch(db, 'say "hi"', { topK: 5 });
    expect(hits[0]?.id).toBe("quoted");
  });

  it("native SQL vector path drives the vector channel (В17)", async () => {
    const db = freshDb();
    insertNode(db, "alpha", "Alpha Book", "reading");
    insertNode(db, "beta", "Beta Pen", "writing");
    await reembed(db, { embedFn: async (text) =>
      fakeEmbed(text.includes("Alpha Book") ? [1, 0, 0, 0] : [0, 1, 0, 0])() });

    // Explicit publication fills the current native projection atomically.
    expect(db.vectorTableCount()).toBe(2);
    expect(db.vectorTableCount()).toBeGreaterThanOrEqual(
      db.countActiveWithEmbeddings()
    );

    const hits = await hybridSearch(db, "book", {
      topK: 5,
      embedFn: fakeEmbed([1, 0, 0, 0]),
    });
    const alpha = hits.find((h) => h.id === "alpha");
    const beta = hits.find((h) => h.id === "beta");
    expect(alpha?.via).toBe("both"); // fts + vector
    expect(beta?.via).toBe("vector"); // vector only, orthogonal to the query
  });
});
