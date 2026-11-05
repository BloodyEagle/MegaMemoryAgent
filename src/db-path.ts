import fs from "node:fs";
import path from "node:path";
import { errorBold } from "./cli-utils.js";

/**
 * Единый резолвер пути к knowledge.db для всех CLI-команд.
 *
 * Раньше `--db` разобрали только stats/conflicts/resolve (и merge со своими
 * позиционными аргументами), а doctor/migrate/reembed и остальные молча брали
 * путь из MEGAMEMORY_DB_PATH или из cwd — опечатка в пути создавала пустую
 * базу и давала «всё чисто».
 */

export class DbPathError extends Error {}

export interface DbPathOptions {
  /**
   * Файл должен существовать. По умолчанию true для всех CLI-команд:
   * диагностика не создаёт базу, чтобы опечатка не выглядела чистым отчётом.
   */
  requireExisting?: boolean;
  /**
   * Только для `serve` и MCP-режима: первая установка законно создаёт базу.
   */
  allowCreate?: boolean;
}

/**
 * Разобрать `--db PATH` / `--db=PATH` из argv.
 *
 * Флаг дважды — ошибка (не «последний выиграл»): неясно, какую базу имел в
 * виду пользователь, и молчаливый выбор только усугубляет опечатку.
 */
export function parseDbFlag(argv: string[]): string | undefined {
  let found: string | undefined;
  let count = 0;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--db") {
      count += 1;
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new DbPathError(
          `Флагу --db нужно значение пути: --db <путь-к-knowledge.db>.`
        );
      }
      found = value;
      i += 1;
    } else if (token.startsWith("--db=")) {
      count += 1;
      const value = token.slice("--db=".length);
      if (value === "") {
        throw new DbPathError(
          `Флаг --db= задан без значения: --db=<путь-к-knowledge.db>.`
        );
      }
      found = value;
    }
  }

  if (count > 1) {
    throw new DbPathError(
      `Флаг --db указан ${count} раза — неясно, какую базу иметь в виду. Оставь один.`
    );
  }

  return found;
}

/**
 * Разрешить путь к базе: `--db` → `MEGAMEMORY_DB_PATH` → `<cwd>/.megamemory/knowledge.db`.
 *
 * Бросает DbPathError с путём в тексте; файл при ошибке не создаётся.
 */
export function resolveDbPath(argv: string[], opts?: DbPathOptions): string {
  const flag = parseDbFlag(argv);

  const envPath = process.env.MEGAMEMORY_DB_PATH;
  const fromEnv = envPath !== undefined && envPath.trim() !== "" ? envPath : undefined;

  const raw = flag ?? fromEnv ?? path.join(process.cwd(), ".megamemory", "knowledge.db");
  const p = path.resolve(raw);

  const requireExisting = opts?.allowCreate ? false : (opts?.requireExisting ?? true);

  if (fs.existsSync(p)) {
    if (fs.statSync(p).isDirectory()) {
      throw new DbPathError(
        `Путь указывает на каталог, а не на файл базы: ${p}. Укажи путь к knowledge.db.`
      );
    }
    return p;
  }

  if (requireExisting) {
    throw new DbPathError(
      `База не найдена: ${p}. Укажи --db, MEGAMEMORY_DB_PATH или запусти из каталога проекта.`
    );
  }

  return p;
}

/**
 * CLI-обёртка: ошибка резолвера печатается и завершает процесс кодом 1.
 */
export function resolveDbPathOrExit(argv: string[], opts?: DbPathOptions): string {
  try {
    return resolveDbPath(argv, opts);
  } catch (err) {
    if (err instanceof DbPathError) {
      errorBold(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * 2.1.12 F2: разобрать `--repo PATH` / `--repo=PATH` из argv — репозиторий
 * для разрешения git:tag/commit/branch-опор. Тот же стиль, что --db: флаг
 * дважды — ошибка, значение без пути — ошибка.
 */
export function parseRepoFlag(argv: string[]): string | undefined {
  let found: string | undefined;
  let count = 0;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--repo") {
      count += 1;
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new DbPathError(
          `Флагу --repo нужно значение пути: --repo <путь-к-репозиторию>.`
        );
      }
      found = value;
      i += 1;
    } else if (token.startsWith("--repo=")) {
      count += 1;
      const value = token.slice("--repo=".length);
      if (value === "") {
        throw new DbPathError(
          `Флаг --repo= задан без значения: --repo=<путь-к-репозиторию>.`
        );
      }
      found = value;
    }
  }

  if (count > 1) {
    throw new DbPathError(
      `Флаг --repo указан ${count} раза — неясно, какой репозиторий иметь в виду. Оставь один.`
    );
  }

  return found;
}

/**
 * Репозиторий для git:-опор: `--repo` → каталог базы (база живёт внутри
 * репозитория, git сам находит корень по .git вверх по дереву).
 */
export function resolveRepoPath(argv: string[], dbPath: string): string {
  const flag = parseRepoFlag(argv);
  return path.resolve(flag ?? path.dirname(dbPath));
}
