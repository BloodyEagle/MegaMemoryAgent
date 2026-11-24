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
const packageVersion = (JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version: string }).version;
const realHomes = [...new Set([os.homedir(), process.env.HOME, process.env.USERPROFILE].filter((value): value is string => Boolean(value)))];
// План 29: детектор инструкций читает больше домашних файлов — снапшот
// реального профиля расширен соответственно (изоляция HOME на Windows).
const realConfigPaths = realHomes.flatMap((home) => [
  ".zcode/cli/config.json", ".zcode/AGENTS.md", ".zcode/skills/megamemory",
  ".claude.json", ".claude/CLAUDE.md", ".codex/config.toml", ".codex/AGENTS.md",
  ".config/opencode/opencode.json", ".config/kilo/kilo.jsonc", ".config/kilo/AGENTS.md", ".config/kilo/rules",
  ".agents/AGENTS.md", ".agents/skills/megamemory",
].map((relative) => path.join(home, relative)));

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

interface ZcodeConfig {
  mcp?: { servers?: Record<string, Record<string, unknown>> };
  hooks?: { enabled?: boolean; events?: { UserPromptSubmit?: Array<Record<string, unknown>> } };
  [key: string]: unknown;
}
let root: string;
let home: string;
let workspace: string;
let configPath: string;
let previousCwd: string;
let previousExitCode: typeof process.exitCode;
let realBefore: Record<string, string>;
let output: string[];

beforeEach(() => {
  previousCwd = process.cwd();
  previousExitCode = process.exitCode;
  realBefore = treeSnapshot(realConfigPaths);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-zcode-test-"));
  home = path.join(root, "home");
  workspace = path.join(root, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  configPath = path.join(home, ".zcode", "cli", "config.json");
  for (const [key, value] of Object.entries({
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), OPENCODE_CONFIG_DIR: path.join(home, ".config/opencode"),
    CODEX_HOME: path.join(home, ".codex"), MEGAMEMORY_DB_PATH: path.join(root, "never-opened.db"),
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
  return runInstall(["--target", "zcode", ...flags]);
}
function readConfig(file: string): ZcodeConfig {
  const errors: ParseError[] = [];
  const config = parse(fs.readFileSync(file, "utf8"), errors, { allowTrailingComma: true }) as ZcodeConfig;
  expect(errors).toEqual([]);
  return config;
}
/** Полная запись megamemory — ровно та, которую установщик считает готовой. */
function completeRecord(): Record<string, unknown> {
  return { type: "stdio", command: "node", args: [expectedEntry], timeoutMs: 60000 };
}
function hookEntryArgs(config: ZcodeConfig): string[] {
  const groups = config.hooks?.events?.UserPromptSubmit ?? [];
  const ours = groups.filter((group) => JSON.stringify(group).includes("megamemory-user-prompt-hook"));
  expect(ours, "exactly one megamemory hook group").toHaveLength(1);
  const entry = (ours[0].hooks as Array<Record<string, unknown>>)[0];
  return entry.args as string[];
}

describe("Plan 28 ZCode target", () => {
  it("installs MCP record, prompt hook, workflow rules and skill into an empty home", async () => {
    const outcome = await install();
    expect(outcome.ok).toBe(true);
    expect(outcome.failed).toEqual([]);
    expect(process.exitCode).toBe(0);

    const config = readConfig(configPath);
    expect(config.mcp?.servers?.megamemory).toEqual(completeRecord());
    expect(config.hooks?.enabled).toBe(true);
    const args = hookEntryArgs(config);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("-e");
    const script = args[1];
    expect(script).toContain("hookEventName:\"UserPromptSubmit\"");
    expect(script).toContain("additionalContext");
    expect(script).toContain("megamemory-user-prompt-hook");
    const contextLiteral = /additionalContext:("(?:\\.|[^"\\])*")/.exec(script)?.[1];
    expect(contextLiteral).toBeDefined();
    const context = JSON.parse(contextLiteral!) as string;
    for (const token of ["understand", "create_concept", "evidence"]) expect(context).toContain(token);
    const entry = (config.hooks?.events?.UserPromptSubmit?.filter((group) => JSON.stringify(group).includes("megamemory-user-prompt-hook"))[0].hooks as Array<Record<string, unknown>>)[0];
    expect(entry.type).toBe("process");
    expect(entry.statusMessage).toBe("MegaMemory");
    expect(entry.timeoutMs).toBe(10000);

    const agents = fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Project Knowledge Graph");
    expect(fs.readFileSync(path.join(home, ".zcode", "skills", "megamemory", "SKILL.md"), "utf8")).toContain("MegaMemory-managed file");

    const printed = output.join("\n");
    for (const file of [configPath, path.join(workspace, "AGENTS.md"), path.join(home, ".zcode", "skills", "megamemory", "SKILL.md")]) {
      expect(printed).toContain(file);
    }
    expect(printed).toMatch(/Restart ZCode/);
  });

  it("is byte-idempotent and never duplicates the rules block", async () => {
    expect((await install()).ok).toBe(true);
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
    const agents = fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8");
    expect(agents.match(/## Project Knowledge Graph/g)).toHaveLength(1);
    const config = readConfig(configPath);
    expect(hookEntryArgs(config)).toHaveLength(2);
  });

  it.each([0, 1, 2])("refreshes the outdated managed hook at position %s without touching foreign groups", async (position) => {
    const oldContext = "MegaMemory: устаревшее напоминание из предыдущей версии.";
    const oldScript = `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:${JSON.stringify(oldContext)}}}));/* megamemory-user-prompt-hook */`;
    const foreignFirst = '{ "matcher": "foreign-first", "hooks": [{ "type": "process", "command": "keep-first", "args": ["--foreign"] }] }';
    const foreignLast = '{"matcher":"foreign-last","hooks":[{"type":"process","command":"keep-last","args":[]}]}';
    const groups = [foreignFirst, foreignLast];
    groups.splice(position, 0, JSON.stringify({ hooks: [{ type: "process", command: "old-node", args: ["-e", oldScript], timeoutMs: 10000, statusMessage: "MegaMemory" }] }));
    writeFixture(configPath, [
      "// user comment: preserve me",
      "{",
      `  "mcp": { "servers": { "megamemory": ${JSON.stringify(completeRecord())} } },`,
      '  "hooks": { "enabled": true, "events": { "UserPromptSubmit": [',
      "    // group order is user-owned",
      groups.join(",\n"),
      "  ] } }",
      "}",
      "",
    ].join("\n"));

    expect((await install()).ok).toBe(true);
    const updated = fs.readFileSync(configPath, "utf8");
    const config = readConfig(configPath);
    const refreshed = config.hooks?.events?.UserPromptSubmit ?? [];
    expect(refreshed).toHaveLength(3);
    const args = hookEntryArgs(config);
    expect(args[1]).not.toBe(oldScript);
    expect(JSON.stringify(refreshed[position])).toContain("megamemory-user-prompt-hook");
    expect(refreshed.filter((_, index) => index !== position)).toEqual([JSON.parse(foreignFirst), JSON.parse(foreignLast)]);
    for (const preserved of [foreignFirst, foreignLast, "// user comment: preserve me", "// group order is user-owned"]) expect(updated).toContain(preserved);
    expect(output.join("\n")).not.toContain("Prompt hook already up to date");

    output = [];
    expect((await install()).ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(updated);
    expect(output.join("\n")).toContain("Prompt hook already up to date");
  });

  it("dry-run leaves an outdated managed hook untouched", async () => {
    const stale = { hooks: [{ type: "process", command: "old-node", args: ["-e", "old reminder /* megamemory-user-prompt-hook */"] }] };
    writeFixture(configPath, `${JSON.stringify({ mcp: { servers: { megamemory: completeRecord() } }, hooks: { enabled: true, events: { UserPromptSubmit: [stale] } } }, null, 2)}\n`);
    const before = treeSnapshot([root]);
    expect((await install("--dry-run")).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(before);
    expect(output.join("\n")).not.toContain("Prompt hook already up to date");
    expect(output.join("\n")).not.toContain("Semantic search is off until");
  });

  it("fills missing fields of a user-owned megamemory record and preserves foreign servers and comments", async () => {
    writeFixture(configPath, [
      "// user comment: keep me",
      "{",
      '  "theme": "user-theme",',
      '  "mcp": {',
      '    "servers": {',
      '      "other": { "command": "keep", "enabled": false },',
      '      "megamemory": { "command": "C:\\\\custom\\\\mega.cmd", "args": ["--custom"] }',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"));
    expect((await install()).ok).toBe(true);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain("// user comment: keep me");
    const config = readConfig(configPath);
    expect(config.mcp?.servers?.other).toEqual({ command: "keep", enabled: false });
    expect(config.mcp?.servers?.megamemory).toEqual({ command: "C:\\custom\\mega.cmd", args: ["--custom"], type: "stdio", timeoutMs: 60000 });
  });

  it("rejects broken JSONC with path and position and leaves the file untouched", async () => {
    const broken = '{\n  "mcp": {\n    "servers": {\n';
    writeFixture(configPath, broken);
    const before = fs.readFileSync(configPath);
    const outcome = await install();
    expect(outcome.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]).toMatchObject({ target: "zcode", name: "MCP server config" });
    expect(outcome.failed[0].error).toContain(configPath);
    expect(outcome.failed[0].error).toMatch(/at position \d+ \(line \d+, column \d+\)/);
    expect(fs.readFileSync(configPath)).toEqual(before);
    expect(output.join("\n")).toContain(configPath);
  });

  it("dry-run writes nothing", async () => {
    const before = treeSnapshot([root]);
    const outcome = await install("--dry-run");
    expect(outcome.ok).toBe(true);
    expect(outcome.succeeded).toBeGreaterThan(0);
    expect(treeSnapshot([root])).toEqual(before);
    expect(output.join("\n")).toMatch(/Dry-run: .*config\.json/);
    expect(output.join("\n")).toMatch(/no files written/);
  });

  it("keeps the skill description within the ZCode 1024-character limit", async () => {
    expect((await install()).ok).toBe(true);
    const skill = fs.readFileSync(path.join(home, ".zcode", "skills", "megamemory", "SKILL.md"), "utf8");
    const description = /^description:\s*(.+)$/m.exec(skill)?.[1];
    expect(description).toBeDefined();
    expect(description!.length).toBeLessThanOrEqual(1024);
  });
});

describe("Plan 29 instructions detection", () => {
  it("zcode --global: instructions_status видит ~/.zcode/AGENTS.md и сигналит о чужой версии", async () => {
    const outcome = await install("--global");
    expect(outcome.ok).toBe(true);
    // cwd — каталог без AGENTS.md: проектного файла нет, работает глобальный.
    expect(fs.existsSync(path.join(workspace, "AGENTS.md"))).toBe(false);
    const { instructionsStatus } = await import("../instructions.js");
    expect(instructionsStatus(packageVersion)).toEqual({
      instructions_stale: false,
      instructions_version: packageVersion,
      server_version: packageVersion,
    });

    // Правка штампа на чужую версию — stale: true с версией из штампа.
    const rules = path.join(home, ".zcode", "AGENTS.md");
    const stamped = fs.readFileSync(rules, "utf8");
    fs.writeFileSync(rules, stamped.replace(`v${packageVersion}`, "v2.11.0"), "utf8");
    expect(instructionsStatus(packageVersion)).toEqual({
      instructions_stale: true,
      instructions_version: "2.11.0",
      server_version: packageVersion,
    });
  });

  it("kilo --global: instructions_status видит ~/.config/kilo/AGENTS.md и файл правил", async () => {
    writeFixture(path.join(home, ".config", "kilo", "kilo.jsonc"), "{}\n");
    const { runInstall } = await import("../install.js");
    expect((await runInstall(["--target", "kilo", "--global"])).ok).toBe(true);

    const { instructionsStatus } = await import("../instructions.js");
    // Глобальный AGENTS.md kilo начинается со штампа megamemory:instructions.
    expect(instructionsStatus(packageVersion)).toEqual({
      instructions_stale: false,
      instructions_version: packageVersion,
      server_version: packageVersion,
    });

    // Файл правил kilo несёт только маркер сниппета — версия читается из него
    // (до плана 29 такой файл всегда был stale: true, version: null).
    const rules = path.join(home, ".config", "kilo", "rules", "megamemory.md");
    expect(fs.readFileSync(rules, "utf8")).toContain(`<!-- megamemory-snippet v${packageVersion} -->`);
    expect(instructionsStatus(packageVersion, [rules])).toEqual({
      instructions_stale: false,
      instructions_version: packageVersion,
      server_version: packageVersion,
    });
  });
});

describe("Plan 28 ZCode --uninstall (hook only)", () => {
  it("restores the config byte-identically when the megamemory record pre-exists, keeping the foreign hook", async () => {
    const fixture = `${JSON.stringify({
      mcp: { servers: { megamemory: completeRecord() } },
      hooks: { enabled: true, events: { UserPromptSubmit: [{ matcher: ".*", hooks: [{ type: "command", command: "echo foreign-hook", timeout: 5 }] }] } },
    }, null, 2)}\n`;
    writeFixture(configPath, fixture);
    const before = fs.readFileSync(configPath);
    expect((await install()).ok).toBe(true);
    expect(fs.readFileSync(configPath)).not.toEqual(before);
    expect((await install("--uninstall")).ok).toBe(true);
    expect(fs.readFileSync(configPath)).toEqual(before);
    const config = readConfig(configPath);
    const foreign = config.hooks?.events?.UserPromptSubmit ?? [];
    expect(JSON.stringify(foreign)).toContain("echo foreign-hook");
    expect(JSON.stringify(foreign)).not.toContain("megamemory-user-prompt-hook");
    expect(config.hooks?.enabled).toBe(true);
    expect(output.join("\n")).toContain("Хук megamemory снят");

    const once = fs.readFileSync(configPath);
    const second = await install("--uninstall");
    expect(second.ok).toBe(true);
    expect(second.succeeded).toBe(0);
    expect(fs.readFileSync(configPath)).toEqual(once);
    expect(output.join("\n")).toContain("Хук не установлен");
  });

  it("removes the hook it created while keeping the MCP record and hooks.enabled", async () => {
    expect((await install()).ok).toBe(true);
    const withHook = fs.readFileSync(configPath);
    expect((await install("--uninstall")).ok).toBe(true);
    const config = readConfig(configPath);
    expect(config.mcp?.servers?.megamemory).toEqual(completeRecord());
    expect(config.hooks?.enabled).toBe(true);
    expect(JSON.stringify(config.hooks?.events?.UserPromptSubmit ?? [])).not.toContain("megamemory-user-prompt-hook");
    expect(fs.readFileSync(configPath)).not.toEqual(withHook);
  });

  it.each([
    ["--target kilo --uninstall", ["--target", "kilo", "--uninstall"]],
    ["--target zcode,kilo --uninstall", ["--target", "zcode,kilo", "--uninstall"]],
    ["--target zcode --uninstall --dry-run", ["--target", "zcode", "--uninstall", "--dry-run"]],
  ])("rejects %s explicitly and touches nothing", async (_name, args) => {
    writeFixture(configPath, "{}\n");
    const before = treeSnapshot([root]);
    const { runInstall } = await import("../install.js");
    const outcome = await runInstall(args);
    expect(outcome.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(outcome.failed[0].error).toContain("--uninstall поддержан только для --target zcode");
    expect(treeSnapshot([root])).toEqual(before);
  });
});
