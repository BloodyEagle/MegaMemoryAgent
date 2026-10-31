import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { planDigests, rebuildDigests } from "./digest.js";
import { errorBold, success, info, heading, skip } from "./cli-utils.js";

function dbPath(): string {
  return (
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db")
  );
}

/**
 * `megamemory digest [--module <id>] [--apply]`
 *
 * Rebuilds digest nodes: all modules with >=5 children, or one module.
 * Default is a dry-run report; --apply writes/updates digest nodes.
 */
export async function runDigest(args: string[]): Promise<void> {
  const apply = args.includes("--apply");
  const moduleIdx = args.indexOf("--module");
  const moduleId = moduleIdx !== -1 ? args[moduleIdx + 1] : undefined;

  const p = dbPath();
  if (!fs.existsSync(p)) {
    errorBold(`No database at ${p}. Run inside a project with .megamemory/knowledge.db.`);
    process.exit(1);
  }

  const db = new KnowledgeDB(p);
  try {
    if (!apply) {
      const { build, skipped } = planDigests(db, moduleId);
      heading(
        `  Digest plan: ${build.length} module(s) to build, ${skipped.length} skipped`
      );
      for (const b of build) {
        console.log(
          `  ${pc.cyan(b.digestId)} ${pc.dim(`(${b.children} children, ${b.created ? "new" : "refresh"})`)}`
        );
      }
      for (const s of skipped) {
        skip(`${s.moduleId}: ${s.children} children (need >=5)`);
      }
      info("dry run: nothing written. Pass --apply to build digests.");
      return;
    }

    const { built, skipped } = await rebuildDigests(db, moduleId);
    heading(`  Built ${built.length} digest(s), ${skipped.length} skipped`);
    for (const b of built) {
      info(`${b.digestId} (${b.children} children, ${b.created ? "new" : "refresh"})`);
    }
    success(`built ${built.length} digest(s).`);
  } finally {
    db.close();
  }
}
