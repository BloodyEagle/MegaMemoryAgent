import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { exportMarkdown, checkMarkdown, renderAllMarkdown } from "../export.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;
let outDir: string;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-export-"));
  outDir = path.join(tmpDir, "md");
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("markdown export", () => {
  it("is deterministic: two exports produce identical bytes", () => {
    const db = freshDb();
    db.insertNode({ id: "книга", name: "Книга", kind: "module", summary: "Всё о книгах" });
    db.insertNode({ id: "книга/глава", name: "Глава", kind: "feature", summary: "Первая глава", parent_id: "книга" });
    db.insertNode({ id: "zzz", name: "Z Last", kind: "decision", summary: "why: order" });

    const first = exportMarkdown(db, outDir);
    expect(first.written).toBe(3);
    const snapshot = renderAllMarkdown(db);

    // Mutate nothing; re-render and compare byte-for-byte.
    const second = renderAllMarkdown(db);
    expect([...second.entries()]).toEqual([...snapshot.entries()]);

    // Files exist with expected content shape.
    const bookFile = fs.readFileSync(path.join(outDir, "книга.md"), "utf8");
    expect(bookFile).toContain('id: "книга"');
    expect(bookFile).toContain("Всё о книгах");
    expect(bookFile).toContain("[[книга/глава|Глава]]");
  });

  it("check detects changed, missing and extra files with exit-worthy diff", () => {
    const db = freshDb();
    db.insertNode({ id: "alpha", name: "Alpha", kind: "feature", summary: "one" });
    db.insertNode({ id: "beta", name: "Beta", kind: "feature", summary: "two" });
    exportMarkdown(db, outDir);

    // Everything in sync.
    expect(checkMarkdown(db, outDir)).toEqual({ written: 0, missing: [], differing: [], extra: [], pruned: 0 });

    // Change one file on disk.
    fs.writeFileSync(path.join(outDir, "alpha.md"), "tampered", "utf8");
    const diff = checkMarkdown(db, outDir);
    expect(diff.differing).toEqual(["alpha.md"]);
  });

  it("cyrillic and nested filenames are created and re-read", () => {
    const db = freshDb();
    db.insertNode({ id: "модуль", name: "Модуль", kind: "module", summary: "корень" });
    db.insertNode({ id: "модуль/поиск", name: "Поиск", kind: "feature", summary: "子", parent_id: "модуль" });
    exportMarkdown(db, outDir);

    expect(fs.existsSync(path.join(outDir, "модуль.md"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "модуль", "поиск.md"))).toBe(true);
    // The nested file round-trips through check.
    expect(checkMarkdown(db, outDir).differing).toEqual([]);
  });

  it("--check prunes orphan .md files (М8)", () => {
    const db = freshDb();
    db.insertNode({ id: "solo", name: "Solo", kind: "feature", summary: "one" });
    exportMarkdown(db, outDir);
    fs.writeFileSync(path.join(outDir, "orphan.md"), "stale", "utf8");
    const diff = checkMarkdown(db, outDir);
    expect(diff.extra).toEqual(["orphan.md"]);
    expect(diff.pruned).toBe(1);
    expect(fs.existsSync(path.join(outDir, "orphan.md"))).toBe(false);
  });
});
