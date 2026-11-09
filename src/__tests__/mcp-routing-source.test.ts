import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cleanupDir } from "./helpers/cleanup.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href;
const entry = path.join(root, "src/index.ts");

async function invoke(flags: (db: string, repo: string) => string[], envDb: boolean) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mm-mcp-routing-"));
  const db = path.join(cwd, "explicit.db"), repo = path.join(cwd, "repository");
  fs.mkdirSync(repo);
  const home = path.join(cwd, "profile");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"), CODEX_HOME: path.join(home, "codex"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"), OPENCODE_CONFIG_DIR: path.join(home, "opencode"),
    MEGAMEMORY_DB_PATH: envDb ? db : "", MEGAMEMORY_SEARCH: "fts", MEGAMEMORY_AUTO_MIGRATE: "0",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", NODE_OPTIONS: "" };
  const args = flags(db, repo);
  try {
    const result = await new Promise<{ initialized: boolean; code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", loader, entry, ...args], { cwd, env, shell: false, windowsHide: true });
      let stdout = "", stderr = "", initialized = false;
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("MCP initialize timed out")); }, 8000);
      child.stdin.on("error", () => {});
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        for (const line of stdout.split(/\r?\n/)) {
          try {
            const message = JSON.parse(line);
            if (message.id === 1 && message.result?.serverInfo && !initialized) {
              initialized = true;
              child.kill("SIGTERM");
            }
          } catch {}
        }
      });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.on("error", err => { clearTimeout(timer); reject(err); });
      child.on("close", code => { clearTimeout(timer); resolve({ initialized, code, stdout, stderr }); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "routing-regression", version: "1" },
      } }) + "\n");
    });
    return { ...result, selected: fs.existsSync(db), defaultCreated: fs.existsSync(path.join(cwd, ".megamemory/knowledge.db")) };
  } finally { await cleanupDir(cwd); }
}

describe("F-03 source MCP entrypoint", () => {
  it.each([
    ["environment", () => [], true],
    ["db", (db: string) => ["--db", db], false],
    ["repo", (_db: string, repo: string) => ["--repo", repo], true],
    ["both", (db: string, repo: string) => ["--db", db, "--repo", repo], false],
    ["equals", (db: string, repo: string) => [`--db=${db}`, `--repo=${repo}`], false],
  ] as const)("%s flags initialize at the selected database", async (_name, args, envDb) => {
    const result = await invoke(args, envDb);
    expect(result.stderr).not.toContain("Unknown command");
    expect(result.initialized, result.stderr).toBe(true);
    expect(result.selected).toBe(true);
    expect(result.defaultCreated).toBe(false);
  });

  it("F-02 source CLI rejects missing output before touching its input files", async () => {
    const result = await invoke(db => ["merge", db, db, "--into"], false);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--into.*requires a value/);
    expect(result.selected).toBe(false);
  });

  it("F-01 source CLI preserves the fractional threshold before database validation", async () => {
    const result = await invoke(db => ["consolidate", "--db", db, "--threshold", "0.95junk"], false);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--threshold.*finite number/);
    expect(result.selected).toBe(false);
  });

  it("unknown command does not initialize MCP or create a database", async () => {
    const result = await invoke(db => ["--db", db, "unknown-command"], false);
    expect(result.code).toBe(1);
    expect(result.initialized).toBe(false);
    expect(result.selected).toBe(false);
    expect(result.defaultCreated).toBe(false);
  });
});
