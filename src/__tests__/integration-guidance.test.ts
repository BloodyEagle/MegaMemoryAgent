import { describe, it, expect } from "vitest";
import { buildGuideText } from "../guide.js";
import fs from "node:fs";

describe("I-05/I-06 executable guidance", () => {
  it("ratio below one correctly describes a more expensive graph", () => {
    const guide = buildGuideText();
    expect(guide).not.toContain("Questions with fewer tokens than the baseline\n(`ratio < 1`)");
    expect(guide).toContain("ratio > 1");
    expect(guide).toContain("ratio < 1");
    expect(guide).toContain("200 / 100 = 2");
    expect(guide).toContain("100 / 200 = 0.5");
  });

  it.each(["README.md", "README.ru.md"])("%s points at real skills scripts and literal argv", filename => {
    const doc = fs.readFileSync(new URL(`../../${filename}`, import.meta.url), "utf8");
    expect(doc).not.toContain("~/agent-skills/graph.js");
    expect(doc).not.toContain("~/agent-skills/graph.py");
    expect(doc).toContain("code-searcher.js");
    expect(doc).toContain("--te-exec");
    expect(doc).toContain("--te-arg");
    expect(doc).toContain("from=src/a.ts");
    expect(doc).toContain("to=src/b.ts");
  });
});
