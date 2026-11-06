import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { KnowledgeDB } from "../db.js";
import { resolveDbPath, parseDbFlag, DbPathError } from "../db-path.js";
import { runDoctorCli } from "../doctor-cli.js";
import { closeAndCleanup, cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
const originalEnv = process.env.MEGAMEMORY_DB_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-dbpath-test-"));
  delete process.env.MEGAMEMORY_DB_PATH;
});

afterEach(async () => {
  if (originalEnv === undefined) {
    delete process.env.MEGAMEMORY_DB_PATH;
  } else {
    process.env.MEGAMEMORY_DB_PATH = originalEnv;
  }
  await cleanupDir(tmpDir);
});

function makeDbFile(name = "knowledge.db"): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, "placeholder");
  return p;
}

describe("resolveDbPath — источники пути", () => {
  it("1. --db перебивает MEGAMEMORY_DB_PATH", () => {
    const flagPath = makeDbFile("flag.db");
    const envPath = makeDbFile("env.db");
    process.env.MEGAMEMORY_DB_PATH = envPath;

    const resolved = resolveDbPath(["--db", flagPath]);
    expect(resolved).toBe(path.resolve(flagPath));
  });

  it("2. MEGAMEMORY_DB_PATH перебивает путь по умолчанию в cwd", () => {
    const envPath = makeDbFile("env.db");
    process.env.MEGAMEMORY_DB_PATH = envPath;

    const resolved = resolveDbPath([]);
    expect(resolved).toBe(path.resolve(envPath));
    expect(resolved).not.toBe(path.join(process.cwd(), ".megamemory", "knowledge.db"));
  });

  it("2b. без флага и без env — путь по умолчанию в cwd", () => {
    // F6 2.1.13: тест не зависит от .megamemory в репозитории (в CI её нет) —
    // создаём свою в temp-cwd. Смысл ассерта прежний: источник по умолчанию —
    // cwd/.megamemory/knowledge.db.
    const repoCwd = process.cwd();
    fs.mkdirSync(path.join(tmpDir, ".megamemory"));
    fs.writeFileSync(path.join(tmpDir, ".megamemory", "knowledge.db"), "placeholder");
    process.chdir(tmpDir);
    try {
      expect(resolveDbPath([])).toBe(
        path.join(process.cwd(), ".megamemory", "knowledge.db")
      );
    } finally {
      process.chdir(repoCwd);
    }
  });

  it("2c. пустая MEGAMEMORY_DB_PATH считается незаданной", () => {
    process.env.MEGAMEMORY_DB_PATH = "";
    const repoCwd = process.cwd();
    fs.mkdirSync(path.join(tmpDir, ".megamemory"));
    fs.writeFileSync(path.join(tmpDir, ".megamemory", "knowledge.db"), "placeholder");
    process.chdir(tmpDir);
    try {
      expect(resolveDbPath([])).toBe(
        path.join(process.cwd(), ".megamemory", "knowledge.db")
      );
    } finally {
      process.chdir(repoCwd);
    }
  });

  it("3. --db=PATH работает так же, как --db PATH", () => {
    const p = makeDbFile("eq.db");
    expect(resolveDbPath([`--db=${p}`])).toBe(resolveDbPath(["--db", p]));
  });
});

describe("resolveDbPath — ошибки без создания файла", () => {
  it("4. --db на несуществующий путь → ошибка, файл не создан", () => {
    const missing = path.join(tmpDir, "typo-knowledge.db");

    expect(() => resolveDbPath(["--db", missing])).toThrow(DbPathError);
    expect(() => resolveDbPath(["--db", missing])).toThrow(/База не найдена/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("5. опечатка в имени файла при doctor даёт ошибку и exit 1, а не «0 проблем» на пустой базе", async () => {
    const typo = path.join(tmpDir, "knolwedge.db"); // имя с опечаткой
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      await expect(runDoctorCli(["--db", typo])).rejects.toThrow("exit:1");
      expect(fs.existsSync(typo)).toBe(false);
      const printed = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toContain("База не найдена");
      expect(printed).toContain(typo);
    } finally {
      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  it("6. --db указан дважды → ошибка о неоднозначности", () => {
    const a = makeDbFile("a.db");
    const b = makeDbFile("b.db");

    expect(() => resolveDbPath(["--db", a, "--db", b])).toThrow(/указан 2 раза/);
    expect(() => resolveDbPath([`--db=${a}`, "--db", b])).toThrow(/указан 2 раза/);
    expect(() => parseDbFlag(["--db", a, "--db", b])).toThrow(DbPathError);
  });

  it("7. --db на каталог вместо файла → ошибка с путём", () => {
    expect(() => resolveDbPath(["--db", tmpDir])).toThrow(/каталог/);
    expect(() => resolveDbPath(["--db", tmpDir])).toThrow(new RegExp(tmpDir.replace(/\\/g, "\\\\")));
  });

  it("7b. --db без значения и --db= с пустым значением — отдельные ошибки", () => {
    expect(() => resolveDbPath(["--db"])).toThrow(/нужно значение/);
    expect(() => resolveDbPath(["--db="])).toThrow(/без значения/);
    expect(() => resolveDbPath(["--db", "--apply"])).toThrow(/нужно значение/);
  });
});

describe("allowCreate — serve и MCP", () => {
  it("8. serve без существующей базы возвращает путь и создаёт её, doctor тот же пропуск не прощает", async () => {
    const serveDb = path.join(tmpDir, "fresh", "knowledge.db");
    fs.mkdirSync(path.dirname(serveDb), { recursive: true });

    // serve: путь отдаётся, хотя файла нет (первая установка)
    expect(resolveDbPath(["--db", serveDb], { allowCreate: true })).toBe(path.resolve(serveDb));
    expect(fs.existsSync(serveDb)).toBe(false);

    // ...и KnowledgeDB на этом пути базу создаёт (то, что делает serve)
    const db = new KnowledgeDB(serveDb);
    db.insertNode({ id: "seed", name: "seed", kind: "feature", summary: "s", why: null, file_refs: null, parent_id: null, created_by_task: null, embedding: null });
    await closeAndCleanup(db, path.join(tmpDir, "fresh"));

    // doctor: на отсутствующем пути файл не создаётся
    const doctorDb = path.join(tmpDir, "fresh2", "knowledge.db");
    expect(() => resolveDbPath(["--db", doctorDb])).toThrow(DbPathError);
    expect(fs.existsSync(doctorDb)).toBe(false);
  });
});

describe("requireExisting — существующий файл отдаётся", () => {
  it("возвращает путь к существующему файлу", () => {
    const p = makeDbFile("existing.db");
    expect(resolveDbPath(["--db", p])).toBe(path.resolve(p));
  });
});
