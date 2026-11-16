import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { ensureSchema } from "../../src/migrate-schema.js";
import { auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

// F1 2.1.13: обозреватель слушает только loopback, без wildcard-CORS,
// POST /api/consolidate защищён (same-origin, application/json, 64 КБ).
// Сервер собирается из dist — перед прогоном нужен npm run build (F6).

const MAX_BODY = 64 * 1024;

let serverFixture: AuditFixture | null = null;
let port = 0;
let serverOut = "";

afterEach(async () => {
  const owned = serverFixture;
  serverFixture = null;
  await owned?.close();
});

async function startServe(dbFile: string, extraArgs: string[] = []): Promise<number> {
  const server = await startAuditHttp(serverFixture!, dbFile, { extraArgs });
  port = server.port;
  serverOut = server.diagnostics();
  return port;
}

async function makeDb(name: string): Promise<{ file: string; count: number }> {
  serverFixture = auditFixture();
  const file = serverFixture.file(`${name}/knowledge.db`);
  const db = serverFixture.db(file);
  ensureSchema(db);
  db.insertNode({ id: "узел-а", name: "Узел А", kind: "module", summary: "первый узел" });
  db.insertNode({ id: "узел-б", name: "Узел Б", kind: "module", summary: "второй узел" });
  db.insertNode({ id: "узел-в", name: "Узел В", kind: "module", summary: "третий узел" });
  await serverFixture.release(db);
  return { file, count: 3 };
}

async function nodeCount(dbFile: string): Promise<number> {
  const db = serverFixture!.db(dbFile);
  try {
    return db.getStats().nodes;
  } finally {
    await serverFixture!.release(db);
  }
}

/** node:http клиент: fetch не даёт подменить Host (forbidden header), а тут он — предмет теста. */
function request(
  target: { host: string; port: number },
  reqPath: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.host,
        port: target.port,
        path: reqPath,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        let text = "";
        res.on("data", (d) => {
          text += String(d);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text })
        );
      }
    );
    const timer = setTimeout(() => req.destroy(new Error("Security HTTP probe exceeded 2000 ms")), 2000);
    req.once("close", () => clearTimeout(timer));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Hard wall-clock deadline includes connection establishment, not socket inactivity. */
function tryConnect(host: string, portNum: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: portNum });
    let settled = false;
    const done = (result: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done("timeout"), 1500);
    socket.once("connect", () => done("connected"));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      done(err.code === "ETIMEDOUT" ? "timeout" : err.code === "ECONNREFUSED" ? "refused" : `error:${err.code ?? "UNKNOWN"}`);
    });
  });
}

type Listener = { address: string; port: number; pid: number | null };

function parseListeners(platform: string, text: string, expectedPort: number): Listener[] {
  if (platform === "win32") {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error("Windows listener observation must be an array");
    return rows.map((row) => {
      if (!row || typeof row !== "object") throw new Error("Malformed Windows listener row");
      const { address, port, pid } = row as Record<string, unknown>;
      if (typeof address !== "string" || !net.isIP(address) || port !== expectedPort || !Number.isInteger(pid) || (pid as number) <= 0) {
        throw new Error(`Malformed Windows listener endpoint: ${JSON.stringify(row)}`);
      }
      return { address, port: expectedPort, pid: pid as number };
    });
  }
  if (platform !== "linux") throw new Error(`Unsupported listener observation platform: ${platform}`);
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "LISTEN" || fields.length < 5) throw new Error(`Malformed ss listener row: ${line}`);
    const endpoint = /^(.*):(\d+)$/.exec(fields[3]);
    if (!endpoint || Number(endpoint[2]) !== expectedPort) throw new Error(`Unexpected ss listener endpoint: ${line}`);
    const address = endpoint[1].replace(/^\[(.*)\]$/, "$1");
    if (address !== "*" && !net.isIP(address)) throw new Error(`Malformed ss listener address: ${line}`);
    const pid = /\bpid=(\d+)/.exec(line);
    return { address, port: expectedPort, pid: pid ? Number(pid[1]) : null };
  });
}

function assertLoopbackListeners(listeners: Listener[]) {
  expect(listeners.length, "OS listener observation must not be empty").toBeGreaterThan(0);
  for (const listener of listeners) {
    expect(["127.0.0.1", "::1"], `non-loopback listener ${JSON.stringify(listener)}`).toContain(listener.address);
  }
}

async function observeListeners(portNum: number): Promise<Listener[]> {
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === "win32") {
    command = "powershell.exe";
    const script = `$ErrorActionPreference = 'Stop'; $rows = @(Get-NetTCPConnection -LocalPort ${portNum} -State Listen -ErrorAction Stop); $result = @($rows | ForEach-Object { @{ address = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } }); ConvertTo-Json -InputObject $result -Compress`;
    args = ["-NoProfile", "-NonInteractive", "-Command", script];
  } else if (platform === "linux") {
    command = "ss";
    args = ["-H", "-ltnp", "sport", "=", String(portNum)];
  } else {
    throw new Error(`Unsupported listener observation platform: ${platform}`);
  }
  const text = await new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 6000, maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`OS listener observation failed (${platform}): ${error.message}; stderr=${stderr.slice(-2000)}`, { cause: error }));
      resolve(stdout);
    });
  });
  return parseListeners(platform, text, portNum);
}

describe("serve security (F1 2.1.13)", () => {
  it.each(["win32", "linux"])("%s listener oracle accepts loopback and rejects wildcard or Ethernet binding", (platform) => {
    const port = 54321;
    const observation = (address: string) => platform === "win32"
      ? JSON.stringify([{ address, port, pid: 123 }])
      : `LISTEN 0 511 ${address.includes(":") ? `[${address}]` : address}:${port} *:* users:(("node",pid=123,fd=20))\n`;
    expect(() => assertLoopbackListeners(parseListeners(platform, observation("127.0.0.1"), port))).not.toThrow();
    expect(() => assertLoopbackListeners(parseListeners(platform, observation("::1"), port))).not.toThrow();
    for (const address of ["0.0.0.0", "::", "192.168.185.232"]) {
      expect(() => assertLoopbackListeners(parseListeners(platform, observation(address), port)), address).toThrow("non-loopback listener");
    }
    expect(() => assertLoopbackListeners([])).toThrow("OS listener observation must not be empty");
  });

  it(
    "listens on 127.0.0.1 only; the banner prints the actual address",
    { timeout: 45000 },
    async () => {
      const db = await makeDb("loopback");
      await startServe(db.file);

      // Фактический адрес в баннере совпадает с тем, по которому ходим.
      expect(serverOut).toContain(`http://127.0.0.1:${port}`);
      expect(serverOut).toContain("Local interface only");

      // Positive control prevents a dead server from satisfying the negative probe.
      const tcp = await tryConnect("127.0.0.1", port);
      const http = await request({ host: "127.0.0.1", port }, "/api/stats");
      const listeners = await observeListeners(port);
      const childPid = JSON.parse(serverOut).pid as number;
      const external = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
        (list ?? []).filter((iface) => !iface.internal && iface.family === "IPv4")
          .map((iface) => ({ interface: name, address: iface.address })));
      // Probe all current external IPv4 addresses concurrently; each has a 1.5s deadline.
      const outcomes = await Promise.all(external.map(async (iface) => ({
        ...iface, outcome: await tryConnect(iface.address, port),
      })));
      console.log("[serve-loopback-observation]", JSON.stringify({
        platform: process.platform, childPid, port, listeners, positiveControl: { tcp, http: http.status },
        external: outcomes, cause: "unknown",
      }));
      expect(tcp).toBe("connected");
      expect(http.status).toBe(200);
      assertLoopbackListeners(listeners);
      for (const listener of listeners) {
        // ss can hide process metadata without permissions; Windows always supplies it.
        if (listener.pid !== null) expect(listener.pid, "listener must belong to the owned HTTP child").toBe(childPid);
      }
      for (const probe of outcomes) {
        expect(probe.outcome, `external interface ${probe.interface} ${probe.address}`).toMatch(/^(refused|timeout|error:[A-Z0-9_]+)$/);
      }
    }
  );

  it("rejects a foreign Host header with 403 (DNS rebinding guard)", { timeout: 45000 }, async () => {
    const db = await makeDb("host");
    await startServe(db.file);

    const res = await request({ host: "127.0.0.1", port }, "/api/stats", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);

    // Тот же порт с правильным Host работает — отказ адресный, не серверный.
    const ok = await request({ host: "127.0.0.1", port }, "/api/stats", {
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(ok.status).toBe(200);
  });

  it("rejects malformed Host forms: bare IPv6 and a portless Host on a non-80 port", { timeout: 45000 }, async () => {
    const db = await makeDb("hostform");
    await startServe(db.file);

    // R-08: `::1` без скобок — не валидная форма Host (браузеры шлют
    // `[::1]:port`). Раньше проходила через whitelist-запись "::1".
    const bare6 = await request({ host: "127.0.0.1", port }, "/api/stats", {
      headers: { host: `::1:${port}` },
    });
    expect(bare6.status).toBe(403);

    // Host без порта допустим только для дефолтного 80 — на любом другом
    // порту это не браузерная форма (браузер всегда шлёт порт).
    const portless = await request({ host: "127.0.0.1", port }, "/api/stats", {
      headers: { host: "localhost" },
    });
    expect(portless.status).toBe(403);

    // Легитимные формы не задеты: скобочный IPv6 и localhost с портом.
    const bracketed = await request({ host: "127.0.0.1", port }, "/api/stats", {
      headers: { host: `[::1]:${port}` },
    });
    expect(bracketed.status).toBe(200);

    const withPort = await request({ host: "127.0.0.1", port }, "/api/stats", {
      headers: { host: `localhost:${port}` },
    });
    expect(withPort.status).toBe(200);
  });

  it("rejects a foreign Origin with 403 and no CORS header", { timeout: 45000 }, async () => {
    const db = await makeDb("origin");
    await startServe(db.file);

    const res = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      headers: { origin: "http://evil.local" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    // Same-origin GET не задет.
    const same = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(same.status).toBe(200);
  });

  it("POST without application/json → 415, database unchanged", { timeout: 45000 }, async () => {
    const db = await makeDb("ct");
    await startServe(db.file);

    const res = await fetch(`http://127.0.0.1:${port}/api/consolidate`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ survivor: "узел-а", other: "узел-б" }),
    });
    expect(res.status).toBe(415);
    expect(await nodeCount(db.file)).toBe(3);
  });

  it("POST body over the 64 KB limit → 413", { timeout: 45000 }, async () => {
    const db = await makeDb("big");
    await startServe(db.file);

    const big = JSON.stringify({
      survivor: "узел-а",
      other: "узел-б",
      pad: "x".repeat(MAX_BODY),
    });
    expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_BODY);

    const res = await fetch(`http://127.0.0.1:${port}/api/consolidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(await nodeCount(db.file)).toBe(3);
  });

  it("POST with invalid JSON → 400, database unchanged", { timeout: 45000 }, async () => {
    const db = await makeDb("badjson");
    await startServe(db.file);

    const res = await fetch(`http://127.0.0.1:${port}/api/consolidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{survivor: узел-а",
    });
    expect(res.status).toBe(400);
    expect(await nodeCount(db.file)).toBe(3);
  });

  it("same-origin POST merges two nodes", { timeout: 45000 }, async () => {
    const db = await makeDb("post-ok");
    await startServe(db.file);

    const res = await fetch(`http://127.0.0.1:${port}/api/consolidate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ survivor: "узел-а", other: "узел-б" }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok?: boolean };
    expect(payload.ok).toBe(true);
    // Слияние реально записано: 3 узла → 2.
    expect(await nodeCount(db.file)).toBe(2);
  });

  it("GET graph and SSE work as before, without CORS headers", { timeout: 45000 }, async () => {
    const db = await makeDb("getsse");
    await startServe(db.file);

    const graph = await fetch(`http://127.0.0.1:${port}/api/graph`);
    expect(graph.status).toBe(200);
    expect(graph.headers.get("access-control-allow-origin")).toBeNull();
    const payload = (await graph.json()) as { nodes: Array<{ id: string }> };
    expect(payload.nodes.map((n) => n.id)).toContain("узел-а");

    // SSE: init-событие приходит, поток живой.
    const ctrl = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: ctrl.signal,
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    expect(sse.headers.get("access-control-allow-origin")).toBeNull();

    const reader = sse.body!.getReader();
    const { value } = await reader.read();
    const chunk = Buffer.from(value!).toString("utf8");
    expect(chunk).toContain("data:");
    expect(chunk).toContain("init");
    ctrl.abort();
  });
});
