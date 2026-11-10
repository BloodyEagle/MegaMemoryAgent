import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { renderAllMarkdown, exportMarkdown, ExportPathError } from "../export.js";
import { addNode } from "./helpers/audit.js";

describe("B-06 Windows export identity", () => {
  it.each([["Auth", "auth"], ["Auth/child", "auth/child"], ["CON", "_CON"]])("preflights equivalent output paths %j and %j", (a, b) => {
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      addNode(db, a, { summary: "First independent payload" });
      addNode(db, b, { summary: "Second independent payload" });
      expect(() => renderAllMarkdown(db)).toThrow(ExportPathError);
    } finally { db.close(); }
  });

  it.each([
    ["Auth", "auth"],
    ["Auth/child", "auth/child"],
    ["CON", "_CON"],
    ["same?name", "same*name"],
    ["name.", "name"],
    ["Модуль/a", "модуль/b"],
    ["Auth/a", "auth/b"],
    ["root/Auth/a", "root/auth/b"],
    ["CON/a", "_CON/b"],
    ["name./a", "name/b"],
    ["same?dir/a", "same*dir/b"],
    ["bucket", "bucket.md/child"],
    ["Bucket", "bucket.MD/child"],
    ["CON.txt", "_CON.txt"],
    ["CON.txt/a", "_CON.txt/b"],
  ])("rejects directory identity collisions %j and %j before changing the target", (a, b) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p07-export-"));
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      addNode(db, "000-first", { summary: "Must not be written before preflight finishes" });
      addNode(db, a, { summary: "First independent payload" });
      addNode(db, b, { summary: "Second independent payload" });
      fs.writeFileSync(path.join(root, "000-first.md"), "Existing user note", "utf8");
      fs.mkdirSync(path.join(root, "notes"));
      fs.writeFileSync(path.join(root, "notes", "sentinel.bin"), Buffer.from([0, 255, 13, 10]));
      const before = directoryBytes(root);
      expect(() => exportMarkdown(db, root)).toThrow(ExportPathError);
      expect(directoryBytes(root)).toEqual(before);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["Auth/a", "Auth/b"],
    ["same?dir/a", "same?dir/b"],
    ["CON/a", "CON/b"],
    ["модуль", "модуль/поиск"],
  ])("writes two distinct payloads with safe shared directories for %j and %j", (a, b) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p07-export-"));
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      addNode(db, a, { summary: "First independent payload" });
      addNode(db, b, { summary: "Second independent payload" });
      const originalIds = db.getAllNodesRaw().map(node => node.id).sort();
      expect(exportMarkdown(db, root).written).toBe(2);
      const actual = directoryBytes(root).filter(([name]) => !name.endsWith("/"));
      expect(actual).toHaveLength(2);
      expect(new Set(actual.map(([name]) => name.toLowerCase())).size).toBe(2);
      const bodies = actual.map(([, bytes]) => Buffer.from(bytes, "hex").toString("utf8"));
      expect(bodies.filter(body => body.includes("First independent payload"))).toHaveLength(1);
      expect(bodies.filter(body => body.includes("Second independent payload"))).toHaveLength(1);
      expect(db.getAllNodesRaw().map(node => node.id).sort()).toEqual(originalIds);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preflights the existing final containment guard before writing earlier files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p07-export-"));
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      addNode(db, "-first", { summary: "Would overwrite the sentinel before a late rejection" });
      addNode(db, String.raw`..\backslash`, { summary: "Existing strict containment rejection must remain" });
      fs.writeFileSync(path.join(root, "-first.md"), "Existing user note", "utf8");
      const before = directoryBytes(root);
      expect(() => exportMarkdown(db, root)).toThrow(ExportPathError);
      expect(directoryBytes(root)).toEqual(before);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps traversal, colon and backslash IDs contained without losing their payloads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p07-export-"));
    const target = path.join(root, "target");
    const db = new KnowledgeDB(":memory:");
    try {
      ensureSchema(db);
      ["../escape", "nested/../../outside", String.raw`C:\audit\marker`, String.raw`a\backslash`, "a:b"].forEach((id, index) => {
        addNode(db, id, { summary: `Hostile-ID independent payload ${index}` });
      });
      const sentinel = path.join(root, "escape.md");
      fs.writeFileSync(sentinel, "User-owned sibling", "utf8");
      expect(exportMarkdown(db, target).written).toBe(5);
      expect(fs.readdirSync(root).sort()).toEqual(["escape.md", "target"]);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("User-owned sibling");
      const actual = directoryBytes(target).filter(([name]) => !name.endsWith("/"));
      expect(actual).toHaveLength(5);
      for (const [name] of actual) {
        expect(path.posix.isAbsolute(name) || path.win32.isAbsolute(name)).toBe(false);
        expect(name).not.toMatch(/[:\\\\]/);
        expect(name.split("/")).not.toContain("..");
        expect(name.split("/")).not.toContain(".");
      }
      for (let index = 0; index < 5; index++) {
        expect(actual.filter(([, bytes]) => Buffer.from(bytes, "hex").toString("utf8").includes(`Hostile-ID independent payload ${index}`))).toHaveLength(1);
      }
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function directoryBytes(root: string): Array<[string, string]> {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry): Array<[string, string]> => {
    const full = path.join(root, entry.name);
    return entry.isDirectory()
      ? [[`${entry.name}/`, ""], ...directoryBytes(full).map(([name, bytes]): [string, string] => [`${entry.name}/${name}`, bytes])]
      : [[entry.name, fs.readFileSync(full).toString("hex")]];
  });
}
