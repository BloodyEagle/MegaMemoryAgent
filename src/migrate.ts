import fs from "node:fs";
import path from "node:path";
import { KnowledgeDB } from "./db.js";
import { makeId } from "./tools.js";

/**
 * Fork migration helpers.
 *
 * T0: repair of legacy ids produced by the ASCII-only makeId — upstream could
 * store `id = ''` (special-char names) or ids ending in `/` (name slugified to
 * nothing under a parent). Both break lookups, URLs and graph rendering.
 */

export interface RepairPlanEntry {
  oldId: string;
  newId: string;
  name: string;
}

export interface RepairPlan {
  entries: RepairPlanEntry[];
  /** Entries whose target id already belongs to another node — skipped on apply. */
  conflicts: RepairPlanEntry[];
  /** Nodes with empty id — PK means only one such row ever survived upstream. */
  dataLossEmptyIds: number;
}

export function isBrokenId(id: string): boolean {
  return id === "" || id.endsWith("/");
}

export function planIdRepair(db: KnowledgeDB): RepairPlan {
  const rows = db
    .getAllNodesRaw()
    .filter((n) => isBrokenId(n.id))
    .map((n) => ({
      oldId: n.id,
      name: n.name,
      parentId: n.parent_id || undefined,
    }));

  const dataLossEmptyIds = rows.filter((r) => r.oldId === "").length;

  const entries: RepairPlanEntry[] = [];
  const conflicts: RepairPlanEntry[] = [];
  const idMap = new Map<string, string>(); // old parent id → new parent id

  // Repair parents before children so nested slugs build on fresh parent ids.
  // Loop until fixpoint: chains like "" ← "/a" need multiple passes.
  const pending = new Set(rows);
  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const row of [...pending]) {
      if (
        row.parentId !== undefined &&
        isBrokenId(row.parentId) &&
        !idMap.has(row.parentId)
      ) {
        continue; // parent not resolved yet
      }
      const parentResolved =
        row.parentId !== undefined
          ? (idMap.get(row.parentId) ?? row.parentId)
          : undefined;
      const parentId =
        parentResolved && db.nodeExists(parentResolved)
          ? parentResolved
          : undefined;
      const newId = makeId(row.name, parentId);
      if (newId !== row.oldId) {
        const entry: RepairPlanEntry = {
          oldId: row.oldId,
          newId,
          name: row.name,
        };
        if (db.nodeExists(newId)) {
          conflicts.push(entry);
        } else {
          entries.push(entry);
          idMap.set(row.oldId, newId);
        }
      }
      pending.delete(row);
      progressed = true;
    }
  }

  // Б12.2: descendants of renamed ids follow the rename (path prefix),
  // longest prefix first so nested chains resolve correctly.
  const byOld = [...idMap.entries()].sort((a, b) => b[0].length - a[0].length);
  if (byOld.length > 0) {
    for (const row of db.getAllNodesRaw()) {
      if (isBrokenId(row.id)) continue;
      // Map keys may already carry the trailing slash (broken ids like "svc/").
      const hit = byOld.find(([old]) => {
        const prefix = old.endsWith("/") ? old : old + "/";
        return row.id.startsWith(prefix);
      });
      if (!hit) continue;
      // Keep the "/" separator between the new parent id and the tail.
      const tail = row.id.slice(hit[0].length);
      const newId = hit[1] + (tail.startsWith("/") ? tail : "/" + tail);
      if (newId !== row.id) {
        entries.push({ oldId: row.id, newId, name: row.name });
      }
    }
  }

  return { entries, conflicts, dataLossEmptyIds };
}

export interface RepairResult {
  renamed: number;
  skipped: number;
}

export function applyIdRepair(
  db: KnowledgeDB,
  plan: RepairPlan
): RepairResult {
  let renamed = 0;
  let skipped = plan.conflicts.length;
  const claimed = new Set<string>();
  for (const entry of plan.entries) {
    // Two broken rows may plan the same target; second one must not clobber.
    if (db.nodeExists(entry.newId) || claimed.has(entry.newId)) {
      skipped += 1;
      console.error(
        `  repair-ids: conflict, "${entry.newId}" already exists — skipped "${entry.oldId}"`
      );
      continue;
    }
    if (db.renameNodeId(entry.oldId, entry.newId)) {
      claimed.add(entry.newId);
      // Б12.3: old ids stay resolvable through the aliases table.
      db.recordAlias(entry.oldId, entry.newId);
      renamed += 1;
    } else {
      console.error(
        `  repair-ids: rename failed for "${entry.oldId}" -> "${entry.newId}"`
      );
    }
  }
  return { renamed, skipped };
}

/**
 * Backup the database file before a destructive operation.
 * Keeps the 3 most recent backups, never overwrites an existing one.
 * Returns the backup path, or null when there was nothing to back up.
 */
export function backupDb(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15); // YYYYMMDD-HHMMSS
  const backupPath = `${dbPath}.bak-${stamp}`;
  if (fs.existsSync(backupPath)) return backupPath;
  fs.copyFileSync(dbPath, backupPath);

  // Prune old backups, keep 3 most recent.
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.bak-`))
    .sort()
    .reverse();
  for (const old of backups.slice(3)) {
    fs.unlinkSync(path.join(dir, old));
  }
  return backupPath;
}
