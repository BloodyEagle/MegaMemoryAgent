import path from "node:path";
import { fileURLToPath } from "url";

/**
 * План 11 (2.2.1): включить структурный страж фикстур на время тестов.
 *
 * MEGAMEMORY_FIXTURES_DIR указывает KnowledgeDB каталог эталонных фикстур:
 * RW-открытие файла оттуда падает с ReadonlyDbError (FIXTURE_WRITE_FORBIDDEN),
 * а не мутирует байты, которые защищает fixtures/sha256sums.txt. Env
 * наследуется spawned dist-CLI интеграционных тестов — страж покрывает и их.
 *
 * Вне тестов env не задан: make-demo-db.cjs и ручные команды легитимно пишут
 * фикстуру (легитимное обновление обязано обновить и sha256sums.txt —
 * repo-hygiene).
 */
process.env.MEGAMEMORY_FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures"
);
