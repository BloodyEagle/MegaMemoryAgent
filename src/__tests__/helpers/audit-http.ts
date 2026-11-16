import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { KnowledgeDB } from "../../db.js";
import { ensureSchema } from "../../migrate-schema.js";
import { AuditCleanupError, AuditHarnessError, deferred, type AuditFixture } from "./audit.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const serveScript = path.join(repository, "dist", "index.js");

export async function seedHttpDb(fixture: AuditFixture, seed: (db: KnowledgeDB) => void): Promise<string> {
  const db = fixture.db("http.db");
  const file = fixture.file("http.db");
  ensureSchema(db);
  seed(db);
  // This scope ends before fixture cleanup so native statements can be collected on Windows.
  await fixture.release(db);
  return file;
}

export async function reserveAuditPort(fixture: AuditFixture) {
  const server = net.createServer((socket) => socket.destroy());
  const reservation = fixture.track({
    port: 0,
    listening: () => server.listening,
    close: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => error ? reject(new AuditCleanupError("Could not close owned port reservation", { cause: error })) : resolve());
    }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  reservation.port = (server.address() as net.AddressInfo).port;
  if (reservation.port === 4321) throw new AuditHarnessError("The live explorer port is forbidden in audit tests");
  return reservation;
}

type Reservation = Awaited<ReturnType<typeof reserveAuditPort>>;
export interface AuditHttpResponse {
  status: number | null;
  text: string;
  headers: http.IncomingHttpHeaders;
  transportError: string | null;
}
export interface AuditSseEvent { type: string; data: any }

export async function startAuditHttp(fixture: AuditFixture, dbFile: string, options: {
  port?: number;
  retry?: Reservation;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
} = {}) {
  if (!fs.existsSync(serveScript)) throw new AuditHarnessError("Fresh dist/index.js is required; ask the main agent to build it");
  let port = options.port;
  if (port === undefined) {
    const reservation = await reserveAuditPort(fixture);
    port = reservation.port;
    await fixture.release(reservation);
  }
  const extraArgs = options.extraArgs ?? [];
  if (extraArgs.some((arg) => /^--(?:db|port|host)(?:=|$)/.test(arg))) {
    throw new AuditHarnessError("extraArgs must not override the isolated database or loopback binding");
  }
  return startAuditHttpProcess(fixture, dbFile, {
    args: [serveScript, "serve", "--host", "127.0.0.1", "--port", String(port), "--db", dbFile, ...extraArgs],
    port, retry: options.retry, env: options.env,
  });
}

/** Both adapters own one Node process; readiness and transport share fixture cleanup. */
export async function startAuditHttpProcess(fixture: AuditFixture, dbFile: string, options: {
  args: string[];
  port: number;
  retry?: Reservation;
  env?: NodeJS.ProcessEnv;
}) {
  if (options.port === 4321 || options.retry?.port === 4321) throw new AuditHarnessError("Port 4321 is forbidden in audit tests");
  const dbEnv = options.env?.MEGAMEMORY_DB_PATH ?? "";
  for (const [name, file] of [["dbFile", dbFile], ["MEGAMEMORY_DB_PATH", dbEnv]]) {
    if (!file) continue;
    // --db and relative env paths are resolved by the child from its owned cwd.
    const relative = path.relative(fixture.root, path.resolve(fixture.root, file));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AuditHarnessError(`${name} must remain inside the owned audit fixture`);
    }
  }
  const signals = new EventEmitter();
  const profile = fixture.profile();
  const child = spawn(process.execPath, options.args, {
    cwd: fixture.root,
    env: {
      ...profile.env, ...options.env,
      HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.env.APPDATA, LOCALAPPDATA: profile.env.LOCALAPPDATA,
      MEGAMEMORY_DB_PATH: dbEnv, MEGAMEMORY_SEARCH: "fts", NO_COLOR: "1", FORCE_COLOR: "0",
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  let startupError: Error | undefined;
  const finished = deferred<void>();
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[audit-http ${child.pid} stdout] ${text}`);
    stdout = (stdout + text).slice(-65_536);
    signals.emit("change");
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(`[audit-http ${child.pid} stderr] ${text}`);
    stderr = (stderr + text).slice(-65_536);
    signals.emit("change");
  });
  child.on("error", (error) => { startupError = error; signals.emit("change"); });
  child.on("close", () => { closed = true; finished.resolve(); signals.emit("change"); });
  child.stdin.on("error", (error) => { startupError = error; signals.emit("change"); });
  function diagnostics() {
    return JSON.stringify({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, stdout, stderr });
  }
  async function waitForClose(timeout: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        finished.promise.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const requests = new Map<http.ClientRequest, Promise<void>>();
  let closing: Promise<void> | undefined;
  const resource = fixture.track({
    close: () => closing ??= (async () => {
      for (const req of requests.keys()) req.destroy();
      await Promise.all(requests.values());
      if (closed) return;
      child.kill("SIGTERM");
      if (await waitForClose(1000)) return;
      child.kill("SIGKILL");
      // kill() is not close: pipes and native Windows handles must finish first.
      if (!await waitForClose(2000)) throw new AuditCleanupError(`Owned HTTP child did not close after SIGKILL: ${diagnostics()}`);
    })(),
  });
  let releasing: Promise<void> | undefined;
  const close = () => releasing ??= closing ?? fixture.release(resource);
  // One deadline for the entire startup, including the owned-port retry prompt.
  // Leave room inside db's 15s test budget for TERM/KILL and native fixture cleanup.
  const readyBy = Date.now() + 7000;
  async function waitForStdout(predicate: () => boolean, description: string) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new AuditHarnessError(`Readiness timeout (${description}): ${diagnostics()}`)), Math.max(0, readyBy - Date.now()));
      const finish = (error?: Error) => { clearTimeout(timer); signals.off("change", check); error ? reject(error) : resolve(); };
      const check = () => {
        if (startupError || closed) finish(new AuditHarnessError(`HTTP child failed before ${description}: ${diagnostics()}`, { cause: startupError }));
        else if (predicate()) finish();
      };
      signals.on("change", check);
      check();
    });
  }
  let origin: string;
  try {
    if (options.retry) {
      await waitForStdout(() => stdout.includes("Enter a different port"), "owned-port retry prompt");
      await fixture.release(options.retry);
      child.stdin.write(`${options.retry.port}\n`);
    }
    const expectedPort = options.retry?.port ?? options.port;
    // A 403 is a product outcome, not failed readiness; port 0 uses the bound banner.
    const boundPort = expectedPort === 0 ? "[1-9]\\d*" : String(expectedPort);
    const banner = new RegExp(`Local:\\s+(http://127\\.0\\.0\\.1:${boundPort})(?=\\s|$)[\\s\\S]*?Press Ctrl\\+C to stop\\.`);
    await waitForStdout(() => banner.test(stdout), "complete Local URL banner on stdout");
    origin = banner.exec(stdout)![1];
    if (Number(new URL(origin).port) === 4321) throw new AuditHarnessError("Port 4321 is forbidden in audit tests");
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AuditHarnessError("HTTP startup and cleanup failed", { cause: new AggregateError([error, cleanup]) }); }
    throw error;
  }

  function request(route: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<AuditHttpResponse> {
    if (!route.startsWith("/") || route.startsWith("//")) throw new AuditHarnessError("Only relative requests to the owned loopback server are allowed");
    return new Promise((resolve) => {
      let text = "";
      let status: number | null = null;
      let headers: http.IncomingHttpHeaders = {};
      let settled = false;
      const done = deferred<void>();
      const finish = (transportError: string | null) => {
        if (settled) return;
        settled = true;
        req.destroy();
        void done.promise.then(() => resolve({ status, text, headers, transportError }));
      };
      const req = http.request(new URL(route, origin), {
        method: init.method ?? "GET", agent: false,
        headers: { ...(init.method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}), ...init.headers },
      }, (res) => {
        status = res.statusCode ?? null;
        headers = res.headers;
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => finish(null));
        res.on("error", (error) => finish(String(error)));
        res.on("aborted", () => finish("HTTP response aborted"));
      });
      const timer = setTimeout(() => req.destroy(new Error("Owned HTTP request exceeded 3000 ms")), 3000);
      requests.set(req, done.promise);
      req.once("close", () => {
        clearTimeout(timer);
        requests.delete(req);
        done.resolve();
        finish("HTTP request closed before response completed");
      });
      // A reset/exit is an observed product outcome, never a rejection before expect(status).
      req.on("error", (error) => finish(String(error)));
      req.end(init.body);
    });
  }

  async function events() {
    const messages: AuditSseEvent[] = [];
    const waiters: Array<{ predicate: (event: AuditSseEvent) => boolean; resolve: (event: AuditSseEvent | undefined) => void }> = [];
    let buffer = "";
    let stream: http.IncomingMessage | undefined;
    let streamError: string | null = null;
    let stopped = false;
    const opened = deferred<number | null>();
    const done = deferred<void>();
    const stop = () => {
      stopped = true;
      for (const waiter of waiters.splice(0)) waiter.resolve(undefined);
    };
    const notify = (message: AuditSseEvent) => {
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index < 0) messages.push(message); else waiters.splice(index, 1)[0].resolve(message);
    };
    const req = http.get(new URL("/api/events", origin), { agent: false }, (res) => {
      stream = res;
      opened.resolve(res.statusCode ?? null);
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += String(chunk).replaceAll("\r\n", "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try { notify(JSON.parse(data) as AuditSseEvent); }
          catch (error) { streamError = String(error); }
        }
      });
      res.on("error", (error) => { if (!stopped) streamError = String(error); });
      res.on("aborted", () => { if (!stopped) streamError = "SSE response aborted"; stop(); });
      res.on("end", stop);
    });
    req.on("error", (error) => { if (!stopped) streamError = String(error); opened.resolve(null); stop(); });
    const openingTimer = setTimeout(() => req.destroy(new Error("Owned SSE readiness exceeded 3000 ms")), 3000);
    requests.set(req, done.promise);
    req.once("close", () => { clearTimeout(openingTimer); requests.delete(req); opened.resolve(null); stop(); done.resolve(); });
    // Track before awaiting headers: fixture cleanup also owns failed/pending opens.
    let closing: Promise<void> | undefined;
    const resource = fixture.track({
      close: () => closing ??= (async () => {
        clearTimeout(openingTimer);
        stop();
        stream?.destroy();
        req.destroy();
        await done.promise;
      })(),
    });
    let releasing: Promise<void> | undefined;
    const close = () => releasing ??= closing ?? fixture.release(resource);
    const status = await opened.promise;
    clearTimeout(openingTimer);
    if (status !== 200 || stopped) await close();
    return {
      status,
      error: () => streamError,
      next: (predicate: (event: AuditSseEvent) => boolean, timeout = 5000): Promise<AuditSseEvent | undefined> => {
        const index = messages.findIndex(predicate);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        if (stopped) return Promise.resolve(undefined);
        return new Promise((resolve) => {
          const timer = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); resolve(undefined); }, timeout);
          const waiter = { predicate, resolve: (event: AuditSseEvent | undefined) => { clearTimeout(timer); resolve(event); } };
          waiters.push(waiter);
        });
      },
      close,
    };
  }
  return { origin, port: Number(new URL(origin).port), request, events, close, diagnostics, alive: () => child.exitCode === null && child.signalCode === null && !closed };
}

export type AuditHttp = Awaited<ReturnType<typeof startAuditHttp>>;
