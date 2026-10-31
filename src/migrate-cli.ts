import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { planIdRepair, applyIdRepair, backupDb } from "./migrate.js";
import { runMigration, emptyReport } from "./migrate-schema.js";
import { errorBold, success, info, heading, skip, warn } from "./cli-utils.js";

function dbPath(): string {
  return (
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db")
  );
}

function printReport(
  report: Awaited<ReturnType<typeof runMigration>>,
  dryRun: boolean
): void {
  heading(
    `  Migration report: ${report.applied.length} step(s) applied, ` +
      `${report.alreadyOk.length} already in place`
  );
  for (const step of report.applied) {
    console.log(`  ${pc.green("+")} ${step}`);
  }
  if (report.alreadyOk.length > 0 && !dryRun) {
    info("already in place: " + report.alreadyOk.join(", "));
  }
  if (report.repairedIds > 0) {
    success(`repaired ${report.repairedIds} legacy id(s)`);
  }
  if (report.skippedIdConflicts > 0) {
    skip(`${report.skippedIdConflicts} id repair conflict(s) skipped`);
  }
  for (const w of report.warnings) {
    warn(w);
  }
  if (report.reembedNeeded) {
    info(`reembed required: run ${pc.cyan("megamemory reembed")}`);
  }
  if (report.digestPending > 0) {
    info(`digest pending for ${report.digestPending} module(s)`);
  }
}

/**
 * `megamemory migrate [--dry-run|--apply]`
 *
 * Upgrades an upstream v1.6.2 database to the fork schema: meta table, fork
 * columns, FTS index, id repair. Dry-run is the default: nothing is written
 * without --apply. Idempotent — safe to run repeatedly.
 */
export async function runMigrate(args: string[]): Promise<void> {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  const p = dbPath();
  if (!fs.existsSync(p)) {
    errorBold(
      `No database at ${p}. Run inside a project with .megamemory/knowledge.db.`
    );
    process.exit(1);
  }

  const db = new KnowledgeDB(p);
  try {
    const report = await runMigration(db, {
      apply: !dryRun,
      dbPath: p,
      backup: backupDb,
    });
    printReport(report, dryRun);
    if (dryRun) {
      info("dry run: nothing written. Pass --apply to migrate.");
    } else {
      success("migration complete.");
    }
  } finally {
    db.close();
  }
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
