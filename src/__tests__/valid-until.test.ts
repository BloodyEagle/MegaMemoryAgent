/**
 * 2.1.12 F1: срок годности факта (valid_until). Узел «PR #3 не открыт» верен
 * на дату записи — опор у него нет, support_check никогда не скажет changed,
 * поэтому единственная защита — явная дата, после которой факт выпадает из
 * выдачи, но остаётся в графе.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB, isNodeExpired } from "../db.js";
import { createConcept, updateConcept, understand, getConcept, listRoots, link } from "../tools.js";
import { provenanceTrace } from "../provenance.js";
import { ensureSchema, markMigrated, ensureEmbedMeta, emptyReport } from "../migrate-schema.js";
import { closeAndCleanup, cleanupDir } from "./helpers/cleanup.js";

vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embed: vi.fn(async () => Buffer.alloc(0)),
    embeddingText: vi.fn((name: string, kind: string, summary: string) => `${kind}: ${name} — ${summary}`),
    findTopK: vi.fn(),
    embedForStorage: vi.fn(async () => null),
    vectorSearchEnabled: vi.fn(() => false),
    cosineSimilarity: vi.fn(() => 0),
    queryText: vi.fn((q: string) => q),
    // doctor.ts проверяет модель — имя оставляем настоящее: ensureEmbedMeta
    // ставит в meta ровно то же значение
    isModelLoaded: vi.fn(() => false),
  };
});

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-valid-until-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
  process.env.MEGAMEMORY_SEARCH = "fts"; // basicSearch — без векторов
});

afterEach(async () => {
  delete process.env.MEGAMEMORY_SEARCH;
  if (db) await closeAndCleanup(db, tmpDir);
});

const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

function featureNode(id: string, summary: string, validUntil?: string | null): void {
  db.insertNode({ id, name: id, kind: "feature", summary, valid_until: validUntil ?? undefined });
}

// ---- 1-3, 6-7: understand и срок годности ----

describe("F1: understand и valid_until", () => {
  it("1+3. узел с прошедшим сроком исключён из выдачи, meta.stale_excluded = 1", async () => {
    featureNode("stale-fact", "Сборка ломается на node 20 из-за старого gyp, чинится флагом", PAST);
    featureNode("fresh-fact", "Сборка использует кэш по mtime, инвалидируется сменой tsconfig");

    const res = await understand(db, { query: "сборка" });
    const ids = res.compact!.map((m) => m.id);
    expect(ids).toContain("fresh-fact");
    expect(ids).not.toContain("stale-fact");
    expect(res.meta?.stale_excluded).toBe(1);
  });

  it("2. include_stale: true возвращает просроченный узел с пометкой expired", async () => {
    featureNode("stale-fact", "Сборка ломается на node 20 из-за старого gyp, чинится флагом", PAST);

    const res = await understand(db, { query: "сборка", include_stale: true });
    const match = res.compact!.find((m) => m.id === "stale-fact");
    expect(match).toBeDefined();
    expect(match!.expired).toBe(true);
    expect(res.meta?.stale_excluded).toBe(0);
  });

  it("2b. full mode: expired: true на карточке узла", async () => {
    featureNode("stale-fact", "Сборка ломается на node 20 из-за старого gyp, чинится флагом", PAST);

    const res = await understand(db, { query: "сборка", mode: "full", include_stale: true });
    const match = res.matches.find((m) => m.id === "stale-fact");
    expect(match?.expired).toBe(true);
    expect(match?.valid_until).toBe(PAST);
  });

  it("6. узел без valid_until ведёт себя как раньше (stale_excluded: 0)", async () => {
    featureNode("plain-fact", "Импорт использует кэш по mtime, инвалидируется сменой tsconfig");

    const res = await understand(db, { query: "импорт" });
    expect(res.compact!.map((m) => m.id)).toContain("plain-fact");
    expect(res.meta?.stale_excluded).toBe(0);
  });

  it("7. valid_until в будущем не влияет на выдачу и не помечает expired", async () => {
    featureNode("future-fact", "Планировщик выключен до конца квартала, задачи идут в очередь", FUTURE);

    const res = await understand(db, { query: "планировщик очередь" });
    const match = res.compact!.find((m) => m.id === "future-fact");
    expect(match).toBeDefined();
    expect(match!.expired).toBe(false); // явная квалификация карточки (2.1.12 F1/E-05)
    expect(res.meta?.stale_excluded).toBe(0);
  });

  it("6b. superseded-узел с valid_until — не «просроченный», фильтры не смешиваются", async () => {
    // valid_until у superseded ставит supersedes — это метка замены, а не
    // срок годности утверждения: stale-фильтр его не считает.
    db.insertNode({
      id: "old-fact",
      name: "old-fact",
      kind: "feature",
      summary: "Старый импорт читал CSV целиком, держал файл в памяти",
      valid_until: PAST,
    });
    db.setNodeStatus("old-fact", "superseded", PAST, "superseded by new-fact");

    expect(isNodeExpired(db.getNode("old-fact")!)).toBe(false);
    const res = await understand(db, { query: "старый импорт", include_inactive: true });
    const match = res.compact!.find((m) => m.id === "old-fact");
    expect(match).toBeDefined();
    expect(match!.expired).toBe(false); // явная квалификация карточки (2.1.12 F1/E-05)
  });
});

// ---- 4: weak_links expired ----

describe("F1: weak_links и provenance_trace", () => {
  it("4. просроченный предшественник помечен expired и не обрывает цепочку", async () => {
    db.insertNode({ id: "d", name: "d", kind: "decision", summary: "Решение держится на факте о сборке" });
    featureNode("stale-fact", "Сборка ломается на node 20 из-за старого gyp, чинится флагом", PAST);
    link(db, { from: "d", to: "stale-fact", relation: "informed_by", description: "опирается на факт о поломке сборки" });

    const trace = provenanceTrace(db, { node_id: "d" });
    const support = trace.nodes.find((n) => n.id === "stale-fact");
    expect(support?.expired).toBe(true);
    // цепочка не оборвана: предшественник в замыкании и в счёте путей
    expect(support?.in_paths).toBe(1);
    expect(trace.total_within_depth).toBe(2);

    const expired = trace.weak_links.find((w) => w.type === "expired");
    expect(expired).toBeDefined();
    expect(expired!.id).toBe("stale-fact");
  });
});

// ---- 5: stats ----

describe("F1: счётчики", () => {
  it("5. countExpiredNodes считает только активные живые просроченные", () => {
    featureNode("stale-fact", "Сборка ломается на node 20 из-за старого gyp, чинится флагом", PAST);
    featureNode("fresh-fact", "Сборка использует кэш по mtime, инвалидируется сменой tsconfig", FUTURE);
    featureNode("plain-fact", "Импорт читает манифест и резолвит пути через tsconfig paths");
    db.insertNode({
      id: "old-fact",
      name: "old-fact",
      kind: "feature",
      summary: "Старый импорт читал CSV целиком, держал файл в памяти",
    });
    db.setNodeStatus("old-fact", "superseded", PAST, "superseded by fresh-fact");
    db.insertNode({
      id: "dead-fact",
      name: "dead-fact",
      kind: "feature",
      summary: "Удалённый узел с прошедшим сроком — не в счёте",
      valid_until: PAST,
    });
    db.softDeleteNode("dead-fact", "убран");

    expect(db.countExpiredNodes()).toBe(1);
  });
});

// ---- CRUD: create/update/get/list_roots ----

describe("F1: CRUD valid_until", () => {
  it("create_concept принимает срок, get_concept и list_roots его отдают", async () => {
    const created = await createConcept(db, {
      name: "release-2112-status",
      kind: "feature",
      summary: "Релиз 2.1.12 опубликован в npm 2026-11-05: пакет содержит d3-фолбэк, тег v2.1.12 стоит на main",
      valid_until: FUTURE,
    });
    expect(created.id).toBe("release-2112-status");
    expect(created.message).toContain("Срок годности");

    const card = getConcept(db, { id: "release-2112-status" });
    expect(card.valid_until).toBe(FUTURE);

    const roots = listRoots(db, { max_tokens: 100000 });
    const compactRow = roots.roots_compact!.find((r) => r.id === "release-2112-status");
    expect(compactRow?.valid_until).toBe(FUTURE);
  });

  it("update_concept: срок ставится, null снимает, мусор отклоняет правку", async () => {
    await createConcept(db, {
      name: "pr-19-state",
      kind: "feature",
      summary: "PR #19 открыт и требует ревью после рефакторинга артефактов",
    });
    expect(db.getNode("pr-19-state")!.valid_until ?? null).toBeNull();

    await updateConcept(db, { id: "pr-19-state", changes: { valid_until: FUTURE } });
    expect(db.getNode("pr-19-state")!.valid_until).toBe(FUTURE);

    await updateConcept(db, { id: "pr-19-state", changes: { valid_until: null } });
    expect(db.getNode("pr-19-state")!.valid_until ?? null).toBeNull();

    await expect(
      updateConcept(db, { id: "pr-19-state", changes: { valid_until: "не дата" } })
    ).rejects.toThrow(/ISO-8601/);
    // мусорная дата ничего не записала
    expect(db.getNode("pr-19-state")!.valid_until ?? null).toBeNull();

    await expect(
      createConcept(db, {
        name: "bad-date",
        kind: "feature",
        summary: "Узел с мусорной датой не должен записаться вовсе",
        valid_until: "завтра",
      })
    ).rejects.toThrow(/ISO-8601/);
    expect(db.getNode("bad-date")).toBeUndefined();
  });
});

// ---- 8: миграция v12 → v13 ----

describe("F1: миграция v12 → v13", () => {
  it("8. данные сохранены, valid_until никем не дозаполнен, repo_path добавлен", async () => {
    const { dbPath, tmp } = await buildV12Fixture();

    const reopened = new KnowledgeDB(dbPath);
    try {
      expect(reopened.getUserVersion()).toBe(14);
      // данные целы
      const d = reopened.getNode("d")!;
      expect(d.summary).toContain("указател");
      const f = reopened.getNode("f")!;
      expect(f.valid_until).toBe(PAST); // записанное владельцем значение не тронуто
      const g = reopened.getNode("g")!;
      expect(g.valid_until ?? null).toBeNull(); // колонка никем не дозаполнена
      // структура: node_artifacts несёт repo_path
      const cols = (
        reopened.pragma("table_info(node_artifacts)") as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toContain("repo_path");
      // врач согласен
      const { runDoctor } = await import("../doctor.js");
      const { problems } = runDoctor(reopened);
      expect(problems).toBe(0);
    } finally {
      reopened.close();
      await cleanupDir(tmp);
    }
  });
});

/**
 * База в точности как её оставил 2.1.11 (schema v12): полная структура минус
 * node_artifacts.repo_path, user_version = 12. Среди узлов — активный факт
 * с вышедшим сроком (1 из 11 активных — doctor ещё зелёный) и пара без
 * срока: миграция не имеет права дозаполнить колонку.
 */
async function buildV12Fixture(): Promise<{ dbPath: string; tmp: string }> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-v12-"));
  const dbPath = path.join(tmpDir, "knowledge.db");
  const builder = new KnowledgeDB(dbPath);
  ensureSchema(builder);
  markMigrated(builder);
  ensureEmbedMeta(builder, emptyReport());
  builder.insertNode({ id: "d", name: "d", kind: "decision", summary: "Решение держится на указателе кэша" });
  builder.insertNode({ id: "f", name: "f", kind: "feature", summary: "Кэш по mtime живёт до конца квартала", valid_until: PAST });
  builder.insertNode({ id: "g", name: "g", kind: "feature", summary: "Импорт резолвит пути через tsconfig paths" });
  for (let i = 1; i <= 8; i++) {
    builder.insertNode({ id: `extra-${i}`, name: `extra-${i}`, kind: "feature", summary: `Наполнитель для доли просроченных, часть ${i}` });
  }
  builder.close();
  const raw = new Database(dbPath);
  raw.exec("ALTER TABLE node_artifacts DROP COLUMN repo_path");
  raw.pragma("user_version = 12");
  raw.close();
  return { dbPath, tmp: tmpDir };
}
