import { describe, it, expect } from "vitest";
import { makeId, disambiguateId } from "../tools.js";

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

  it("strips slashes from nested names", () => {
    expect(makeId("a/b")).toBe("ab");
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
    expect(a).toMatch(/^еж-[0-9a-f]{4}$/);
    expect(a).not.toBe(b);
    expect(disambiguateId("еж", "Ёж")).toBe(a);
  });
});
