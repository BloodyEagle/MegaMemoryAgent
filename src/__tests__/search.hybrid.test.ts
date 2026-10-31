import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { hybridSearch, rrfMerge, hasCjk } from "../search.js";
import { ensureSchema } from "../migrate-schema.js";
import { MODEL_NAME } from "../embeddings.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(withTrigram = false): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-search-"));
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
  if (db) await closeAndCleanup(db, tmpDir);
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
    const vec = new Float32Array([1, 0, 0, 0]);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    // Named param: libsql panics on single-positional Buffer statements.
    db.execSqlRun("UPDATE nodes SET embedding = @e", { e: buf });
    db.setMetaValue("embed_model", MODEL_NAME); // enable vector channel
    db.setMetaValue("embed_dim", "4");

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
    const v1 = new Float32Array([1, 0, 0, 0]);
    const v2 = new Float32Array([0, 1, 0, 0]);
    const toBuf = (v: Float32Array) =>
      Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    db.execSqlRun("UPDATE nodes SET embedding = @e WHERE id = @id", {
      e: toBuf(v1),
      id: "alpha",
    });
    db.execSqlRun("UPDATE nodes SET embedding = @e WHERE id = @id", {
      e: toBuf(v2),
      id: "beta",
    });
    db.setMetaValue("embed_model", MODEL_NAME);
    db.setMetaValue("embed_dim", "4");

    // Populate the native shadow table — the SQL path must serve the hits.
    db.upsertVector("alpha", toBuf(v1));
    db.upsertVector("beta", toBuf(v2));
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
