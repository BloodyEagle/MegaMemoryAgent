import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// W5 (план 20+21 v3): человекочитаемый реестр возможностей по операциям.
// Проверяются обязательные разделы, обязательные операции и явное положение
// непроверенных систем вне контракта — не содержимое каждой ячейки.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOC = path.join(ROOT, "docs", "capabilities.md");
const text = fs.readFileSync(DOC, "utf-8");

describe("docs/capabilities.md — реестр возможностей (W5)", () => {
  it("документ существует, UTF-8, читается", () => {
    // Байт-контракт (ровно один LF, без CR) закреплён только за
    // docs/agent-workflow.md через .gitattributes; этот документ
    // содержательных проверок по подстрокам и не зависит от перевода строк
    // checkout'а (core.autocrlf).
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("Реестр возможностей");
  });

  it("таблицы несут все обязательные аспекты операции", () => {
    for (const aspect of [
      "Тип вопроса",
      "Локальная CPU/I/O",
      "Модель/сеть",
      "Побочные записи",
      "Допустимые repo/scope/ref-виды",
      "Бюджеты",
      "Fallback",
    ]) {
      expect(text, aspect).toContain(aspect);
    }
  });

  it("перечислены операции MegaMemory: MCP и CLI", () => {
    for (const op of ["understand", "get_concept", "confirm_supports", "stats", "doctor", "expire", "bench", "eval", "export"]) {
      expect(text, op).toContain(`\`${op}\``);
    }
    // формы записи и цепочки описаны как операции, а не только имена инструментов
    expect(text).toContain("`record`");
    expect(text).toContain("`trail`");
  });

  it("перечислены операции token-economy-ts с указанием базиса проверки", () => {
    // Версия скилла — не контракт документа: литерал ротируется с каждым его релизом
    // и падает на верной правке. Проверяется, что базис назван версией, а возможности —
    // теми же именами, что и раньше.
    expect(text).toMatch(/token-economy-ts \d+\.\d+\.\d+/);
    expect(text).toContain("`graph op=read`");
    expect(text).toContain("`sig`");
    // факт, не догадка: ref= поддержан в 1.4.0; git-виды распознаются, но не читаются
    expect(text).toContain("`ref=`");
    expect(text).toContain("unsupported_ref_kind");
  });

  it("непроверенные системы явно вне контракта — без выдуманных возможностей", () => {
    expect(text).toContain("Hindsight");
    expect(text).toContain("sgo-schedule");
    expect(text).toContain("вне проверенного контракта, автоматически не вызывать");
  });

  it("документ не заявляет измеренную экономию", () => {
    expect(text).toContain("not_measured");
    expect(text).not.toMatch(/экономия (составляет|доказана)/);
  });

  it("workflow-документ ссылается на этот реестр — пара документов согласована", () => {
    const workflow = fs.readFileSync(path.join(ROOT, "docs", "agent-workflow.md"), "utf-8");
    expect(workflow).toContain("docs/capabilities.md");
  });
});
