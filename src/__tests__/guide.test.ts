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
  it("2.7.0 T3: memory: остаётся в строке After work, без обязательной записи нового узла", () => {
    // план 31: нумерованный список → абзацы-триггеры; строка ищется по новому
    // началу «**After verified work:**» (прежде — «3. **After work:**»)
    const afterWork = SNIPPET.split("\n").find((line) => line.startsWith("**After verified work:**"));
    expect(afterWork).toContain("Commit and PR memory:");
    expect(afterWork).toContain("`memory: <id>`");
    expect(afterWork).toContain("`memory: нечего — <причина>`");
    expect(afterWork).toContain("docs/commits.md");
    expect(afterWork).toContain("lawfully record nothing");
    expect(buildGuideText()).toContain(afterWork!);
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
    // truncated_by (обход неполный) с плана 31 живёт в docs/agent-workflow.md —
    // ассерт перенесён в тест «указатель живой и знание перенесено»
  });

  it("учит реакции на instructions_stale", () => {
    expect(SNIPPET).toContain("instructions_stale: true");
    expect(SNIPPET).toContain("megamemory install");
  });

  it("сохраняет ключевые слова прежнего сниппета (install.test.ts опирается на них)", () => {
    expect(SNIPPET).toContain("supersedes");
    expect(SNIPPET).toContain("## Project Knowledge Graph");
    expect(SNIPPET.trimEnd().endsWith(AGENTS_MD_END)).toBe(true);
  });
});

describe("гвард объёма, формы и ядра сниппета (план 31)", () => {
  it("объём: ≤3000 символов и ≤35 строк — считаем символы, строки обходились длиной абзаца", () => {
    // План 31: прежний лимит «≤60 строк» пропускал абзацы по 4 557 символов —
    // контракт держит объём в символах; строки — вторичная защита от
    // «одной гигантской строки».
    expect(SNIPPET.length, `SNIPPET.length = ${SNIPPET.length}`).toBeLessThanOrEqual(3000);
    const lines = SNIPPET.split("\n").length;
    expect(lines, `строк = ${lines}`).toBeLessThanOrEqual(35);
  });

  it("ядро на месте: сокращение не имеет права выпилить правило", () => {
    const markers = [
      "indistinguishable from a guess",
      "one short relevant",
      "support_check",
      "valid_until",
      "state_claim_without_expiry",
      "evidence: [{",
      "not a stub",
      "confirm_supports(",
      "instructions_stale",
      "supersedes",
      "lawfully record nothing",
      "megamemory guide --workflow",
    ];
    for (const marker of markers) {
      expect(SNIPPET, marker).toContain(marker);
    }
  });

  it("указатель живой и знание перенесено: уехавшие термины есть в docs/agent-workflow.md", () => {
    expect(buildGuideText()).toContain("megamemory guide --workflow");
    const doc = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "agent-workflow.md"), "utf-8");
    const terms = [
      "MEGAMEMORY_TOOLS",
      "`compact`",
      "`full`",
      "`brief`",
      "collapse_ref_anchors",
      "include_source",
      "max_tokens",
      "roots_compact",
      "`slots`",
      "board_top",
      "truncated_by: depth|nodes|scan",
      "reembed",
      "auth-token-refresh",
      "configured_by",
      "megamemory bench",
    ];
    for (const term of terms) {
      expect(doc, term).toContain(term);
    }
  });

  it("форма — триггеры: каждый абзац блока начинается с условия «когда»", () => {
    // Блок читается как «когда → что сделать», а не как проза-мануал:
    // строка без «когда» — кандидат на выброс из контекста каждой сессии.
    const paragraphs = SNIPPET.split(/\n{2,}/).filter((p) => p.startsWith("**"));
    expect(paragraphs.length).toBeGreaterThanOrEqual(8);
    for (const paragraph of paragraphs) {
      expect(paragraph, paragraph.slice(0, 40)).toMatch(/^\*\*(Before|When|After|Claims|State|Stale)/);
    }
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
  it("строка про bench есть в выводе guide — один источник текста (план 31: bench уехал из сниппета в раздел измерения)", () => {
    const guide = buildGuideText();
    const benchLine = guide.split("\n").find((l) => l.includes("megamemory bench"));
    expect(benchLine).toBeDefined();
    expect(guide).toContain("--baseline files");
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

  it("38. guide содержит фразу про предупреждение", () => {
    expect(SNIPPET).toContain("state_claim_without_expiry");
    expect(SNIPPET).toContain("a warning, not a refusal");
  });
});

describe("сниппет согласован с workflow-договором (план 20+21 v3, W1/W2)", () => {
  it("указывает на полный договор: megamemory guide --workflow — одна строка-указатель", () => {
    expect(SNIPPET).toContain("megamemory guide --workflow");
  });

  it("не требует обязательного обзора при каждом старте и записи после каждой задачи", () => {
    // конкурирующие «сначала» и обязательный record вычеркнуты, а не добавлены рядом
    expect(SNIPPET).not.toContain("You must call `megamemory` with action `overview`");
    expect(SNIPPET).not.toContain("After each task:** You must call");
    expect(SNIPPET).not.toContain("before reading source files for project understanding");
    expect(SNIPPET).toContain("not a mandatory ritual");
  });

  it("сохраняет ядро нового порядка: квалификация, структурное чтение, запись только нового", () => {
    expect(SNIPPET).toContain("one short relevant");
    expect(SNIPPET).toContain("support_check");
    expect(SNIPPET).toContain("outline then exact ranges");
    expect(SNIPPET).toContain("not whole-file coverage");
    expect(SNIPPET).toContain("lawfully record nothing");
    expect(SNIPPET).toContain("not an automatic refutation");
    // нормативное ядро доверия сохранено целиком (проверки выше в этом файле)
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
