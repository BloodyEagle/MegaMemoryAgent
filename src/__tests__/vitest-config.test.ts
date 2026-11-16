/**
 * 2.1.12 F3: прогон без флагов = прогон с флагами. Конфиг обязан держать
 * дефолтный параллелизм (раньше только флагом) и отдельный testTimeout для
 * db-проекта — тяжёлые файлы с libsql/эмбеддингами флакали на дефолтных 5 с.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import config, { UNIT_FILES, TEST_PATHS } from "../../vitest.config.js";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projects = config.test!.projects as Array<{ test: { name: string; include: string[]; exclude?: string[]; testTimeout?: number; setupFiles: string[] } }>;

describe("vitest.config.ts (2.1.12 F3)", () => {
  it("16. maxWorkers: 3 задан по умолчанию, а не только флагом", () => {
    expect(config.test!.maxWorkers).toBe(3);
  });

  it("17. testTimeout: 15_000 у db-проекта, не глобально", () => {
    expect(projects.find((p) => p.test.name === "db")!.test.testTimeout).toBe(15_000);
    expect(config.test!.testTimeout).toBeUndefined();
    expect(projects.find((p) => p.test.name === "unit")!.test.testTimeout).toBeUndefined();
  });

  it("unit-список не протух: перечисленные файлы существуют на диске", () => {
    expect(UNIT_FILES.length).toBeGreaterThan(0);
    expect(UNIT_FILES).toContain("telemetry-report");
    for (const file of TEST_PATHS.unit) expect(fs.existsSync(path.join(PROJECT_ROOT, file))).toBe(true);
  });
});

describe("vitest.config.ts — интеграции в общем прогоне (2.1.13 F6)", () => {
  it("33. проекты используют один контракт include/exclude", () => {
    expect(projects.map((p) => p.test.name)).toEqual(["unit", "db", "integration"]);
    expect(projects[0].test.include).toEqual(TEST_PATHS.unit);
    expect(projects[1].test.include).toEqual(TEST_PATHS.db);
    expect(projects[1].test.exclude).toEqual(TEST_PATHS.unit);
    expect(projects[2].test.include).toEqual(TEST_PATHS.integration);
    expect(TEST_PATHS.integration).toEqual(["tests/integration/**/*.test.ts"]);
    for (const project of projects) expect(project.test.setupFiles).toContain("./src/__tests__/fixtures-guard.setup.ts");
  });

  it("33b. интеграционные файлы существуют на диске и не попадают в db/unit", () => {
    const integrationDir = path.join(PROJECT_ROOT, "tests", "integration");
    const files = fs.readdirSync(integrationDir).filter((f) => f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(fs.existsSync(path.join(integrationDir, f))).toBe(true);
      expect(TEST_PATHS.unit).not.toContain(`tests/integration/${f}`);
    }
    expect(TEST_PATHS.db).toEqual(["src/__tests__/**/*.test.ts"]);
  });
});
