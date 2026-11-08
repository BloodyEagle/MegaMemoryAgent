import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
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
  //
  // План 11 (2.2.1): парсер и обе проверки переехали в
  // scripts/check-fixtures.mjs — один источник истины для теста, который
  // видит состояние середины прогона, и для npm posttest, который ловит
  // мутацию после завершения всех процессов (отложенный GC-чекпоинт libsql).
  it("fixtures-guard: хеши сходятся, сайдкаров нет (середина прогона)", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/check-fixtures.mjs"], {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
      })
    ).not.toThrow();
  });
});
