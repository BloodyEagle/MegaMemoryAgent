import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { understand, estimateTokens, link, trimSummary } from "../tools.js";
import { ftsSearch } from "../search.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// 2.1.7 F2: опоры вкладываются в свои решения. Контракт: множество id,
// доступных агенту, не уменьшается — всё, что было на верхнем уровне, либо
// осталось, либо вложено; порядок верхнего уровня не меняется; вложенная
// опора не занимает слот top_k, но её токены посчитаны.

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-inline-supports-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db); // FTS: без схемы поиск уходит в LIKE-fallback по всей фразе
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

const DECISION_SUMMARY =
  "decision: the EBUSY race of two batches needs a single writer retry loop qmarker";
const SUPPORT_SUMMARY =
  "fact: the EBUSY race of two batches reproduced with two parallel writer processes qmarker";
const FILLER_ONE = "fact: the EBUSY race also corrupts the reader cache qmarker";
const FILLER_TWO = "fact: the EBUSY race logs a warning on every retry qmarker";

function insertFixture(): void {
  db.insertNode({
    id: "dec-ebusy",
    name: "dec-ebusy",
    kind: "decision",
    summary: DECISION_SUMMARY,
  });
  db.insertNode({
    id: "sup-ebusy",
    name: "sup-ebusy",
    kind: "fact",
    summary: SUPPORT_SUMMARY,
  });
  link(db, {
    from: "dec-ebusy",
    to: "sup-ebusy",
    relation: "informed_by",
    description: "the reproduced race is what the retry loop fixes",
  });
}

describe("2.1.7 F2: вложение опор в решения", () => {
  it("8. решение и его опора в выдаче: опора вложена, returned −1, supports_inlined = 1", async () => {
    insertFixture();
    const result = await understand(db, { query: "ebusy race writer qmarker", top_k: 10 });
    const compact = result.compact!;
    const dec = compact.find((m) => m.id === "dec-ebusy");
    expect(dec).toBeDefined();
    // опоры нет на верхнем уровне
    expect(compact.find((m) => m.id === "sup-ebusy")).toBeUndefined();
    // и есть вложенной в решение
    expect(dec!.supports).toHaveLength(1);
    expect(dec!.supports![0].id).toBe("sup-ebusy");
    expect(dec!.supports![0].name).toBe("sup-ebusy");
    expect(dec!.supports![0].summary).toBe(trimSummary(SUPPORT_SUMMARY));
    expect(result.meta!.supports_inlined).toBe(1);
    // верхний уровень оскудел ровно на вложенную опору
    expect(result.meta!.returned).toBe(1);
  });

  it("9. опора без решения в выдаче: остаётся на верхнем уровне как самостоятельный факт", async () => {
    insertFixture();
    // запрос совпадает только с опорой — решения в выдаче нет
    const result = await understand(db, { query: "parallel reproduced qmarker", top_k: 10 });
    const compact = result.compact!;
    expect(compact.some((m) => m.id === "sup-ebusy")).toBe(true);
    expect(compact.some((m) => m.id === "dec-ebusy")).toBe(false);
    expect(compact.every((m) => !m.supports)).toBe(true);
    expect(result.meta!.supports_inlined).toBe(0);
  });

  it("10. объединение id до и после вложения совпадает — знание не потеряно", async () => {
    insertFixture();
    db.insertNode({ id: "filler-one", name: "filler-one", kind: "fact", summary: FILLER_ONE });
    db.insertNode({ id: "filler-two", name: "filler-two", kind: "fact", summary: FILLER_TWO });
    const result = await understand(db, { query: "ebusy race qmarker", top_k: 10 });
    const compact = result.compact!;
    const union = new Set<string>();
    for (const m of compact) {
      union.add(m.id);
      for (const s of m.supports ?? []) union.add(s.id);
    }
    expect(union.size).toBe(4);
    for (const id of ["dec-ebusy", "sup-ebusy", "filler-one", "filler-two"]) {
      expect(union.has(id)).toBe(true);
    }
  });

  it("11. токены вложенной опоры учтены в tokens_estimated", async () => {
    insertFixture();
    const result = await understand(db, { query: "ebusy race writer qmarker", top_k: 10 });
    // тот же ответ без вложенных опор — дешевле
    const bare = result.compact!.map(({ supports: _supports, ...rest }) => rest);
    const bareTokens = estimateTokens(
      JSON.stringify({
        matches: [],
        compact: bare,
        meta: { returned: bare.length, dropped: 0, tokens_estimated: 0 },
      })
    );
    expect(result.meta!.tokens_estimated).toBeGreaterThan(bareTokens);
  });

  it("12. слот вложенной опоры дозаполняется: 4 кандидата, бюджет на 3 → 3 верхних, не 2", async () => {
    insertFixture();
    const fat = "word ".repeat(400); // ~700 токенов на запись
    // плотность терминов запроса выше у решения и опоры — они ранжируются
    // первыми, жирные филлеры попадают под бюджетный срез
    db.insertNode({
      id: "fat-one",
      name: "fat-one",
      kind: "fact",
      summary: `${fat} ebusy race qmarker ebusy race qmarker ebusy race qmarker filler one`,
    });
    db.insertNode({
      id: "fat-two",
      name: "fat-two",
      kind: "fact",
      summary: `${fat} ebusy race qmarker ebusy race qmarker ebusy race qmarker filler two`,
    });
    const result = await understand(db, { query: "ebusy race qmarker", top_k: 4, max_tokens: 2600 });
    expect(result.meta!.supports_inlined).toBe(1);
    expect(result.meta!.returned).toBe(3);
    expect(result.compact!.length).toBe(3);
    // все четыре узла в ответе: три сверху, один вложен
    const union = new Set<string>();
    for (const m of result.compact!) {
      union.add(m.id);
      for (const s of m.supports ?? []) union.add(s.id);
    }
    expect(union.size).toBe(4);
    expect(result.meta!.dropped).toBe(0);
  });

  it("13. глубина вложения один: опора опоры не вкладывается и не теряется", async () => {
    // цепочка dec-ebusy ← sup-ebusy ← nested-deeper
    insertFixture();
    db.insertNode({
      id: "nested-deeper",
      name: "nested-deeper",
      kind: "fact",
      summary: "fact: the EBUSY race happened on one file descriptor pair qmarker",
    });
    link(db, {
      from: "sup-ebusy",
      to: "nested-deeper",
      relation: "informed_by",
      description: "the race was reproduced on this exact pair",
    });
    const result = await understand(db, { query: "ebusy race qmarker", top_k: 10 });
    const compact = result.compact!;
    const dec = compact.find((m) => m.id === "dec-ebusy")!;
    expect(dec.supports).toHaveLength(1);
    expect(dec.supports![0].id).toBe("sup-ebusy");
    // вложенная опора — лист: без supports
    expect(dec.supports![0]).not.toHaveProperty("supports");
    // опора опоры остаётся на верхнем уровне
    const deeper = compact.find((m) => m.id === "nested-deeper");
    expect(deeper).toBeDefined();
    expect(deeper!.supports).toBeUndefined();
    expect(result.meta!.supports_inlined).toBe(1);
  });

  it("порядок верхнего уровня не меняется при вложении", async () => {
    insertFixture();
    db.insertNode({ id: "filler-one", name: "filler-one", kind: "fact", summary: FILLER_ONE });
    const result = await understand(db, { query: "ebusy race qmarker", top_k: 10 });
    // порядок кандидатов из поиска
    const candidateOrder = ftsSearch(db, "ebusy race qmarker", 10).map((h) => h.id);
    // верхний уровень — подпоследовательность кандидатов: вложение
    // только убирает опору, не переставляет остальных
    const topIds = result.compact!.map((m) => m.id);
    let cursor = 0;
    for (const id of topIds) {
      const at = candidateOrder.indexOf(id, cursor);
      expect(at).toBeGreaterThan(-1);
      cursor = at + 1;
    }
    expect(topIds).not.toContain("sup-ebusy");
  });
});
