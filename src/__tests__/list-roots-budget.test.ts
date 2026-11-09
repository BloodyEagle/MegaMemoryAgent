/**
 * 2.1.13 F3: бюджет list_roots. Переполнение больше не переключает на полный
 * ответ — выдача режется с конца приоритета (роли → задачи → корни) и помечает
 * сокращение в meta. Бюджет считается по сериализованному ответу вместе со
 * всем, что добавляет MCP-обработчик (extra_payload).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { listRoots, estimateTokens } from "../tools.js";

let fixture: AuditFixture;
let db: KnowledgeDB;

beforeEach(() => {
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  ensureSchema(db);
});

afterEach(async () => {
  await fixture.close();
  delete process.env.MEGAMEMORY_DB_PATH;
});

/** Имитация добавки MCP-обработчика: instructions_status + stats. */
function handlerExtra(testStats = { nodes: 1 }): Record<string, unknown> {
  return {
    instructions_status: { current: "v1", stale: false },
    stats: testStats,
  };
}

describe("list_roots budget (F3 2.1.13)", () => {
  it("100 корней с длинными именами при max_tokens 1500 → компактно, dropped, оценка в бюджете (тест 16)", () => {
    for (let i = 0; i < 100; i++) {
      db.insertNode({
        id: `root-${String(i).padStart(3, "0")}`,
        name: `Длинное имя корня номер ${i} — ${"описание ".repeat(8)}`,
        kind: "module",
        summary: "x".repeat(200),
      });
    }
    const extra = handlerExtra({ nodes: 100 });
    const result = listRoots(db, { max_tokens: 1500, extra_payload: extra });
    expect(result.compact).toBe(true);
    expect(result.roots).toEqual([]); // полный ответ больше не возвращается
    const returned = result.roots_compact!.length;
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThan(100);
    expect(result.meta!.dropped).toBe(100 - returned);
    expect(result.meta!.truncated).toBe(true);
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(1500);
    // оценка не расходится с реальной сериализацией обработчика
    const actual = estimateTokens(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ...result, ...extra }, null, 2) }] }));
    expect(actual).toBeLessThanOrEqual(1500);
    expect(Math.abs(actual - result.meta!.tokens_estimated)).toBeLessThanOrEqual(5);
  });

  it("длинные имена, русский, CJK, emoji не обходят лимит (тест 17)", () => {
    db.insertNode({ id: "r-ru", name: "Русский текст ".repeat(20), kind: "module", summary: "s" });
    db.insertNode({ id: "r-cjk", name: "中文模块设计支付".repeat(20), kind: "module", summary: "s" });
    db.insertNode({ id: "r-emoji", name: "🚀🔥💡".repeat(40), kind: "module", summary: "s" });
    db.insertNode({ id: `r-${"a".repeat(200)}`, name: "latin ".repeat(30), kind: "module", summary: "s" });
    const extra = handlerExtra();
    const result = listRoots(db, { max_tokens: 600, extra_payload: extra });
    const actual = estimateTokens(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ...result, ...extra }, null, 2) }] }));
    expect(actual).toBeLessThanOrEqual(600);
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(actual);
  });

  it("пустая база, малая база, большой бюджет (тест 18)", () => {
    // пустая база: hint, нули в meta, usage пишется
    const empty = listRoots(db, { max_tokens: 1500 });
    expect(empty.compact).toBe(true);
    expect(empty.roots_compact).toEqual([]);
    expect(empty.meta!.returned).toBe(0);
    expect(empty.meta!.dropped).toBe(0);
    expect(empty.meta!.truncated).toBe(false);
    expect(empty.hint).toContain("Graph is empty");

    // малая база: всё помещается целиком
    db.insertNode({ id: "m1", name: "Малый", kind: "module", summary: "s" });
    const small = listRoots(db, { max_tokens: 1500 });
    expect(small.roots_compact).toHaveLength(1);
    expect(small.meta!.truncated).toBe(false);

    // большой бюджет: ничего не режется
    const big = listRoots(db, { max_tokens: 100000 });
    expect(big.roots_compact).toHaveLength(1);
    expect(big.meta!.truncated).toBe(false);
  });

  it("бюджет ниже минимума конверта → понятная ошибка (тест 19)", () => {
    db.insertNode({ id: "x1", name: "X", kind: "module", summary: "s" });
    const extra = handlerExtra({ nodes: 1, big: "y".repeat(400) });
    expect(() => listRoots(db, { max_tokens: 20, extra_payload: extra })).toThrow(
      /ниже минимума/
    );
  });

  it("в обрезанной выдаче корректны usage, счётчики и valid_until (тест 20)", () => {
    for (let i = 0; i < 60; i++) {
      db.insertNode({
        id: `k-${String(i).padStart(2, "0")}`,
        name: `Корень ${i} ${"текст ".repeat(10)}`,
        kind: "module",
        summary: "s",
        // 2.1.12 F1: идентификаторы и valid_until сохраняются при резке
        valid_until: i === 0 ? "2099-12-31" : null,
      });
    }
    const result = listRoots(db, { max_tokens: 800 });
    const returned = result.roots_compact!.length;
    expect(returned).toBeLessThan(60);
    expect(result.meta!.returned).toBe(returned);
    expect(result.meta!.dropped).toBe(60 - returned);
    const first = result.roots_compact!.find((r) => r.id === "k-00");
    expect(first).toBeDefined();
    expect(first!.valid_until).toBe("2099-12-31");
    // usage записан и на обрезанной ветке
    const usage = db.getUsageStats(7);
    expect(usage.total_queries).toBe(1);
    expect(usage.total_tokens).toBeGreaterThan(0);
  });

  it("бюджет проверяется по фактическому объекту ответа, а не по проекции (тест 21)", () => {
    for (let i = 0; i < 30; i++) {
      db.insertNode({
        id: `p-${i}`,
        name: `Проверка ${i} ${"данные ".repeat(6)}`,
        kind: "module",
        summary: "s",
      });
    }
    db.insertNode({ id: "рол", name: "Роль", kind: "module", summary: "s" });
    db.setSlot("", "architect", "рол");
    const extra = handlerExtra({ nodes: 31, wide: "z".repeat(120) });
    const result = listRoots(db, { max_tokens: 900, extra_payload: extra });
    const actual = estimateTokens(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ...result, ...extra }, null, 2) }] }));
    // замер шёл по полной сериализации — расходится максимум на цифры meta
    expect(Math.abs(actual - result.meta!.tokens_estimated)).toBeLessThanOrEqual(5);
    expect(actual).toBeLessThanOrEqual(900);
  });

  it("приоритет: при крохотном бюджете корни режутся первыми, роли — последними", () => {
    db.insertNode({ id: "role-node", name: "Роль-узел", kind: "module", summary: "s" });
    db.setSlot("", "architect", "role-node");
    db.insertNode({ id: "board-node", name: "Задача-узел", kind: "module", summary: "s" });
    // board_top берётся из computeBoard: узел без rot может не попасть;
    // для теста достаточно, чтобы slots резались последними.
    for (let i = 0; i < 20; i++) {
      db.insertNode({
        id: `rr-${i}`,
        name: `Корень ${i} ${"наполнение ".repeat(10)}`,
        kind: "module",
        summary: "s",
      });
    }
    const result = listRoots(db, { max_tokens: 500 });
    expect(result.meta!.truncated).toBe(true);
    expect(result.meta!.dropped).toBeGreaterThan(0);
    // роли пережили резку, которая корни уже порезала
    expect(result.slots).toHaveLength(1);
    expect(result.meta!.dropped_slots).toBe(0);
    expect(result.meta!.dropped_board_top).toBe(0);
  });
});
