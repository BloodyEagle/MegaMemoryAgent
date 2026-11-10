import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { understand, estimateTokens, trimSummary, listRoots } from "../tools.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-budget-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

// 20 nodes with ~2 KB summaries each.
function insertFatNodes(db: KnowledgeDB, count: number): void {
  const fat = "Слово ".repeat(350); // ~2100 chars, cyrillic
  for (let i = 1; i <= count; i++) {
    db.insertNode({
      id: `fat-node-${String(i).padStart(2, "0")}`,
      name: `Fat Node ${i}`,
      kind: "feature",
      summary: `${fat} маркер-${i}`,
    });
  }
}

describe("estimateTokens / trimSummary", () => {
  it("estimates ceil(utf8 bytes / 3) — А6", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(2); // 4 bytes
    // cyrillic: 10 chars = 20 bytes
    expect(estimateTokens("привет мир")).toBe(7);
    // chinese: 3 chars = 9 bytes -> 3; chars/3 would wrongly say 1
    expect(estimateTokens("模块设计")).toBe(4); // 4 chars x 3 bytes
  });

  it("trims cyrillic by characters, never by bytes, at word boundary", () => {
    const long = "ё".repeat(500); // each ё is 2 bytes in UTF-8
    const out = trimSummary(long, 240);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith("…")).toBe(true);
    // 500-char surrogate-free string: character count, not byte count.
    expect(trimSummary("слово " + "х".repeat(400), 240)).toContain("слово");
  });
});

describe("understand compact mode budget", () => {
  it("keeps the hard cap: no card fits — empty answer with an explicit budget reason", async () => {
    const db = freshDb();
    insertFatNodes(db, 20);

    const result = await understand(db, {
      query: "Слово",
      top_k: 20,
      max_tokens: 500,
    });

    expect(result.meta).toBeDefined();
    // Бюджет — жёсткий потолок, а не пожелание: карточка сверх лимита не
    // отдаётся. Пустой ответ обязан называть причину, иначе он читается как
    // «ничего не нашлось» — это и было регрессом.
    expect(result.compact!.length).toBe(0);
    expect(result.meta!.returned).toBe(0);
    expect(result.meta!.truncated).toBe(true);
    expect(result.meta!.reason).toBe("budget");
    expect(result.meta!.dropped).toBe(20);
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(500);
    // U6: the explorer derives "saved vs full" from this pair.
    expect(result.meta!.estimated_full_tokens).toBeGreaterThan(result.meta!.tokens_estimated);
  });

  it("places cards when the budget has room and never claims a budget reason", async () => {
    const db = freshDb();
    insertFatNodes(db, 20);

    const result = await understand(db, {
      query: "Слово",
      top_k: 20,
      max_tokens: 8000,
    });

    expect(result.meta).toBeDefined();
    expect(result.meta!.returned).toBeGreaterThanOrEqual(1);
    expect(result.meta!.returned).toBe(result.compact!.length);
    expect(result.meta!.returned + result.meta!.dropped).toBe(20);
    expect(result.meta!.reason).toBeUndefined();
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(8000);
    // Every compact node is trimmed to <=240 chars.
    expect(result.compact!.every((m) => m.summary.length <= 240)).toBe(true);
  });

  it("full mode returns legacy shape with why/children", async () => {
    const db = freshDb();
    db.insertNode({
      id: "parent",
      name: "Parent",
      kind: "module",
      summary: "parent summary",
    });
    db.insertNode({
      id: "parent/child",
      name: "Child",
      kind: "feature",
      summary: "child summary",
      parent_id: "parent",
    });

    const result = await understand(db, {
      query: "parent summary",
      mode: "full",
      top_k: 5,
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].why).toBeNull();
    expect(result.matches[0].children.length).toBe(1);
    expect(result.compact).toBeUndefined();
  });

  it("empty result does not throw", async () => {
    const db = freshDb();
    const result = await understand(db, { query: "ничего", max_tokens: 500 });
    expect(result.compact).toEqual([]);
    expect(result.meta?.returned).toBe(0);
  });
});

describe("listRoots budgeted overview", () => {
  it("returns roots_compact with child counts and meta", () => {
    const db = freshDb();
    db.insertNode({ id: "r1", name: "Root One", kind: "module", summary: "s1" });
    db.insertNode({ id: "r2", name: "Root Two", kind: "module", summary: "s2" });
    db.insertNode({ id: "r2/child", name: "Kid", kind: "feature", summary: "c", parent_id: "r2" });

    const result = listRootsForTest(db);
    expect(result.compact).toBe(true);
    expect(result.roots_compact).toHaveLength(2);
    const r2 = result.roots_compact!.find((r) => r.id === "r2");
    expect(r2?.child_count).toBe(1);
    expect(result.roots_compact!.every((r) => !("summary" in r))).toBe(true);
    expect(result.meta?.tokens_estimated).toBeGreaterThan(0);
  });
});

function listRootsForTest(db: KnowledgeDB) {
  return listRoots(db, { max_tokens: 1500 });
}

describe("patches v1.1: zh budget (А6/В15) and edges_between (В14)", () => {
  it("20 chinese nodes, max_tokens=500: estimate holds", async () => {
    const db = freshDb();
    const fat = "支付模块设计说明".repeat(260); // ~2080 chars = ~6240 bytes
    for (let i = 1; i <= 20; i++) {
      db.insertNode({
        id: "zh-" + String(i).padStart(2, "0"),
        name: "节点" + i,
        kind: "feature",
        summary: fat + "标记" + i,
      });
    }
    const result = await understand(db, { query: "支付", top_k: 20, max_tokens: 500 });
    // План 06 K-04 / план 13: карточка ~2000+ токенов в бюджет 500 не
    // помещается целиком — честный ответ воронки: пустой список, усечение
    // помечено, полный размер оценён. Ноль — валидный результат, «хоть одна
    // карточка любой ценой» (эпоха v1.1) больше не переувеличивает бюджет.
    expect(result.meta!.returned).toBe(0);
    expect(result.meta!.dropped).toBe(20);
    expect(result.meta!.estimated_full_tokens).toBeGreaterThan(500);
    // План 13 §2.1: блок next присутствует в каждом ответе, и его record не
    // режется никогда — кап соблюдается с точностью до этого постоянного
    // минимума, а превышение помечается meta.truncated (мера остаётся честной).
    const NEXT_FLOOR_TOKENS = 96;
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(500 + NEXT_FLOOR_TOKENS);
    expect(result.meta!.truncated).toBe(true);
  });

  it("compact output carries edges_between (В14)", async () => {
    const db = freshDb();
    db.insertNode({ id: "a", name: "Alpha", kind: "module", summary: "alpha node" });
    db.insertNode({ id: "b", name: "Beta", kind: "feature", summary: "beta node" });
    db.insertEdge({ from_id: "a", to_id: "b", relation: "connects_to" });
    const result = await understand(db, { query: "node", top_k: 5, max_tokens: 1500 });
    expect(result.edges_between).toEqual([{ from: "a", to: "b", relation: "connects_to" }]);
  });
});
