import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../../src/db.js";
import { ensureSchema } from "../../src/migrate-schema.js";
import { cleanupDir } from "../../src/__tests__/helpers/cleanup.js";

// F1 2.1.13: обозреватель слушает только loopback, без wildcard-CORS,
// POST /api/consolidate защищён (same-origin, application/json, 64 КБ).
// Сервер собирается из dist — перед прогоном нужен npm run build (F6).

const repoRoot = path.resolve(import.meta.dirname, "../..");
const serveScript = path.join(repoRoot, "dist", "index.js");
const MAX_BODY = 64 * 1024;

let child: ChildProcess | null = null;
let tmpDir: string | null = null;
let port = 0;
let serverOut = "";

afterEach(async () => {
  if (child) {
    child.kill();
    child = null;
  }
  if (tmpDir) {
    await cleanupDir(tmpDir);
    tmpDir = null;
  }
});

function startServe(dbFile: string, extraArgs: string[] = []): Promise<number> {
  port = 43000 + Math.floor(Math.random() * 10000);
  serverOut = "";
  return new Promise((resolve, reject) => {
    // 2.1.13 F6: FTS-режим (предмет теста — маршруты, не эмбеддинги);
    // окружение нейтрализовано: путь задаёт только --db.
    child = spawn(
      process.execPath,
      [serveScript, "serve", "--port", String(port), "--db", dbFile, ...extraArgs],
      {
        env: { ...process.env, MEGAMEMORY_SEARCH: "fts", MEGAMEMORY_DB_PATH: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    child.stdout?.on("data", (d) => {
      serverOut += String(d);
    });
    child.stderr?.on("data", (d) => {
      serverOut += String(d);
    });
    child.on("exit", (code) =>
      reject(new Error(`serve exited early (${code}): ${serverOut}`))
    );

    const started = Date.now();
    const poll = async (): Promise<void> => {
      while (Date.now() - started < 20000) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
          if (res.ok) {
            resolve(port);
            return;
          }
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      reject(new Error(`serve did not start in 20s: ${serverOut}`));
    };
    void poll();
  });
}

function makeDb(dir: string, name: string): { dir: string; file: string; count: number } {
  const dirPath = fs.mkdtempSync(path.join(dir, `mm-sec-${name}-`));
  const file = path.join(dirPath, "knowledge.db");
  const db = new KnowledgeDB(file);
  ensureSchema(db);
  db.insertNode({ id: "узел-а", name: "Узел А", kind: "module", summary: "первый узел" });
  db.insertNode({ id: "узел-б", name: "Узел Б", kind: "module", summary: "второй узел" });
  db.insertNode({ id: "узел-в", name: "Узел В", kind: "module", summary: "третий узел" });
  db.close();
  return { dir: dirPath, file, count: 3 };
}

function nodeCount(dbFile: string): number {
  const db = new KnowledgeDB(dbFile);
  try {
    return db.getStats().nodes;
  } finally {
    db.close();
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
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text })
        );
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** TCP-подключение: "connected" | "refused" | "timeout". */
function tryConnect(host: string, portNum: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: portNum });
    const done = (result: string): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(3000, () => done("timeout"));
    socket.on("connect", () => done("connected"));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      done(err.code === "ECONNREFUSED" ? "refused" : "error");
    });
  });
}

describe("serve security (F1 2.1.13)", () => {
  it(
    "listens on 127.0.0.1 only; the banner prints the actual address",
    { timeout: 45000 },
    async () => {
      const db = makeDb(os.tmpdir(), "loopback");
      tmpDir = db.dir;
      await startServe(db.file);

      // Фактический адрес в баннере совпадает с тем, по которому ходим.
      expect(serverOut).toContain(`http://127.0.0.1:${port}`);
      expect(serverOut).toContain("Local interface only");

      // По 127.0.0.1 — подключение есть.
      expect(await tryConnect("127.0.0.1", port)).toBe("connected");

      // На прочих интерфейсах подключения нет (когда они физически есть).
      const external: string[] = [];
      const ifaces = os.networkInterfaces();
      for (const list of Object.values(ifaces)) {
        for (const i of list ?? []) {
          if (!i.internal && i.family === "IPv4") external.push(i.address);
        }
      }
      for (const addr of external) {
        expect(await tryConnect(addr, port), `external interface ${addr}`).toBe(
          "refused"
        );
      }
    }
  );

  it("rejects a foreign Host header with 403 (DNS rebinding guard)", { timeout: 45000 }, async () => {
    const db = makeDb(os.tmpdir(), "host");
    tmpDir = db.dir;
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

  it("rejects a foreign Origin with 403 and no CORS header", { timeout: 45000 }, async () => {
    const db = makeDb(os.tmpdir(), "origin");
    tmpDir = db.dir;
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
    const db = makeDb(os.tmpdir(), "ct");
    tmpDir = db.dir;
    await startServe(db.file);

    const res = await fetch(`http://127.0.0.1:${port}/api/consolidate`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ survivor: "узел-а", other: "узел-б" }),
    });
    expect(res.status).toBe(415);
    expect(nodeCount(db.file)).toBe(3);
  });

  it("POST body over the 64 KB limit → 413", { timeout: 45000 }, async () => {
    const db = makeDb(os.tmpdir(), "big");
    tmpDir = db.dir;
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
    expect(nodeCount(db.file)).toBe(3);
  });

  it("POST with invalid JSON → 400, database unchanged", { timeout: 45000 }, async () => {
    const db = makeDb(os.tmpdir(), "badjson");
    tmpDir = db.dir;
    await startServe(db.file);

    const res = await fetch(`http://127.0.0.1:${port}/api/consolidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{survivor: узел-а",
    });
    expect(res.status).toBe(400);
    expect(nodeCount(db.file)).toBe(3);
  });

  it("same-origin POST merges two nodes", { timeout: 45000 }, async () => {
    const db = makeDb(os.tmpdir(), "post-ok");
    tmpDir = db.dir;
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
    expect(nodeCount(db.file)).toBe(2);
  });

  it("GET graph and SSE work as before, without CORS headers", { timeout: 45000 }, async () => {
    const db = makeDb(os.tmpdir(), "getsse");
    tmpDir = db.dir;
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
