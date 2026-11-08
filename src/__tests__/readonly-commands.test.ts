import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Database from "libsql";
import { SCHEMA_VERSION } from "../db.js";
import { openReadonlyOrExplain } from "../cli-utils.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";

/**
 * План 18 (2.4.0): читающие команды не пишут в базу.
 *
 * `export`, `eval`, `conflicts` открывают базу ТОЛЬКО НА ЧТЕНИЕ
 * (openReadonlyOrExplain): на устаревшей схеме — понятный отказ с готовой
 * командой `megamemory migrate --apply --db "<путь>"` и exit 2;
 * MEGAMEMORY_ALLOW_AUTO_MIGRATE=1 возвращает прежнее RW-открытие
 * с авто-миграцией. `doctor` (как и serve/MCP) по-прежнему мигрирует.
 *
 * Шаг 0 плана нашёл скрытые записи телеметрии (db.insertUsage) в путях
 * `bench` (understand) и `stats` (list_roots) — по правилу §3.2.2 они
 * ВЫЧЕРКНУТЫ из конверсии и остаются RW; тесты ниже фиксируют это решение
 * (старая база по-прежнему авто-мигрирует под ними).
 */

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/demo.db"
);
/** Насколько «устареваем» копию фикстуры, чтобы получить старую схему. */
const SCHEMA_DELTA = 9;

let fixture: AuditFixture;

beforeEach(() => {
  fixture = auditFixture();
});

afterEach(async () => {
  await fixture.close();
});

function sha(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Копия фикстуры с заниженной user_version — «старая база». */
function makeOldDb(name: string): string {
  const copy = fixture.file(name);
  fs.copyFileSync(FIXTURE, copy);
  const raw = fixture.track(new Database(copy));
  raw.pragma(`user_version = ${SCHEMA_VERSION - SCHEMA_DELTA}`);
  raw.close();
  return copy;
}

function userVersion(p: string): number {
  const raw = fixture.track(new Database(p));
  const rows = raw.pragma("user_version") as Array<{ user_version: number }>;
  const value = rows[0].user_version;
  raw.close();
  return value;
}

/**
 * -wal/-shm исчезают после освобождения нативного хендла — нудж GC и ждём.
 * Только для in-process соединений (B6): вышедший дочерний процесс своих
 * sidecar-файлов не чистит — на спавн-тесты этот ассерт не распространяется.
 */
async function waitSidecarsGone(dbPath: string): Promise<void> {
  globalThis.gc?.();
  for (let i = 0; i < 30; i++) {
    const wal = fs.existsSync(`${dbPath}-wal`);
    const shm = fs.existsSync(`${dbPath}-shm`);
    if (!wal && !shm) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
  expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
}

function spawnCli(
  args: string[],
  extraEnv: Record<string, string> = {}
): { status: number | null; output: string } {
  if (!fs.existsSync(cli)) throw new Error("Build dist before running readonly-commands tests");
  const { env } = fixture.profile();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fixture.root,
    // Без сети, без векторного пути, без унаследованной пользовательской базы.
    env: {
      ...env,
      NODE_OPTIONS: "",
      MEGAMEMORY_DB_PATH: "",
      MEGAMEMORY_SEARCH: "fts",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      NO_COLOR: "1",
      ...extraEnv,
    },
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error(
      `Subprocess did not complete: ${result.error?.message ?? result.signal}`,
      { cause: result.error }
    );
  }
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("план 18: export на устаревшей схеме", () => {
  it("B1: exit 2, в выводе migrate --apply и env-выход, файл базы не изменился", async () => {
    const oldDb = makeOldDb("b1-old.db");
    const before = sha(oldDb);

    const result = spawnCli(["export", "--db", oldDb, "--md", fixture.file("b1-md")]);

    expect(result.status).toBe(2);
    expect(result.output).toContain("migrate --apply");
    expect(result.output).toContain("MEGAMEMORY_ALLOW_AUTO_MIGRATE=1");
    expect(sha(oldDb)).toBe(before);
  });

  it("B2: MEGAMEMORY_ALLOW_AUTO_MIGRATE=1 возвращает RW-открытие — exit 0 и схема поднята", async () => {
    const oldDb = makeOldDb("b2-old.db");

    const result = spawnCli(
      ["export", "--db", oldDb, "--md", fixture.file("b2-md")],
      { MEGAMEMORY_ALLOW_AUTO_MIGRATE: "1" }
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain("exported");
    expect(userVersion(oldDb)).toBe(SCHEMA_VERSION);
  });
});

describe("план 18: eval и conflicts на устаревшей схеме — exit 2", () => {
  it("B3a: eval отказывает по схеме (валидный файл пар подготовлен до открытия БД)", async () => {
    const oldDb = makeOldDb("b3a-old.db");
    const pairs = fixture.file("b3a-eval.jsonl");
    fs.writeFileSync(
      pairs,
      `${JSON.stringify({ query: "alpha", expected_id: "alpha", lang: "en" })}\n`,
      "utf8"
    );

    const result = spawnCli(["eval", "--db", oldDb, "--file", pairs, "--k", "1", "--min", "0"]);

    expect(result.status).toBe(2);
    expect(result.output).toContain("migrate --apply");
  });

  it("B3b: conflicts отказывает по схеме", async () => {
    const oldDb = makeOldDb("b3b-old.db");

    const result = spawnCli(["conflicts", "--db", oldDb]);

    expect(result.status).toBe(2);
    expect(result.output).toContain("migrate --apply");
  });
});

describe("план 18: вычеркнутые из конверсии команды (§3.2.2 — скрытая запись insertUsage)", () => {
  it("stats и bench по-прежнему открывают RW: старая база авто-мигрирует, exit 0", async () => {
    const statsDb = makeOldDb("b3c-stats-old.db");
    const stats = spawnCli(["stats", "--db", statsDb]);
    expect(stats.status).toBe(0);
    expect(stats.output).toContain("megamemory stats");
    expect(userVersion(statsDb)).toBe(SCHEMA_VERSION);

    const benchDb = makeOldDb("b3d-bench-old.db");
    const questions = fixture.file("b3d-questions.jsonl");
    fs.writeFileSync(
      questions,
      `${JSON.stringify({ id: "q1", query: "catalog import", lang: "en" })}\n`,
      "utf8"
    );
    const bench = spawnCli(["bench", "--db", benchDb, "--questions", questions]);
    expect(bench.status).toBe(0);
    expect(bench.output).toContain("megamemory bench");
    expect(userVersion(benchDb)).toBe(SCHEMA_VERSION);
  });
});

describe("план 18: актуальная схема", () => {
  it("B4: export на копии фикстуры работает и не меняет файл базы", async () => {
    const copy = fixture.file("b4-current.db");
    fs.copyFileSync(FIXTURE, copy);
    const before = sha(copy);

    const result = spawnCli(["export", "--db", copy, "--md", fixture.file("b4-md")]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("exported");
    expect(sha(copy)).toBe(before);
  });

  it("B5: doctor на старой базе мигрирует её (осознанно: doctor остаётся RW)", async () => {
    const oldDb = makeOldDb("b5-old.db");

    const result = spawnCli(["doctor", "--db", oldDb]);

    // doctor сообщает и о проблемах здоровья самой демо-базы (embed_model не
    // записан, узел вне FTS) — его exit-код здесь не про миграцию. Контракт
    // B5: RW-открытие подняло схему, doctor отчитался уже по v13.
    expect(result.output).toContain("megamemory doctor");
    expect(result.output).toContain("matches SCHEMA_VERSION");
    expect(userVersion(oldDb)).toBe(SCHEMA_VERSION);
  });
});

describe("план 18: ошибки схемы без ввода в заблуждение", () => {
  it("SCHEMA_TOO_NEW: exit 2, совет обновить пакет, БЕЗ env-подсказки (она не помогла бы)", async () => {
    const copy = fixture.file("b-newer.db");
    fs.copyFileSync(FIXTURE, copy);
    const raw = fixture.track(new Database(copy));
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();

    const result = spawnCli(["conflicts", "--db", copy]);

    expect(result.status).toBe(2);
    expect(result.output).toContain("создана более новой версией");
    expect(result.output).toContain("Обнови пакет");
    expect(result.output).not.toContain("MEGAMEMORY_ALLOW_AUTO_MIGRATE");
  });
});

describe("план 18 B6: родной файл фикстуры читается readonly-хелпером без мутации", () => {
  it("openReadonlyOrExplain на fixtures/demo.db: нет FIXTURE_WRITE_FORBIDDEN, байты не изменились", async () => {
    const before = sha(FIXTURE);
    const savedEnv = process.env.MEGAMEMORY_ALLOW_AUTO_MIGRATE;
    delete process.env.MEGAMEMORY_ALLOW_AUTO_MIGRATE;
    try {
      // Страж фикстур запрещает RW-открытие fixtures/*; readonly-путь —
      // легален. Это главное отличие от прежнего поведения: RW-открытие
      // здесь падало бы (FIXTURE_WRITE_FORBIDDEN), а чтение — работает.
      const db = openReadonlyOrExplain(FIXTURE, "export");
      try {
        expect(db.getStats().nodes).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      if (savedEnv === undefined) delete process.env.MEGAMEMORY_ALLOW_AUTO_MIGRATE;
      else process.env.MEGAMEMORY_ALLOW_AUTO_MIGRATE = savedEnv;
    }

    expect(sha(FIXTURE)).toBe(before);
    await waitSidecarsGone(FIXTURE);
  });
});
