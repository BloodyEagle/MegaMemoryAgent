import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";
import { reserveAuditPort } from "./helpers/audit-http.js";
import { ensureSchema } from "../migrate-schema.js";

// Exercise the current source HTTP boundary, not an old dist or a mocked DTO.
// Only the owned child is stopped; the installed explorer is never contacted.
async function sourceHttp(fixture: AuditFixture, dbFile: string) {
  const reservation = await reserveAuditPort(fixture);
  const port = reservation.port;
  await fixture.release(reservation);
  const profile = fixture.profile();
  const webUrl = new URL("../web.ts", import.meta.url).href;
  const loader = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const guard = `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module'; const blocked=()=>{throw new Error('P07_CHILD_NETWORK_FORBIDDEN')}; http.request=http.get=https.request=https.get=blocked; net.connect=net.createConnection=tls.connect=blocked; globalThis.fetch=blocked; syncBuiltinESMExports();`;
  const script = `process.argv=[process.execPath,'p07-source-serve','serve','--db',${JSON.stringify(dbFile)}]; const {runServe}=await import(${JSON.stringify(webUrl)}); await runServe(${port},'127.0.0.1');`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(guard)}`, "--import", loader, "--input-type=module", "--eval", script], {
    cwd: fixture.root,
    env: { ...profile.env, MEGAMEMORY_DB_PATH: dbFile, MEGAMEMORY_SEARCH: "fts", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  let closed = false;
  let startupError: Error | undefined;
  const finished = new Promise<void>(resolve => child.once("close", () => { closed = true; resolve(); }));
  child.on("error", error => { startupError = error; });
  const capture = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    process.stdout.write(`[p07-source-http ${child.pid}] ${chunk.toString("utf8")}`);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  fixture.track({ close: async () => {
    if (closed) return;
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([finished, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Owned P07 HTTP cleanup timeout: ${output}`));
        }, 5000);
      })]);
    } finally { clearTimeout(timer); }
  } });
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout.off("data", check);
      child.off("error", fail);
      child.off("close", failClose);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (output.includes(`http://127.0.0.1:${port}`) && output.includes("Press Ctrl+C to stop.")) finish();
      else if (startupError || closed) failClose();
    };
    const fail = (error: Error) => finish(error);
    const failClose = () => finish(new Error(`P07 source HTTP startup failed: ${output}`, { cause: startupError }));
    const timer = setTimeout(() => finish(new Error(`P07 source HTTP startup timeout: ${output}`)), 8000);
    child.stdout.on("data", check);
    child.once("error", fail);
    child.once("close", failClose);
    check();
  });
  return (route: string) => {
    if (!route.startsWith("/") || route.startsWith("//") || port === 4321) throw new Error("Only owned P07 loopback requests allowed");
    return fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000) });
  };
}

describe("E-07 source HTTP single-node/bundle Markdown parity", () => {
  it("preserves informed_by rationale and the complete single-node Markdown bytes", async () => {
    const fixture = auditFixture();
    try {
      const file = fixture.file("http.db");
      const db = fixture.db("http.db");
      ensureSchema(db);
      const id = "модуль/решение";
      addNode(db, id, { kind: "decision", summary: "Решение с независимой опорой", why: "Причина выбора решения" });
      addNode(db, "support", { summary: "Независимая опора" });
      addNode(db, `${id}/child`, { parent_id: id, summary: "Дочерний узел" });
      db.insertEdge({ from_id: id, to_id: "support", relation: "informed_by", description: String.raw`Опора "UTF-8": причина\контекст` });
      await fixture.release(db);
      const request = await sourceHttp(fixture, file);
      const bundleResponse = await request("/api/export.json");
      expect(bundleResponse.status).toBe(200);
      const bundle = await bundleResponse.json() as { files: Record<string, string> };
      const expected = bundle.files[`${id}.md`];
      expect(expected).toContain(String.raw`    why: "Опора \"UTF-8\": причина\\контекст"`);
      expect(expected).toContain("## Why\n\nПричина выбора решения");
      expect(expected).toContain("## Children");
      const singleResponse = await request(`/api/node/${encodeURIComponent(id)}.md`);
      expect(singleResponse.status).toBe(200);
      expect(singleResponse.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(await singleResponse.text()).toBe(expected);
    } finally { await fixture.close(); }
  });
});
