import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, execSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => { throw Object.assign(new Error("isolated executable lookup"), { code: "ENOENT" }); }),
  execSyncMock: vi.fn(() => { throw new Error("shell execution forbidden"); }),
}));
vi.mock("child_process", () => ({ execFileSync: execFileSyncMock, execSync: execSyncMock }));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expectedEntry = path.join(projectRoot, "dist/index.js");
const allowedTools = ["understand", "list_roots", "get_concept", "create_concept", "update_concept", "link", "check_freshness", "provenance_trace"];
const realHomes = [...new Set([os.homedir(), process.env.HOME, process.env.USERPROFILE].filter((value): value is string => Boolean(value)))];
const realConfigPaths = realHomes.flatMap((home) => [
  ".config/kilo", ".kilocode/mcp_settings.json", ".kilocode/cli", ".kilocode/settings", ".kilocode/rules",
  ".claude.json", ".claude/CLAUDE.md", ".claude/commands", ".codex/config.toml", ".codex/AGENTS.md",
  ".config/opencode/opencode.json", ".config/opencode/AGENTS.md", ".config/opencode/tool", ".config/opencode/commands", ".agents/AGENTS.md", ".agents/skills/megamemory",
].map((relative) => path.join(home, relative)));
for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value))) {
  for (const relative of ["kilo", "kilocode", "Code/User/globalStorage/kilocode.kilo-code"]) realConfigPaths.push(path.join(base, relative));
}
for (const directory of [process.env.OPENCODE_CONFIG_DIR, process.env.CODEX_HOME].filter((value): value is string => Boolean(value))) realConfigPaths.push(directory);
function treeSnapshot(roots: string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (file: string): void => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries[file] = "missing";
      return;
    }
    if (stat.isSymbolicLink()) { entries[file] = `link:${fs.readlinkSync(file)}`; return; }
    if (stat.isDirectory()) {
      entries[file] = "directory";
      for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
    } else entries[file] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  };
  for (const root of [...new Set(roots)].sort()) visit(root);
  return entries;
}
interface LegacyConfig {
  mcpServers: Record<string, Record<string, unknown>>;
  userSetting?: unknown;
  mcp?: unknown;
  permission?: unknown;
  instructions?: unknown;
}
let root: string;
let home: string;
let workspace: string;
let previousCwd: string;
let previousExitCode: typeof process.exitCode;
let realBefore: Record<string, string>;
let output: string[];
beforeEach(() => {
  previousCwd = process.cwd();
  previousExitCode = process.exitCode;
  realBefore = treeSnapshot(realConfigPaths);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-kilo-legacy-test-"));
  home = path.join(root, "home");
  workspace = path.join(root, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  for (const [key, value] of Object.entries({
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state"),
    OPENCODE_CONFIG_DIR: path.join(home, ".config/opencode"), CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    KILO_CONFIG_DIR: path.join(home, ".config/kilo"), KILOCODE_HOME: path.join(home, ".kilocode"), MEGAMEMORY_DB_PATH: path.join(root, "never-opened.db"),
  })) vi.stubEnv(key, value);
  process.chdir(workspace);
  process.exitCode = 0;
  output = [];
  execFileSyncMock.mockClear();
  execSyncMock.mockClear();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
  vi.resetModules();
});
afterEach(() => {
  try {
    expect(execSyncMock).not.toHaveBeenCalled();
    for (const call of execFileSyncMock.mock.calls as unknown as Array<[string, string[], { shell: boolean }]>) {
      expect(path.basename(call[0]).toLowerCase()).toMatch(/^(where\.exe|which)$/);
      expect(call[1]).toEqual(["megamemory"]);
      expect(call[2].shell).toBe(false);
    }
    expect(treeSnapshot(realConfigPaths), "real HOME/APPDATA config trees must remain unchanged").toEqual(realBefore);
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function writeFixture(file: string, content: string): void {
  expect(path.relative(root, file).startsWith("..")).toBe(false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
async function install(...flags: string[]): Promise<import("../install.js").InstallOutcome> {
  const { runInstall } = await import("../install.js");
  return runInstall(["--target", "kilo", ...flags]);
}
function readConfig(file: string): LegacyConfig {
  return JSON.parse(fs.readFileSync(file, "utf8")) as LegacyConfig;
}
function assertLegacy(file: string): void {
  const config = readConfig(file);
  expect(config.mcpServers.megamemory.command).toBe("node");
  expect(config.mcpServers.megamemory.args).toEqual([expectedEntry]);
  expect(config.mcpServers.megamemory.alwaysAllow).toEqual(allowedTools);
  for (const name of ["remove_concept", "resolve_conflict", "merge", "slot_release", "expire"]) expect(config.mcpServers.megamemory.alwaysAllow).not.toContain(name);
  expect(fs.readFileSync(file, "utf8")).not.toContain("megamemory_*");
  expect(config).not.toHaveProperty("mcp");
  expect(config).not.toHaveProperty("permission");
  expect(config).not.toHaveProperty("instructions");
  for (const newFile of [path.join(workspace, "kilo.jsonc"), path.join(workspace, ".kilo/kilo.jsonc"), path.join(home, ".config/kilo/kilo.jsonc")]) expect(fs.existsSync(newFile)).toBe(false);
  expect(fs.existsSync(path.join(workspace, ".kilocode/rules/megamemory.md"))).toBe(true);
  expect(fs.existsSync(path.join(workspace, ".kilo/rules/megamemory.md"))).toBe(false);
}

describe("Plan E T1 Kilo legacy config", () => {
  it("writes only the project legacy file, preserves user options, and is byte-idempotent", async () => {
    const file = path.join(workspace, ".kilocode/mcp.json");
    const other = { command: "user-server", args: ["--custom"] };
    const options = { disabled: true, timeout: 4000, env: { USER_KEY: "fixture" }, custom: { keep: true } };
    const original = `${JSON.stringify({ userSetting: { untouched: true }, mcpServers: { other, megamemory: { ...options, command: "old", args: ["old"], alwaysAllow: ["understand"] } } }, null, 2)}\n`;
    writeFixture(file, original);
    expect((await install()).ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalled();
    assertLegacy(file);
    const config = readConfig(file);
    expect(config.userSetting).toEqual({ untouched: true });
    expect(config.mcpServers.other).toEqual(other);
    expect(config.mcpServers.megamemory).toEqual({ ...options, command: "node", args: [expectedEntry], alwaysAllow: allowedTools });
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("mcp.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), backups[0]))).toEqual(Buffer.from(original));
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it("prefers project legacy over every global legacy config and reports skipped paths", async () => {
    const selected = path.join(workspace, ".kilocode/mcp.json");
    const ignored = [path.join(home, ".kilocode/mcp_settings.json"), path.join(home, ".kilocode/cli/global/settings/mcp_settings.json")];
    for (const file of [selected, ...ignored]) writeFixture(file, "{}\n");
    const before = treeSnapshot(ignored);
    expect((await install()).ok).toBe(true);
    assertLegacy(selected);
    expect(treeSnapshot(ignored)).toEqual(before);
    for (const file of ignored) expect(output.join("\n")).toContain(file);
    expect(output.join("\n")).toMatch(/Skipped.*first config wins/);
  });

  it("finds the last legacy cli/global/settings location at depth three", async () => {
    const file = path.join(home, ".kilocode/cli/global/settings/mcp_settings.json");
    writeFixture(file, '{"mcpServers":{"other":{"command":"untouched"}}}\n');
    expect((await install()).ok).toBe(true);
    assertLegacy(file);
    expect(readConfig(file).mcpServers.other).toEqual({ command: "untouched" });
    expect(output.join("\n")).toContain(file);
    expect(fs.existsSync(path.join(workspace, ".kilocode/mcp.json"))).toBe(false);
  });

  it("uses the first deterministic global legacy match and ignores files beyond depth three", async () => {
    const selected = path.join(home, ".kilocode/a/mcp_settings.json");
    const later = path.join(home, ".kilocode/z/mcp_settings.json");
    const tooDeep = path.join(home, ".kilocode/0/one/two/three/mcp_settings.json");
    for (const file of [selected, later, tooDeep]) writeFixture(file, "{}\n");
    const before = treeSnapshot([later, tooDeep]);
    expect((await install()).ok).toBe(true);
    assertLegacy(selected);
    expect(treeSnapshot([later, tooDeep])).toEqual(before);
    expect(output.join("\n")).toContain(later);
    expect(output.join("\n")).not.toContain(tooDeep);
  });

  it("does not discover a legacy settings file deeper than the declared search boundary", async () => {
    const file = path.join(home, ".kilocode/cli/global/settings/deeper/mcp_settings.json");
    writeFixture(file, "{}\n");
    const before = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(before);
    expect(output.join("\n")).toMatch(/config not found/i);
    expect(fs.existsSync(path.join(workspace, ".agents"))).toBe(false);
  });

  it("reports an unreadable lower-priority legacy directory without blocking the project config", async () => {
    const selected = path.join(workspace, ".kilocode/mcp.json");
    const unreadable = path.join(home, ".kilocode");
    writeFixture(selected, "{}\n");
    fs.mkdirSync(unreadable, { recursive: true });
    const readDirectory = fs.readdirSync;
    const readdirSpy = vi.spyOn(fs, "readdirSync");
    readdirSpy.mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === unreadable) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
      return Reflect.apply(readDirectory, fs, args);
    }) as typeof fs.readdirSync);
    try {
      expect((await install()).ok).toBe(true);
      assertLegacy(selected);
      expect(output.join("\n")).toContain(unreadable);
      expect(output.join("\n")).toMatch(/Cannot inspect legacy config directory.*continuing config discovery/);
    } finally { readdirSpy.mockRestore(); }
  });

  it("dry-run leaves all legacy, rules and agents files and backup trees unchanged", async () => {
    const file = path.join(workspace, ".kilocode/mcp.json");
    writeFixture(file, "{}\n");
    writeFixture(path.join(workspace, ".kilocode/rules/megamemory.md"), "# User rules\n");
    const before = treeSnapshot([root]);
    expect((await install("--dry-run")).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(before);
    expect(output.join("\n")).toMatch(/Dry-run:.*bytes/);
    expect(fs.existsSync(path.join(workspace, ".agents"))).toBe(false);
  });
});
