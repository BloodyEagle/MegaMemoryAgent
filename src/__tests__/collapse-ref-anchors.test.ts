import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { understand, link, getConcept } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// D0 (план 20+21 v3 §9): убрать навигационный шум без миграции опор.
//
// По умолчанию compact сворачивает технические ref-якоря; explicit false
// сохраняет прежнюю форму, а path-запрос с диапазоном отключает default collapse:
// - Технический якорь определяется по происхождению И текущей структуре
//   (created_via='file_ref' + шаблонное саммари + имя = file_refs[0] — путь):
//   отредактированная осмысленная карточка не прячется из-за старого
//   происхождения.
// - Якорь с найденным зависимым выводом показывается компактно ВМЕСТЕ с
//   rationale и состоянием опоры (вложение в решение или collapsed-вид с
//   informed_by_incoming).
// - Прямой запрос по id (get_concept) разрешает опору во всех режимах —
//   D0 не ломает resolution.
// - Если найдены только якоря — не ложный no-match: хотя бы один остаётся
//   квалифицированной compact-карточкой, остальные доступны через anchors
//   и discovery.
// - Счётчики честные: meta.anchor_collapsed; физические числа stats не
//   подменяются числом показанных карточек.
// - БД не меняется: состояние выводится из существующих данных (без
//   hidden_from_search).
//
// Примечание к фикстурам: FTS — AND по токенам запроса. Шаблонный текст
// якоря несёт только слова шаблона и путь, поэтому запросы подбираются так,
// чтобы совпадение якоря/решения было детерминированным.

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-collapse-anchors-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

const DECISION_SUMMARY =
  "decision: single-writer retry loop fixes the EBUSY race; lives in src/anchors/retry.ts qmarker";
const RATIONALE = "the reproduced race is what the retry loop fixes";
const CLAIM_SUMMARY = "fact: retry guards and anchors doc miss the reader-cache purge";
// Запрос сценария «якорь без решения в выдаче»: решение его токены не содержит.
const ANCHORS_QUERY = "anchors";
// Основной запрос сценария «якорь и решение в одной выдаче».
const QUERY = "retry anchors";

/** Серверный якорь: шаблонное саммари, имя = file_refs[0] = путь. */
function insertAnchor(id: string, refPath: string): void {
  db.insertNode({
    id,
    name: refPath,
    kind: "feature",
    summary: `File-fact node for "${refPath}" — created as a provenance support.`,
    file_refs: [refPath],
    created_via: "file_ref",
  });
}

/** Сценарий 1: решение + его якорь + осмысленные карточки в одной выдаче. */
function insertFoldFixture(): void {
  db.insertNode({
    id: "dec-retry",
    name: "dec-retry",
    kind: "decision",
    summary: DECISION_SUMMARY,
  });
  insertAnchor("anchor-retry", "src/anchors/retry.ts");
  link(db, { from: "dec-retry", to: "anchor-retry", relation: "informed_by", description: RATIONALE });
  db.insertNode({
    id: "fact-reader",
    name: "fact-reader",
    kind: "fact",
    summary: CLAIM_SUMMARY,
  });
  // Якорь, отредактированный до осмысленной карточки: происхождение старое,
  // структура — нет. Такой НЕ считается техническим.
  db.insertNode({
    id: "anchor-edited",
    name: "src/anchors/edited.ts",
    kind: "feature",
    summary: "Проверено: guard цикла retry читает конфиг при старте",
    file_refs: ["src/anchors/edited.ts"],
    created_via: "file_ref",
  });
}

/** Сценарий 2: якоря в выдаче без своих зависимых решений (+ якорь-сирота). */
function insertCollapsedFixture(withMatchingClaim = true): void {
  db.insertNode({
    id: "dec-offtopic",
    name: "dec-offtopic",
    kind: "decision",
    summary: "decision: the batch writer serializes commits qmarkera",
  });
  insertAnchor("anchor-retry", "src/anchors/retry.ts");
  link(db, { from: "dec-offtopic", to: "anchor-retry", relation: "informed_by", description: RATIONALE });
  // Якорь без зависимых выводов.
  insertAnchor("anchor-orphan", "src/anchors/orphan.ts");
  // Осмысленная карточка отделяет collapse-сценарий от anchor-only fallback.
  // Своё зависимое решение по-прежнему не совпадает с ANCHORS_QUERY.
  if (withMatchingClaim) {
    db.insertNode({
      id: "fact-anchor-index",
      name: "fact-anchor-index",
      kind: "feature",
      summary: "The anchors index lists source locations without proving their claims.",
    });
  }
}

describe("D0: collapse_ref_anchors: false — прежняя выдача", () => {
  it("якорь не свёрнут: обычная вложенная опора или карточка, секции anchors нет", async () => {
    insertFoldFixture();
    const result = await understand(db, { query: QUERY, collapse_ref_anchors: false });
    // прежнее поведение: якорь и решение в одной выдаче вкладываются (2.1.7 F2)
    const dec = result.compact!.find((m) => m.id === "dec-retry");
    const asCard = result.compact!.some((m) => m.id === "anchor-retry");
    const asNested = dec?.supports?.some((s) => s.id === "anchor-retry") ?? false;
    expect(asCard || asNested).toBe(true);
    if (asNested) {
      // шаблонное саммари в обычном вложении сохраняется, как раньше
      expect(dec!.supports![0].summary).toBeDefined();
    }
    expect(result.anchors).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("collapsed_anchor");
    expect(result.meta!.anchor_collapsed).toBeUndefined();
  });
});

describe("D0: default collapse и explicit true — верхний уровень без технических якорей", () => {
  it("по умолчанию якорь с зависимым выводом вкладывается в решение: компактно, с rationale, без шаблонного саммари", async () => {
    insertFoldFixture();
    const result = await understand(db, { query: QUERY });
    const dec = result.compact!.find((m) => m.id === "dec-retry")!;
    expect(dec).toBeDefined();
    const folded = dec.supports?.find((s) => s.id === "anchor-retry");
    expect(folded).toBeDefined();
    // шаблонное саммари — шум; collapsed-вложение его не повторяет
    expect(folded!.summary).toBeUndefined();
    expect(folded!.collapsed_anchor).toBe(true);
    // rationale и состояние опоры едут вместе с якорем
    expect(folded!.rationale).toBe(RATIONALE);
    expect(folded!.file_refs).toEqual(["src/anchors/retry.ts"]);
    // якорь не занимает верхний уровень
    expect(result.compact!.some((m) => m.id === "anchor-retry")).toBe(false);
    expect(result.meta!.supports_inlined).toBe(1);
    // осмысленные карточки остаются на верхнем уровне
    expect(result.compact!.some((m) => m.id === "fact-reader")).toBe(true);
    // отредактированная карточка с old-происхождением НЕ прячется
    expect(result.compact!.some((m) => m.id === "anchor-edited")).toBe(true);
    expect(result.meta!.anchor_collapsed).toBe(0);
  });

  it("якорь без решения в выдаче — collapsed-вид с зависимыми выводами и rationale", async () => {
    insertCollapsedFixture();
    const result = await understand(db, {
      query: ANCHORS_QUERY,
      collapse_ref_anchors: true,
    });
    // Зависимое решение не совпало с запросом; осмысленная карточка индекса
    // оставляет якоря в collapsed-проекции, а не в anchor-only fallback.
    expect(result.compact!.some((m) => m.id === "fact-anchor-index")).toBe(true);
    expect(result.compact!.some((m) => m.id === "dec-offtopic")).toBe(false);
    expect(result.compact!.some((m) => m.id === "anchor-retry")).toBe(false);
    const collapsed = result.anchors?.find((a) => a.id === "anchor-retry");
    expect(collapsed).toBeDefined();
    expect(collapsed!.collapsed_anchor).toBe(true);
    expect(collapsed!.file_refs).toEqual(["src/anchors/retry.ts"]);
    // зависимый вывод виден вместе с rationale ребра
    expect(collapsed!.informed_by_incoming).toEqual([
      { from: "dec-offtopic", from_name: "dec-offtopic", rationale: RATIONALE },
    ]);
    // якорь-сирота — collapsed-локатор без блока зависимых
    const orphan = result.anchors?.find((a) => a.id === "anchor-orphan");
    expect(orphan).toBeDefined();
    expect(orphan!.collapsed_anchor).toBe(true);
    expect(orphan!.file_refs).toEqual(["src/anchors/orphan.ts"]);
    expect(orphan!.informed_by_incoming ?? []).toHaveLength(0);
    expect(result.meta!.anchor_collapsed).toBe(2);
  });

  it("только якоря — квалифицированная compact-карточка для UI и локаторы, не ложный no-match", async () => {
    insertCollapsedFixture(false);
    const result = await understand(db, { query: ANCHORS_QUERY, collapse_ref_anchors: true });
    expect(result.compact!.length).toBeGreaterThan(0);
    expect(result.compact!.length).toBeLessThanOrEqual(3);
    for (const card of result.compact!) {
      const node = db.getNode(card.id)!;
      expect(card.name).toBe(node.name);
      expect(card.summary).toBeTruthy();
      expect(card.status).toBe("active");
      expect(card.epistemic_status).toBe("open");
      expect(card.file_refs).toEqual(JSON.parse(node.file_refs!));
    }
    const visibleIds = new Set([
      ...result.candidates!.map((candidate) => candidate.id),
      ...result.compact!.map((card) => card.id),
      ...(result.anchors ?? []).map((anchor) => anchor.id),
    ]);
    expect([...visibleIds].sort()).toEqual(["anchor-orphan", "anchor-retry"]);
    expect(result.meta!.cards).toBe(result.compact!.length);
    expect(result.meta!.returned).toBe(result.candidates!.length);
    expect(result.meta!.anchor_collapsed).toBe((result.anchors ?? []).length);
    expect(result.meta!.dropped).toBe(0);
    expect(result.meta!.reason).toBeUndefined();
  });

  it("якорь-сирота без зависимых выводов — самостоятельная квалифицированная карточка, не исчезает", async () => {
    insertCollapsedFixture(false);
    const result = await understand(db, {
      query: "orphan.ts",
      top_k: 10,
    });
    // Bare path не включает range-only исключение из default collapse;
    // карточку сохраняет anchor-only guarantee, а не путь запроса.
    const orphan = result.compact!.find((a) => a.id === "anchor-orphan");
    expect(orphan).toBeDefined();
    expect(orphan!.name).toBe("src/anchors/orphan.ts");
    expect(orphan!.summary).toContain("src/anchors/orphan.ts");
    expect(orphan!.status).toBe("active");
    expect(orphan!.epistemic_status).toBe("open");
    expect(orphan!.file_refs).toEqual(["src/anchors/orphan.ts"]);
    expect(orphan!.edges ?? []).toHaveLength(0);
    expect(getConcept(db, { id: orphan!.id }).incoming_edges).toHaveLength(0);
    expect(result.meta!.cards).toBe(1);
    expect(result.meta!.anchor_collapsed).toBe(0);
    expect(result.meta!.reason).toBeUndefined();
  });

  it("союз идентификаторов до и после collapse сохраняется — знание не теряется", async () => {
    insertFoldFixture();
    const before = await understand(db, { query: QUERY, collapse_ref_anchors: false });
    const after = await understand(db, { query: QUERY, collapse_ref_anchors: true });
    const unionOf = (r: Awaited<ReturnType<typeof understand>>) => {
      const ids = new Set<string>();
      for (const candidate of r.candidates ?? []) ids.add(candidate.id);
      for (const m of r.compact ?? []) {
        ids.add(m.id);
        for (const s of m.supports ?? []) ids.add(s.id);
      }
      for (const a of r.anchors ?? []) ids.add(a.id);
      return ids;
    };
    const beforeIds = unionOf(before);
    const afterIds = unionOf(after);
    for (const id of beforeIds) expect(afterIds.has(id)).toBe(true);
    expect(afterIds.size).toBe(beforeIds.size);
  });

  it("якоря вытесняются с верхнего уровня последними: claims заполняют top_k первыми", async () => {
    insertFoldFixture();
    db.insertNode({
      id: "fact-extra-1",
      name: "fact-extra-1",
      kind: "fact",
      summary: "fact: retry queue depth is bounded by the anchors list qmarker",
    });
    db.insertNode({
      id: "fact-extra-2",
      name: "fact-extra-2",
      kind: "fact",
      summary: "fact: retry jitter avoids the anchors herd problem qmarker",
    });
    const result = await understand(db, { query: QUERY, collapse_ref_anchors: true, top_k: 3 });
    // верхний уровень — осмысленные карточки; технический якорь не занял слот
    expect(result.compact!.length).toBe(3);
    expect(result.compact!.some((m) => m.id === "anchor-retry")).toBe(false);
  });

  it("counts честные: anchor_collapsed = размер секции; физический счётчик stats не подменяется", async () => {
    insertCollapsedFixture();
    const result = await understand(db, { query: ANCHORS_QUERY, collapse_ref_anchors: true });
    expect(result.meta!.anchor_collapsed).toBe((result.anchors ?? []).length);
    // физическое число узлов в базе включает якоря независимо от выдачи
    expect(db.getStats().nodes).toBe(4);
  });

  it("resolution по id работает во всех режимах: get_concept находит якорь до и после collapse", async () => {
    insertFoldFixture();
    expect(getConcept(db, { id: "anchor-retry" }).id).toBe("anchor-retry");
    await understand(db, { query: QUERY, collapse_ref_anchors: true });
    expect(getConcept(db, { id: "anchor-retry" }).id).toBe("anchor-retry");
    expect(getConcept(db, { id: "anchor-edited" }).id).toBe("anchor-edited");
  });

  it("кириллические пути и имена едут в collapsed-виде байт-в-байт", async () => {
    db.insertNode({
      id: "dec-cyr",
      name: "dec-cyr",
      kind: "decision",
      summary: "decision: единый кэш ускоряет сборку маркировка",
    });
    insertAnchor("anchor-cyr", "docs/отчёт-архитектуры.md");
    // Осмысленный совпадающий индекс удерживает именно collapsed-проекцию,
    // чтобы проверить кириллические refs и входящий rationale без fallback.
    db.insertNode({
      id: "fact-cyr-index",
      name: "fact-cyr-index",
      kind: "feature",
      summary: "Индекс отчёт-архитектуры связывает документы с проверенными выводами.",
    });
    link(db, {
      from: "dec-cyr",
      to: "anchor-cyr",
      relation: "informed_by",
      description: "раздел отчёта описывает сборку",
    });
    const result = await understand(db, {
      query: "отчёт-архитектуры",
      collapse_ref_anchors: true,
    });
    expect(result.compact!.some((m) => m.id === "dec-cyr")).toBe(false);
    expect(result.compact!.some((m) => m.id === "fact-cyr-index")).toBe(true);
    const collapsed = result.anchors?.find((a) => a.id === "anchor-cyr");
    expect(collapsed).toBeDefined();
    expect(collapsed!.name).toBe("docs/отчёт-архитектуры.md");
    expect(collapsed!.file_refs).toEqual(["docs/отчёт-архитектуры.md"]);
    expect(collapsed!.informed_by_incoming).toEqual([
      { from: "dec-cyr", from_name: "dec-cyr", rationale: "раздел отчёта описывает сборку" },
    ]);
  });

  it("collapse_ref_anchors с mode=full/brief — явная ошибка", async () => {
    insertFoldFixture();
    await expect(
      understand(db, { query: QUERY, collapse_ref_anchors: true, mode: "full" })
    ).rejects.toThrow(/collapse_ref_anchors/);
    await expect(
      understand(db, { query: QUERY, collapse_ref_anchors: true, mode: "brief" })
    ).rejects.toThrow(/collapse_ref_anchors/);
  });
});
