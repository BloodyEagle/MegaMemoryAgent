import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { AGENTS_MD_END, AGENTS_MD_SNIPPET, SESSION_EXAMPLE, buildGuideText } from "../guide.js";
import { buildHelp } from "../help.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const SNIPPET = AGENTS_MD_SNIPPET.trimStart();

describe("AGENTS_MD_SNIPPET — онбординг провенанса (2.1.5 F1)", () => {
  it("весь блок не длиннее 60 строк — сниппет живёт в контексте каждой сессии", () => {
    const lines = SNIPPET.split("\n").length;
    expect(lines).toBeLessThanOrEqual(60);
  });

  it("учит опорам при записи: evidence с why, file_refs не опора, автовывод — черновик", () => {
    expect(SNIPPET).toContain("evidence: [{node | ref, why}]");
    expect(SNIPPET).toContain("auto_ground");
  });

  it("учит подтверждению версий и чтению состояний support_check", () => {
    expect(SNIPPET).toContain("confirm_supports(decision_id,");
    expect(SNIPPET).toContain("expected_status_digest");
    expect(SNIPPET).toContain("support_check.state");
    // unknown и incomplete — НЕ «всё хорошо»
    expect(SNIPPET).toMatch(/`unknown` and `incomplete` are NOT/);
    // truncated_by — обход неполный, «опор больше нет» не выводится
    expect(SNIPPET).toContain("truncated_by: depth|nodes|scan");
  });

  it("учит реакции на instructions_stale", () => {
    expect(SNIPPET).toContain("instructions_stale: true");
    expect(SNIPPET).toContain("megamemory install");
  });

  it("сохраняет ключевые слова прежнего сниппета (install.test.ts опирается на них)", () => {
    expect(SNIPPET).toContain("supersedes");
    expect(SNIPPET).toContain("max_tokens");
    expect(SNIPPET).toContain("reembed");
    expect(SNIPPET).toContain("## Project Knowledge Graph");
    expect(SNIPPET.trimEnd().endsWith(AGENTS_MD_END)).toBe(true);
  });
});

describe("megamemory guide (2.1.5 F2)", () => {
  it("печатает ровно сниппет — одна константа, один источник", () => {
    const guide = buildGuideText();
    expect(guide).toContain(SNIPPET);
    // сниппет идёт первым, без вставок до него
    expect(guide.startsWith(SNIPPET)).toBe(true);
  });

  it("добавляет пример сессии 15–20 строк: старт → вопрос → запись с evidence → подтверждение", () => {
    expect(buildGuideText()).toContain(SESSION_EXAMPLE.trimStart());
    const fenceMatch = SESSION_EXAMPLE.match(/```\n([\s\S]*?)\n```/);
    expect(fenceMatch).not.toBeNull();
    const lines = fenceMatch![1].split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(15);
    expect(lines.length).toBeLessThanOrEqual(20);
    // полный цикл присутствует
    const example = fenceMatch![1];
    expect(example).toContain("list_roots()");
    expect(example).toContain("understand(");
    expect(example).toContain("evidence:");
    expect(example).toContain("confirm_supports(");
  });
});

describe("документация про bench (2.1.5 F5)", () => {
  it("строка про bench из сниппета присутствует в выводе guide — один источник текста", () => {
    const benchLine = SNIPPET.split("\n").find((l) => l.includes("megamemory bench"));
    expect(benchLine).toBeDefined();
    expect(buildGuideText()).toContain(benchLine!);
  });

  it("--help перечисляет bench и флаг --baseline со всеми тремя значениями", () => {
    const help = plain(buildHelp("2.1.5"));
    expect(help).toMatch(/^  bench /m);
    const benchLine = help.split("\n").find((l) => l.trim().startsWith("bench "));
    expect(benchLine, "строка команды bench должна нести --db PATH (дисциплина 2.1.4)").toContain("--db PATH");
    expect(help).toMatch(/--baseline.*files \| te \| both/s);
    expect(help).toContain("--te-cmd");
    expect(help).toContain("--questions");
  });

  it("раздел «Измерение пользы» есть в обоих README", () => {
    const en = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    const ru = fs.readFileSync(path.join(PROJECT_ROOT, "README.ru.md"), "utf-8");
    expect(en).toContain("## Measuring the benefit");
    expect(en).toContain("--baseline files");
    expect(ru).toContain("## Измерение пользы");
    expect(ru).toContain("--baseline files");
  });

  it("docs/bench-protocol.md различает bench (стоимость ориентации) и живой A/B-протокол", () => {
    const doc = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "bench-protocol.md"), "utf-8");
    expect(doc).toContain("## What `bench` measures — and what it does not");
    expect(doc).toMatch(/A\/B/);
    expect(doc).toContain("10 questions");
  });
});

describe("документация про bench (2.1.6 F7)", () => {
  it("--help содержит --ref-root и --files-top с описанием hit_rate@1", () => {
    const help = plain(buildHelp("2.1.6"));
    expect(help).toContain("--ref-root");
    expect(help).toContain("--files-top");
    expect(help).toContain("hit_rate@1");
  });

  it("оба README объясняют честную цифру --files-top 3", () => {
    const en = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    const ru = fs.readFileSync(path.join(PROJECT_ROOT, "README.ru.md"), "utf-8");
    expect(en).toContain("--files-top 3");
    expect(en).toContain("### How to read the numbers");
    expect(ru).toContain("--files-top 3");
    expect(ru).toContain("### Как читать цифры");
  });
});
