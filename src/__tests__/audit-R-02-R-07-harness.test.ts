import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addNode, auditFixture, deferred, sqlState, type AuditFixture } from "./helpers/audit.js";
import { seedHttpDb, startAuditHttp, startAuditHttpProcess } from "./helpers/audit-http.js";
import { startAuditHttpSrc } from "./helpers/audit-http-src.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

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

  it.each([
    ["compiled", startAuditHttp],
    ["source", startAuditHttpSrc],
  ] as const)("%s adapter preserves loopback HTTP/SSE and releases early closes once", async (adapter, start) => {
    fixture = auditFixture();
    const release = vi.spyOn(fixture, "release");
    const track = vi.spyOn(fixture, "track");
    const dbFile = await seedHttpDb(fixture, (db) => addNode(db, "transport"));
    const server = await start(fixture, dbFile);
    const spawnCall = vi.mocked(spawn).mock.calls.at(-1)!;
    const args = spawnCall[1] as string[];
    if (adapter === "compiled") {
      expect(args[0].replaceAll("\\", "/")).toMatch(/\/dist\/index\.js$/);
      expect(args.slice(1, 4)).toEqual(["serve", "--host", "127.0.0.1"]);
    } else {
      expect(args[0]).toBe("--import");
      expect(args[1]).toMatch(/\/tsx\/dist\/loader\.mjs$/);
    }
    const env = (spawnCall[2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.HOME).toBe(env.USERPROFILE);
    for (const key of ["HOME", "APPDATA", "LOCALAPPDATA"] as const) expect(env[key]).toContain(fixture.root);
    expect(new URL(server.origin).hostname).toBe("127.0.0.1");
    expect(server.port).not.toBe(4321);
    expect(() => server.request("//external.invalid/")).toThrow("Only relative requests");
    expect((await server.request("/api/node/transport")).status).toBe(200);
    const post = await server.request("/api/consolidate", { method: "POST", body: "{}" });
    expect(post.transportError).toBeNull();
    expect(post.status).toBe(400); // Reaches validation, not missing Origin's 403.
    const sse = await server.events();
    expect(sse.status).toBe(200);
    expect((await sse.next((event) => event.type === "init"))?.type).toBe("init");
    const pending = sse.next(() => false, 20_000);
    const subscription = track.mock.calls.at(-1)![0];
    const subscriptionClose = vi.spyOn(subscription, "close");
    await sse.close();
    await sse.close();
    expect(await pending).toBeUndefined();
    const reconnected = await server.events();
    expect(reconnected.status).toBe(200);
    expect((await reconnected.next((event) => event.type === "init"))?.data.nodes.map((node: { id: string }) => node.id)).toContain("transport");
    await reconnected.close();
    expect(subscriptionClose).toHaveBeenCalledTimes(1);
    expect(release.mock.calls.filter(([owned]) => owned === subscription)).toHaveLength(1);
    await server.close();
    await server.close();
    expect(server.alive()).toBe(false);
    const stopped = JSON.parse(server.diagnostics());
    expect(stopped.exitCode !== null || stopped.signal !== null).toBe(true);
    expect((await server.request("/api/node/transport")).transportError).not.toBeNull();
    await fixture.close();
    expect(subscriptionClose).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.root)).toBe(false);
  });

  it.each([
    ["compiled", startAuditHttp],
    ["source", startAuditHttpSrc],
  ] as const)("%s relative database resolves from fixture cwd without weakening path guards", async (adapter, start) => {
    fixture = auditFixture();
    await seedHttpDb(fixture, (db) => addNode(db, "relative-owned"));
    const before = vi.mocked(spawn).mock.calls.length;
    for (const escaped of ["../outside.db", path.resolve(fixture.root, "../outside.db")]) {
      await expect(start(fixture, escaped)).rejects.toThrow("dbFile must remain inside the owned audit fixture");
    }
    expect(vi.mocked(spawn).mock.calls).toHaveLength(before);
    if (adapter === "compiled") {
      await expect(startAuditHttp(fixture, "http.db", { env: { MEGAMEMORY_DB_PATH: "../outside.db" } })).rejects.toThrow("MEGAMEMORY_DB_PATH must remain inside the owned audit fixture");
    }
    const server = await start(fixture, "http.db");
    const card = await server.request("/api/node/relative-owned");
    expect(card.status).toBe(200);
    expect(JSON.parse(card.text).id).toBe("relative-owned");
    expect(server.diagnostics()).toContain(fixture.root.replaceAll("\\", "\\\\"));
    await server.close();
    await fixture.close();
    expect(fs.existsSync(fixture.root)).toBe(false);
  });

  it("fixture closes a live source child and its SSE before deleting native database files", async () => {
    fixture = auditFixture();
    const dbFile = await seedHttpDb(fixture, (db) => addNode(db, "owned"));
    const server = await startAuditHttpSrc(fixture, dbFile);
    const sse = await server.events();
    expect(sse.status).toBe(200);
    const pending = sse.next(() => false, 20_000);
    await fixture.close();
    expect(await pending).toBeUndefined();
    expect(server.alive()).toBe(false);
    expect(fs.existsSync(fixture.root)).toBe(false);
  });

  it("source setupFile failure releases the child before rejecting startup", async () => {
    fixture = auditFixture();
    const track = vi.spyOn(fixture, "track");
    const release = vi.spyOn(fixture, "release");
    const dbFile = await seedHttpDb(fixture, (db) => addNode(db, "startup"));
    const setupFile = fixture.file("failed-setup.mts");
    fs.writeFileSync(setupFile, 'throw new Error("controlled setupFile failure");\n', "utf8");
    await expect(startAuditHttpSrc(fixture, dbFile, { setupFile })).rejects.toThrow("controlled setupFile failure");
    const child = track.mock.calls.at(-1)![0];
    expect(release.mock.calls.filter(([owned]) => owned === child)).toHaveLength(1);
    const close = vi.spyOn(child, "close");
    await fixture.close();
    expect(close).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.root)).toBe(false);
  });

  it("readiness deadline rejects locally and releases the still-running child", async () => {
    fixture = auditFixture();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      pid: 123, exitCode: null, signalCode: null,
      kill: vi.fn(() => { setImmediate(() => child.emit("close")); return true; }),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const release = vi.spyOn(fixture, "release");
    vi.useFakeTimers();
    try {
      const startup = startAuditHttpProcess(fixture, fixture.file("unused.db"), { args: ["unused"], port: 0 });
      const rejected = expect(startup).rejects.toThrow("Readiness timeout");
      await vi.advanceTimersByTimeAsync(7001); // Default readiness + cleanup stays below db's 15s.
      await rejected;
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
    await fixture.close();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.root)).toBe(false);
  });

  it("SIGKILL escalation waits for close before releasing the fixture's child", async () => {
    fixture = auditFixture();
    const killed = deferred();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      pid: 456, exitCode: null, signalCode: null,
      kill: vi.fn((signal: string) => {
        if (signal === "SIGKILL") killed.resolve();
        return true;
      }),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    setImmediate(() => child.stdout.write("Local: http://127.0.0.1:9876\nPress Ctrl+C to stop.\n"));
    const server = await startAuditHttpProcess(fixture, fixture.file("unused.db"), { args: ["unused"], port: 9876 });
    const release = vi.spyOn(fixture, "release");
    let released = false;
    const closing = server.close().then(() => { released = true; });
    try {
      await killed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(released).toBe(false);
      expect(server.alive()).toBe(true);
    } finally {
      child.emit("close");
      await closing;
    }
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(server.alive()).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    await fixture.close();
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(fixture.root)).toBe(false);
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
