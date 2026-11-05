/**
 * 2.1.12 F5: scripts/report-journals.mjs находит журнальные узлы и не пишет
 * в базу. Скрипт — глаза, не руки: решение по каждой строке за владельцем.
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

describe("report-journals.mjs (2.1.12 F5)", () => {
  it("21. находит 3 журнала на фикстуре и не пишет в базу", () => {
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
    // опора на один из журналов — колонка supports должна это показать
    db.insertNode({
      id: "follower",
      name: "follower",
      kind: "feature",
      summary: "Решение о релизе опирается на состояние PR",
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

    // три кандидата, не-журналы не попали
    expect(out).toContain("pr-19-state");
    expect(out).toContain("release-2111");
    expect(out).toContain("migration-status");
    expect(out).not.toContain("behavior");
    expect(out).not.toContain("convention");
    // колонки таблицы на месте
    expect(out).toContain("valid_until");
    expect(out).toContain("нет valid_until при утверждении о состоянии");
    // опоры посчитаны
    const row = out.split("\n").find((l) => l.includes("release-2111"))!;
    expect(row).toMatch(/1/);
  });
});
