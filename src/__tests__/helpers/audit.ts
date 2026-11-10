import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "libsql";
import { KnowledgeDB } from "../../db.js";

export class AuditHarnessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditHarnessError";
  }
}

export class AuditCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditCleanupError";
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function addNode(
  db: KnowledgeDB,
  id: string,
  overrides: Partial<Parameters<KnowledgeDB["insertNode"]>[0]> = {},
): string {
  db.insertNode({
    id, name: id, kind: "feature", summary: `Verified fixture for ${id}: a concrete independent audit example.`,
    ...overrides,
  });
  return id;
}

function normalizeSqlValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { hex: Buffer.from(value).toString("hex") };
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeSqlValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_metadata").map(([key, item]) => [key, normalizeSqlValue(item)]));
  }
  return value;
}

export function sqlState(db: KnowledgeDB | Database.Database) {
  const all = (sql: string) => db instanceof KnowledgeDB ? db.execSqlAll(sql) : db.prepare(sql).all();
  const schema = all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name");
  const names = all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") as { name: string }[];
  const tables = Object.fromEntries(names.map(({ name }) => {
    const quoted = name.replaceAll('"', '""');
    const rows = all(`SELECT * FROM "${quoted}"`).map(normalizeSqlValue);
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [name, rows];
  }));
  return normalizeSqlValue({
    schema, tables,
    userVersion: all("PRAGMA user_version"),
    journalMode: all("PRAGMA journal_mode"),
  });
}

export function auditFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-audit-"));
  const resources: { close(): unknown }[] = [];
  const restorers: (() => void)[] = [];
  let disposed = false;

  function file(name: string): string {
    const result = path.resolve(root, name);
    const relative = path.relative(root, result);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AuditHarnessError(`Fixture path escapes its directory: ${name}`);
    }
    fs.mkdirSync(path.dirname(result), { recursive: true });
    return result;
  }

  function track<T extends { close(): unknown }>(resource: T): T {
    resources.push(resource);
    return resource;
  }

  async function release(resource: { close(): unknown }) {
    const index = resources.indexOf(resource);
    if (index < 0) throw new AuditHarnessError("Resource is not owned by this fixture");
    await resource.close();
    resources.splice(index, 1);
  }

  function db(name = `${randomUUID()}.db`): KnowledgeDB {
    return track(new KnowledgeDB(file(name)));
  }

  function raw(name = `${randomUUID()}.db`, options?: Database.Options): Database.Database {
    return track(new Database(file(name), options));
  }

  function profile() {
    const home = file(`profiles/${randomUUID()}`);
    const appData = path.join(home, "AppData", "Roaming");
    const localAppData = path.join(home, "AppData", "Local");
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(localAppData, { recursive: true });
    return { home, env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData } };
  }

  function isolateHome() {
    const isolated = profile();
    const keys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    for (const key of keys) process.env[key] = isolated.env[key];
    restorers.push(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    return isolated;
  }

  function snapshot(source: KnowledgeDB, name = `snapshots/${randomUUID()}.db`): string {
    const destination = file(name);
    if (fs.existsSync(destination)) throw new AuditHarnessError(`Snapshot already exists: ${destination}`);
    source.execSqlRun("VACUUM INTO ?", destination);
    return destination;
  }

  async function close() {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    while (resources.length) {
      let resource: { close(): unknown } | undefined = resources.pop();
      try { await resource?.close(); } catch (error) { errors.push(error); }
      resource = undefined;
    }
    for (const restore of restorers.reverse()) restore();
    // libsql statements can retain the native file handle until collected.
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.gc?.();
    let cleanupError: unknown;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        cleanupError = undefined;
        break;
      } catch (error) {
        cleanupError = error;
        // Yield to native handle cleanup; re-run the collector every few
        // attempts — statement garbage from a whole file of prior tests can
        // surface the last lock only after more of the queue is reclaimed.
        if (attempt % 5 === 4) globalThis.gc?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (cleanupError) errors.push(cleanupError);
    if (errors.length) {
      const failure = new AuditCleanupError(`Cleanup failed for ${root}`, { cause: new AggregateError(errors) });
      console.warn("[CLEANUP_WARNING]", failure);
      throw failure;
    }
  }

  return { root, file, track, release, db, raw, profile, isolateHome, snapshot, close };
}

export type AuditFixture = ReturnType<typeof auditFixture>;
