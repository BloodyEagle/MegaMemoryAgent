import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, execSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => { throw Object.assign(new Error("isolated executable lookup"), { code: "ENOENT" }); }),
  execSyncMock: vi.fn(() => { throw new Error("shell execution forbidden"); }),
}));
vi.mock("child_process", () => ({ execFileSync: execFileSyncMock, execSync: execSyncMock }));

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expectedEntry = path.join(projectRoot, "dist", "index.js");
const allowedTools = ["understand", "list_roots", "get_concept", "create_concept", "update_concept", "link", "check_freshness", "provenance_trace"];
const destructiveTools = ["remove_concept", "resolve_conflict", "merge", "slot_release", "expire"];
const ruleRef = ".kilo/rules/megamemory.md";
const realHomes = [...new Set([os.homedir(), process.env.HOME, process.env.USERPROFILE].filter((value): value is string => Boolean(value)))];
const realConfigPaths = realHomes.flatMap((home) => [
  ".config/kilo", ".kilocode/mcp_settings.json", ".kilocode/cli", ".kilocode/settings", ".kilocode/rules",
  ".claude.json", ".claude/CLAUDE.md", ".claude/commands", ".codex/config.toml", ".codex/AGENTS.md",
  ".config/opencode/opencode.json", ".config/opencode/AGENTS.md", ".config/opencode/tool", ".config/opencode/commands", ".agents/AGENTS.md", ".agents/skills/megamemory",
].map((relative) => path.join(home, relative)));
for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value))) {
  for (const relative of ["kilo", "kilocode", "Code/User/globalStorage/kilocode.kilo-code", "Code/User/globalStorage/kilocode.kilo-code/settings"]) realConfigPaths.push(path.join(base, relative));
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

interface NewConfig {
  mcp: Record<string, Record<string, unknown>>;
  permission: Record<string, string>;
  instructions: string[];
  theme?: string;
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-kilo-test-"));
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
function readConfig(file: string): NewConfig {
  const errors: ParseError[] = [];
  const config = parse(fs.readFileSync(file, "utf8"), errors, { allowTrailingComma: true }) as NewConfig;
  expect(errors).toEqual([]);
  return config;
}
function assertPermissions(config: NewConfig, text: string): void {
  expect(Object.keys(config.permission).filter((key) => key.startsWith("megamemory_")).sort()).toEqual(allowedTools.map((tool) => `megamemory_${tool}`).sort());
  for (const tool of allowedTools) expect(config.permission[`megamemory_${tool}`]).toBe("allow");
  for (const tool of destructiveTools) expect(config.permission).not.toHaveProperty(`megamemory_${tool}`);
  expect(text).not.toContain("megamemory_*");
}

describe("Plan E T1 Kilo new config", () => {
  it.each(["root", ".kilo", "global"])("updates only the first existing %s config and reports skipped alternatives", async (winner) => {
    const candidates = [path.join(workspace, "kilo.jsonc"), path.join(workspace, ".kilo/kilo.jsonc"), path.join(home, ".config/kilo/kilo.jsonc"), path.join(workspace, ".kilocode/mcp.json"), path.join(home, ".kilocode/cli/global/settings/mcp_settings.json")];
    const index = ["root", ".kilo", "global"].indexOf(winner);
    for (const [candidateIndex, file] of candidates.entries()) if (candidateIndex >= index) writeFixture(file, "{}\n");
    const untouched = candidates.slice(index + 1).map((file) => [file, fs.readFileSync(file)] as const);
    expect((await install()).ok).toBe(true);
    const selected = candidates[index];
    const config = readConfig(selected);
    expect(config.mcp.megamemory).toEqual({ type: "local", command: ["node", expectedEntry], enabled: true });
    expect(execFileSyncMock).toHaveBeenCalled();
    assertPermissions(config, fs.readFileSync(selected, "utf8"));
    const expectedRule = winner === "global" ? path.resolve(home, ".config/kilo/rules/megamemory.md") : ruleRef;
    expect(config.instructions).toEqual([expectedRule]);
    if (winner === "global") {
      expect(path.isAbsolute(config.instructions[0])).toBe(true);
      expect(fs.existsSync(config.instructions[0])).toBe(true);
      expect(fs.existsSync(path.join(workspace, ".kilo/rules/megamemory.md"))).toBe(false);
      const once = treeSnapshot([root]);
      expect((await install()).ok).toBe(true);
      expect(treeSnapshot([root])).toEqual(once);
      expect(readConfig(selected).instructions.filter((ref) => ref === expectedRule)).toHaveLength(1);
    }
    for (const [file, bytes] of untouched) {
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.bak-`))).toEqual([]);
      expect(output.join("\n")).toContain(file);
    }
    for (const file of candidates.slice(0, index)) expect(fs.existsSync(file)).toBe(false);
    expect(output.join("\n")).toMatch(/Skipped.*first config wins/);
    expect(fs.existsSync(winner === "global" ? expectedRule : path.join(workspace, ruleRef))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".kilocode/rules/megamemory.md"))).toBe(false);
  });

  it("preserves user fields, servers and instruction order and is byte-idempotent", async () => {
    const file = path.join(workspace, "kilo.jsonc");
    const userServer = { type: "remote", url: "https://example.test/mcp", enabled: false };
    const userOptions = { enabled: false, environment: { TOKEN: "fixture-not-secret" }, timeout: 12345, custom: { retain: true } };
    const instructions = ["first.md", ruleRef, "last.md"];
    writeFixture(file, `${JSON.stringify({ theme: "user-theme", mcp: { other: userServer, megamemory: { ...userOptions, type: "remote", command: ["old"] } }, permission: { shell: "ask", megamemory_understand: "ask" }, instructions }, null, 2)}\n`);
    expect((await install()).ok).toBe(true);
    const config = readConfig(file);
    expect(config.theme).toBe("user-theme");
    expect(config.mcp.other).toEqual(userServer);
    expect(config.mcp.megamemory).toEqual({ ...userOptions, type: "local", command: ["node", expectedEntry] });
    expect(config.permission.shell).toBe("ask");
    assertPermissions(config, fs.readFileSync(file, "utf8"));
    expect(config.instructions).toEqual(instructions);
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
    expect(readConfig(file).instructions.filter((item) => item === ruleRef)).toHaveLength(1);
  });

  it("appends the instruction once while retaining the order of unrelated entries", async () => {
    const file = path.join(workspace, "kilo.jsonc");
    writeFixture(file, '{"instructions":["z-user.md","a-user.md"]}\n');
    expect((await install()).ok).toBe(true);
    expect(readConfig(file).instructions).toEqual(["z-user.md", "a-user.md", ruleRef]);
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it("deduplicates the rule reference without moving its first occurrence", async () => {
    const file = path.join(workspace, "kilo.jsonc");
    writeFixture(file, `${JSON.stringify({ instructions: ["first.md", ruleRef, "middle.md", ruleRef, "last.md"] })}\n`);
    expect((await install()).ok).toBe(true);
    expect(readConfig(file).instructions).toEqual(["first.md", ruleRef, "middle.md", "last.md"]);
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it("updates only a versioned rules block and retains user text before and after it", async () => {
    writeFixture(path.join(workspace, "kilo.jsonc"), "{}\n");
    const file = path.join(workspace, ".kilo/rules/megamemory.md");
    const prefix = "# User rules\nKeep this before.\n\n";
    const suffix = "\n\nKeep this after.\n";
    writeFixture(file, `${prefix}<!-- megamemory-snippet v0.0.1 -->\nobsolete body\n<!-- /megamemory-snippet -->${suffix}`);
    expect((await install()).ok).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.endsWith(suffix)).toBe(true);
    expect(text).not.toContain("obsolete body");
    expect(text.match(/<!--\s*\/?megamemory-snippet\b/g)).toHaveLength(2);
    const { buildWorkflowText } = await import("../guide.js");
    expect(text).toContain(buildWorkflowText().trim());
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it("warns before appending rules to an unmarked file without removing user content", async () => {
    writeFixture(path.join(workspace, "kilo.jsonc"), "{}\n");
    const file = path.join(workspace, ".kilo/rules/megamemory.md");
    const original = "# Existing instructions\nKeep the user's spelling.\n";
    writeFixture(file, original);
    expect((await install()).ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain(original);
    expect(output.join("\n")).toMatch(/No megamemory markers.*appending/);
  });

  it("returns success with a new-format stdout fragment and creates nothing when no config exists", async () => {
    const before = treeSnapshot([root]);
    const result = await install();
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    expect(process.exitCode).toBe(0);
    expect(treeSnapshot([root])).toEqual(before);
    expect(output.join("\n")).toMatch(/config not found.*No files created/i);
    expect(output.join("\n")).toContain("./kilo.jsonc");
    const snippet = output.find((line) => line.startsWith("{\n"));
    expect(snippet).toBeDefined();
    const config = JSON.parse(snippet!) as NewConfig;
    expect(config.mcp.megamemory).toEqual({ type: "local", command: ["node", expectedEntry] });
    assertPermissions(config, snippet!);
    expect(config.instructions).toEqual([ruleRef]);
    expect(fs.existsSync(path.join(workspace, ".agents"))).toBe(false);
  });
});
