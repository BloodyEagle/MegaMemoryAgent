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

  it("2.1.10: ref создаёт якорь — это опора, а не заглушка", () => {
    expect(SNIPPET).toContain("an anchor (a file-named node with a template summary)");
    expect(SNIPPET).toContain("not a stub");
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

describe("документация про дайджесты и вложенные опоры (2.1.7 F4)", () => {
  it("guide учит: дайджест решения — в get_concept.current_digests, руками считать не нужно", () => {
    const guide = buildGuideText();
    expect(guide).toContain("current_digests");
    expect(guide).toContain("never computed by hand");
    // сниппет остаётся в объёме: одна строка изменилась, блок не разросся
    expect(SNIPPET.split("\n").length).toBeLessThanOrEqual(60);
  });

  it("оба README объясняют падение hit_rate@1 из-за вложенных опор", () => {
    const en = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    const ru = fs.readFileSync(path.join(PROJECT_ROOT, "README.ru.md"), "utf-8");
    expect(en).toContain("nested supports");
    expect(en).toContain("supports_inlined");
    expect(ru).toContain("вложенные опоры");
    expect(ru).toContain("supports_inlined");
  });

  it("docs/bench-protocol.md объясняет вложенные опоры", () => {
    const doc = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "bench-protocol.md"), "utf-8");
    expect(doc).toContain("nested supports");
    expect(doc).toContain("supports_inlined");
  });
});

describe("сниппет: файл — это ref, а не узел (2.1.9 F3)", () => {
  it("15. сниппет учит: опора на файл — ref, узел-опора только для невыразимого ссылкой", () => {
    expect(SNIPPET).toContain('evidence: [{ref: "src/x.ts:120-180", why}]');
    expect(SNIPPET).toMatch(/not\s*\n\s*a new node/);
    expect(SNIPPET).toContain("a thought a link cannot express");
    // лимит объёма сохранён
    expect(SNIPPET.split("\n").length).toBeLessThanOrEqual(60);
  });

  it("16. guide печатает ту же строку — один источник текста", () => {
    const line = SNIPPET.split("\n").find((l) => l.includes("src/x.ts:120-180"));
    expect(line).toBeDefined();
    expect(buildGuideText()).toContain(line!);
  });
});

describe("срок годности и git-опоры в документации (2.1.12 F4)", () => {
  it("18. guide содержит правило про valid_until и пример git:-опоры", () => {
    expect(SNIPPET).toContain("valid_until");
    expect(SNIPPET).toContain("State claims expire");
    expect(SNIPPET).toContain('evidence: [{ref: "git:tag:v2.1.11", why}]');
    expect(SNIPPET).toContain("git:commit:<sha>");
    // лимит 60 строк сохранён (20)
    expect(SNIPPET.split("\n").length).toBeLessThanOrEqual(60);
  });

  it("19. оба README содержат раздел срока годности и пример git:-опоры", () => {
    const en = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    const ru = fs.readFileSync(path.join(PROJECT_ROOT, "README.ru.md"), "utf-8");
    expect(en).toContain("## Facts expire");
    expect(en).toContain("git:tag:v2.1.11");
    expect(en).toContain("stale_excluded");
    expect(ru).toContain("## Срок годности фактов");
    expect(ru).toContain("git:tag:v2.1.11");
    expect(ru).toContain("stale_excluded");
  });
});

describe("документация 2.1.13 (F7)", () => {
  it("36. --help содержит expire и --host", () => {
    const help = plain(buildHelp("2.1.13"));
    expect(help).toMatch(/expire\s+Set valid_until/);
    expect(help).toContain("--host");
    expect(help).toContain("loopback");
  });

  it("37. README ×2: раздел про valid_until с предупреждением и expire", () => {
    const en = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    const ru = fs.readFileSync(path.join(PROJECT_ROOT, "README.ru.md"), "utf-8");
    for (const [name, doc] of [["en", en], ["ru", ru]] as const) {
      expect(doc, name).toMatch(/## (Facts expire|Срок годности фактов)/);
      expect(doc, name).toContain("state_claim_without_expiry");
      expect(doc, name).toContain("expired_on_create");
      expect(doc, name).toMatch(/megamemory expire --ids/);
      // локатор: ru — «локатор», en — латиницей
      expect(doc, name).toMatch(/локатор|locator/i);
    }
  });

  it("37b. README ×2: serve — loopback, не сетевой сервис", () => {
    const en = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    const ru = fs.readFileSync(path.join(PROJECT_ROOT, "README.ru.md"), "utf-8");
    expect(en).toMatch(/Loopback only/);
    expect(en).toMatch(/not a network service/);
    expect(ru).toContain("Только loopback");
    expect(ru).toContain("не сетевой сервис");
  });

  it("38. guide содержит фразу про предупреждение (сниппет <= 60 строк)", () => {
    expect(SNIPPET).toContain("state_claim_without_expiry");
    expect(SNIPPET).toContain("a warning, not a refusal");
    const lines = SNIPPET.split("\n").length;
    expect(lines).toBeLessThanOrEqual(60);
  });
});

describe("readonly-команды в документации (план 18, 2.4.0)", () => {
  it("guide объясняет читающие команды: список, migrate --apply, env-выход", () => {
    const guide = buildGuideText();
    expect(guide).toContain("## Read-only commands");
    expect(guide).toContain("`megamemory export`, `eval` and `conflicts`");
    expect(guide).toContain("megamemory migrate --apply --db");
    expect(guide).toContain("MEGAMEMORY_ALLOW_AUTO_MIGRATE=1");
    // вычеркнутые из конверсии названы честно, со причиной
    expect(guide).toContain("`stats`, `bench` and `doctor` still open the database for writing");
  });

  it("раздел «Какие команды не пишут в базу» есть в обоих README — по смыслу идентичен", () => {
    const en = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    const ru = fs.readFileSync(path.join(PROJECT_ROOT, "README.ru.md"), "utf-8");
    for (const [name, doc] of [["en", en], ["ru", ru]] as const) {
      // список команд совпадает с guide
      expect(doc, name).toMatch(/`export`, `eval` и `conflicts`|`export`, `eval` and `conflicts`/);
      expect(doc, name).toContain("stats --funnel --json");
      expect(doc, name).toContain("migrate --apply --db");
      expect(doc, name).toContain("MEGAMEMORY_ALLOW_AUTO_MIGRATE=1");
      // осознанные исключения названы в обоих
      expect(doc, name).toMatch(/`stats`, `bench` и `doctor`|`stats`, `bench` and `doctor`/);
    }
    expect(en).toContain("### Which commands never write to the database");
    expect(ru).toContain("### Какие команды не пишут в базу");
  });
});
