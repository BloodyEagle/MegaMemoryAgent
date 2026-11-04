import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { runDoctor } from "./doctor.js";
import { errorBold, heading, success } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";

/**
 * `megamemory doctor`
 *
 * Read-only health check of the current database. Prints one line per
 * check (ok / problem) and exits 1 when a problem is found — CI-friendly.
 */
export async function runDoctorCli(args: string[]): Promise<void> {
  const p = resolveDbPathOrExit(args);

  const db = new KnowledgeDB(p);
  try {
    const { checks, problems } = runDoctor(db);
    heading(`  megamemory doctor — ${p}`);
    for (const check of checks) {
      const mark = check.ok ? pc.green("✓") : pc.red("✗");
      const name = check.ok ? check.name : pc.red(check.name);
      console.log(`  ${mark} ${name.padEnd(16)} ${check.detail}`);
    }
    console.log();
    if (problems > 0) {
      errorBold(`${problems} problem(s) found.`);
      process.exit(1);
    }
    success("all checks passed.");
  } finally {
    db.close();
  }
}
