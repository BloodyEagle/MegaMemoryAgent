import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { runMigration } from "../migrate-schema.js";
import { autoMigrateIfNeeded } from "../auto-migrate.js";
import { runRepairIds } from "../migrate-cli.js";
import { auditFixture, sqlState } from "./helpers/audit.js";

const textOf = (calls: unknown[][]) => calls.map((args) => args.join(" ")).join("\n");

describe("B-09 repair CLI reports unresolved descendants", () => {
  it("full migration refuses to stamp success while broken descendants remain", async () => {
    const fixture = auditFixture();
    try {
      const db = fixture.db("blocked.db");
      db.pragma("foreign_keys = OFF");
      db.execSqlRun("INSERT INTO nodes (id, name, kind, summary, parent_id) VALUES ('orphan/', 'Child', 'feature', 'Missing parent', 'missing')");
      db.pragma("foreign_keys = ON");
      const beforeMarker = db.getMetaValue("schema_version");
      await expect(runMigration(db, { apply: true, backup: () => null, dbPath: db.dbPath }))
        .rejects.toThrow(/unresolved descendant/);
      expect(db.getMetaValue("schema_version")).toBe(beforeMarker);
      expect(db.getNode("orphan/")).toBeDefined();
    } finally { await fixture.close(); }
  });

  it("auto-migration rolls back rather than stamping an incomplete repair", async () => {
    const fixture = auditFixture();
    try {
      const db = fixture.db("auto.db");
      db.pragma("foreign_keys = OFF");
      db.execSqlRun("INSERT INTO nodes (id, name, kind, summary, parent_id) VALUES ('orphan/', 'Child', 'feature', 'Missing parent', 'missing')");
      db.pragma("foreign_keys = ON");
      const beforeMarker = db.getMetaValue("schema_version");
      await expect(autoMigrateIfNeeded(db, db.dbPath)).rejects.toThrow(/unresolved descendant/);
      expect(db.getMetaValue("schema_version")).toBe(beforeMarker);
      expect(db.getNode("orphan/")).toBeDefined();
    } finally { await fixture.close(); }
  });

  it.each(["--dry-run", "--apply"])("%s reports blocked descendants instead of claiming nothing to repair", async (mode) => {
    const fixture = auditFixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = fixture.db("repair.db");
      db.pragma("foreign_keys = OFF");
      db.execSqlRun("INSERT INTO nodes (id, name, kind, summary, parent_id) VALUES ('orphan/', 'Child', 'feature', 'Missing parent', 'missing')");
      db.pragma("foreign_keys = ON");
      const before = sqlState(db);
      // Keep dry-run cleanup inside this test's directory, not the real temp tree.
      vi.spyOn(os, "tmpdir").mockReturnValue(fixture.root);
      await runRepairIds(["--db", db.dbPath, mode]);
      const output = textOf([...log.mock.calls, ...err.mock.calls]);
      expect(output).toContain("1 descendant(s) left unresolved");
      expect(output).not.toContain("nothing to repair.");
      expect(sqlState(db)).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  });
});
