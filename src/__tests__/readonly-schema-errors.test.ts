import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import Database from "libsql";
import { KnowledgeDB, ReadonlyDbError, SCHEMA_VERSION } from "../db.js";
import { auditFixture } from "./helpers/audit.js";

/**
 * План 13.1 (F1): readonly-открытие базы с чужой схемой обязано давать
 * понятный отказ с готовой командой (migrate --apply для старой, обновление
 * пакета для новой), а повреждённой базе совет мигрировать не достаётся —
 * quick_check идёт раньше совета.
 */
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/demo.db"
);

function catchReadonly(run: () => unknown): ReadonlyDbError {
  try {
    run();
  } catch (err) {
    if (err instanceof ReadonlyDbError) return err;
    throw new Error(`ожидали ReadonlyDbError, получили: ${err}`);
  }
  throw new Error("ожидали ReadonlyDbError, открытие прошло");
}

describe("план 13.1 F1: понятный отказ readonly-открытия чужой схемы", () => {
  it("старая схема: код SCHEMA_TOO_OLD_READONLY, в сообщении команда migrate и путь", async () => {
    const fx = auditFixture();
    try {
      const copyPath = fx.file("old-schema.db");
      fs.copyFileSync(FIXTURE, copyPath);
      const raw = fx.track(new Database(copyPath));
      raw.pragma(`user_version = ${SCHEMA_VERSION - 9}`);
      raw.close();

      const err = catchReadonly(() =>
        new KnowledgeDB(copyPath, { readonly: true })
      );
      expect(err.code).toBe("SCHEMA_TOO_OLD_READONLY");
      expect(err.message).toContain('megamemory migrate --apply --db "');
      expect(err.message).toContain(`${copyPath}"`);
      expect(err.message).toContain("не мигрирует");
    } finally {
      await fx.close();
    }
  });

  it("новая схема: код SCHEMA_TOO_NEW_READONLY, совет обновить пакет с user_version", async () => {
    const fx = auditFixture();
    try {
      const copyPath = fx.file("new-schema.db");
      fs.copyFileSync(FIXTURE, copyPath);
      const raw = fx.track(new Database(copyPath));
      raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
      raw.close();

      const err = catchReadonly(() =>
        new KnowledgeDB(copyPath, { readonly: true })
      );
      expect(err.code).toBe("SCHEMA_TOO_NEW_READONLY");
      expect(err.message).toContain("создана более новой версией");
      expect(err.message).toContain(`user_version = ${SCHEMA_VERSION + 1}`);
      expect(err.message).toContain("Обнови пакет");
    } finally {
      await fx.close();
    }
  });

  it("коды старой и новой схемы различаются", async () => {
    const fx = auditFixture();
    try {
      const codes: string[] = [];
      for (const delta of [-1, 1]) {
        const copyPath = fx.file(`schema-${delta}.db`);
        fs.copyFileSync(FIXTURE, copyPath);
        const raw = fx.track(new Database(copyPath));
        raw.pragma(`user_version = ${SCHEMA_VERSION + delta}`);
        raw.close();
        codes.push(catchReadonly(() => new KnowledgeDB(copyPath, { readonly: true })).code);
      }
      expect(codes[0]).not.toBe(codes[1]);
    } finally {
      await fx.close();
    }
  });

  it("повреждённая база: код DB_CORRUPT_READONLY, совета migrate нет", async () => {
    const fx = auditFixture();
    try {
      const copyPath = fx.file("damaged.db");
      fs.copyFileSync(FIXTURE, copyPath);
      const raw = fx.track(new Database(copyPath));
      raw.pragma(`user_version = ${SCHEMA_VERSION - 9}`);
      raw.close();
      // Обрезаем хвост: заголовок (user_version) цел, страницы схемы нет.
      fs.truncateSync(copyPath, 1024);

      const err = catchReadonly(() =>
        new KnowledgeDB(copyPath, { readonly: true })
      );
      expect(err.code).toBe("DB_CORRUPT_READONLY");
      expect(err.message).toContain("quick_check");
      expect(err.message).not.toContain("migrate");
    } finally {
      await fx.close();
    }
  });

  it("несуществующий путь: код DB_MISSING_READONLY, без schema-советов", async () => {
    const fx = auditFixture();
    try {
      const missing = fx.file("no-such.db");
      const err = catchReadonly(() => new KnowledgeDB(missing, { readonly: true }));
      expect(err.code).toBe("DB_MISSING_READONLY");
      expect(err.message).toContain("не найдена");
      expect(err.message).not.toContain("migrate");
    } finally {
      await fx.close();
    }
  });
});
