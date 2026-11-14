/**
 * B-06 (аудит 2026-11-12): разбор eval-набора fail-closed. Раньше
 * truthy-проверка полей молча пропускала неполные пары (опечатка
 * expectedId вместо expected_id исчезала из знаменателя), recall
 * завышался, и quality gate `--min` давал ложный success.
 *
 * Здесь: unit-тесты parse-функции (номер строки в ошибке) и CLI-тест
 * in-process: ошибка разбора — exit 1 ДО открытия БД и ДО измерения.
 * KnowledgeDB и hybridSearch замоканы, чтобы «БД не открыта» и «recall не
 * считался» были проверяемыми фактами, а не следствием падения.
 * Зелёный CLI-путь с настоящей базой — в eval-cli-gate.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  opened: [] as string[],
  searched: vi.fn(async () => []),
}));
vi.mock("../db.js", () => ({
  KnowledgeDB: class {
    constructor(file: string) {
      mocks.opened.push(file);
    }
    close(): void {}
  },
  ReadonlyDbError: class ReadonlyDbError extends Error {},
}));
vi.mock("../search.js", () => ({ hybridSearch: mocks.searched }));

import { loadEvalPairs } from "../eval.js";
import { runEvalCli } from "../eval-cli.js";
import { cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
let out: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-eval-parser-"));
  mocks.opened.length = 0;
  mocks.searched.mockClear();
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDir(tmpDir);
});

function writeEvalFile(content: string): string {
  const file = path.join(tmpDir, "eval.jsonl");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** Пустой файл базы: exists() проходит, открытие (если случится) фиксируется в mocks.opened. */
function sentinelDb(): string {
  const file = path.join(tmpDir, "sentinel.db");
  fs.writeFileSync(file, "", "utf8");
  return file;
}

describe("B-06: loadEvalPairs — fail-closed разбор JSONL", () => {
  it("hit-пара + пара с опечаткой expectedId → исключение с номером строки 2", () => {
    const jsonl = [
      JSON.stringify({ query: "alpha", expected_id: "a", lang: "en" }),
      JSON.stringify({ query: "beta", expectedId: "b", lang: "en" }),
    ].join("\n");
    expect(
      () => loadEvalPairs(jsonl),
      "B-06: неполная пара обязана отвергаться, а не исчезать молча"
    ).toThrow(/строка 2/);
  });

  it.each([
    ["null-значение поля", '{"query":"q","expected_id":null}', /строка 1.*expected_id/],
    ["массив вместо объекта", '["query","e1"]', /строка 1/],
    ["числовое поле", '{"query":42,"expected_id":"e1"}', /строка 1.*query/],
    ["пустая строка-значение", '{"query":"","expected_id":"e1"}', /строка 1.*query/],
    ["пробельное значение", '{"query":"q","expected_id":"   "}', /строка 1.*expected_id/],
    ["пустой lang", '{"query":"q","expected_id":"e1","lang":""}', /строка 1.*lang/],
    ["битый JSON", '{"query":"q", ', /строка 1/],
    ["ошибка во второй строке", '{"query":"q1","expected_id":"e1"}\n{"query":"q2","expected_id":"e2","lang":5}', /строка 2/],
  ])("%s → отказ с номером строки", (_name, jsonl, pattern) => {
    expect(() => loadEvalPairs(jsonl)).toThrow(pattern);
  });

  it("пустые строки, пробельные строки и // -комментарии пропускаются; значения не обрезаются", () => {
    const pairs = loadEvalPairs(
      [
        "",
        "   ",
        "// комментарий с ведущими пробелами",
        '{"query":"q1","expected_id":"e1","lang":"ru"}',
        "",
        '// {"query":"закомментировано","expected_id":"x"}',
        '{"query":"  q2  ","expected_id":"e2"}',
      ].join("\n")
    );
    expect(pairs).toHaveLength(2);
    expect(pairs[0].lang).toBe("ru");
    expect(pairs[1].lang).toBe("unknown");
    expect(pairs[1].query).toBe("  q2  ");
  });
});

describe("B-06: eval CLI отказывает до открытия БД и измерения", () => {
  it("набор с неполной парой — exit 1, БД не открыта, recall не печатается", async () => {
    const file = writeEvalFile(
      [
        JSON.stringify({ query: "alpha", expected_id: "a", lang: "en" }),
        JSON.stringify({ query: "beta", expectedId: "b", lang: "en" }),
      ].join("\n")
    );
    const dbFile = sentinelDb();

    await expect(
      runEvalCli(["--db", dbFile, "--file", file, "--min", "0.8"]),
      "B-06: неполный набор не получает recall"
    ).rejects.toThrow(/exit:1/);

    expect(mocks.opened, "B-06: ошибка разбора обязана отказать до открытия БД").toHaveLength(0);
    expect(mocks.searched).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("строка 2");
    expect(out.join("\n")).not.toContain("overall:");
  });

  it("полностью пустой набор — exit 1 без открытия БД (прежнее поведение сохранено)", async () => {
    const file = writeEvalFile("\n\n// только комментарии\n");
    const dbFile = sentinelDb();

    await expect(runEvalCli(["--db", dbFile, "--file", file])).rejects.toThrow(/exit:1/);

    expect(mocks.opened).toHaveLength(0);
    expect(out.join("\n")).toContain("Eval set is empty.");
  });
});
