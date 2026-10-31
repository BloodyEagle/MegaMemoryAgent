import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { planIdRepair, applyIdRepair, backupDb } from "./migrate.js";
import { errorBold, success, info, heading, skip } from "./cli-utils.js";

function dbPath(): string {
  return (
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db")
  );
}

/**
 * `megamemory repair-ids [--dry-run|--apply]`
 *
 * Repairs legacy ids produced by the ASCII-only makeId (empty ids, ids ending
 * in "/"). Dry-run is the default: nothing is written without --apply.
 */
export async function runRepairIds(args: string[]): Promise<void> {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  const p = dbPath();
  if (!fs.existsSync(p)) {
    errorBold(`No database at ${p}. Run inside a project with .megamemory/knowledge.db.`);
    process.exit(1);
  }

  const db = new KnowledgeDB(p);
  try {
    const plan = planIdRepair(db);

    heading(
      `  Repair plan: ${plan.entries.length} id(s) to rename, ${plan.conflicts.length} conflict(s)`
    );
    for (const entry of plan.entries) {
      console.log(
        `  ${pc.red(JSON.stringify(entry.oldId))} ${pc.dim("→")} ${pc.green(JSON.stringify(entry.newId))} ${pc.dim(`(${entry.name})`)}`
      );
    }
    for (const entry of plan.conflicts) {
      skip(`conflict: "${entry.newId}" already exists — "${entry.oldId}" (${entry.name}) left as is`);
    }
    if (plan.dataLossEmptyIds > 0) {
      info(
        `data loss suspected: ${plan.dataLossEmptyIds} node(s) with empty id — only one such row could ever be stored (PK), earlier ones were lost upstream, not by this migration`
      );
    }

    if (dryRun) {
      info("dry run: nothing written. Pass --apply to rename.");
      return;
    }

    if (plan.entries.length === 0) {
      success("nothing to repair.");
      return;
    }

    const backup = backupDb(dbPath());
    if (backup) {
      info(`backup: ${path.basename(backup)}`);
    }

    const result = applyIdRepair(db, plan);
    success(`renamed ${result.renamed} id(s), skipped ${result.skipped}.`);
  } finally {
    db.close();
  }
}
