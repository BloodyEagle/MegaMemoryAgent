import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { reserveAuditPort } from "../../src/__tests__/helpers/audit-http.js";
import type { AuditFixture } from "../../src/__tests__/helpers/audit.js";

// Own adapter: the shared HTTP helper forces FTS and cannot test the vector gate.
export async function p14Http(fixture: AuditFixture, file: string, d3Url?: string) {
  const reservation = await reserveAuditPort(fixture);
  const port = reservation.port;
  await fixture.release(reservation);
  const profile = fixture.profile();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/index.js", import.meta.url)), "serve", "--host", "127.0.0.1", "--port", String(port), "--db", file], {
    cwd: fixture.root, env: { ...profile.env, ...(d3Url ? { MEGAMEMORY_D3_URL: d3Url } : {}), MEGAMEMORY_DB_PATH: file, MEGAMEMORY_SEARCH: "hybrid", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  const closed = once(child, "close");
  const capture = (chunk: Buffer) => { output += chunk.toString("utf8"); process.stdout.write(`[p14-http ${child.pid}] ${chunk}`); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  fixture.track({ close: async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Owned P14 HTTP child cleanup timeout")); }, 5000); })]); }
    finally { clearTimeout(timer); }
  } });
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); child.stdout.off("data", check); child.off("error", fail); child.off("close", failClose); error ? reject(error) : resolve(); };
    const check = () => { if (output.includes(`http://127.0.0.1:${port}`) && output.includes("Press Ctrl+C to stop.")) finish(); };
    const fail = (error: Error) => finish(error);
    const failClose = () => finish(new Error("P14 HTTP startup failed: " + output));
    const timer = setTimeout(() => finish(new Error("P14 HTTP startup timeout: " + output)), 8000);
    child.stdout.on("data", check); child.once("error", fail); child.once("close", failClose); check();
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin, diagnostics: () => output,
    request: (route: string, headers: Record<string, string> = {}) => {
      if (!route.startsWith("/") || route.startsWith("//") || port === 4321) throw new Error("Only owned loopback requests allowed");
      return fetch(origin + route, { headers, signal: AbortSignal.timeout(3000) });
    },
  };
}
