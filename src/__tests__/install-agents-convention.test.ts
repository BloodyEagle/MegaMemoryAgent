import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractInstructionsVersion } from "../instructions.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, execSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => { throw Object.assign(new Error("isolated executable lookup"), { code: "ENOENT" }); }),
  execSyncMock: vi.fn(() => { throw new Error("shell execution forbidden"); }),
}));
vi.mock("child_process", () => ({ execFileSync: execFileSyncMock, execSync: execSyncMock }));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageVersion = (JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version: string }).version;
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-agents-test-"));
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
function assertNativeBlock(file: string, reference: string): void {
  const text = fs.readFileSync(file, "utf8");
  expect(extractInstructionsVersion(text)).toBe(packageVersion);
  expect(text.match(/<!--\s*megamemory:instructions\b/g)).toHaveLength(1);
  expect(text.match(/<!--\s*\/?megamemory-snippet\b/g)).toHaveLength(2);
  expect(text).toContain(reference);
  const body = /<!-- megamemory-snippet v[^\r\n]+ -->\n([\s\S]*?)\n<!-- \/megamemory-snippet -->/.exec(text)?.[1];
  expect(body).toBeDefined();
  expect(body!.split("\n")).toHaveLength(3);
  expect(body).toContain("evidence");
  expect(body).toContain("next.record");
}
function assertSkill(file: string): void {
  const text = fs.readFileSync(file, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  expect(frontmatter).not.toBeNull();
  const fields = Object.fromEntries(frontmatter![1].split(/\r?\n/).map((line) => {
    const index = line.indexOf(":");
    expect(index).toBeGreaterThan(0);
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
  expect(fields.name).toBe("megamemory");
  expect(fields.description.trim().length).toBeGreaterThan(20);
  for (const word of ["understand", "create_concept", "evidence", "next.record", "parent_id"]) expect(text).toContain(word);
  expect(text).toContain("docs/agent-workflow.md");
}
function assertNoLinks(): void {
  expect(Object.values(treeSnapshot([root])).filter((value) => value.startsWith("link:"))).toEqual([]);
  for (const base of [workspace, home]) expect(fs.existsSync(path.join(base, ".agents/AGENTS.md"))).toBe(false);
}

describe("Plan E T5 native agents convention", () => {
  it("creates a frontmatter skill and root-native AGENTS block without a canonical file or links", async () => {
    writeFixture(path.join(workspace, "kilo.jsonc"), "{}\n");
    const agents = path.join(workspace, "AGENTS.md");
    const original = "# Native project instructions\nKeep the user's rules intact.\n";
    writeFixture(agents, original);
    expect((await install()).ok).toBe(true);
    assertSkill(path.join(workspace, ".agents/skills/megamemory/SKILL.md"));
    assertNativeBlock(agents, ".agents/skills/megamemory/SKILL.md");
    expect(fs.readFileSync(agents, "utf8").startsWith(original)).toBe(true);
    const beforeRepeat = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(beforeRepeat);
    assertNativeBlock(agents, ".agents/skills/megamemory/SKILL.md");
    assertNoLinks();
    expect(fs.existsSync(path.join(home, ".agents"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".config/kilo/AGENTS.md"))).toBe(false);
  });

  it.each([false, true])("preserves an unmarked user skill without a backup or rewrite; global = %s", async (global) => {
    writeFixture(path.join(workspace, "kilo.jsonc"), "{}\n");
    const skill = path.join(global ? home : workspace, ".agents/skills/megamemory/SKILL.md");
    const original = "---\nname: megamemory\ndescription: User-owned project workflow\n---\n\nKeep my custom skill byte-for-byte.\n";
    writeFixture(skill, original);
    expect((await install(...(global ? ["--global"] : []))).ok).toBe(true);
    expect(fs.readFileSync(skill)).toEqual(Buffer.from(original));
    expect(fs.readdirSync(path.dirname(skill))).toEqual(["SKILL.md"]);
    expect(output.join("\n")).toContain("not marked as MegaMemory-managed. Left it untouched.");
    const once = treeSnapshot([root]);
    expect((await install(...(global ? ["--global"] : []))).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it("updates a managed skill with an exact backup", async () => {
    writeFixture(path.join(workspace, "kilo.jsonc"), "{}\n");
    const skill = path.join(workspace, ".agents/skills/megamemory/SKILL.md");
    const original = "---\nname: megamemory\ndescription: Old managed protocol\n---\n\n<!-- MegaMemory-managed file. Safe for megamemory install to update. -->\nOld protocol.\n";
    writeFixture(skill, original);
    expect((await install()).ok).toBe(true);
    assertSkill(skill);
    expect(fs.readFileSync(skill, "utf8")).not.toContain("Old protocol.");
    const backups = fs.readdirSync(path.dirname(skill)).filter((name) => name.startsWith("SKILL.md.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(skill), backups[0]))).toEqual(Buffer.from(original));
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it.each([false, true])("global install writes HOME skill and native Kilo instructions; existing Codex = %s", async (codexExists) => {
    writeFixture(path.join(home, ".config/kilo/kilo.jsonc"), "{}\n");
    const kiloAgents = path.join(home, ".config/kilo/AGENTS.md");
    const kiloOriginal = "# Global Kilo user rules\nKeep them.\n";
    writeFixture(kiloAgents, kiloOriginal);
    const codexAgents = path.join(home, ".codex/AGENTS.md");
    const codexOriginal = "# Codex user rules\nKeep these too.\n";
    if (codexExists) writeFixture(codexAgents, codexOriginal);
    expect((await install("--global")).ok).toBe(true);
    const skill = path.join(home, ".agents/skills/megamemory/SKILL.md");
    assertSkill(skill);
    assertNativeBlock(kiloAgents, skill.replace(/\\/g, "/"));
    expect(fs.readFileSync(kiloAgents, "utf8").startsWith(kiloOriginal)).toBe(true);
    if (codexExists) {
      assertNativeBlock(codexAgents, skill.replace(/\\/g, "/"));
      expect(fs.readFileSync(codexAgents, "utf8").startsWith(codexOriginal)).toBe(true);
    } else expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".agents"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(false);
    const once = treeSnapshot([root]);
    expect((await install("--global")).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
    assertNoLinks();
  });

  it("replaces only an existing native AGENTS managed block and keeps exactly two markers", async () => {
    writeFixture(path.join(workspace, "kilo.jsonc"), "{}\n");
    const agents = path.join(workspace, "AGENTS.md");
    const prefix = "# User rules\nKeep before.\n\n";
    const suffix = "\n\nKeep after.\n";
    writeFixture(agents, `${prefix}<!-- megamemory-snippet v0.0.1 -->\nOld protocol.\n<!-- /megamemory-snippet -->${suffix}`);
    expect((await install()).ok).toBe(true);
    const updated = fs.readFileSync(agents, "utf8");
    expect(updated.startsWith(prefix)).toBe(true);
    expect(updated.endsWith(suffix)).toBe(true);
    expect(updated).not.toContain("Old protocol.");
    assertNativeBlock(agents, ".agents/skills/megamemory/SKILL.md");
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
    assertNoLinks();
  });

  it.each(["project", "global-kilo", "global-codex"])("preflights unclosed %s AGENTS blocks before any config, rules or skill writes", async (location) => {
    writeFixture(path.join(workspace, "kilo.jsonc"), "{}\n");
    const agents = location === "project" ? path.join(workspace, "AGENTS.md")
      : location === "global-kilo" ? path.join(home, ".config/kilo/AGENTS.md") : path.join(home, ".codex/AGENTS.md");
    writeFixture(agents, "# User instructions\n<!-- megamemory-snippet v0.0.1 -->\nMissing closing marker.\n");
    const before = treeSnapshot([root]);
    const result = await install(...(location === "project" ? [] : ["--global"]));
    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain(agents);
    expect(result.failed[0].error).toMatch(/Unclosed megamemory block/);
    expect(treeSnapshot([root])).toEqual(before);
    expect(process.exitCode).toBe(1);
    assertNoLinks();
  });

  it.each([false, true])("Windows --link prints exact ln -s commands without invoking them or failing; global = %s", async (global) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    writeFixture(path.join(workspace, "kilo.jsonc"), "{}\n");
    const flags = global ? ["--global", "--link"] : ["--link"];
    const result = await install(...flags);
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    const base = global ? home : workspace;
    const agents = global ? path.join(home, ".config/kilo/AGENTS.md") : path.join(workspace, "AGENTS.md");
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    expect(output.join("\n")).toContain(`ln -s ${quote(agents)} ${quote(path.join(base, ".agents/AGENTS.md"))}`);
    expect(output.join("\n")).toMatch(/Symlink not created.*unsupported environment/);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
    assertNoLinks();
  });
});
