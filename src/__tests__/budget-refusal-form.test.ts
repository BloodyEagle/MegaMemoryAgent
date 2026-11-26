import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { understand } from "../tools.js";
import { getConceptProfile } from "../concept-profile.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// План 36 T3: отказ по бюджету пинит ФОРМУ числа, а не его значение.
// Тексты двух сайтов не объединяются (understand — русский CLI-текст,
// get_concept — английский MCP-текст): проверяется источник числа —
// оба интерполируют вычисленную меру, литералов 544/482 в src нет.

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-budget-form-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

function insertFatNodes(db: KnowledgeDB, count: number): void {
  const fat = "Слово ".repeat(350); // ~2100 символов, кириллица
  for (let i = 1; i <= count; i++) {
    db.insertNode({
      id: `fat-node-${String(i).padStart(2, "0")}`,
      name: `Fat Node ${i}`,
      kind: "feature",
      summary: `${fat} маркер-${i}`,
    });
  }
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("budget refusal form", () => {
  it("understand: refusal message carries exactly one computed minimum (no pinned literal)", async () => {
    const db = freshDb();
    insertFatNodes(db, 20);

    let message = "";
    let minimum = 0;
    try {
      await understand(db, { query: "Слово", top_k: 20, max_tokens: 1 });
      expect.unreachable("understand must refuse a floor-sized budget");
    } catch (error) {
      message = String(error);
      const match = message.match(/ниже минимума (\d+)/);
      expect(match, `refusal form: ${message}`).toBeTruthy();
      minimum = Number(match![1]);
    }
    expect(minimum).toBeGreaterThan(0);
    // Число минимума в сообщении ровно одно — никакого второго «544/482».
    expect(message.match(/ниже минимума \d+/g)).toHaveLength(1);
    expect(message).not.toMatch(/\b544\b/);
    expect(message).not.toMatch(/\b482\b/);

    // Названное число больше не бросает отказ «ниже минимума» (первый сайт).
    let refusedAgain = false;
    try {
      await understand(db, { query: "Слово", top_k: 20, max_tokens: minimum });
    } catch (error) {
      refusedAgain = /ниже минимума \d+/.test(String(error));
    }
    expect(refusedAgain).toBe(false);
  });

  it("get_concept: refusal prints one computed minimum and the named number fits", () => {
    const db = freshDb();
    db.insertNode({ id: "budget-node-1", name: "Budget Node 1", kind: "fact", summary: "Слово слово слово." });

    // 1 < MIN_PROFILE_TOKENS (100) вообще не доходит до бюджетного отказа —
    // «заведомо малый» бюджет должен пройти гард ≥ 100 и всё же не влезть.
    let message = "";
    let minimum = 0;
    expect(() => getConceptProfile(db, { id: "budget-node-1", max_tokens: 100 })).toThrow();
    try {
      getConceptProfile(db, { id: "budget-node-1", max_tokens: 100 });
    } catch (error) {
      message = String(error);
      const match = message.match(/minimum (\d+)/);
      expect(match, `refusal form: ${message}`).toBeTruthy();
      minimum = Number(match![1]);
    }
    expect(minimum).toBeGreaterThan(0);
    expect(message.match(/minimum \d+/g)).toHaveLength(1);
    expect(message).not.toMatch(/\b544\b/);
    expect(message).not.toMatch(/\b482\b/);

    // Повторный вызов с названным числом — отказ по минимуму не бросается.
    expect(() => getConceptProfile(db, { id: "budget-node-1", max_tokens: minimum })).not.toThrow();
  });
});
