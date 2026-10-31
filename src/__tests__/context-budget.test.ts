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
  it("estimates ceil(len/3)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(2); // ceil(4/3)
    expect(estimateTokens("привет мир")).toBe(4); // ceil(10/3)
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
  it("respects max_tokens, drops nodes, always returns at least one", async () => {
    const db = freshDb();
    insertFatNodes(db, 20);

    const result = await understand(db, {
      query: "Слово",
      top_k: 20,
      max_tokens: 500,
    });

    expect(result.meta).toBeDefined();
    expect(result.meta!.returned).toBeGreaterThanOrEqual(1);
    expect(result.meta!.dropped).toBeGreaterThan(0);
    expect(result.meta!.returned + result.meta!.dropped).toBe(20);
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(500);
    expect(result.compact!.length).toBe(result.meta!.returned);
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
