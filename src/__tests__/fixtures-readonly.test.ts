import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { KnowledgeDB, ReadonlyDbError, SCHEMA_VERSION } from "../db.js";
import { auditFixture } from "./helpers/audit.js";

/**
 * План 11 (2.2.1): фикстуры перестают меняться — не стражем, а уровнем
 * соединения. Три уровня защиты, каждый проверяется своим тестом:
 *
 * 1. Страж окружения (MEGAMEMORY_FIXTURES_DIR от setupFile) валит RW-открытие
 *    фикстуры ДО создания соединения.
 * 2. readonly-соединение читает, но любая запись падает с SQLITE_READONLY —
 *    проверяется на байт-в-байт копии фикстуры во временном каталоге (этап C
 *    плана 20+21 v3, C1.2): libsql при любом открытии WAL-базы создаёт
 *    -wal/-shm рядом с файлом и не удаляет их на close() внутри процесса,
 *    поэтому эталонный файл в тестовом процессе не открывается вовсе.
 * 3. Копия фикстуры во временном каталоге — законный путь для всего, чему
 *    нужна запись; оригинал не трогается.
 */
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/demo.db"
);

function fixtureHash(): string {
  return createHash("sha256").update(fs.readFileSync(FIXTURE)).digest("hex");
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

let hashBefore: string;

beforeAll(() => {
  hashBefore = fixtureHash();
});

afterAll(() => {
  // Отложенный GC-чекпоинт проявился бы после освобождения нативных хендлов —
  // к afterAll все соединения файла закрыты, значит следа быть не должно.
  globalThis.gc?.();
  expect(fixtureHash()).toBe(hashBefore);
});

describe("план 11: фикстуры только для чтения", () => {
  it("1. RW-открытие фикстуры падает со стражем, до создания соединения", () => {
    try {
      new KnowledgeDB(FIXTURE);
      expect.unreachable("RW-открытие фикстуры должно падать");
    } catch (err) {
      expect(err).toBeInstanceOf(ReadonlyDbError);
      expect((err as ReadonlyDbError).code).toBe("FIXTURE_WRITE_FORBIDDEN");
      expect((err as Error).message).toContain("копи");
    }
  });

  it("2. readonly-соединение читает демо-граф (изолированная копия фикстуры)", async () => {
    // Этап C (C1.2): поведение readonly-соединения с теми же настройками
    // защиты (query_only) проверяется на байт-в-байт копии — эталонный файл
    // в тестовом процессе не открывается, сайдкары остаются во временном
    // каталоге. Равенство хешей связывает проверку с реальными байтами
    // фикстуры; неудавшаяся очистка роняет тест (auditFixture.close).
    const fx = auditFixture();
    try {
      const copyPath = fx.file("demo-copy.db");
      fs.copyFileSync(FIXTURE, copyPath);
      expect(sha256File(copyPath)).toBe(fixtureHash());
      const db = fx.track(new KnowledgeDB(copyPath, { readonly: true }));
      const nodes = db.getAllNodesRaw();
      expect(nodes.length).toBeGreaterThan(0);
      // План 13.1 (F2) страж: фикстура обязана быть на текущей схеме —
      // v4 (до перегенерации) не возвращается. Копия байт-в-байт равна
      // фикстуре, значит проверка относится к её реальным байтам.
      expect(db.getUserVersion()).toBe(SCHEMA_VERSION);
    } finally {
      await fx.close();
    }
  });

  it("3. запись через readonly-соединение отклоняется, байты не меняются (изолированная копия)", async () => {
    const fx = auditFixture();
    try {
      const copyPath = fx.file("demo-copy.db");
      fs.copyFileSync(FIXTURE, copyPath);
      const db = fx.track(new KnowledgeDB(copyPath, { readonly: true }));
      expect(() =>
        db.insertNode({
          id: "fixture-write-attempt",
          name: "must not land",
          kind: "feature",
          summary: "план 11: запись в фикстуру запрещена",
        })
      ).toThrowError(/readonly/i);
      expect(sha256File(copyPath)).toBe(fixtureHash());
    } finally {
      await fx.close();
    }
    globalThis.gc?.();
    expect(fixtureHash()).toBe(hashBefore);
  });

  it("4. копия фикстуры — законный путь для записи", async () => {
    const fx = auditFixture();
    try {
      const copyPath = fx.file("demo-copy.db");
      fs.copyFileSync(FIXTURE, copyPath);
      const db = fx.track(new KnowledgeDB(copyPath));
      db.insertNode({
        id: "copy-write-ok",
        name: "запись в копию",
        kind: "feature",
        summary: "план 11: копия фикстуры принимает запись",
      });
      expect(db.getNode("copy-write-ok")).not.toBeNull();
    } finally {
      await fx.close();
    }
    expect(fixtureHash()).toBe(hashBefore);
  });
});
