import { defineConfig } from "vitest/config";

/**
 * 2.1.12 F3: прогон без флагов = прогон с флагами.
 *
 * Раньше параллелизм задавался только флагом (`npm test -- --maxWorkers=3`),
 * а дефолтный vitest.run поднимал по воркеру на файл и на живой базе с
 * libsql/эмбеддингами упирался в 5-секундный testTimeout — флак «ротировал
 * жертвы» между файлами (2.1.3).
 *
 * - `maxWorkers: 3` — глобальный дефолт; CLI-флаг по-прежнему перекрывает.
 * - Проект `db` — файлы, открывающие базу (libsql) или работающие с
 *   эмбеддингами: testTimeout 15_000 только у них, не глобально.
 * - Проект `unit` — чистые текстовые тесты (доки, хелп, гайд, гигиена
 *   репо): обычный дефолт 5000 мс. Новый файл, не внесённый в `unit`,
 *   попадает в `db` — безопасное направление асимметрии: тесту разрешено
 *   больше времени, а не меньше.
 * - Проект `integration` (2.1.13 F6) — HTTP/MCP-интеграции из
 *   tests/integration: раньше они не входили в стандартный прогон.
 *   HTTP-тесты поднимают собранный dist — полный прогон требует
 *   `npm run build` до старта.
 */
const UNIT_FILES = [
  "docs-anchors",
  "error-formatting",
  "guide",
  "help",
  "instructions",
  "repo-hygiene",
  "vitest-config",
];

export default defineConfig({
  test: {
    maxWorkers: 3,
    projects: [
      {
        test: {
          name: "unit",
          include: UNIT_FILES.map((f) => `src/__tests__/${f}.test.ts`),
        },
      },
      {
        test: {
          name: "db",
          include: ["src/__tests__/**/*.test.ts"],
          exclude: UNIT_FILES.map((f) => `src/__tests__/${f}.test.ts`),
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
