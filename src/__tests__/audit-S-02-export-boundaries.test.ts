import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportMarkdown, renderAllMarkdown } from "../export.js";
import { MergeEngine } from "../merge.js";
import { ensureSchema } from "../migrate-schema.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function imported(ids: string[]) {
  const left = fixture.db("left.db");
  const right = fixture.db("empty.db");
  ensureSchema(left);
  ensureSchema(right);
  ids.forEach((id, index) => addNode(left, id, { summary: `Independent export payload number ${index}.` }));
  const output = fixture.file("imported.db");
  new MergeEngine().merge(left.dbPath, right.dbPath, output);
  return fixture.db("imported.db");
}

function markdownFiles(dir: string): Array<{ file: string; body: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? markdownFiles(file)
      : [{ file, body: fs.readFileSync(file, "utf8") }];
  });
}

function expectPathRejection(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/path|filename|travers|contain|unsafe|invalid|collision|duplicate|export|conflict/i);
}

function expectSafeRelativeFile(file: string) {
  expect(path.posix.isAbsolute(file) || path.win32.isAbsolute(file)).toBe(false);
  expect(file.split(/[\\/]/)).not.toContain("..");
  expect(file.split(/[\\/]/)).not.toContain(".");
}

describe("S-02 imported IDs cannot escape or overwrite Markdown output", () => {
  it.each([
    { label: "parent segment", id: "../escaped-audit-marker" },
    { label: "nested parent segments", id: "nested/../../escaped-audit-marker" },
    { label: "backslash parent segment", id: "..\\escaped-audit-marker" },
  ])("contains export with a $label inside the target", ({ id }) => {
    const db = imported([id]);
    // Even the defective exporter can only reach this fixture-owned sibling:
    // no ID used for an actual write can escape the outer temp root.
    const target = fixture.file("boundary/target");
    const sibling = fixture.file("boundary/escaped-audit-marker.md");
    fs.writeFileSync(sibling, "User-owned sibling must stay byte-for-byte intact.", "utf8");
    const before = fs.readFileSync(sibling);
    let rejected = false;
    try {
      exportMarkdown(db, target);
    } catch (error) {
      rejected = true;
      expectPathRejection(error);
    }

    expect(fs.readFileSync(sibling)).toEqual(before);
    expect(fs.readdirSync(path.dirname(target)).sort()).toEqual(
      rejected && !fs.existsSync(target)
        ? ["escaped-audit-marker.md"]
        : ["escaped-audit-marker.md", "target"],
    );
    if (!rejected) {
      const files = markdownFiles(target);
      expect(files).toHaveLength(1);
      expect(files[0].body).toContain("Independent export payload number 0.");
    }
  });

  it.each([
    { label: "POSIX absolute", id: "/absolute-audit-marker" },
    { label: "Windows absolute", id: "C:\\audit-only\\absolute-audit-marker" },
  ])("renders $label IDs only as safe relative paths or rejects them", ({ id }) => {
    const db = imported([id]);
    // Absolute hostile IDs are tested at the pure render seam, never written.
    let files: Map<string, string> | undefined;
    try {
      files = renderAllMarkdown(db);
    } catch (error) {
      expectPathRejection(error);
      return;
    }
    expect(files.size).toBe(1);
    for (const file of files.keys()) expectSafeRelativeFile(file);
    expect([...files.values()][0]).toContain("Independent export payload number 0.");
  });

  const collisionCases = [
    { label: "sanitized punctuation", ids: ["same?name", "same*name"] },
    { label: "backslash versus underscore", ids: ["path\\name", "path_name"] },
    { label: "normalized relative path", ids: ["nested/../same", "same"] },
  ].flatMap((testCase) => [
    { ...testCase, seam: "render" as const },
    { ...testCase, seam: "write" as const },
  ]);

  it.each(collisionCases)("does not silently coalesce $label at the $seam seam", ({ ids, seam }) => {
    const db = imported(ids);
    const target = fixture.file("export");
    let rendered: Map<string, string> | undefined;
    let rejected = false;
    try {
      if (seam === "render") rendered = renderAllMarkdown(db);
      else exportMarkdown(db, target);
    } catch (error) {
      rejected = true;
      expectPathRejection(error);
    }
    if (rejected) {
      expect(markdownFiles(target)).toEqual([]);
      return;
    }

    const files = rendered
      ? [...rendered].map(([file, body]) => ({ file: path.resolve(target, file), body }))
      : markdownFiles(target);
    expect(files).toHaveLength(2);
    const actualPaths = files.map(({ file }) => process.platform === "win32" ? file.toLowerCase() : file);
    expect(new Set(actualPaths).size).toBe(2);
    expect(files.filter(({ body }) => body.includes("Independent export payload number 0."))).toHaveLength(1);
    expect(files.filter(({ body }) => body.includes("Independent export payload number 1."))).toHaveLength(1);
  });

  it("exports valid nested Unicode IDs without losing either node", () => {
    const db = imported(["модуль", "модуль/поиск"]);
    const target = fixture.file("export");
    expect(exportMarkdown(db, target).written).toBe(2);
    expect(fs.readFileSync(path.join(target, "модуль.md"), "utf8")).toContain('id: "модуль"');
    expect(fs.readFileSync(path.join(target, "модуль", "поиск.md"), "utf8")).toContain('id: "модуль/поиск"');
    expect(markdownFiles(target)).toHaveLength(2);
  });
});
