import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeId, disambiguateId, createConcept } from "../tools.js";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

describe("makeId", () => {
  it("converts a simple name to a slug", () => {
    expect(makeId("MCP Server")).toBe("mcp-server");
  });

  it("converts underscores to hyphens", () => {
    expect(makeId("my_cool_feature")).toBe("my-cool-feature");
  });

  it("converts spaces to hyphens", () => {
    expect(makeId("Web Explorer")).toBe("web-explorer");
  });

  it("strips special characters", () => {
    expect(makeId("Hello, World! (v2)")).toBe("hello-world-v2");
  });

  it("collapses multiple hyphens", () => {
    expect(makeId("foo---bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(makeId("--leading-trailing--")).toBe("leading-trailing");
  });

  it("handles mixed underscores, spaces, and special chars", () => {
    expect(makeId("Init Command — Setup")).toBe("init-command-setup");
  });

  it("lowercases everything", () => {
    expect(makeId("CamelCaseInput")).toBe("camelcaseinput");
  });

  it("prefixes with parent ID when provided", () => {
    expect(makeId("Tool Registration", "mcp-server")).toBe(
      "mcp-server/tool-registration"
    );
  });

  it("keeps Cyrillic letters — id is never empty", () => {
    const id = makeId("Книга");
    expect(id).toBe("книга");
    expect(id.length).toBeGreaterThan(0);
  });

  it("keeps CJK characters", () => {
    expect(makeId("模块")).toBe("模块");
    expect(makeId("日本語のモジュール")).toBe("日本語のモジュール");
  });

  it("keeps Arabic and Hebrew", () => {
    expect(makeId("وحدة")).toBe("وحدة");
    expect(makeId("מודול")).toBe("מודול");
  });

  it("strips diacritics", () => {
    expect(makeId("café")).toBe("cafe");
  });

  it("falls back to name hash for emoji-only names", () => {
    const id = makeId("🚀");
    expect(id).toMatch(/^node-[0-9a-f]{8}$/);
  });

  it("falls back to name hash for special-char-only names", () => {
    expect(makeId("!!!")).toMatch(/^node-[0-9a-f]{8}$/);
  });

  it("falls back to name hash for whitespace-only names", () => {
    expect(makeId("   ")).toMatch(/^node-[0-9a-f]{8}$/);
  });

  it("turns slashes into dashes (a/b != ab)", () => {
    expect(makeId("a/b")).toBe("a-b");
    expect(makeId("a/b")).not.toBe(makeId("ab")); // А3: slash must become a dash
  });

  it("builds a child id from a Cyrillic parent", () => {
    expect(makeId("Поиск", "книга")).toBe("книга/поиск");
  });

  it("gives the same slug to Ёж and Еж (collision source)", () => {
    expect(makeId("Ёж")).toBe(makeId("Еж"));
    expect(makeId("Ёж")).toBe("еж");
  });

  it("disambiguateId appends a deterministic 4-char hash suffix", () => {
    const a = disambiguateId("еж", "Ёж");
    const b = disambiguateId("еж", "Еж");
    expect(a).toMatch(/^еж-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(disambiguateId("еж", "Ёж")).toBe(a);
  });
});

describe("makeId language matrix (T10 hardening)", () => {
  const cases: Array<[string, string]> = [
    ["Привет Мир", "привет-мир"],
    ["Hello World", "hello-world"],
    ["模块设计", "模块设计"],
    ["日本語のモジュール", "日本語のモジュール"],
    ["وحدة عربية", "وحدة-عربية"],
    ["מודול עברית", "מודול-עברית"],
    ["한국어 모듈", "한국어-모듈"],
    ["ประเทศไทย", "ประเทศไทย"],
    ["café crème", "cafe-creme"],
    ["naïve façade", "naive-facade"],
    ["mixed язык 模块 café", "mixed-язык-模块-cafe"],
    ["🚀 rocket 🌙", "rocket"],
  ];

  for (const [input, expected] of cases) {
    it(`slugifies ${JSON.stringify(input)}`, () => {
      expect(makeId(input)).toBe(expected);
    });
  }
});

describe("createConcept collision handling (T10 hardening)", () => {
  let tmpDir: string;
  let db: KnowledgeDB;

  afterEach(async () => {
    if (db) await closeAndCleanup(db, tmpDir);
  });

  it("Ёж and Еж coexist: same slug, second gets a hash suffix", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-collide-"));
    db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
    ensureSchema(db);

    const a = await createConcept(db, { name: "Ёж", kind: "feature", summary: "с колючками" });
    const b = await createConcept(db, { name: "Еж", kind: "feature", summary: "без ё" });

    expect(a.id).toBe("еж");
    expect(b.id).toMatch(/^еж-[0-9a-f]{8}$/);
    expect(b.id).not.toBe(a.id);
    expect(db.getNode(a.id)?.name).toBe("Ёж");
    expect(db.getNode(b.id)?.name).toBe("Еж");

    // Same name again → "already exists" (update_concept path).
    await expect(
      createConcept(db, { name: "Еж", kind: "feature", summary: "dup" })
    ).rejects.toThrow(/already exists/);
  });
});

// Patches v1.1 (А1): katakana dakuten and Hangul must survive intact.
describe("makeId script safety (А1)", () => {
  it("keeps dakuten: ジ != シ, パ != ハ", () => {
    expect(makeId("ジ")).not.toBe(makeId("シ"));
    expect(makeId("パ")).not.toBe(makeId("ハ"));
    expect(makeId("ガ")).not.toBe(makeId("カ"));
  });

  it("does not distort 日本語のモジュール", () => {
    expect(makeId("日本語のモジュール")).toBe("日本語のモジュール");
  });

  it("emits NFC for decomposed Hangul input", () => {
    const id = makeId("각한국어");
    expect(id).toBe(id.normalize("NFC"));
    expect(makeId("각한국어")).toBe("각한국어");
  });
});
