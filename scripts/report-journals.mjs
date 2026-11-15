#!/usr/bin/env node
/**
 * 2.1.12 F5 / M2 B4 (план 20+21 v3 §7): разовая уборка журналов — НАЙТИ,
 * не чинить. Скрипт — тонкий adapter над единым module обнаружения
 * кандидатов src/scan-expiry.ts (собирается в dist/scan-expiry.js): правила
 * (маркеры, направление опор, исключённые kinds, git-диагностика) живут в
 * одном месте, здесь только открытие и текстовый рендер.
 *
 * Журнальные узлы («PR #19 не открыт», «релиз 2.1.11 влит») не устаревают
 * сами: опор у них нет, support_check не видит изменений. Схема v13 даёт
 * таким узлам valid_until, но расставить сроки по накопленной базе — решение
 * владельца. Скрипт печатает таблицу:
 *
 *   id | kind | создан | опоры | valid_until | признаки журнала | противоречия
 *
 * «Опоры» — ИСХОДЯЩИЕ живые informed_by с живыми целями (R11: старая версия
 * скрипта считала входящие — направление опор перепутано). Существующий
 * git tag не доказывает влитость конкретного PR: расхождение с «не влито» —
 * признак кандидата, не авто-опровержение (R09).
 *
 * База открывается через KnowledgeDB readonly (PRAGMA query_only = ON) —
 * безопасный readonly-путь, а не «только SELECT» поверх сырого RW libsql.
 * Скрипт НИЧЕГО не пишет в базу. JSON для машины: `megamemory expire --scan
 * --json` — версионный отчёт, совместимый с `expire --report`.
 *
 * Использование:
 *   node scripts/report-journals.mjs --db <путь-к-knowledge.db> [--repo <путь-к-репозиторию>]
 *
 * Требует собранного dist (npm run build).
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function flag(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const dbPath = flag("db");
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("Использование: node scripts/report-journals.mjs --db <путь-к-knowledge.db> [--repo <путь>]");
  process.exit(1);
}
const repoPath = flag("repo");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(projectRoot, "dist");
if (!fs.existsSync(path.join(distDir, "scan-expiry.js"))) {
  console.error("dist не собран: правила скана живут в src/scan-expiry.ts. Выполни `npm run build` и повтори.");
  process.exit(1);
}

const { KnowledgeDB } = await import(pathToFileURL(path.join(distDir, "db.js")).href);
const { scanExpiryCandidates, renderScanText, ScanError } = await import(
  pathToFileURL(path.join(distDir, "scan-expiry.js")).href
);

let db;
try {
  db = new KnowledgeDB(dbPath, { readonly: true });
  const report = scanExpiryCandidates(db, { repoPath });
  console.log(renderScanText(report));
} catch (err) {
  // Ошибка git / нечитаемая база — явная ошибка, а не «кандидатов нет» (B4.8).
  console.error(
    err instanceof ScanError || (err && err.constructor?.name === "ScanError")
      ? err.message
      : `report-journals: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
} finally {
  if (db) db.close();
}
