import fs from "node:fs";
import path from "node:path";
import Database from "libsql";
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
  /** B-09: потомки нерешённого сломанного родителя (его target занят либо
   * родитель вообще не существует в итоговом пространстве плана) остаются
   * без плана и будут починены повторным repair после разрешения родителя.
   * Молча превращать их в корневые id нельзя — это стёрло бы иерархию. */
  unresolvedDescendants?: number;
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
      parentId: n.parent_id ?? undefined,
    }));

  const dataLossEmptyIds = rows.filter((r) => r.oldId === "").length;

  const entries: RepairPlanEntry[] = [];
  const conflicts: RepairPlanEntry[] = [];
  const idMap = new Map<string, string>(); // old parent id → new parent id
  // B-09: итоговое пространство имён — занятые сейчас в БД плюс уже
  // запланированные target id. Планируемый родитель ещё НЕ записан в базу,
  // поэтому проверка занятости только по db.nodeExists отвергла бы его и
  // лишила ребёнка префикса.
  const planned = new Set<string>();
  const targetTaken = (id: string): boolean =>
    db.getNodeIncludingRemoved(id) !== undefined || planned.has(id);

  // Repair parents before children so nested slugs build on fresh parent ids.
  // Loop until fixpoint: chains like "" ← "/a" need multiple passes.
  const pending = new Set(rows);
  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const row of [...pending]) {
      // B-09: ребёнок строит id от уже разрешённого БУДУЩЕГО id родителя.
      // Сломанный родитель обязан быть разрешён в idMap (план ничего не
      // пишет, db.nodeExists увидел бы лишь его ещё сломанную строку);
      // обычный родитель должен существовать в итоговом пространстве плана —
      // в базе либо среди запланированных target id. «Висящий» parent_id без
      // строки не разрешается молча в корень: потомок остаётся без плана
      // (unresolvedDescendants) до следующего repair после починки родителя.
      let parentResolved: string | undefined;
      if (row.parentId !== undefined) {
        if (isBrokenId(row.parentId)) {
          if (!idMap.has(row.parentId)) {
            continue; // parent not resolved yet
          }
          parentResolved = idMap.get(row.parentId);
        } else if (!db.nodeExists(row.parentId) && !planned.has(row.parentId)) {
          continue; // dangling parent — rooted silently would lose the hierarchy
        } else {
          parentResolved = row.parentId;
        }
      }
      const newId = makeId(row.name, parentResolved);
      if (newId !== row.oldId) {
        const entry: RepairPlanEntry = {
          oldId: row.oldId,
          newId,
          name: row.name,
        };
        if (targetTaken(newId)) {
          conflicts.push(entry);
        } else {
          entries.push(entry);
          planned.add(newId);
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
        const entry: RepairPlanEntry = { oldId: row.id, newId, name: row.name };
        if (targetTaken(newId)) {
          conflicts.push(entry);
        } else {
          entries.push(entry);
          planned.add(newId);
        }
      }
    }
  }

  // Остаток pending — потомки нерешённых родителей: застряли на
  // «parent not resolved yet» и никогда не получат план в этом прогоне.
  return { entries, conflicts, dataLossEmptyIds, unresolvedDescendants: pending.size };
}

export interface RepairResult {
  renamed: number;
  skipped: number;
}

export function applyIdRepair(
  db: KnowledgeDB,
  plan: RepairPlan
): RepairResult {
  return db.runInTransaction(() => {
    let renamed = 0;
    const skipped = plan.conflicts.length;
    const claimed = new Set<string>();
    for (const entry of plan.entries) {
      // The plan is advisory; apply is fail-closed and atomic if state changed.
      if (db.getNodeIncludingRemoved(entry.newId) || claimed.has(entry.newId)) {
        throw new Error(`repair-ids: conflict, "${entry.newId}" already exists — batch cancelled.`);
      }
      if (!db.renameNodeId(entry.oldId, entry.newId)) {
        throw new Error(`repair-ids: rename failed for "${entry.oldId}" -> "${entry.newId}" — batch cancelled.`);
      }
      claimed.add(entry.newId);
      // Б12.3: old ids stay resolvable through the aliases table.
      db.recordAlias(entry.oldId, entry.newId);
      renamed += 1;
    }
    return { renamed, skipped };
  });
}

/**
 * S-01: coherent SQLite snapshot of a live (possibly WAL) database.
 *
 * The old backupDb() copyFile()'d only the main file: in WAL mode a committed
 * transaction can live in `-wal`, so a "backup" silently lost every write
 * since the last checkpoint. The replacement snapshots through SQLite itself:
 * `VACUUM INTO` runs inside a read transaction against the source, so
 * committed WAL frames are included, a concurrent uncommitted transaction is
 * invisible, and the output is a self-contained file needing no `-wal`/`-shm`
 * siblings. libsql (SQLite >= 3.27) supports the parameterized form; the
 * source is opened readonly and is never written by this call.
 */
export function snapshotDb(sourcePath: string, destinationPath: string): void {
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    source.pragma("busy_timeout = 5000");
    // exec, not prepare().run(): a retained Statement object keeps the
    // Windows file handle alive until GC, which a short-lived CLI never
    // runs. Parameter-less exec leaves no such object behind.
    source.exec(`VACUUM INTO '${destinationPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
}

const BACKUP_SUFFIX = ".bak-";
/** Backups kept by default retention (three newest by mtime). */
const BACKUPS_TO_KEEP = 3;

/** Strict own backup naming: `<db>.bak-YYYYMMDD-HHMMSS-mmm[-N]`; the older
 * second-precision `YYYYMMDD-HHMMSS` form matches too, so pre-2.1.14 backups
 * still age out. Retention never touches anything else. */
function ownBackupPattern(base: string): RegExp {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped}\\.bak-\\d{8}-\\d{6}(?:-\\d{3})?(?:-\\d+)?$`
  );
}

/** UTC `YYYYMMDD-HHMMSS-mmm`: millisecond precision keeps same-second calls apart. */
function backupStamp(d: Date): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `-${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}` +
    `-${pad(d.getUTCMilliseconds(), 3)}`
  );
}

/** Inspect a retention candidate before deleting: a file that is not a
 * SQLite database (whatever its name) is never ours. */
function looksLikeSqliteFile(p: string): boolean {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const header = Buffer.alloc(16);
      const read = fs.readSync(fd, header, 0, 16, 0);
      return (
        read === 16 &&
        header.toString("latin1") === "SQLite format 3\u0000"
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Delete own verified backups beyond the `keep` newest. Candidates are
 * filtered by the strict naming pattern and the SQLite magic header, sorted
 * by mtime; unreadable files and foreign lookalikes are left alone. */
function pruneBackups(dbPath: string, keep: number): void {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const pattern = ownBackupPattern(base);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || !looksLikeSqliteFile(file)) continue;
      candidates.push({ file, mtime: st.mtimeMs });
    } catch {
      continue; // an unreadable candidate is never deleted
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const old of candidates.slice(keep)) {
    try {
      fs.unlinkSync(old.file);
    } catch {
      // A competing pruner or an open handle: pruning is best-effort.
    }
  }
}

/**
 * Backup the database file before a destructive operation.
 * S-01: the backup is a coherent SQLite snapshot (committed WAL included,
 * in-flight transactions excluded), each call writes a distinct file even
 * twice within the same second, and retention deletes only own verified
 * files. Returns the backup path, or null when there was nothing to back up.
 */
export function backupDb(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const stamp = backupStamp(new Date());

  // Millisecond stamp + collision suffix; a competing process racing for the
  // same name is settled by VACUUM INTO's own "output file already exists".
  let backupPath: string | null = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    const name =
      attempt === 0
        ? `${base}${BACKUP_SUFFIX}${stamp}`
        : `${base}${BACKUP_SUFFIX}${stamp}-${attempt}`;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) continue;
    try {
      snapshotDb(dbPath, candidate);
      backupPath = candidate;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) throw err;
    }
  }
  if (backupPath === null) {
    throw new Error(`backupDb: could not reserve a unique backup name for ${dbPath}`);
  }

  pruneBackups(dbPath, BACKUPS_TO_KEEP);
  return backupPath;
}
