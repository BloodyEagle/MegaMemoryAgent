import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";

/**
 * Этап C (план 20+21 v3, C2/C3.3): строгий страж scripts/check-fixtures.mjs
 * проверяется и на отказе — инъекция сайдкара и инъекция мутации обязаны
 * валить прогон. Негативные проверки выполняются в отдельном временном
 * каталоге-песочнице с той же раскладкой (scripts/check-fixtures.mjs +
 * fixtures/sha256sums.txt), никогда не в настоящих fixtures/ — эталонные
 * файлы здесь только ЧИТАЮТСЯ и служат содержимым песочницы. Ослаблять
 * страж ради таких проверок нельзя: он должен падать на мусоре, а не
 * пропускать его.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = path.join(ROOT, "scripts", "check-fixtures.mjs");
const SUMS = fs.readFileSync(path.join(ROOT, "fixtures", "sha256sums.txt"));
const DEMO = fs.readFileSync(path.join(ROOT, "fixtures", "demo.db"));
const EVAL = fs.readFileSync(path.join(ROOT, "fixtures", "eval.jsonl"));

let sandbox = "";

function makeSandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-guard-sandbox-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
  // Страж вычисляет корень от собственного расположения: копия скрипта
  // в песочнице смотрит на fixtures/ песочницы, не на настоящий каталог.
  fs.copyFileSync(GUARD, path.join(root, "scripts", "check-fixtures.mjs"));
  fs.writeFileSync(path.join(root, "fixtures", "sha256sums.txt"), SUMS);
  fs.writeFileSync(path.join(root, "fixtures", "demo.db"), DEMO);
  fs.writeFileSync(path.join(root, "fixtures", "eval.jsonl"), EVAL);
  return root;
}

function runGuard(dir: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["scripts/check-fixtures.mjs"], {
    cwd: dir,
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

afterEach(() => {
  if (sandbox) {
    fs.rmSync(sandbox, { recursive: true, force: true });
    sandbox = "";
  }
});

describe("этап C: строгий страж — инъекции в песочнице валят прогон", () => {
  it("контроль: чистая песочница с эталонным содержимым — страж зелёный", () => {
    sandbox = makeSandbox();
    const r = runGuard(sandbox);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("fixtures-guard: OK");
    expect(r.stderr).toBe("");
  });

  it("инъекция сайдкара demo.db-wal — страж падает, файл назван", () => {
    sandbox = makeSandbox();
    // Фейковый сайдкар рядом с эталонным файлом — тот же след, который
    // оставляло in-process открытие фикстуры (red-лог m1c-red).
    fs.writeFileSync(path.join(sandbox, "fixtures", "demo.db-wal"), "fake wal");
    const r = runGuard(sandbox);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("demo.db-wal");
    expect(r.stderr).toContain("не внесён в sha256sums.txt");
  });

  it("инъекция мутации demo.db — страж падает с расхождением хеша", () => {
    sandbox = makeSandbox();
    const mutated = Buffer.from(DEMO);
    mutated[mutated.length - 1] ^= 0xff;
    fs.writeFileSync(path.join(sandbox, "fixtures", "demo.db"), mutated);
    const r = runGuard(sandbox);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fixtures/demo.db: хеш");
    expect(r.stderr).toContain("файл мутировал");
  });

  it("чужой непредусмотренный файл в fixtures — страж падает", () => {
    sandbox = makeSandbox();
    fs.writeFileSync(path.join(sandbox, "fixtures", "stray.db-shm"), "junk");
    const r = runGuard(sandbox);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stray.db-shm");
  });
});
