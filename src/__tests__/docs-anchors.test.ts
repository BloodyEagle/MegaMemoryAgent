import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

// 2.1.10 F5 (тест 22): README ×2 объясняют якоря vs утверждения — почему у
// узла-якоря шаблонное саммари и почему это нормально, и что Stubs считает
// только ручные заглушки.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("2.1.10 F5: README про якоря и заглушки", () => {
  for (const file of ["README.md", "README.ru.md"]) {
    it(`${file} содержит раздел про якоря`, () => {
      const text = fs.readFileSync(path.join(ROOT, file), "utf-8");
      expect(text).toMatch(/created_via/);
      expect(text).toMatch(/anchors a, claims c/);
      // Заглушки считаются только ручные — якорь не заглушка.
      expect(text).toMatch(/never\s+a stub|not a stub|не считается заглушкой|не признается заглушкой/);
    });
  }

  it("CHANGELOG описывает 2.1.10", () => {
    const text = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf-8");
    expect(text).toContain("## 2.1.10");
    expect(text).toContain("created_via");
    expect(text).toContain("duplicate_of");
  });
});
