#!/usr/bin/env node
/**
 * 2.1.12 F5: разовая уборка журналов — НАЙТИ, не чинить.
 *
 * Журнальные узлы («PR #19 не открыт», «релиз 2.1.11 влит») не устаревают
 * сами: опор у них нет, support_check не видит изменений. Схема v13 даёт
 * таким узлам valid_until, но расставить сроки по накопленной базе — решение
 * владельца. Скрипт находит кандидатов и печатает таблицу:
 *
 *   id | создан | опоры | valid_until | признаки журнала | противоречия
 *
 * По таблице владелец решает: поставить valid_until в прошлом (узел выпадет
 * из выдачи), перевести в superseded/refuted или удалить. Скрипт НИЧЕГО не
 * пишет в базу — только SELECT.
 *
 * Использование:
 *   node scripts/report-journals.mjs --db <путь-к-knowledge.db> [--repo <путь-к-репозиторию>]
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "libsql";

// ---- argv ----

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

// ---- признаки журнала ----

const JOURNAL_KINDS = new Set(["decision", "feature", "digest", "module"]);

const JOURNAL_PATTERNS = [
  ["дата", /\b\d{4}-\d{2}-\d{2}\b/],
  ["PR", /\b#\d+\b|\bPR\s+#?\d+/i],
  ["релиз", /\b\d+\.\d+\.\d+\b/],
  ["не начато", /не начат|not started/i],
  ["не влито", /не влит|not merged/i],
  ["влито", /влит|смержен|merged/i],
  ["закрыто", /закрыт|closed/i],
  ["открыто", /открыт|opened/i],
];

// Утверждения о состоянии — им положен valid_until (2.1.12 F1).
const STATE_CLAIM =
  /влит|смержен|merged|не начат|not started|закрыт|closed|открыт|opened|вышел|shipped|релиз/i;
const NEGATION = /не влит|не открыт|не начат|not merged|not started/i;

// ---- данные ----

const db = new Database(dbPath);

const nodes = db
  .prepare(
    `SELECT id, kind, summary, valid_until, created_at FROM nodes
     WHERE removed_at IS NULL AND kind IN ('decision','feature','digest','module')
     ORDER BY created_at, id`
  )
  .all();

function supportCount(nodeId) {
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges
         WHERE to_id = ? AND relation = 'informed_by' AND removed_at IS NULL`
      )
      .get(nodeId).n
  );
}

function repoTags() {
  if (!repoPath) return null;
  try {
    return execFileSync("git", ["tag", "--list"], { cwd: repoPath }).toString().split("\n");
  } catch (err) {
    console.error(`--repo: git недоступен или путь не репозиторий (${err.message}) — проверку тегов пропускаю`);
    return null;
  }
}

const tags = repoTags();

// ---- таблица ----

const rows = [];
for (const node of nodes) {
  if (!JOURNAL_KINDS.has(node.kind)) continue;
  const summary = node.summary ?? "";
  const hits = JOURNAL_PATTERNS.filter(([, re]) => re.test(summary)).map(([name]) => name);
  if (hits.length === 0) continue;

  const contradictions = [];
  if (STATE_CLAIM.test(summary) && !node.valid_until) {
    contradictions.push("нет valid_until при утверждении о состоянии");
  }
  if (NEGATION.test(summary) && tags) {
    const versions = [...summary.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((m) => `v${m[0]}`);
    for (const v of versions) {
      if (tags.includes(v)) {
        contradictions.push(`тег ${v} существует, а саммари говорит «не влито»`);
        break;
      }
    }
  }

  rows.push({
    id: node.id,
    kind: node.kind,
    created: (node.created_at ?? "").slice(0, 10),
    supports: supportCount(node.id),
    valid_until: node.valid_until ?? "—",
    journal: hits.join(", "),
    contradictions: contradictions.join("; ") || "—",
  });
}

if (rows.length === 0) {
  console.log("Журнальных узлов не найдено.");
} else {
  const cols = ["id", "kind", "created", "supports", "valid_until", "journal", "contradictions"];
  const width = {};
  for (const c of cols) width[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  const line = (cells) => cells.map((c) => String(c).padEnd(width[c])).join("  ");
  console.log(line(cols));
  console.log(cols.map((c) => "-".repeat(width[c])).join("  "));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
  console.log(`\nИтого: ${rows.length} кандидата(ов). Скрипт ничего не менял:`,
    "по каждой строке решает владелец — valid_until в прошлом (узел выпадет из выдачи),",
    "superseded/refuted, или удаление.");
}

db.close();
