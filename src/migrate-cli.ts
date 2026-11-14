import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import pc from "picocolors";
import { KnowledgeDB, UpstreamSchemaError } from "./db.js";
import { planIdRepair, applyIdRepair, backupDb, snapshotDb } from "./migrate.js";
import { runMigration } from "./migrate-schema.js";
import { success, info, heading, skip, warn } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";

/**
 * 08-N1 (план 09): сырая upstream-база (user_version = 0) не открывается
 * конструктором с авто-миграцией — тот падал на индексе по ещё не существующей
 * колонке. Для migrate это штатный вход: открываем базу без авто-миграции,
 * поднимаем схему шагами конструктора (runPendingMigrations), форк-колонки
 * (status, name_norm), FTS и метки добавит runMigration.
 */
function openForMigration(dbPath: string): KnowledgeDB {
  try {
    return new KnowledgeDB(dbPath);
  } catch (err) {
    if (!(err instanceof UpstreamSchemaError)) throw err;
    const db = new KnowledgeDB(dbPath, { autoMigrate: false });
    db.runPendingMigrations();
    return db;
  }
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

function printRepairPlan(plan: ReturnType<typeof planIdRepair>): void {
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
  if ((plan.unresolvedDescendants ?? 0) > 0) {
    warn(`${plan.unresolvedDescendants} descendant(s) left unresolved — repair missing or conflicting parents, then rerun repair-ids.`);
  }
  if (plan.dataLossEmptyIds > 0) {
    info(
      `data loss suspected: ${plan.dataLossEmptyIds} node(s) with empty id — only one such row could ever be stored (PK), earlier ones were lost upstream, not by this migration`
    );
  }
}

/** Fingerprint of the database files: main hash + `-wal` hash. A `-wal`-only
 * change (a committed transaction since the last checkpoint) must invalidate
 * "nothing written" just as much as a main-file change — comparing the main
 * hash alone is exactly the blind spot behind S-07's old green test. */
interface DbFingerprint {
  main: string;
  wal: string | null;
}

function dbFingerprint(dbPath: string): DbFingerprint {
  const sha = (file: string) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const wal = `${dbPath}-wal`;
  return {
    main: sha(dbPath),
    wal: fs.existsSync(wal) ? sha(wal) : null,
  };
}

export { dbFingerprint };

function fingerprintsEqual(a: DbFingerprint, b: DbFingerprint): boolean {
  return a.main === b.main && a.wal === b.wal;
}

/** Injectable seams for dry-run tests (fingerprint stability controls whether
 * "nothing written" may be claimed). Production callers pass nothing. */
export interface DryRunDeps {
  fingerprint?: (dbPath: string) => DbFingerprint;
}

/** libsql holds the native file handle of a closed connection until GC, and
 * a short-lived CLI process never collects — so a dry-run temp dir can
 * outlive its process. Sweep abandoned ones (older than an hour, to leave
 * concurrent dry-runs alone) before creating a new copy. Best-effort. */
function sweepStaleDryRunDirs(): void {
  let names: string[];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("megamemory-dryrun-")) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory() || Date.now() - st.mtimeMs < 60 * 60 * 1000) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a busy or unreadable leftover is swept by a later run
    }
  }
}

/**
 * Dry-run plan on a coherent temporary copy (S-07): opening the original with
 * KnowledgeDB would auto-migrate it (journal_mode, user_version, backfill),
 * so the plan is computed on a `VACUUM INTO` snapshot in a temp directory.
 * The source is only read; the copy is discarded afterwards.
 */
async function withDryRunCopy<T>(
  dbPath: string,
  fn: (copyPath: string) => Promise<T> | T
): Promise<T> {
  sweepStaleDryRunDirs();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-dryrun-"));
  const copyPath = path.join(tmpDir, path.basename(dbPath));
  try {
    snapshotDb(dbPath, copyPath);
    return await fn(copyPath);
  } finally {
    // libsql statements can retain the native file handle until collected:
    // yield the event loop (and GC where available) before removing.
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.gc?.();
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch {
        // Nudge the young-generation GC so libsql's FinalizationRegistry can
        // release the copied file's handle: allocation pressure, not elapsed
        // time, is what triggers collection here.
        for (let i = 0; i < 200_000; i++) {
          if (({ i }).i < 0) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (attempt === 19) {
        console.error(`  ⚠ failed to remove dry-run temp dir: ${tmpDir}`);
      }
    }
  }
}

/**
 * `megamemory migrate [--dry-run|--apply]`
 *
 * Upgrades an upstream v1.6.2 database to the fork schema: meta table, fork
 * columns, FTS index, id repair. Dry-run is the default: nothing is written
 * without --apply. Idempotent — safe to run repeatedly.
 */
export async function runMigrate(args: string[], deps: DryRunDeps = {}): Promise<void> {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  const p = resolveDbPathOrExit(args);
  const fingerprint = deps.fingerprint ?? dbFingerprint;

  if (dryRun) {
    const before = fingerprint(p);
    await withDryRunCopy(p, async (copyPath) => {
      const db = openForMigration(copyPath);
      try {
        const report = await runMigration(db, {
          apply: true,
          dbPath: copyPath,
          backup: () => null,
        });
        printReport(report, true);
      } finally {
        db.close();
      }
    });
    // "nothing written" is a verified claim, not an assumption: a concurrent
    // writer between the two fingerprints is reported instead.
    if (fingerprintsEqual(before, fingerprint(p))) {
      info("dry run: nothing written. Pass --apply to migrate.");
    } else {
      warn(
        "original database changed during the dry run (concurrent writer?) — verify the state before --apply"
      );
    }
    return;
  }

  const db = openForMigration(p);
  try {
    const report = await runMigration(db, {
      apply: true,
      dbPath: p,
      backup: backupDb,
    });
    printReport(report, false);
    success("migration complete.");
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
export async function runRepairIds(args: string[], deps: DryRunDeps = {}): Promise<void> {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  const p = resolveDbPathOrExit(args);
  const fingerprint = deps.fingerprint ?? dbFingerprint;

  if (dryRun) {
    const before = fingerprint(p);
    await withDryRunCopy(p, (copyPath) => {
      const db = new KnowledgeDB(copyPath);
      try {
        printRepairPlan(planIdRepair(db));
      } finally {
        db.close();
      }
    });
    if (fingerprintsEqual(before, fingerprint(p))) {
      info("dry run: nothing written. Pass --apply to rename.");
    } else {
      warn(
        "original database changed during the dry run (concurrent writer?) — verify the state before --apply"
      );
    }
    return;
  }

  const db = new KnowledgeDB(p);
  try {
    const plan = planIdRepair(db);
    printRepairPlan(plan);

    if (plan.entries.length === 0) {
      if (plan.conflicts.length > 0 || (plan.unresolvedDescendants ?? 0) > 0) {
        warn("no safe renames: unresolved ids remain; nothing written.");
      } else {
        success("nothing to repair.");
      }
      return;
    }

    const backup = backupDb(p);
    if (backup) {
      info(`backup: ${path.basename(backup)}`);
    }

    const result = applyIdRepair(db, plan);
    success(`renamed ${result.renamed} id(s), skipped ${result.skipped}.`);
  } finally {
    db.close();
  }
}
