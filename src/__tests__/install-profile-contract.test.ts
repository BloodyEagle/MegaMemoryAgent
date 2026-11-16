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

describe("R02 atomic managed install publication", () => {
  function destinations() {
    const json = '{"theme":"пользователь","mcp":{"other":{"command":"keep"}},"mcpServers":{"other":{"command":"keep"}}}\r\n';
    const instructions = '# User rules\r\n\r\n<!-- megamemory:instructions v0.0.1 -->\n## Project Knowledge Graph\nold workflow\n<!-- /megamemory-snippet -->\n\n## User tail\nСохранить правила.\n';
    const managed = 'MegaMemory-managed file. Safe for megamemory install to update.\nold managed content\n';
    return [
      { target: "opencode", name: "MCP server config", file: path.join(opencode, "opencode.json"), prior: json },
      { target: "claudecode", name: "MCP server config", file: path.join(home, ".claude.json"), prior: json },
      { target: "antigravity", name: "MCP server config", file: path.join(workspace, "mcp_config.json"), prior: json },
      { target: "codex", name: "MCP server config", file: path.join(home, ".codex/config.toml"), prior: 'model = "keep"\n[mcp_servers.megamemory]\ncommand = "old"\nargs = ["old"]\nenv = { DB_PATH = "пользователь.db" }\n' },
      { target: "opencode", name: "Global AGENTS.md", file: path.join(opencode, "AGENTS.md"), prior: instructions },
      { target: "claudecode", name: "Global CLAUDE.md", file: path.join(home, ".claude/CLAUDE.md"), prior: instructions },
      { target: "codex", name: "Global AGENTS.md", file: path.join(home, ".codex/AGENTS.md"), prior: instructions },
      { target: "opencode", name: "Skill tool plugin", file: path.join(opencode, "tool/megamemory.ts"), prior: "// " + managed },
      { target: "opencode", name: "Bootstrap command", file: path.join(opencode, "commands/bootstrap-memory.md"), prior: "<!-- " + managed },
      { target: "opencode", name: "Save memory command", file: path.join(opencode, "commands/save-memory.md"), prior: "<!-- " + managed },
      { target: "claudecode", name: "Bootstrap command", file: path.join(home, ".claude/commands/bootstrap-memory.md"), prior: "<!-- " + managed },
      { target: "claudecode", name: "Save memory command", file: path.join(home, ".claude/commands/save-memory.md"), prior: "<!-- " + managed },
    ];
  }

  it.each(Array.from({ length: 12 }, (_, i) => [i]))("rename failure preserves original bytes and reports failed managed destination #%s", async (index) => {
    const item = destinations()[index];
    fs.mkdirSync(path.dirname(item.file), { recursive: true });
    const before = Buffer.from(item.prior, "utf8");
    fs.writeFileSync(item.file, before);
    const rename = fs.renameSync;
    let attempted = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === item.file) {
        attempted = true;
        expect(path.dirname(String(from))).toBe(path.dirname(item.file));
        expect(fs.readFileSync(item.file)).toEqual(before);
        throw Object.assign(new Error("R02 mocked publish failure"), { code: "EACCES" });
      }
      return rename(from, to);
    });

    const result = await install(item.target);
    expect(attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([expect.objectContaining({ target: item.target, name: item.name, error: expect.stringContaining("R02 mocked publish failure") })]);
    expect(fs.readFileSync(item.file)).toEqual(before);
    expect(fs.readdirSync(path.dirname(item.file)).filter((name) => name.includes(".megamemory-tmp-"))).toEqual([]);
  });

  it.each(["append", "legacy"])("instruction %s publication failure preserves surrounding user text", async (mode) => {
    const file = path.join(opencode, "AGENTS.md");
    const before = Buffer.from(mode === "append" ? "# User rules\r\nТолько пользовательские правила.\r\n" : "# User rules\n## Project Knowledge Graph\nold\n## User tail\nСохранить.\n", "utf8");
    fs.writeFileSync(file, before);
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === file) throw new Error("instruction publish failed");
      return rename(from, to);
    });
    expect((await install("opencode")).ok).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(opencode).filter((name) => name.includes(".megamemory-tmp-"))).toEqual([]);
  });

  it("fresh all-target installation fsyncs and closes each sibling temp before publishing", async () => {
    const files = destinations().map((item) => item.file);
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const close = fs.closeSync;
    const rename = fs.renameSync;
    const handles = new Map<number, string>();
    const synced = new Set<string>();
    const closed = new Set<string>();
    const published: string[] = [];
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      if (String(file).includes(".megamemory-tmp-")) {
        expect(flags).toBe("wx");
        handles.set(fd, String(file));
      }
      return fd;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      sync(fd);
      const file = handles.get(fd);
      if (file) synced.add(file);
    });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      const file = handles.get(fd);
      if (file) {
        expect(synced.has(file)).toBe(true);
        closed.add(file);
        handles.delete(fd);
      }
      close(fd);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const temp = String(from);
      const target = String(to);
      expect(path.dirname(temp)).toBe(path.dirname(target));
      expect(synced.has(temp)).toBe(true);
      expect(closed.has(temp)).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
      published.push(target);
      rename(from, to);
    });
    const { runInstall } = await import("../install.js");
    const result = await runInstall(["--target", "opencode", "--target", "claudecode", "--target", "antigravity", "--target", "codex"]);
    expect(result.ok).toBe(true);
    expect(published.sort()).toEqual(files.sort());
    expect(handles.size).toBe(0);
    for (const file of files) expect(fs.existsSync(file)).toBe(true);
  });

  it("failed fsync never publishes or truncates existing user config", async () => {
    const file = path.join(opencode, "opencode.json");
    const before = Buffer.from('{"theme":"keep","mcp":{}}\r\n', "utf8");
    fs.writeFileSync(file, before);
    const rename = vi.spyOn(fs, "renameSync");
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("R02 fsync failed"); });
    const result = await install("opencode");
    expect(result.ok).toBe(false);
    expect(result.failed[0].error).toContain("R02 fsync failed");
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(opencode)).toEqual(["opencode.json"]);
  });
});

describe("R02 symlink and permission publication", () => {
  it.for([
    ["opencode", "config", false], ["opencode", "config", true],
    ["codex", "config", false], ["codex", "config", true],
    ["opencode", "instructions", false], ["opencode", "instructions", true],
  ] as const)("%s %s follows file symlink and preserves it (publish failure=%s)", async ([target, kind, fail], context) => {
    const file = kind === "instructions" ? path.join(opencode, "AGENTS.md") : target === "codex" ? path.join(home, ".codex/config.toml") : path.join(opencode, "opencode.json");
    const actual = path.join(root, "shared settings", kind === "instructions" ? "rules.md" : "settings");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(actual), { recursive: true });
    const prior = Buffer.from(kind === "instructions" ? "# User rules\nСохранить мои правила.\n" : target === "codex" ? 'model = "keep"\n[mcp_servers.megamemory]\ncommand = "old"\nargs = ["old"]\nenv = { DB_PATH = "keep.db" }\n' : '{"theme":"keep","mcp":{"other":{"command":"keep"}}}\n', "utf8");
    fs.writeFileSync(actual, prior);
    const relative = path.relative(path.dirname(file), actual);
    try { fs.symlinkSync(relative, file, "file"); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) {
        console.warn(`R02 real file symlink skipped: Windows file-symlink privilege unavailable (${code})`);
        context.skip();
        return;
      }
      throw err;
    }
    const rename = fs.renameSync;
    let published = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === actual) {
        published = true;
        expect(path.dirname(String(from))).toBe(path.dirname(actual));
        expect(fs.readFileSync(actual)).toEqual(prior);
        if (fail) throw new Error("symlink target publish denied");
      }
      return rename(from, to);
    });
    const result = await install(target);
    expect(published).toBe(true);
    expect(result.ok).toBe(!fail);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(file)).toBe(relative);
    expect(fs.readFileSync(file)).toEqual(fs.readFileSync(actual));
    if (fail) expect(fs.readFileSync(actual)).toEqual(prior);
    else {
      expect(fs.readFileSync(actual)).not.toEqual(prior);
      expect(fs.readFileSync(actual, "utf8")).toContain(kind === "instructions" ? "Сохранить мои правила." : target === "codex" ? 'DB_PATH = "keep.db"' : '"theme": "keep"');
    }
    expect(fs.readdirSync(path.dirname(actual))).toEqual([path.basename(actual)]);
  });

  it.each([false, true])("resolved-path boundary publishes beside target, not configured alias (failure=%s)", async (fail) => {
    const file = path.join(opencode, "opencode.json");
    const actual = path.join(root, "shared settings", "actual.json");
    const prior = Buffer.from('{"theme":"keep","mcp":{}}\n', "utf8");
    fs.mkdirSync(path.dirname(actual), { recursive: true });
    fs.writeFileSync(file, prior);
    fs.writeFileSync(actual, prior);
    // Portable consumer seam for Windows without file-symlink privileges.
    // Actual symlink semantics are covered separately and explicitly skipped.
    const realpath = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementation((value, options) => String(value) === file ? actual : realpath(value, options));
    const rename = fs.renameSync;
    let published = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === actual) {
        published = true;
        expect(path.dirname(String(from))).toBe(path.dirname(actual));
        if (fail) throw new Error("resolved target publish denied");
      }
      return rename(from, to);
    });
    const result = await install("opencode");
    expect(published).toBe(true);
    expect(result.ok).toBe(!fail);
    expect(fs.readFileSync(file)).toEqual(prior);
    if (fail) expect(fs.readFileSync(actual)).toEqual(prior);
    else expect(JSON.parse(fs.readFileSync(actual, "utf8")).mcp.megamemory).toBeDefined();
    expect(fs.readdirSync(path.dirname(actual))).toEqual(["actual.json"]);
  });

  it("restores existing mode through fchmod before fsync and publication", async () => {
    const file = path.join(opencode, "opencode.json");
    fs.writeFileSync(file, '{"theme":"keep","mcp":{}}\n', "utf8");
    const mode = fs.statSync(file).mode & 0o7777;
    const chmod = fs.fchmodSync;
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    let restored = false;
    vi.spyOn(fs, "fchmodSync").mockImplementation((fd, value) => {
      expect(value).toBe(mode);
      chmod(fd, value);
      restored = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      expect(restored).toBe(true);
      sync(fd);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === file) expect(restored).toBe(true);
      rename(from, to);
    });
    expect((await install("opencode")).ok).toBe(true);
    expect(restored).toBe(true);
  });

  it.skipIf(process.platform === "win32")("retains POSIX mode 0660 despite umask 0022", async () => {
    const file = path.join(opencode, "opencode.json");
    fs.writeFileSync(file, '{"theme":"keep","mcp":{}}\n', "utf8");
    fs.chmodSync(file, 0o660);
    const previous = process.umask(0o022);
    try {
      expect((await install("opencode")).ok).toBe(true);
      expect(fs.statSync(file).mode & 0o7777).toBe(0o660);
    } finally { process.umask(previous); }
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
