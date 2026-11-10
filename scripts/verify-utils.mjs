import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TIMEOUT_MS = 60_000;

export function isolatedEnvironment(directory) {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP", "CI"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: directory, USERPROFILE: directory,
    APPDATA: path.join(directory, "AppData/Roaming"), LOCALAPPDATA: path.join(directory, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(directory, ".config"), XDG_CACHE_HOME: path.join(directory, ".cache"), XDG_DATA_HOME: path.join(directory, ".local/share"),
    CODEX_HOME: path.join(directory, ".codex"), CLAUDE_CONFIG_DIR: path.join(directory, ".claude"), OPENCODE_CONFIG_DIR: path.join(directory, ".config/opencode"),
    HF_HOME: path.join(directory, ".cache/huggingface"), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
    MEGAMEMORY_DB_PATH: path.join(directory, "owned.db"), MEGAMEMORY_FIXTURES_DIR: path.join(ROOT, "fixtures"),
    MEGAMEMORY_SEARCH: "fts", MEGAMEMORY_AUTO_DIGEST: "0", MEGAMEMORY_PROVENANCE_AUTO_GROUND: "0",
    NODE_OPTIONS: "", NO_COLOR: "1", FORCE_COLOR: "0",
  });
  for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "HF_HOME"]) {
    fs.mkdirSync(env[key], { recursive: true });
  }
  return env;
}

export async function cleanup(directory) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.rmSync(directory, { recursive: true, force: true }); return; }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`CLEANUP_FAILED ${directory}: ${lastError.message}`);
}

export function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `megamemory-${label}-`));
}

// Direct --import arguments (proven pattern); NODE_OPTIONS is not used so
// that child processes stay under the same explicit supervision. --import
// requires a file:// URL, never a plain Windows path.
export function offlineImports() {
  return ["--import", new URL("./verify-offline.mjs", import.meta.url).href];
}

export async function runBounded(command, args, { cwd = ROOT, env = process.env, label = "check", capture = false } = {}) {
  const logDirectory = process.env.MEGAMEMORY_VERIFY_LOG_DIR || os.tmpdir();
  fs.mkdirSync(logDirectory, { recursive: true });
  const log = path.join(logDirectory, `${label}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.log`);
  const fd = fs.openSync(log, "wx");
  const started = Date.now();
  fs.writeSync(fd, JSON.stringify({ command, args, cwd, timeout_ms: TIMEOUT_MS }) + "\n");
  let timedOut = false, failure = null, output = "", outputBytes = 0, killer = null;
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const terminate = () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      killer = new Promise((resolve) => {
        const processKiller = spawn(path.join(env.SystemRoot || env.SYSTEMROOT || "C:/Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        processKiller.on("error", () => { child.kill("SIGKILL"); resolve(); });
        processKiller.on("close", resolve);
      });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failure = error.message; }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    fs.writeSync(fd, "\nVERIFY_TIMEOUT: terminating owned process tree\n");
    terminate();
  }, TIMEOUT_MS);
  child.stdout.on("data", (chunk) => {
    fs.writeSync(fd, chunk);
    process.stdout.write(chunk);
    if (capture) {
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) { failure = "CAPTURE_LIMIT_EXCEEDED"; terminate(); }
      else output += chunk.toString("utf8");
    }
  });
  child.stderr.on("data", (chunk) => { fs.writeSync(fd, chunk); process.stderr.write(chunk); });
  child.on("error", (error) => { failure = error.message; });
  const { code, signal } = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  if (killer) await killer;
  const result = { label, code: timedOut ? 124 : failure ? 1 : code ?? 1, signal, timed_out: timedOut, error: failure, duration_ms: Date.now() - started, log };
  fs.writeSync(fd, "\nVERIFY_RESULT " + JSON.stringify(result) + "\n");
  fs.closeSync(fd);
  console.log(JSON.stringify(result));
  if (result.code !== 0) throw Object.assign(new Error(`${label} failed; see ${log}`), { exitCode: result.code });
  return { ...result, stdout: output };
}

export function reportFailure(error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = error.exitCode || 1;
}
