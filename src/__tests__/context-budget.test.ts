import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { understand, estimateTokens, trimSummary, listRoots, measureMcpPayload } from "../tools.js";
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
  it("at the honest minimum a summary-less card may take the room", async () => {
    const db = freshDb();
    insertFatNodes(db, 20);

    // Пустой минимум считает сервер; небольшой запас всё ещё не позволяет
    // разместить квалифицированную карточку независимо от наличия модели.
    let minBudget = 0;
    try {
      await understand(db, { query: "Слово", top_k: 20, max_tokens: 1 });
    } catch (error) {
      expect(String(error)).toMatch(/минимума \d+/);
      minBudget = Number(String(error).match(/минимума (\d+)/)?.[1]);
    }
    expect(minBudget).toBeGreaterThan(0);

    // Пустой конверт дешевле честного ответа с reason/notice о потерях.
    // Если запас ниже второго минимума, сервер должен явно отказать; повтор
    // идёт ровно с названным минимумом, без льгот и искусственного floor.
    let budget = minBudget + 20;
    let result: Awaited<ReturnType<typeof understand>>;
    try {
      result = await understand(db, { query: "Слово", top_k: 20, max_tokens: budget });
    } catch (error) {
      expect(String(error)).toMatch(/cannot fit the instructions, qualification and loss notice \(minimum \d+\)/);
      const honestMinimum = Number(String(error).match(/minimum (\d+)/)?.[1]);
      expect(honestMinimum).toBeGreaterThan(budget);
      budget = honestMinimum;
      result = await understand(db, { query: "Слово", top_k: 20, max_tokens: budget });
    }

    expect(result.meta).toBeDefined();
    // Бюджет — жёсткий потолок: карточка сверх лимита не отдаётся. План 33
    // добавил в конверт обязательный search_warning, и прежнее окно «ниже
    // минимума и без карточек» сжалось: на минимуме сервер возвращает либо
    // пустой ответ с reason=budget, либо одну минимальную карточку без
    // summary (zh-контракт «optional summary уступить можно»). Регресс
    // «пустой ответ без причины» ловит условие ниже.
    expect(result.meta!.tokens_estimated).toBe(measureMcpPayload(result));
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(budget);
    if (result.compact!.length === 0) {
      expect(result.meta!.reason).toBe("budget");
      expect(result.meta!.cards).toBe(0);
    } else {
      expect(result.meta!.reason).toBeUndefined();
      expect(result.compact!.every((m) => !m.summary)).toBe(true);
    }
    expect(result.meta!.returned).toBe(result.candidates!.length);
    expect(result.meta!.truncated).toBe(true);
    // Discovery не является карточкой, но видимый кандидат уже не dropped.
    expect(result.meta!.dropped).toBe(20 - result.candidates!.length);
    expect(result.next!.record).toBeTruthy();
    // U6: the explorer derives "saved vs full" from this pair.
    expect(result.meta!.estimated_full_tokens).toBeGreaterThan(result.meta!.tokens_estimated);
  });

  // План 34 дельта 5 §3: пин на «названное число работает». Гейт — floor;
  // сжатые ответы на 482–543 легальны и гейтом дельты 3 были почти потеряны.
  // Число из второго отказа — достаточный бюджет, не минимальный (на жирной
  // фикстуре оно 544, а дешёвая сжатая форма стоит 482): проверяется только,
  // что на нём ответ помещается.
  it("pins the hard cap: the floor refuses, squeezed answers fit below the second refusal's number", async () => {
    const db = freshDb();
    insertFatNodes(db, 20);

    let floor = 0;
    try {
      await understand(db, { query: "Слово", top_k: 20, max_tokens: 1 });
      expect.unreachable("understand must refuse a floor-sized budget");
    } catch (error) {
      floor = Number(String(error).match(/ниже минимума (\d+)/)?.[1]);
    }
    expect(floor).toBeGreaterThan(0);
    await expect(understand(db, { query: "Слово", top_k: 20, max_tokens: floor })).rejects.toThrow(/cannot fit/);
    await expect(understand(db, { query: "Слово", top_k: 20, max_tokens: 450 })).rejects.toThrow(/cannot fit/);

    // Дешёвые сжатые ответы: одна карточка без summary дешевле пустой формы.
    const squeezed = await understand(db, { query: "Слово", top_k: 20, max_tokens: 500 });
    expect(squeezed.meta!.tokens_estimated).toBe(measureMcpPayload(squeezed));
    expect(squeezed.meta!.tokens_estimated).toBeLessThanOrEqual(500);

    for (const budget of [543, 544]) {
      const result = await understand(db, { query: "Слово", top_k: 20, max_tokens: budget });
      expect(result.meta!.tokens_estimated).toBe(measureMcpPayload(result));
      expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(budget);
      const compact = result.compact!;
      expect(compact.length === 0 || compact.length === 1).toBe(true);
      if (compact.length === 0) {
        expect(result.meta!.reason).toBe("budget");
      } else {
        expect(compact[0]).not.toHaveProperty("summary");
        expect(result.meta!.reason).toBeUndefined();
      }
      expect(result.meta!.cards).toBe(compact.length);
    }
  });

  // Ответ на свободном бюджете совпадает с фикстурой — барьер против мутаций
  // выдачи замерами бюджета (план 34, дельты 2–5).
  it("the served answer keeps the full fixture shape on a generous budget", async () => {
    const db = freshDb();
    insertFatNodes(db, 20);

    const result = await understand(db, { query: "Слово", top_k: 20, max_tokens: 8000 });

    expect(result.candidates!).toHaveLength(20);
    expect(result.compact!).toHaveLength(3);
    expect(result.meta!.cards).toBe(3);
    expect(result.meta!.reason).toBeUndefined();
    expect(result.meta!.tokens_estimated).toBe(measureMcpPayload(result));
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
    expect(result.candidates!).toHaveLength(20);
    expect(result.meta!.returned).toBe(result.candidates!.length);
    expect(result.meta!.cards).toBe(result.compact!.length);
    expect(result.compact!).toHaveLength(3);
    const visibleIds = new Set([
      ...result.candidates!.map((candidate) => candidate.id),
      ...result.compact!.map((card) => card.id),
    ]);
    expect(visibleIds.size + result.meta!.dropped).toBe(20);
    expect(result.meta!.dropped).toBe(0);
    expect(result.meta!.reason).toBeUndefined();
    expect(result.meta!.tokens_estimated).toBe(measureMcpPayload(result));
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(8000);
    // Every compact node is trimmed to <=240 chars; summary may be omitted
    // entirely when squeezed, an absent field is not an overlong one.
    expect(result.compact!.every((m) => String(m.summary ?? "").length <= 240)).toBe(true);
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
  it("20 chinese nodes, max_tokens=600: estimate holds", async () => {
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
    // План 33: обязательный search_warning поднял минимум пустого конверта
    // с ~465 до 544 — бюджет 500 больше не помещает даже его, поэтому тест
    // честности оценки идёт с запасом 600, а не подгонкой под старое число.
    const cap = 600;
    const result = await understand(db, { query: "支付", top_k: 20, max_tokens: cap });
    // Optional summary может уступить место минимальной квалифицированной
    // карточке. Discovery и карточки считаются отдельно, wire-cap — без льгот.
    expect(result.meta!.returned).toBe(result.candidates!.length);
    expect(result.meta!.cards).toBe(result.compact!.length);
    expect(result.compact!.length).toBeLessThanOrEqual(3);
    const visibleIds = new Set([
      ...result.candidates!.map((candidate) => candidate.id),
      ...result.compact!.map((card) => card.id),
    ]);
    expect(visibleIds.size + result.meta!.dropped).toBe(20);
    for (const card of result.compact!) {
      expect(card.status).toBe("active");
      expect(card.epistemic_status).toBe("open");
      expect(card.status_scope).toBeNull();
      expect(card.valid_until).toBeNull();
      expect(card.expired).toBe(false);
      expect(card.file_refs).toBeNull();
      expect(card.id).toMatch(/^zh-\d{2}$/);
      if (typeof card.summary === "string") {
        expect(card.summary.length).toBeLessThanOrEqual(240);
      } else {
        // Optional presentation опущена целиком; квалификация выше неизменна.
        expect(card).not.toHaveProperty("summary");
      }
    }
    if (result.compact!.length === 0) {
      expect(result.meta!.reason).toBe("budget");
      expect(result.next!.record).toBeTruthy();
    } else {
      expect(result.meta!.reason).toBeUndefined();
      if (result.meta!.dropped > 0) expect(result.brief).toBeTruthy();
    }
    expect(result.meta!.estimated_full_tokens).toBeGreaterThan(cap);
    expect(result.meta!.tokens_estimated).toBe(measureMcpPayload(result));
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(cap);
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
