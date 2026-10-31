import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { findDuplicates, mergeNodes } from "./consolidate.js";
import { backupDb } from "./migrate.js";
import { errorBold, success, info, heading, skip } from "./cli-utils.js";

function dbPath(): string {
  return (
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db")
  );
}

function numFlag(args: string[], flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  const v = parseInt(args[idx + 1], 10);
  return isNaN(v) ? fallback : v;
}

/**
 * `megamemory consolidate [--dry-run] [--threshold 0.95] [--limit 100] [--apply]`
 *
 * Finds near-duplicate active nodes (embedding cosine >= threshold, grouped
 * by parent) and, with --apply, merges each pair: older node survives,
 * summary/why/file_refs combine, edges move. Dry-run is the default.
 */
export async function runConsolidate(args: string[]): Promise<void> {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;
  const threshold = numFlag(args, "--threshold", 0.95);
  const limit = numFlag(args, "--limit", 100);

  const p = dbPath();
  if (!fs.existsSync(p)) {
    errorBold(`No database at ${p}. Run inside a project with .megamemory/knowledge.db.`);
    process.exit(1);
  }

  const db = new KnowledgeDB(p);
  try {
    const candidates = findDuplicates(db, { threshold, limit });

    heading(
      `  ${candidates.length} duplicate candidate(s) at threshold ${threshold}`
    );
    for (const c of candidates) {
      console.log(
        `  ${pc.cyan(c.a)} ${pc.dim("≈")} ${pc.cyan(c.b)} ` +
          pc.dim(`sim=${c.similarity.toFixed(4)} name=${c.name_similarity.toFixed(2)} parent=${c.same_parent ? "same" : "diff"}`)
      );
      info(`merge into older: ${c.older}`);
    }

    if (dryRun) {
      info("dry run: nothing written. Pass --apply to merge.");
      return;
    }
    if (candidates.length === 0) {
      success("nothing to consolidate.");
      return;
    }

    const backup = backupDb(p);
    if (backup) info(`backup: ${path.basename(backup)}`);

    let merged = 0;
    let skipped = 0;
    for (const c of candidates) {
      const survivor = c.older;
      const other = survivor === c.a ? c.b : c.a;
      try {
        if (!db.nodeExists(other) || !db.nodeExists(survivor)) {
          skipped += 1; // already merged as part of an earlier pair
          continue;
        }
        const result = mergeNodes(db, survivor, other);
        merged += 1;
        info(`merged ${result.removed} into ${result.survivor}`);
      } catch (err) {
        skipped += 1;
        console.error(
          `  ✗ merge failed for ${survivor}/${other}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    success(`merged ${merged} pair(s), skipped ${skipped}.`);
  } finally {
    db.close();
  }
}
