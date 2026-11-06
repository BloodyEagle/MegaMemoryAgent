/**
 * 2.1.12 F3: прогон без флагов = прогон с флагами. Конфиг обязан держать
 * дефолтный параллелизм (раньше только флагом) и отдельный testTimeout для
 * db-проекта — тяжёлые файлы с libsql/эмбеддингами флакали на дефолтных 5 с.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "vitest.config.ts");

describe("vitest.config.ts (2.1.12 F3)", () => {
  const config = fs.readFileSync(CONFIG_PATH, "utf8");

  it("16. maxWorkers: 3 задан по умолчанию, а не только флагом", () => {
    expect(config).toContain("maxWorkers: 3");
  });

  it("17. testTimeout: 15_000 у db-проекта, не глобально", () => {
    // таймаут есть и поднят именно в проекте db
    expect(config).toContain("testTimeout: 15_000");
    expect(config).toContain('name: "db"');
    // и он не задет на корневом уровне test-конфига
    expect(config).not.toMatch(/^\s{4}testTimeout/m);
  });

  it("unit-список не протух: перечисленные файлы существуют на диске", () => {
    const match = config.match(/const UNIT_FILES = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const files = [...match![1].matchAll(/"([a-z0-9.-]+)"/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(fs.existsSync(path.join(PROJECT_ROOT, "src", "__tests__", `${f}.test.ts`))).toBe(true);
    }
  });
});

describe("vitest.config.ts — интеграции в общем прогоне (2.1.13 F6)", () => {
  const config = fs.readFileSync(CONFIG_PATH, "utf8");

  it("33. проект integration объявлен и включает tests/integration", () => {
    expect(config).toContain('name: "integration"');
    expect(config).toContain('include: ["tests/integration/**/*.test.ts"]');
  });

  it("33b. интеграционные файлы существуют на диске и не попадают в db/unit", () => {
    const integrationDir = path.join(PROJECT_ROOT, "tests", "integration");
    const files = fs.readdirSync(integrationDir).filter((f) => f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(fs.existsSync(path.join(integrationDir, f))).toBe(true);
    }
  });
});
