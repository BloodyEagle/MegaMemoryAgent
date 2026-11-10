import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { createConcept } from "../tools.js";
import { MODEL_NAME, embeddingProfile, vectorSearchEnabled } from "../embeddings.js";
import { cleanupDir } from "./helpers/cleanup.js";

// 2.1.10 F4: дубликаты по смыслу при создании. Две сессии независимо
// записали одну и ту же работу — сервер не помешал, слияние сработало
// постфактум. Теперь create_concept перед вставкой проверяет нормализованное
// имя (регистр, пробелы, пунктуация, ё/е) и вектор саммари (топ-3, порог
// из конфига, по умолчанию 0.92) и отказывает с duplicate_of; force —
// осознанный обход. digest и серверные якоря проверка не трогает.

const DIM = 96;

/** Детерминированный «эмбеддер» — нормализованный мешок слов. */
function bag(text: string): Buffer {
  const vec = new Float32Array(DIM);
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vec[h % DIM] += 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// Мок повторяет реальный контракт embedForStorage: векторный канал выключен,
// пока meta.embed_model не совпадает с моделью ( тест 19 честно получает null).
vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embedForStorage: vi.fn(
      async (db: KnowledgeDB, text: string) =>
        vectorSearchEnabled(db) ? bag(text) : null
    ),
  };
});

let tmpDir: string;

function newDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-dedupe-"));
  return new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
}

const dbs: KnowledgeDB[] = [];
afterEach(async () => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  await cleanupDir(tmpDir);
});

const SUMMARY =
  "импорт каталога кэширует путь модуля по ключу путь mtime и сбрасывает кэш при изменении tsconfig";
const FAR =
  "очередь хранит письма и повторяет отправку с бэкоффом по расписанию smtp";

/** P-10: векторный канал включается только активным поколением. Штампуем
 * поколение с явным dim: на пустой базе reembed не публикует ни одного
 * вектора, и dim остался бы нулём (канал всё ещё закрыт). */
async function enableSemantic(db: KnowledgeDB) {
  const generation = db.beginVectorGeneration({ model: MODEL_NAME, profile: embeddingProfile(MODEL_NAME), dim: DIM });
  db.finishVectorGeneration(generation);
}

describe("2.1.10 F4: дедупликация при создании", () => {
  it("15. близкое имя (регистр/пунктуация/ё-е) → duplicate_of, узел не создан", async () => {
    const db = newDb();
    dbs.push(db);
    const first = await createConcept(db, {
      name: "Планировщик Ёлки",
      kind: "feature",
      summary: SUMMARY,
    });
    expect(first.id).toBeDefined();

    const dup = await createConcept(db, {
      name: "планировщик елки",
      kind: "feature",
      summary: FAR,
    });
    expect(dup.id).toBeUndefined();
    expect(dup.duplicate_of).toBe(first.id);
    expect(dup.matched_by).toBe("name");
    expect(dup.similarity).toBe(1);
    expect(dup.message).toContain("Похожий узел уже есть");
    expect(dup.message).toContain("force: true");
    // Второй узел не записан ни под каким id.
    expect(
      db.execSqlAll("SELECT id FROM nodes WHERE name = 'планировщик елки'")
    ).toHaveLength(0);
  });

  it("16. близкий смысл при разных именах → duplicate_of, matched_by: semantic", async () => {
    const db = newDb();
    dbs.push(db);
    await enableSemantic(db); // векторный канал включён активным поколением
    const first = await createConcept(db, {
      name: "Импорт",
      kind: "decision",
      summary: SUMMARY,
    });
    expect(first.id).toBeDefined();

    const dup = await createConcept(db, {
      name: "Кэш",
      kind: "decision",
      // То же утверждение под другим именем узла — вектор совпадает по смыслу.
      summary: SUMMARY,
    });
    expect(dup.id).toBeUndefined();
    expect(dup.duplicate_of).toBe(first.id);
    expect(dup.matched_by).toBe("semantic");
    expect(dup.similarity).toBeGreaterThanOrEqual(0.92);
  });

  it("17. force: true → создан как обычно", async () => {
    const db = newDb();
    dbs.push(db);
    const first = await createConcept(db, {
      name: "Планировщик Ёлки",
      kind: "feature",
      summary: SUMMARY,
    });
    const forced = await createConcept(db, {
      name: "планировщик елки",
      kind: "feature",
      summary: SUMMARY,
      force: true,
    });
    expect(forced.id).toBeDefined();
    expect(forced.id).not.toBe(first.id);
    expect(forced.duplicate_of).toBeUndefined();
    expect(db.getNode(forced.id!)).toBeDefined();
  });

  it("18. далёкий текст → создан без предупреждения", async () => {
    const db = newDb();
    dbs.push(db);
    await enableSemantic(db);
    await createConcept(db, {
      name: "Планировщик Ёлки",
      kind: "feature",
      summary: SUMMARY,
    });
    const far = await createConcept(db, {
      name: "Очередь уведомлений",
      kind: "feature",
      summary: FAR,
    });
    expect(far.id).toBeDefined();
    expect(far.duplicate_of).toBeUndefined();
  });

  it("19. векторный канал выключен → работает только проверка по имени, без падения", async () => {
    const db = newDb();
    dbs.push(db);
    // meta.embed_model не проставлен — embedForStorage возвращает null.
    await createConcept(db, {
      name: "Импорт",
      kind: "decision",
      summary: SUMMARY,
    });
    // Тот же смысл, другое имя: семантика недоступна — узел создаётся.
    const semanticMiss = await createConcept(db, {
      name: "Кэш",
      kind: "decision",
      summary: SUMMARY,
    });
    expect(semanticMiss.id).toBeDefined();
    // Но имя-канал работает: дубль по имени ловится и без вектора.
    const nameHit = await createConcept(db, {
      name: "импорт",
      kind: "decision",
      summary: FAR,
    });
    expect(nameHit.id).toBeUndefined();
    expect(nameHit.matched_by).toBe("name");
  });

  it("20. kind=digest — проверка пропускается", async () => {
    const db = newDb();
    dbs.push(db);
    await createConcept(db, {
      name: "Планировщик Ёлки",
      kind: "feature",
      summary: SUMMARY,
    });
    // digest с тем же нормализованным именем создаётся — проверка не действует.
    const digest = await createConcept(db, {
      name: "планировщик елки",
      kind: "digest",
      summary: "сводка хранит детей модуля и их опоры",
    });
    expect(digest.id).toBeDefined();
    expect(digest.duplicate_of).toBeUndefined();
    expect(db.getNode(digest.id!)).toBeDefined();
  });

  it("порог читается из megamemory.config.json (dedupe.threshold)", async () => {
    const db = newDb();
    dbs.push(db);
    await enableSemantic(db);
    fs.writeFileSync(
      path.join(path.dirname(db.dbPath), "megamemory.config.json"),
      JSON.stringify({ dedupe: { threshold: 0.5 } })
    );
    await createConcept(db, {
      name: "Импорт",
      kind: "decision",
      summary: SUMMARY,
    });
    // Смысл близкий, но не идентичный: при дефолте 0.92 прошло бы,
    // с порогом 0.5 — ловится как semantic-дубль.
    const dup = await createConcept(db, {
      name: "Очередь",
      kind: "decision",
      summary: SUMMARY + " и ещё письмо администратору",
    });
    expect(dup.duplicate_of).toBeDefined();
    expect(dup.matched_by).toBe("semantic");
  });
});
