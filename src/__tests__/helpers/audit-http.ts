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
  if (port === 4321 || options.retry?.port === 4321) throw new AuditHarnessError("Port 4321 is forbidden in audit tests");
  const signals = new EventEmitter();
  const profile = fixture.profile();
  const dbEnv = options.env?.MEGAMEMORY_DB_PATH ?? "";
  if (dbEnv) {
    const relative = path.relative(fixture.root, path.resolve(dbEnv));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AuditHarnessError("MEGAMEMORY_DB_PATH must remain inside the owned audit fixture");
    }
  }
  const extraArgs = options.extraArgs ?? [];
  if (extraArgs.some((arg) => /^--(?:db|port|host)(?:=|$)/.test(arg))) {
    throw new AuditHarnessError("extraArgs must not override the isolated database or loopback binding");
  }
  const child = spawn(process.execPath, [serveScript, "serve", "--host", "127.0.0.1", "--port", String(port), "--db", dbFile, ...extraArgs], {
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
  async function close() {
    if (closed) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
        reject(new AuditCleanupError(`Owned HTTP child did not close: ${diagnostics()}`));
      }, 5000);
      finished.promise.then(() => { clearTimeout(timer); resolve(); });
    });
  }
  fixture.track({ close });
  async function waitForStdout(predicate: () => boolean, description: string) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new AuditHarnessError(`Readiness timeout (${description}): ${diagnostics()}`)), 8000);
      const finish = (error?: Error) => { clearTimeout(timer); signals.off("change", check); error ? reject(error) : resolve(); };
      const check = () => {
        if (predicate()) finish();
        else if (startupError || closed) finish(new AuditHarnessError(`HTTP child failed before ${description}: ${diagnostics()}`, { cause: startupError }));
      };
      signals.on("change", check);
      check();
    });
  }
  if (options.retry) {
    await waitForStdout(() => stdout.includes("Enter a different port"), "owned-port retry prompt");
    await fixture.release(options.retry);
    child.stdin.write(`${options.retry.port}\n`);
  }
  const expectedPort = options.retry?.port ?? port;
  // The retry path may print two banners. Wait for the explicitly chosen bound port,
  // not for a successful endpoint response (a 403 is the W-05 product assertion).
  const banner = new RegExp(`Local:\\s+(http://127\\.0\\.0\\.1:${expectedPort})(?=\\s|$)[\\s\\S]*?Press Ctrl\\+C to stop\\.`);
  await waitForStdout(() => banner.test(stdout), "complete Local URL banner on stdout");
  const origin = banner.exec(stdout)![1];

  function request(route: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<AuditHttpResponse> {
    if (!route.startsWith("/") || route.startsWith("//")) throw new AuditHarnessError("Only relative requests to the owned loopback server are allowed");
    return new Promise((resolve) => {
      let text = "";
      let status: number | null = null;
      let headers: http.IncomingHttpHeaders = {};
      let settled = false;
      const finish = (transportError: string | null) => {
        if (settled) return;
        settled = true;
        resolve({ status, text, headers, transportError });
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
      req.setTimeout(3000, () => req.destroy(new Error("Owned HTTP request exceeded 3000 ms")));
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
    });
    req.on("error", (error) => { if (!stopped) streamError = String(error); opened.resolve(null); });
    const openingTimer = setTimeout(() => req.destroy(new Error("Owned SSE readiness exceeded 5000 ms")), 5000);
    const status = await opened.promise;
    clearTimeout(openingTimer);
    const subscription = fixture.track({
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
      close: () => {
        stopped = true;
        for (const waiter of waiters.splice(0)) waiter.resolve(undefined);
        stream?.destroy();
        req.destroy();
      },
    });
    return subscription;
  }
  return { origin, port: Number(new URL(origin).port), request, events, diagnostics, alive: () => child.exitCode === null && child.signalCode === null && !closed };
}

export type AuditHttp = Awaited<ReturnType<typeof startAuditHttp>>;
