import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportMarkdown } from "../export.js";
import { addNode, AuditHarnessError, auditFixture, type AuditFixture } from "./helpers/audit.js";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
let fixture: AuditFixture;

beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function checkExport(directory: string) {
  if (!fs.existsSync(cli)) throw new AuditHarnessError("Build dist before running R-05 subprocess tests");
  const { env } = fixture.profile();
  const result = spawnSync(process.execPath, [cli, "export", "--db", fixture.file("source.db"), "--md", directory, "--check"], {
    cwd: fixture.root,
    env: { ...env, NODE_OPTIONS: "", MEGAMEMORY_DB_PATH: "", MEGAMEMORY_SEARCH: "fts", NO_COLOR: "1" },
    shell: false, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.error || result.signal || result.status === null) {
    throw new AuditHarnessError(`Export subprocess did not complete: ${result.error?.message ?? result.signal}`, { cause: result.error });
  }
  return result;
}

function tree(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (current: string) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, item.name);
      if (item.isDirectory()) visit(filename);
      else files[path.relative(directory, filename).split(path.sep).join("/")] = fs.readFileSync(filename).toString("base64");
    }
  };
  visit(directory);
  return files;
}

async function exportedFixture() {
  const db = fixture.db("source.db");
  addNode(db, "alpha", { name: "Alpha", summary: "The first exported fact." });
  addNode(db, "beta", { name: "Beta", summary: "The second exported fact." });
  const directory = fixture.file("export");
  exportMarkdown(db, directory);
  await fixture.release(db);
  return directory;
}

describe("R-05 export --check has no ownership of handwritten Markdown", () => {
  it("reports extra notes without deleting files the exporter does not own", async () => {
    const directory = await exportedFixture();
    fs.writeFileSync(fixture.file("export/manual.md"), "# Ручная заметка\nНе удалять при проверке.\n", "utf8");
    fs.writeFileSync(fixture.file("export/notes/nested.md"), "Nested handwritten note.\n", "utf8");
    fs.writeFileSync(fixture.file("export/notes/keep.txt"), "Non-Markdown user file.\n", "utf8");
    const before = tree(directory);

    const result = checkExport(directory);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("extra: manual.md");
    expect(tree(directory), "R-05: --check must not silently prune an unowned directory").toEqual(before);
  });

  it("reports missing and edited generated files without repairing or overwriting them", async () => {
    const directory = await exportedFixture();
    fs.writeFileSync(path.join(directory, "alpha.md"), "Locally edited export.\n", "utf8");
    fs.unlinkSync(path.join(directory, "beta.md"));
    const before = tree(directory);

    const result = checkExport(directory);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("differing: alpha.md");
    expect(result.stdout).toContain("missing: beta.md");
    expect(tree(directory)).toEqual(before);
  });

  it("succeeds for an unchanged export and leaves its contents untouched", async () => {
    const directory = await exportedFixture();
    const before = tree(directory);

    const result = checkExport(directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("export is up to date");
    expect(tree(directory)).toEqual(before);
  });
});
