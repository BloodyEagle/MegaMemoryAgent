/**
 * 2.1.12 F5 / M2 B4: scripts/report-journals.mjs находит журнальные узлы и
 * не пишет в базу. Скрипт — глаза, не руки: решение по каждой строке за
 * владельцем. С M2 скрипт — тонкий adapter над src/scan-expiry.ts (dist):
 * правила не дублируются, опоры считаются ИСХОДЯЩИЕ живые informed_by с
 * живыми целями (R11), база открывается readonly (query_only), ошибка git —
 * явная ошибка (B4.8).
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import { link } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

/** Логический слепок всех данных — то, что скрипт не имеет права менять. */
function dump(dbPath: string): string {
  const raw = new Database(dbPath);
  try {
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'nodes_fts%'").all() as Array<{ name: string }>
    ).map((t) => t.name).sort();
    const out: Record<string, unknown[]> = {};
    for (const t of tables) {
      out[t] = raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    }
    return JSON.stringify(out);
  } finally {
    raw.close();
  }
}

/** Колонка таблицы скана по id (ячейки разделены двумя+ пробелами). */
function rowCells(out: string, id: string): string[] {
  const line = out.split("\n").find((l) => l.includes(id));
  if (!line) return [];
  return line.trim().split(/\s{2,}/);
}

describe("report-journals.mjs (2.1.12 F5, M2 B4 adapter)", () => {
  it("21. находит 3 журнала на фикстуре, считает опоры ИСХОДЯЩИМИ и не пишет в базу", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-journals-"));
    const dbPath = path.join(tmpDir, "knowledge.db");
    db = new KnowledgeDB(dbPath);

    // три журнальных узла: PR-состояние, релиз, «не начато»
    db.insertNode({
      id: "pr-19-state",
      name: "pr-19-state",
      kind: "decision",
      summary: "PR #19 не открыт, патч ждёт ревью после рефакторинга",
    });
    db.insertNode({
      id: "release-2111",
      name: "release-2111",
      kind: "feature",
      summary: "Релиз 2.1.11 влит в main 2026-11-01, тег стоит на merge-коммите",
    });
    db.insertNode({
      id: "migration-status",
      name: "migration-status",
      kind: "module",
      summary: "Миграция базы MODX не начата, план согласован 2026-10-30",
    });
    // опора: follower ОПИРАЕТСЯ на релиз (follower --informed_by--> release-2111).
    // R11: релиз — цель опоры, его исходящих опор нет; у follower — одна.
    db.insertNode({
      id: "follower",
      name: "follower",
      kind: "feature",
      summary: "Решение о выпуске 2.1.11 опирается на состояние публикации",
    });
    link(db, { from: "follower", to: "release-2111", relation: "informed_by", description: "релиз подтверждает решение" });
    // два не-журнала: поведение и соглашение без дат/PR/версий
    db.insertNode({
      id: "behavior",
      name: "behavior",
      kind: "pattern",
      summary: "Импорт резолвит пути через tsconfig paths и кэширует результат по mtime",
    });
    db.insertNode({
      id: "convention",
      name: "convention",
      kind: "feature",
      summary: "Имена тестов повторяют имя модуля, чтобы поиск находил пару",
    });

    const before = dump(dbPath);
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const out = execFileSync("node", ["scripts/report-journals.mjs", "--db", dbPath], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const after = dump(dbPath);

    // логическое содержимое базы не изменилось
    expect(after).toBe(before);

    // четыре кандидата (3 журнала + follower с маркером версии), не-журналы не попали
    expect(out).toContain("pr-19-state");
    expect(out).toContain("release-2111");
    expect(out).toContain("migration-status");
    expect(out).toContain("follower");
    expect(out).not.toContain("behavior");
    expect(out).not.toContain("convention");
    // колонки таблицы на месте
    expect(out).toContain("valid_until");
    expect(out).toContain("нет valid_until при утверждении о состоянии");

    // R11: направление опор — исходящие живые informed_by с живыми целями.
    // release-2111 — ЦЕЛЬ опоры: у него 0 исходящих (старый скрипт насчитал 1).
    expect(rowCells(out, "release-2111")[3]).toBe("0");
    // follower опирается на релиз: у него 1 исходящая живая опора
    expect(rowCells(out, "follower")[3]).toBe("1");
  });

  it("ошибка git (--repo вне репозитория) — явная ошибка, не «кандидатов нет» (B4.8)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-journals-git-"));
    const dbPath = path.join(tmpDir, "knowledge.db");
    db = new KnowledgeDB(dbPath);
    db.insertNode({
      id: "jr-git",
      name: "jr-git",
      kind: "journal",
      summary: "PR #40 открыт, ждёт ревью",
    });
    const notARepo = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

    let failed = false;
    try {
      execFileSync("node", ["scripts/report-journals.mjs", "--db", dbPath, "--repo", notARepo], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      failed = true;
      const message = String((err as { stderr?: Buffer }).stderr ?? err);
      expect(message).toContain("git");
    }
    expect(failed).toBe(true);
  });
});
