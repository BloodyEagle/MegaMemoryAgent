import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(() => { throw new Error("Shell execution forbidden in install tests"); }),
  installFile: "",
}));
vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: boundary.execFileSync,
  execSync: boundary.execSync,
}));
vi.mock("url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  return {
    ...actual,
    fileURLToPath: (url: string | URL) => boundary.installFile && String(url).endsWith("/install.ts")
      ? boundary.installFile : actual.fileURLToPath(url),
  };
});

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let root: string;
let home: string;
let workspace: string;
let opencode: string;
const originalCwd = process.cwd();
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-install профиль & % ! ^ (тест)-"));
  home = path.join(root, "home");
  workspace = path.join(root, "workspace");
  opencode = path.join(root, "opencode");
  for (const directory of [home, workspace, opencode]) fs.mkdirSync(directory, { recursive: true });
  for (const [key, value] of Object.entries({
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local/share"),
    OPENCODE_CONFIG_DIR: opencode, CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"), MEGAMEMORY_DB_PATH: path.join(root, "never-opened.db"),
  })) vi.stubEnv(key, value);
  originalExitCode = process.exitCode;
  process.chdir(workspace);
  boundary.installFile = "";
  boundary.execSync.mockClear();
  boundary.execFileSync.mockReset().mockImplementation(() => {
    throw Object.assign(new Error("Executable absent in isolated profile"), { code: "ENOENT" });
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.resetModules();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function install(target: string) {
  const { runInstall } = await import("../install.js");
  return runInstall(["--target", target]);
}

describe("F-04 install profile contract", () => {
  it("Codex distinguishes a single quoted dotted key from the managed nested target", async () => {
    const configPath = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const prior = '["mcp_servers.megamemory"]\ncommand = "unrelated"\nargs = ["keep"]\n';
    fs.writeFileSync(configPath, prior, "utf8");
    expect((await install("codex")).ok).toBe(true);
    const updated = fs.readFileSync(configPath, "utf8");
    expect(updated.startsWith(prior)).toBe(true);
    expect(updated).toContain('[mcp_servers.megamemory]\ncommand = "node"');
  });

  it("Codex updates a quoted target table and retains multiline custom data containing header-like text", async () => {
    const configPath = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const custom = 'custom = """\n[mcp_servers.megamemory]\ncommand = "not a field"\n"""\nenv = { DB_PATH = "keep.db", SEARCH = "fts" }\n';
    fs.writeFileSync(configPath, '[mcp_servers."megamemory"]\n"command" = "old"\n\'args\' = ["old"]\n' + custom, "utf8");
    expect((await install("codex")).ok).toBe(true);
    const updated = fs.readFileSync(configPath, "utf8");
    expect(updated).toContain(custom);
    expect(updated).not.toContain('= "old"');
    expect(updated).not.toContain('["old"]');
    expect(updated.match(/^command = "node"$/gm)).toHaveLength(1);
    expect((await install("codex")).ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(updated);
  });

  it.each([
    ["opencode", "mcp"], ["claudecode", "mcpServers"], ["antigravity", "mcpServers"],
  ])("%s rejects an unsupported existing server shape without writing or refreshing instructions", async (target, key) => {
    const configPath = target === "opencode" ? path.join(opencode, "opencode.json")
      : target === "claudecode" ? path.join(home, ".claude.json") : path.join(workspace, "mcp_config.json");
    const prior = JSON.stringify({ [key]: { megamemory: ["not-an-object"], other: { command: "working" } } });
    fs.writeFileSync(configPath, prior, "utf8");
    expect((await install(target)).ok).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(prior);
    expect(fs.existsSync(path.join(opencode, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude/CLAUDE.md"))).toBe(false);
  });

  it.each([
    ["opencode", "mcp"], ["claudecode", "mcpServers"], ["antigravity", "mcpServers"],
  ])("%s refreshes managed runtime fields but preserves user options and env", async (target, key) => {
    const configPath = target === "opencode" ? path.join(opencode, "opencode.json")
      : target === "claudecode" ? path.join(home, ".claude.json") : path.join(workspace, "mcp_config.json");
    const env = { MEGAMEMORY_DB_PATH: "C:/данные & архив/custom.db", MEGAMEMORY_SEARCH: "fts", DB_PATH: "chosen.db", SEARCH: "custom" };
    const options = { env, enabled: false, timeout: 45000, custom: { keep: "пользователь" }, disabledTools: ["remove_concept"] };
    fs.writeFileSync(configPath, JSON.stringify({ theme: "keep", [key]: {
      megamemory: { ...options, command: "old", args: ["old"], type: "old" },
      other: { command: "other", env: { KEEP: "1" } },
    } }), "utf8");

    expect((await install(target)).ok).toBe(true);
    const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(updated[key].megamemory).toMatchObject(options);
    expect(updated[key].other).toEqual({ command: "other", env: { KEEP: "1" } });
    expect(updated.theme).toBe("keep");
    if (target === "opencode") {
      expect(updated[key].megamemory.command).toEqual(["node", path.join(project, "dist/index.js")]);
      expect(updated[key].megamemory.type).toBe("local");
      expect(updated[key].megamemory).not.toHaveProperty("args");
    } else {
      expect(updated[key].megamemory.command).toBe("node");
      expect(updated[key].megamemory.args).toEqual([path.join(project, "dist/index.js")]);
    }
    const first = fs.readFileSync(configPath, "utf8");
    expect((await install(target)).ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(first);
  });

  it("Codex decodes escaped runtime keys without publishing duplicate TOML assignments", async () => {
    const configPath = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const escapedCommand = String.raw`"\u0063ommand"`;
    fs.writeFileSync(configPath, `[mcp_servers.megamemory]\n${escapedCommand} = "old"\nargs = ["--old"]\ncustom = "keep"\n`, "utf8");
    expect((await install("codex")).ok).toBe(true);
    const updated = fs.readFileSync(configPath, "utf8");
    expect(updated).not.toContain(escapedCommand);
    expect(updated.match(/^command = /gm)).toHaveLength(1);
    expect(updated).toContain('custom = "keep"');
  });

  it("Codex preserves environment, supported options and child tables when refreshing only runtime fields", async () => {
    const configPath = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const options = '# comment = [not TOML data\nenabled = false\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\ncustom = "keep"\n';
    const child = '[mcp_servers.megamemory.env]\nMEGAMEMORY_DB_PATH = "C:/данные/custom.db"\nMEGAMEMORY_SEARCH = "fts"\nDB_PATH = "chosen.db"\nSEARCH = "custom"\n';
    const sibling = '[mcp_servers.megamemory-dev]\ncommand = "dev"\nargs = ["keep"]\n';
    fs.writeFileSync(configPath, 'model = "keep"\n\n[mcp_servers.megamemory]\ncommand = "old"\nargs = [\n  "old",\n  "--old",\n]\n' + options + '\n' + child + '\n' + sibling, "utf8");

    expect((await install("codex")).ok).toBe(true);
    const updated = fs.readFileSync(configPath, "utf8");
    expect(updated).toContain(options);
    expect(updated).toContain(child);
    expect(updated).toContain(sibling);
    expect(updated).toContain('command = "node"');
    expect(updated).not.toContain('"--old"');
    expect(updated.match(/^args = /gm)).toHaveLength(2);
    expect((await install("codex")).ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(updated);
  });
});

async function localPackage() {
  const packageRoot = path.join(root, "local package данные & % ! ^ (copy)");
  const entry = path.join(packageRoot, "dist/index.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "// Not executed: only a configured server path.\n", "utf8");
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "2.4.0" }), "utf8");
  boundary.installFile = path.join(packageRoot, "src/install.ts");
  return entry;
}

async function mockCodex(fail = false, shim = false) {
  const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const bin = path.join(root, "bin команды & % ! ^");
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, "node_modules/@openai/codex/bin/codex.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const record = path.join(root, "actual-argv.json");
  fs.writeFileSync(script, `
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ executable: process.execPath, argv: process.argv.slice(2), home: process.env.CODEX_HOME }));
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "partial CLI write\\n");
process.exit(${fail ? 1 : 0});
`, "utf8");
  const executable = shim ? path.join(bin, "codex.cmd") : script;
  if (shim) fs.writeFileSync(executable, '@ECHO off\r\nSET dp0=%~dp0\r\n"node" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n', "utf8");
  boundary.execFileSync.mockImplementation((file: string, args: string[], options: Record<string, unknown>) => {
    if (args?.length === 1 && ["codex", "megamemory"].includes(args[0])) {
      if (args[0] === "codex") return executable + "\n";
      throw Object.assign(new Error("megamemory absent"), { code: "ENOENT" });
    }
    if (file !== process.execPath) throw new Error("Unexpected executable outside owned fixture: " + file);
    expect(options.shell).toBe(false);
    expect(options.timeout).toBeLessThanOrEqual(10000);
    return execFileSync(file, args, options);
  });
  return { record, executable };
}

describe("F-05 structured install process and failure contract", () => {
  it("Codex absent CLI creates a valid config with the local-package path as one escaped argument", async () => {
    const entry = await localPackage();
    expect((await install("codex")).ok).toBe(true);
    const content = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    const args = /^args = (.+)$/m.exec(content);
    expect(JSON.parse(args![1])).toEqual([entry]);
    expect(boundary.execSync).not.toHaveBeenCalled();
  });

  it.each([false, true])("Codex atomic publication failure preserves prior config (target present=%s)", async (present) => {
    await mockCodex(true, true);
    const configPath = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const prior = 'model = "keep"\n' + (present ? '[mcp_servers.megamemory]\ncommand = "working"\nargs = ["--old"]\nenv = { DB_PATH = "keep.db", SEARCH = "fts" }\n' : '[mcp_servers.other]\ncommand = "working"\n');
    fs.writeFileSync(configPath, prior, "utf8");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === configPath) throw Object.assign(new Error("Simulated publication denial"), { code: "EACCES" });
      return rename(from, to);
    });

    const result = await install("codex");
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([expect.objectContaining({ target: "codex", name: "MCP server config" })]);
    expect(result.skipped).toHaveLength(1);
    expect(fs.readFileSync(configPath, "utf8")).toBe(prior);
    expect(fs.readdirSync(path.dirname(configPath))).toEqual(["config.toml"]);
    expect(fs.existsSync(path.join(home, ".codex/AGENTS.md"))).toBe(false);
    expect(boundary.execSync).not.toHaveBeenCalled();
  });

  it("unsupported Windows shim falls back without executing a shell", async () => {
    const executable = path.join(root, "unsupported codex.cmd");
    fs.writeFileSync(executable, '@echo off\r\necho Not an npm shim\r\n', "utf8");
    boundary.execFileSync.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "codex") return executable + "\n";
      throw Object.assign(new Error("Absent"), { code: "ENOENT" });
    });
    expect((await install("codex")).ok).toBe(true);
    expect(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8")).toContain('command = "node"');
    expect(boundary.execSync).not.toHaveBeenCalled();
  });

  it("existing Codex target with a present CLI keeps env and never removes the working runtime", async () => {
    const { record } = await mockCodex();
    const configPath = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const options = 'env = { MEGAMEMORY_DB_PATH = "keep.db", MEGAMEMORY_SEARCH = "fts" }\n';
    fs.writeFileSync(configPath, '[mcp_servers.megamemory]\ncommand = "old"\nargs = ["--old"]\n' + options, "utf8");
    expect((await install("codex")).ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toContain(options);
    expect(fs.existsSync(record)).toBe(false);
    expect(boundary.execSync).not.toHaveBeenCalled();
  });

  it.each([false, true])("Codex CLI receives literal argv for a local package (Windows npm shim=%s)", async (shim) => {
    const entry = await localPackage();
    const { record } = await mockCodex(false, shim);
    const configPath = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const prior = 'model = "keep"\n[mcp_servers.other]\ncommand = "other"\n';
    fs.writeFileSync(configPath, prior, "utf8");

    expect((await install("codex")).ok).toBe(true);
    const actual = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(actual.executable).toBe(process.execPath);
    expect(actual.argv).toEqual(["mcp", "add", "megamemory", "--", "node", entry]);
    expect(actual.home).not.toBe(path.dirname(configPath));
    expect(fs.existsSync(actual.home)).toBe(false);
    const updated = fs.readFileSync(configPath, "utf8");
    expect(updated.startsWith(prior)).toBe(true);
    expect(updated).toContain(`args = ${JSON.stringify([entry])}`);
    expect(updated).not.toContain("partial CLI write");
    expect(boundary.execSync).not.toHaveBeenCalled();
  });

  it("failed Codex add cannot mutate the prior profile and atomically falls back", async () => {
    const entry = await localPackage();
    const { record } = await mockCodex(true);
    const configPath = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const prior = 'model = "keep"\n[mcp_servers.other]\ncommand = "working"\n';
    fs.writeFileSync(configPath, prior, "utf8");

    expect((await install("codex")).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(record, "utf8")).argv).toEqual(["mcp", "add", "megamemory", "--", "node", entry]);
    const updated = fs.readFileSync(configPath, "utf8");
    expect(updated.startsWith(prior)).toBe(true);
    expect(updated).not.toContain("partial CLI write");
    expect(updated).toContain(`args = ${JSON.stringify([entry])}`);
    expect(boundary.execSync).not.toHaveBeenCalled();
  });
});
