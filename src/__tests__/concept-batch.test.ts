import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { KnowledgeDB } from "../db.js";
import { getConcept, measureMcpPayload } from "../tools.js";
import { MAX_BATCH_ITEMS, getConceptBatch } from "../concept-profile.js";
import type { ConceptBatchOutput, ConceptProfileOutput, NodeWithContext } from "../types.js";
import { cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
const openDbs: KnowledgeDB[] = [];

function createTmpDb(name: string): { db: KnowledgeDB; path: string } {
  const dbPath = path.join(tmpDir, name);
  const db = new KnowledgeDB(dbPath);
  openDbs.push(db);
  return { db, path: dbPath };
}

function wire(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-concept-batch-test-"));
});

afterEach(async () => {
  // C1 (план 20+21 v3 §5): все соединения закрываются даже при упавшем тесте.
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // уже закрыта
    }
  }
  openDbs.length = 0;
  (globalThis as { gc?: () => void }).gc?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await cleanupDir(tmpDir);
});

function insertBatchNodes(db: KnowledgeDB, count = 4): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `batch-${i}`;
    ids.push(id);
    db.insertNode({
      id,
      name: `Batch ${i}`,
      kind: "module",
      summary: `Модуль пакета ${i}: параметры, поведение и границы — кириллица и ünïcödé.`,
      why: i % 2 === 0 ? `Обоснование модуля ${i}.` : null,
      file_refs: [`src/batch/${i}.ts:1-40`],
    });
  }
  return ids;
}

describe("getConceptBatch: пакетное чтение (E2)", () => {
  it("карточки элементов равны одиночным вызовам байт-в-байт, порядок сохранён", () => {
    const { db } = createTmpDb("batch-equal.db");
    const ids = insertBatchNodes(db);
    db.insertEdge({
      from_id: ids[0],
      to_id: ids[1],
      relation: "depends_on",
      description: "зависимость внутри пакета",
    });

    const out = getConceptBatch(db, { ids }) as ConceptBatchOutput;
    expect(out.batch.map((item) => item.id)).toEqual(ids);
    for (const item of out.batch) {
      expect(item.status).toBe("ok");
      expect(item.resolved_id).toBe(item.id);
      const single = getConcept(db, { id: item.id }) as NodeWithContext;
      expect(wire(item.card)).toBe(wire(single));
    }
    expect(out.meta.total).toBe(ids.length);
    expect(out.meta.ok).toBe(ids.length);
    expect(out.meta.failed).toBe(0);
    expect(out.meta.truncated).toBe(false);
    expect(measureMcpPayload(out)).toBe(out.meta.tokens_estimated);
    db.close();
  });

  it("неразрешённый id не исчезает молча, ошибка не маскирует соседей", () => {
    const { db } = createTmpDb("batch-error.db");
    const ids = insertBatchNodes(db, 3);
    const withMissing = [ids[0], "нет-такого-узла", ids[2]];

    const out = getConceptBatch(db, { ids: withMissing }) as ConceptBatchOutput;
    expect(out.batch.map((i) => i.id)).toEqual(withMissing);
    expect(out.batch[0].status).toBe("ok");
    expect(out.batch[1].status).toBe("error");
    expect(out.batch[1].error).toContain("нет-такого-узла");
    expect(out.batch[1].card).toBeUndefined();
    expect(out.batch[2].status).toBe("ok");
    expect(out.meta.ok).toBe(2);
    expect(out.meta.failed).toBe(1);
    db.close();
  });

  it("алиасы разрешаются, resolved_id показывает факт", () => {
    const { db } = createTmpDb("batch-alias.db");
    const ids = insertBatchNodes(db, 1);
    db.recordAlias("старый-id", ids[0]);
    const out = getConceptBatch(db, { ids: ["старый-id"] }) as ConceptBatchOutput;
    expect(out.batch[0].status).toBe("ok");
    expect(out.batch[0].resolved_id).toBe(ids[0]);
    db.close();
  });

  it("общий бюджет пакета: не поместившиеся помечены budget_skipped, а не пропали", () => {
    const { db } = createTmpDb("batch-budget.db");
    const ids = insertBatchNodes(db, 4);
    const out = getConceptBatch(db, { ids, max_tokens: 900 }) as ConceptBatchOutput;

    const placed = out.batch.filter((i) => i.status === "ok");
    const skipped = out.batch.filter((i) => i.status === "budget_skipped");
    expect(placed.length).toBeGreaterThan(0);
    expect(skipped.length).toBeGreaterThan(0);
    // Порядок детерминирован: размещение идёт по порядку, пропуск — с первого
    // невлезающего и до конца.
    expect(placed.map((i) => i.id)).toEqual(ids.slice(0, placed.length));
    expect(skipped.map((i) => i.id)).toEqual(ids.slice(placed.length));
    for (const item of skipped) {
      expect(item.reason).toBe("budget");
      expect(item.next_step).toContain("continuation");
    }
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.budget_skipped).toBe(skipped.length);
    expect(out.meta.continuation).toBeDefined();
    expect(measureMcpPayload(out)).toBe(out.meta.tokens_estimated);
    db.close();
  });

  it("продолжение пакета возвращает остаток без повторов; изменение выданного -> конфликт", () => {
    const { db } = createTmpDb("batch-continuation.db");
    const ids = insertBatchNodes(db, 4);
    const page1 = getConceptBatch(db, { ids, max_tokens: 900 }) as ConceptBatchOutput;
    expect(page1.meta.continuation).toBeDefined();

    const token = page1.meta.continuation!;
    const page2 = getConceptBatch(db, { continuation: token, max_tokens: 20000 }) as ConceptBatchOutput;
    const ids1 = page1.batch.filter((i) => i.status === "ok").map((i) => i.id);
    const ids2 = page2.batch.filter((i) => i.status === "ok").map((i) => i.id);
    expect(new Set([...ids1, ...ids2]).size).toBe(ids.length);
    expect(ids2).toEqual(ids.slice(ids1.length));

    // Изменение уже выданного элемента -> version_conflict, повторить чтение.
    db.updateNode(ids[0], { summary: "Переписанное саммари первого элемента." });
    expect(() => getConceptBatch(db, { continuation: token, max_tokens: 20000 })).toThrow(
      /version_conflict/
    );
    db.close();
  });

  it("пределы пакета: пустой список, лишний объём и неверный профиль — явные ошибки", () => {
    const { db } = createTmpDb("batch-limits.db");
    expect(() => getConceptBatch(db, { ids: [] })).toThrow(/ids/);

    const tooMany: string[] = [];
    for (let i = 0; i < MAX_BATCH_ITEMS + 1; i++) {
      const id = `many-${i}`;
      db.insertNode({ id, name: id, kind: "feature", summary: `Узел ${i}.` });
      tooMany.push(id);
    }
    expect(() => getConceptBatch(db, { ids: tooMany })).toThrow(/MAX_BATCH|не более/);

    const ids = insertBatchNodes(db, 1);
    expect(() =>
      getConceptBatch(db, { ids, profile: "полный" as unknown as "full" })
    ).toThrow(/profile/);
    db.close();
  });

  it("кап вычислений support-check помечен явно, не молчалив", () => {
    const { db } = createTmpDb("batch-checkcap.db");
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) {
      const decision = `dec-${i}`;
      const support = `sup-${i}`;
      db.insertNode({ id: decision, name: decision, kind: "decision", summary: `Решение ${i}.` });
      db.insertNode({ id: support, name: support, kind: "feature", summary: `Опора решения ${i}.` });
      db.insertEdge({
        from_id: decision,
        to_id: support,
        relation: "informed_by",
        description: "опора решения",
      });
      ids.push(decision);
    }
    const out = getConceptBatch(db, { ids, max_tokens: 20000 }) as ConceptBatchOutput;
    const withCheck = out.batch.filter(
      (i) => ((i.card ?? {}) as NodeWithContext).support_check
    );
    const deferred = out.batch.filter((i) => i.support_check_deferred);
    expect(withCheck.length).toBeGreaterThan(0);
    expect(deferred.length).toBeGreaterThan(0);
    expect(withCheck.length + deferred.length).toBe(ids.length);
    // Отложенная проверка не выдаётся за чистую.
    for (const item of deferred) {
      expect((item.card as NodeWithContext).support_check).toBeUndefined();
    }
    db.close();
  });

  it("профиль evidence в пакете несёт дайджесты и неполноту по каждому элементу", () => {
    const { db } = createTmpDb("batch-evidence.db");
    db.insertNode({ id: "root", name: "Root", kind: "decision", summary: "Корневое решение пакета." });
    for (let i = 0; i < 6; i++) {
      db.insertNode({ id: `es-${i}`, name: `ES ${i}`, kind: "feature", summary: `Формулировка опоры ${i}.` });
      db.insertEdge({ from_id: "root", to_id: `es-${i}`, relation: "informed_by", description: `опора ${i}` });
    }
    const out = getConceptBatch(db, {
      ids: ["root", "нет-такого"],
      profile: "evidence",
      max_neighbors: 2,
      max_tokens: 20000,
    }) as ConceptBatchOutput;

    expect(out.meta.profile).toBe("evidence");
    const root = out.batch[0];
    expect(root.status).toBe("ok");
    const card = root.card as ConceptProfileOutput;
    expect(card.supports!.length).toBeLessThanOrEqual(2);
    expect(card.meta.dropped!.informed_by).toBe(4);
    expect(card.meta.continuations!.length).toBeGreaterThan(0);
    expect(out.batch[1].status).toBe("error");
    db.close();
  });

  it("кириллица и unicode в пакете не искажаются", () => {
    const { db } = createTmpDb("batch-unicode.db");
    const ids = insertBatchNodes(db, 2);
    const out = getConceptBatch(db, { ids }) as ConceptBatchOutput;
    for (const item of out.batch) {
      const single = getConcept(db, { id: item.id });
      expect(wire(item.card)).toBe(wire(single));
    }
    db.close();
  });
});
