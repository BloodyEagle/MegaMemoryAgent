/**
 * План 09 (R-06a): list_roots не делает запрос на каждый корень.
 *
 * Прежняя реализация читала всех корней одним SELECT * и звала getChildren
 * на каждого — на 100k узлов это 10 009 prepare, 2.4 с и +200 МБ RSS при
 * пустой выдаче (бюджет отсекал всё, но работа уже была сделана). Теперь
 * корни читаются страницами с кейсем, child_count считается одним запросом
 * с GROUP BY на чанк родителей, а остановка чтения — по бюджету.
 *
 * Инвариант: число подготовленных запросов не зависит от числа корней.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { listRoots } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-roots-batching-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

/** Счётчик подготовленных запросов — тот же хук, что в замерах плана 08. */
function prepareCount(db: KnowledgeDB): () => number {
  const raw = (db as unknown as { db: { prepare: (sql: string) => unknown } }).db;
  const orig = raw.prepare.bind(raw);
  let count = 0;
  raw.prepare = (sql: string) => {
    count += 1;
    return orig(sql);
  };
  return () => count;
}

function seedRoots(n: number, childrenPerRoot = 3): void {
  db.runInTransaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `root-${String(i).padStart(4, "0")}`;
      db.insertNode({
        id,
        name: `Модуль ${id} — ${"описание ".repeat(4)}`,
        kind: "module",
        summary: `summary ${i}`,
      });
      for (let c = 0; c < childrenPerRoot; c++) {
        db.insertNode({
          id: `${id}/child-${c}`,
          name: `Child ${c} of ${id}`,
          kind: "feature",
          summary: `child ${c}`,
          parent_id: id,
        });
      }
    }
  });
}

describe("list_roots batching (R-06a, план 09)", () => {
  it("число prepare не зависит от числа корней (регрессия N+1)", () => {
    seedRoots(400);
    const count = prepareCount(db);
    const result = listRoots(db, { max_tokens: 1500 });
    const prepares = count();
    // Прежний код тратил 1 prepare на корень (400+) — верхняя граница не
    // должна расти вместе с графом. 25 покрывает: счётчик корней, страницы,
    // чанки child_count, слоты, доску, stats, usage.
    expect(prepares).toBeLessThanOrEqual(25);
    expect(result.meta!.returned).toBeGreaterThan(0);
    expect(result.meta!.dropped).toBe(400 - result.meta!.returned);
    expect(result.meta!.truncated).toBe(true);
  });

  it("выдача идентична цельному чтению: большой бюджет возвращает все корни в прежнем виде", () => {
    seedRoots(300);
    const result = listRoots(db, { max_tokens: 500_000 });
    // Эталон — прежний алгоритм: все корни SELECT-ом, дети по одному.
    const expected = db.getRootNodes().map((root) => ({
      id: root.id,
      name: root.name,
      kind: root.kind,
      child_count: db.getChildren(root.id).length,
      valid_until: root.valid_until ?? null,
    }));
    expect(result.roots_compact).toEqual(expected);
    expect(result.meta!.returned).toBe(300);
    expect(result.meta!.dropped).toBe(0);
    expect(result.meta!.truncated).toBe(false);
  });

  it("чтение останавливается, когда корневая секция вышла из бюджета", () => {
    seedRoots(1200);
    const origPage = db.getRootOverviewPage.bind(db);
    let pages = 0;
    db.getRootOverviewPage = ((after: { name: string; id: string } | null, limit: number) => {
      pages += 1;
      return origPage(after, limit);
    }) as typeof db.getRootOverviewPage;
    const result = listRoots(db, { max_tokens: 1500 });
    // 1200 корней с длинными именами — первая страница (500) уже не помещается
    // в бюджет 1500 токенов; вторая и третья не читаются.
    expect(pages).toBeLessThan(3);
    expect(result.meta!.returned).toBeGreaterThan(0);
    expect(result.meta!.dropped).toBe(1200 - result.meta!.returned);
    // child_count у возвращённых корней честные (GROUP BY, не нули).
    for (const root of result.roots_compact!) {
      expect(root.child_count).toBe(3);
    }
  });

  it("пустой граф: ноль prepare на страницы, hint на месте", () => {
    const count = prepareCount(db);
    const result = listRoots(db, { max_tokens: 1500 });
    expect(result.meta!.returned).toBe(0);
    expect(result.meta!.dropped).toBe(0);
    expect(result.meta!.truncated).toBe(false);
    expect(result.hint).toContain("Graph is empty");
    expect(count()).toBeLessThanOrEqual(15);
  });
});
