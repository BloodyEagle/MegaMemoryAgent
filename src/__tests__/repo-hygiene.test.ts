import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

// 2.1.10 F2 (тесты 9-10): отчёты планов живут на уровень выше каталога
// проекта, а не в репозитории. plans/ в .gitignore; в индексе планов нет.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" });
}

describe("2.1.10 F2: гигиена репозитория", () => {
  it("9. .gitignore содержит plans/", () => {
    const lines = fs
      .readFileSync(path.join(ROOT, ".gitignore"), "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines).toContain("plans/");
  });

  it("10. git ls-files не содержит plans/", () => {
    const tracked = git(["ls-files", "plans/"]).trim();
    expect(tracked).toBe("");
  });

  it("npm pack не тянет планы (plans/ нет в files)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")
    ) as { files?: string[] };
    expect(pkg.files ?? []).not.toContain("plans");
  });
});

describe("08-N2 (план 09): фикстуры только для чтения", () => {
  // Полный прогон тестов не должен менять файлы в fixtures/ — после прогона
  // fixtures/demo.db растёт, и у каждого, кто склонировал репозиторий,
  // git status показывает «грязный» worktree. Эталонные хеши —
  // fixtures/sha256sums.txt; легитимное обновление фикстуры обязано
  // обновить и список.
  const FIXTURES = path.join(ROOT, "fixtures");
  const SUMS_FILE = path.join(FIXTURES, "sha256sums.txt");

  interface SumsEntry { hash: string; file: string }

  function readSums(): SumsEntry[] {
    return fs
      .readFileSync(SUMS_FILE, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((line) => {
        // формат `sha256sum`: <hash> *<path> | <hash>  <path>
        const match = /^([0-9a-f]{64}) \*?(.+)$/.exec(line.trim());
        if (!match) throw new Error(`malformed sha256sums.txt line: ${line}`);
        return { hash: match[1], file: match[2] };
      });
  }

  function actualHash(file: string): string {
    return createHash("sha256")
      .update(fs.readFileSync(path.join(ROOT, file)))
      .digest("hex");
  }

  it("хеши фикстур совпадают с fixtures/sha256sums.txt", () => {
    const entries = readSums();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(actualHash(entry.file), `${entry.file} mutated during the run`).toBe(entry.hash);
    }
  });

  it("в fixtures/ нет файлов вне списка sha256sums.txt", () => {
    const listed = new Set(readSums().map((e) => path.basename(e.file)));
    const actual = fs.readdirSync(FIXTURES).filter((f) => f !== "sha256sums.txt");
    for (const f of actual) {
      expect(listed.has(f), `unlisted fixture file: ${f} — добавь в sha256sums.txt`).toBe(true);
    }
  });
});
