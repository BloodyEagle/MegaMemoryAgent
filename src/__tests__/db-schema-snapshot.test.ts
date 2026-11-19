import { describe, expect, it, vi } from "vitest";
import Database from "libsql";
import { KnowledgeDB, SCHEMA_VERSION, UpstreamSchemaError } from "../db.js";
import { auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";

const SCHEMA_SNAPSHOT_SQL = `
  SELECT (SELECT user_version FROM pragma_user_version) AS v,
         EXISTS (
           SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes'
         ) AS has_nodes
`;

type ObservedGuard = {
  guard: KnowledgeDB;
  rows: unknown[];
  prepareCount(): number;
  getCount(): number;
  pragmaCount(): number;
  restore(): void;
};

function observeGuard(raw: Database.Database, afterRead: () => void = () => {}): ObservedGuard {
  // Spy on a transparent facade, not native handles retained by Vitest's spy registry.
  // Every result still comes from the installed libsql connection without alteration.
  const leases: {
    database?: Database.Database;
    statements: Database.Statement[];
    afterRead?: () => void;
  } = { database: raw, statements: [], afterRead };
  const rows: unknown[] = [];
  const getSpies: Array<{ mock: { calls: unknown[][] }; mockRestore(): void }> = [];
  const read = (perform: () => unknown): unknown => {
    const row = perform();
    rows.push(row);
    leases.afterRead?.();
    return row;
  };
  const reader = {
    prepare(sql: string): { get(...params: unknown[]): unknown } {
      const index = leases.statements.push(leases.database!.prepare(sql)) - 1;
      const statement = {
        get(...params: unknown[]): unknown {
          return read(() => leases.statements[index].get(...params));
        },
      };
      getSpies.push(vi.spyOn(statement, "get"));
      return statement;
    },
    pragma(source: string, options?: Database.PragmaOptions): unknown {
      return read(() => leases.database!.pragma(source, options));
    },
  };
  const prepareSpy = vi.spyOn(reader, "prepare");
  const pragmaSpy = vi.spyOn(reader, "pragma");
  // Only bypass construction: constructor migration would consume the fresh state.
  const guard = Object.assign(Object.create(KnowledgeDB.prototype) as KnowledgeDB, {
    db: reader,
    dbFile: raw.name,
  });
  return {
    guard,
    rows,
    prepareCount: () => prepareSpy.mock.calls.length,
    getCount: () => getSpies.reduce((count, spy) => count + spy.mock.calls.length, 0),
    pragmaCount: () => pragmaSpy.mock.calls.length,
    restore: () => {
      for (const spy of getSpies) spy.mockRestore();
      getSpies.length = 0;
      prepareSpy.mockRestore();
      pragmaSpy.mockRestore();
      leases.statements.length = 0;
      leases.database = undefined;
      leases.afterRead = undefined;
    },
  };
}

function expectOneSnapshot(observed: ObservedGuard, version: number, hasNodes: number): void {
  expect(observed.prepareCount()).toBe(1);
  expect(observed.getCount()).toBe(1);
  expect(observed.pragmaCount()).toBe(0);
  expect(observed.rows).toHaveLength(1);
  expect(observed.rows[0]).toMatchObject({ v: version, has_nodes: hasNodes });
}

function pendingFreshCommit(fixture: AuditFixture): {
  reader: Database.Database;
  writer: Database.Database;
} {
  const writer = fixture.raw("race.db");
  writer.pragma("journal_mode = WAL");
  const reader = fixture.raw("race.db");
  // Publish nodes and user_version in the same transaction, as fresh migration does.
  writer.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE nodes (id TEXT PRIMARY KEY);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  expect(writer.inTransaction).toBe(true);
  expect(reader.prepare(SCHEMA_SNAPSHOT_SQL).get()).toMatchObject({ v: 0, has_nodes: 0 });
  return { reader, writer };
}

async function withPendingFreshCommit(
  check: (reader: Database.Database, writer: Database.Database) => void,
): Promise<void> {
  const fixture = auditFixture();
  try {
    // Native statements and spy closures leave the synchronous stack before cleanup/GC.
    const run = (): void => {
      const { reader, writer } = pendingFreshCommit(fixture);
      check(reader, writer);
    };
    run();
  } finally {
    vi.restoreAllMocks();
    await fixture.close();
  }
}

describe("schema-open snapshot", () => {
  it("installed libsql reads the version and nodes flag in one in-memory SELECT", () => {
    const raw = new Database(":memory:");
    try {
      expect(raw.prepare(SCHEMA_SNAPSHOT_SQL).get()).toMatchObject({ v: 0, has_nodes: 0 });
      raw.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY)");
      expect(raw.prepare(SCHEMA_SNAPSHOT_SQL).get()).toMatchObject({ v: 0, has_nodes: 1 });
      raw.pragma(`user_version = ${SCHEMA_VERSION}`);
      expect(raw.prepare(SCHEMA_SNAPSHOT_SQL).get()).toMatchObject({ v: SCHEMA_VERSION, has_nodes: 1 });
    } finally {
      raw.close();
    }
  });

  it.each([
    { label: "fresh empty database", version: 0, hasNodes: false, upstream: false },
    { label: "raw upstream with nodes", version: 0, hasNodes: true, upstream: true },
    { label: "v0 with a nodes view, not a table", version: 0, hasNodes: false, upstream: false, view: true },
    { label: "older fork with nodes", version: 1, hasNodes: true, upstream: false },
    { label: "current fork with nodes", version: SCHEMA_VERSION, hasNodes: true, upstream: false },
    { label: "nonzero version without nodes", version: 1, hasNodes: false, upstream: false },
  ])("preserves the openability decision for $label without schema writes", (state) => {
    const raw = new Database(":memory:");
    let observed: ObservedGuard | undefined;
    try {
      if (state.hasNodes) raw.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY)");
      if (state.view) raw.exec("CREATE VIEW nodes AS SELECT 'view-node' AS id");
      raw.pragma(`user_version = ${state.version}`);
      const before = sqlState(raw);
      observed = observeGuard(raw);
      if (state.upstream) {
        expect(() => observed!.guard.assertSchemaOpenable()).toThrowError(UpstreamSchemaError);
      } else {
        expect(() => observed!.guard.assertSchemaOpenable()).not.toThrow();
      }
      expectOneSnapshot(observed, state.version, Number(state.hasNodes));
      observed.restore();
      expect(sqlState(raw)).toEqual(before);
    } finally {
      observed?.restore();
      raw.close();
    }
  });

  it("control: two real reads straddle a fresh-schema commit and misclassify it as upstream", async () => {
    await withPendingFreshCommit((reader, writer) => {
      const versionBefore = reader.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(versionBefore.user_version).toBe(0);
      writer.exec("COMMIT");
      expect(writer.inTransaction).toBe(false);
      const nodesAfter = reader
        .prepare("SELECT 1 AS has_nodes FROM sqlite_master WHERE type = 'table' AND name = 'nodes'")
        .get() as { has_nodes: number };
      expect(nodesAfter.has_nodes).toBe(1);
      // The split guard combines these genuine native results into the false upstream verdict.
      expect(versionBefore.user_version === 0 && nodesAfter.has_nodes === 1).toBe(true);
      expect(reader.prepare(SCHEMA_SNAPSHOT_SQL).get()).toMatchObject({
        v: SCHEMA_VERSION, has_nodes: 1,
      });
    });
  });

  it("does not mix a pre-commit version with post-commit nodes when a writer commits after the first read", async () => {
    await withPendingFreshCommit((reader, writer) => {
      let commitCount = 0;
      const observed = observeGuard(reader, () => {
        if (commitCount !== 0) return;
        writer.exec("COMMIT");
        commitCount++;
      });
      try {
        // A legacy pragma read sees v0, then this hook commits nodes before its second read.
        // An atomic get sees v0/no nodes before committing, and must return that actual row.
        expect(() => observed.guard.assertSchemaOpenable()).not.toThrow();
        expect(commitCount).toBe(1);
        expect(writer.inTransaction).toBe(false);
        expectOneSnapshot(observed, 0, 0);
      } finally {
        observed.restore();
      }
      expect(reader.prepare(SCHEMA_SNAPSHOT_SQL).get()).toMatchObject({
        v: SCHEMA_VERSION, has_nodes: 1,
      });
    });
  });
});
