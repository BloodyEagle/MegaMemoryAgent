import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addNode, auditFixture, deferred, sqlState, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
afterEach(async () => { if (fixture) await fixture.close(); });

describe("R-02 / R-07 — audit harness", () => {
  it("snapshots include committed WAL data and preserve the source", () => {
    fixture = auditFixture();
    const db = fixture.db();
    addNode(db, "seed");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("wal_autocheckpoint=0");
    addNode(db, "committed");
    const before = sqlState(db);
    const snapshot = fixture.snapshot(db);
    const copy = fixture.raw(snapshot, { readonly: true });
    expect(copy.prepare("SELECT id FROM nodes ORDER BY id").all()).toEqual([{ id: "committed" }, { id: "seed" }]);
    expect(copy.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    expect(copy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlState(db)).toEqual(before);
  });

  it("isolates HOME and USERPROFILE together and restores both", async () => {
    fixture = auditFixture();
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const profile = fixture.isolateHome();
    expect(process.env.HOME).toBe(profile.home);
    expect(process.env.USERPROFILE).toBe(profile.home);
    expect(os.homedir()).toBe(profile.home);
    await fixture.close();
    expect(process.env.HOME).toBe(before.HOME);
    expect(process.env.USERPROFILE).toBe(before.USERPROFILE);
    expect(fs.existsSync(fixture.root)).toBe(false);
  });

  it("does not let fixture files escape the owned temporary directory", () => {
    fixture = auditFixture();
    expect(() => fixture.file("../outside.txt")).toThrow("escapes its directory");
  });

  it("releases a tracked database before removing its files", async () => {
    fixture = auditFixture();
    await (async () => {
      const db = fixture.db();
      addNode(db, "closed");
      await fixture.release(db);
    })();
    await fixture.close();
    expect(fs.existsSync(fixture.root)).toBe(false);
  });

  it("reports resource-close failures instead of silently swallowing them", async () => {
    fixture = auditFixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.track({ close() { throw new Error("controlled close failure"); } });
    try {
      await expect(fixture.close()).rejects.toMatchObject({
        name: "AuditCleanupError",
        cause: expect.objectContaining({ errors: [expect.objectContaining({ message: "controlled close failure" })] }),
      });
      expect(warning).toHaveBeenCalledWith("[CLEANUP_WARNING]", expect.any(Error));
    } finally {
      warning.mockRestore();
    }
  });

  it("controls competing operations through a Promise barrier", async () => {
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const operation = (async () => {
      order.push("entered");
      entered.resolve();
      await release.promise;
      order.push("released");
    })();
    await entered.promise;
    expect(order).toEqual(["entered"]);
    release.resolve();
    await operation;
    expect(order).toEqual(["entered", "released"]);
  });
});
