import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { exportMarkdown, checkMarkdown } from "./export.js";
import { errorBold, success, info, heading, warn } from "./cli-utils.js";

function dbPath(): string {
  return (
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db")
  );
}

/**
 * `megamemory export --md <dir> [--check]`
 *
 * Exports the graph to one markdown file per node (git-diffable,
 * Obsidian-open). --check compares the directory with the current render
 * and exits 1 on any difference — for CI.
 */
export async function runExport(args: string[]): Promise<void> {
  const mdIdx = args.indexOf("--md");
  const dir = mdIdx !== -1 ? args[mdIdx + 1] : undefined;
  const check = args.includes("--check");

  if (!dir) {
    errorBold("Missing --md <dir>. Usage: megamemory export --md <dir> [--check]");
    process.exit(1);
  }

  const p = dbPath();
  if (!fs.existsSync(p)) {
    errorBold(`No database at ${p}. Run inside a project with .megamemory/knowledge.db.`);
    process.exit(1);
  }

  const db = new KnowledgeDB(p);
  try {
    if (check) {
      const diff = checkMarkdown(db, dir);
      heading(
        `  Export check: ${diff.differing.length} differing, ${diff.missing.length} missing, ${diff.extra.length} extra`
      );
      for (const f of diff.differing) warn(`differing: ${f}`);
      for (const f of diff.missing) warn(`missing: ${f}`);
      for (const f of diff.extra) warn(`extra: ${f}`);
      if (diff.differing.length + diff.missing.length + diff.extra.length > 0) {
        process.exit(1);
      }
      success("export is up to date.");
      return;
    }

    fs.mkdirSync(dir, { recursive: true });
    const result = exportMarkdown(db, dir);
    success(`exported ${result.written} node(s) to ${path.resolve(dir)}`);
    info("tip: run with --check in CI to catch drift between the graph and the files.");
  } finally {
    db.close();
  }
}
