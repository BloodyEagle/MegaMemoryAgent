import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuditCleanupError, AuditHarnessError, deferred, type AuditFixture } from "./audit.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const tsxCli = path.join(repository, "node_modules", "tsx", "dist", "cli.mjs");

export interface AuditSrcHttpResponse {
  status: number | null;
  text: string;
  headers: http.IncomingHttpHeaders;
  transportError: string | null;
}
export interface AuditSrcSseEvent { type: string; data: any }

/**
 * B-02/B-03/B-04 (аудит 2026-11-12): HTTP-харнес, поднимающий СЕРВЕР ИЗ
 * ИСХОДНИКОВ (src/web.ts через tsx), а не собранный dist — правки web.ts
 * проверяются до пересборки (сборку делает координатор в gate). Схема
 * повторяет helpers/audit-http.ts: реальный loopback-сервер, изолированный
 * профиль, изолированная база, трекинг ресурсов фикстурой.
 *
 * База передаётся через MEGAMEMORY_DB_PATH (runServe резолвит её тем же
 * путём, что и audit-http через --db); порт 0 — фактический читается
 * из баннера stdout.
 */
export async function startAuditHttpSrc(fixture: AuditFixture, dbFile: string, options: { setupFile?: string } = {}) {
  if (!fs.existsSync(tsxCli)) throw new AuditHarnessError("tsx is required to serve src/web.ts in audit tests");
  const relative = path.relative(fixture.root, path.resolve(dbFile));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AuditHarnessError("dbFile must remain inside the owned audit fixture");
  }
  // Точка входа живёт внутри фикстуры и ссылается на исходник сервера
  // абсолютным file-URL: порт 0, база — из MEGAMEMORY_DB_PATH.
  const entry = fixture.file("serve-source.mts");
  const setupImport = options.setupFile ? `import ${JSON.stringify(pathToFileURL(options.setupFile).href)};\n` : "";
  fs.writeFileSync(entry,
    setupImport +
    `import { runServe } from ${JSON.stringify(pathToFileURL(path.join(repository, "src", "web.ts")).href)};\n` +
    `await runServe(0, "127.0.0.1");\n`, "utf8");
  const signals = new EventEmitter();
  const profile = fixture.profile();
  const child = spawn(process.execPath, [tsxCli, entry], {
    cwd: fixture.root,
    env: {
      ...profile.env,
      HOME: profile.home, USERPROFILE: profile.home,
      APPDATA: profile.env.APPDATA, LOCALAPPDATA: profile.env.LOCALAPPDATA,
      MEGAMEMORY_DB_PATH: dbFile, MEGAMEMORY_SEARCH: "fts", NO_COLOR: "1", FORCE_COLOR: "0",
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  let startupError: Error | undefined;
  const finished = deferred<void>();
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(`[audit-http-src ${child.pid} stdout] ${text}`);
    stdout = (stdout + text).slice(-65_536);
    signals.emit("change");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    process.stderr.write(`[audit-http-src ${child.pid} stderr] ${text}`);
    stderr = (stderr + text).slice(-65_536);
    signals.emit("change");
  });
  child.on("error", (error) => { startupError = error; signals.emit("change"); });
  child.on("close", () => { closed = true; finished.resolve(); signals.emit("change"); });
  child.stdin.on("error", (error) => { startupError = error; signals.emit("change"); });
  function diagnostics() {
    return JSON.stringify({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
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
  await new Promise<void>((resolve, reject) => {
    // tsx компилирует исходники на старте: таймаут готовности с запасом.
    const timer = setTimeout(() => finish(new AuditHarnessError(`Readiness timeout (banner): ${diagnostics()}`)), 20_000);
    const finish = (error?: Error) => { clearTimeout(timer); signals.off("change", check); error ? reject(error) : resolve(); };
    const check = () => {
      if (/Local:\s+http:\/\/127\.0\.0\.1:\d+[\s\S]*?Press Ctrl\+C to stop\./.test(stdout)) finish();
      else if (startupError || closed) finish(new AuditHarnessError(`HTTP child failed before banner: ${diagnostics()}`, { cause: startupError }));
    };
    signals.on("change", check);
    check();
  });
  const origin = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)![1];

  function request(route: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<AuditSrcHttpResponse> {
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
      req.setTimeout(5000, () => req.destroy(new Error("Owned HTTP request exceeded 5000 ms")));
      req.on("error", (error) => finish(String(error)));
      req.end(init.body);
    });
  }

  async function events() {
    const messages: AuditSrcSseEvent[] = [];
    const waiters: Array<{ predicate: (event: AuditSrcSseEvent) => boolean; resolve: (event: AuditSrcSseEvent | undefined) => void }> = [];
    let buffer = "";
    let stream: http.IncomingMessage | undefined;
    let streamError: string | null = null;
    let stopped = false;
    const opened = deferred<number | null>();
    const notify = (message: AuditSrcSseEvent) => {
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
          try { notify(JSON.parse(data) as AuditSrcSseEvent); }
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
      next: (predicate: (event: AuditSrcSseEvent) => boolean, timeout = 5000): Promise<AuditSrcSseEvent | undefined> => {
        const index = messages.findIndex(predicate);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        if (stopped) return Promise.resolve(undefined);
        return new Promise((resolve) => {
          const timer = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); resolve(undefined); }, timeout);
          const waiter = { predicate, resolve: (event: AuditSrcSseEvent | undefined) => { clearTimeout(timer); resolve(event); } };
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

export type AuditHttpSrc = Awaited<ReturnType<typeof startAuditHttpSrc>>;
