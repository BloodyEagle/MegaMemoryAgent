import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { applyEdits, findNodeAtLocation, getNodeValue, parseTree, type ParseError } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, execSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => { throw Object.assign(new Error("isolated executable lookup"), { code: "ENOENT" }); }),
  execSyncMock: vi.fn(() => { throw new Error("shell execution forbidden"); }),
}));
vi.mock("child_process", () => ({ execFileSync: execFileSyncMock, execSync: execSyncMock }));
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-jsonc-test-"));
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
function validTree(text: string): NonNullable<ReturnType<typeof parseTree>> {
  const errors: ParseError[] = [];
  const tree = parseTree(text.replace(/^\uFEFF/, " "), errors, { allowTrailingComma: true });
  expect(errors).toEqual([]);
  expect(tree).toBeDefined();
  return tree!;
}
function outsideManagedNodes(text: string): Buffer {
  const tree = validTree(text);
  const changedPaths = [["mcp", "megamemory", "type"], ["mcp", "megamemory", "command"], ...allowedTools.map((tool) => ["permission", `megamemory_${tool}`])];
  const edits = changedPaths.map((jsonPath) => {
    const node = findNodeAtLocation(tree, jsonPath);
    expect(node, jsonPath.join(".")).toBeDefined();
    return { offset: node!.offset, length: node!.length, content: `<${jsonPath.join(".")}>` };
  });
  return Buffer.from(applyEdits(text, edits));
}

describe("Plan E T1 JSONC editing safety", () => {
  it("preserves every byte outside changed nodes including comments, CRLF and user formatting", async () => {
    const permissions = allowedTools.map((tool) => `    "megamemory_${tool}" : "ask", // user's comment for ${tool}`).join("\n");
    const original = [
      "// Header: do not reformat this file", "{", '  "$schema" : "https://example.test/kilo.schema.json",',
      '  "mcp" : {', '    "other" : { "type": "remote", "url": "https://example.test/mcp", }, // keep server',
      '    "megamemory" : {', '      "type" : "remote", /* retain this inline comment */',
      '      "command" : ["old", "--old"], // retain command comment', '      "enabled" : false,',
      '      "environment" : { "USER_VALUE" : "keep  spacing" },', '      "timeout" : 9876, // user timeout', "    },", "  },",
      '  "permission" : {', permissions, '    "edit" : "ask", // non-managed permission', "  },",
      '  "instructions" : [', '    "first.md", // before existing rule', '    ".kilo/rules/megamemory.md", // existing rule', '    "last.md", // after existing rule', "  ],",
      '  "user" : { "value" : "keep // literal", "other" : "/* literal */", },', "}", "// Footer must survive", "",
    ].join("\r\n");
    const file = path.join(workspace, "kilo.jsonc");
    writeFixture(file, original);
    expect((await install()).ok).toBe(true);
    const updated = fs.readFileSync(file, "utf8");
    expect(outsideManagedNodes(updated)).toEqual(outsideManagedNodes(original));
    const tree = validTree(updated);
    expect(getNodeValue(findNodeAtLocation(tree, ["mcp", "megamemory", "type"])!)).toBe("local");
    const command = getNodeValue(findNodeAtLocation(tree, ["mcp", "megamemory", "command"])!) as string[];
    expect(command[0]).toBe("node");
    expect(command).toHaveLength(2);
    for (const tool of allowedTools) expect(getNodeValue(findNodeAtLocation(tree, ["permission", `megamemory_${tool}`])!)).toBe("allow");
    const backups = fs.readdirSync(workspace).filter((name) => name.startsWith("kilo.jsonc.bak-"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^kilo\.jsonc\.bak-\d{4}-\d{2}-\d{2}T/);
    expect(fs.readFileSync(path.join(workspace, backups[0]))).toEqual(Buffer.from(original));
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it("appends instructions without erasing comments attached to existing array entries", async () => {
    const file = path.join(workspace, "kilo.jsonc");
    const original = '{\n  "instructions": [\n    // first user instruction\n    "z.md",\n    /* second user instruction */\n    "a.md",\n  ],\n  "untouched" : true, // keep tail\n}\n';
    writeFixture(file, original);
    expect((await install()).ok).toBe(true);
    const updated = fs.readFileSync(file, "utf8");
    for (const text of ["// first user instruction", "/* second user instruction */", '"untouched" : true, // keep tail']) expect(updated).toContain(text);
    expect(getNodeValue(findNodeAtLocation(validTree(updated), ["instructions"])!)).toEqual(["z.md", "a.md", ".kilo/rules/megamemory.md"]);
  });

  it("inserts missing managed fields without changing user heading and inline comments", async () => {
    const file = path.join(workspace, "kilo.jsonc");
    const unchanged = [
      '// root heading stays with user\n  "user" : { "literal" : true, }, // root inline',
      '// server heading stays with other\n    "other" : { "type" : "remote", "url" : "https://example.test", }, // server inline',
      '// permission heading stays with edit\n    "edit" : "ask", // permission inline',
    ];
    const original = `// file heading\n{\n  ${unchanged[0]}\n  "mcp" : {\n    ${unchanged[1]}\n  },\n  "permission" : {\n    ${unchanged[2]}\n  },\n}\n// file footer\n`;
    writeFixture(file, original);
    expect((await install()).ok).toBe(true);
    const updated = fs.readFileSync(file, "utf8");
    validTree(updated);
    expect(updated.startsWith("// file heading\n")).toBe(true);
    expect(updated.endsWith("// file footer\n")).toBe(true);
    for (const fragment of unchanged) expect(updated).toContain(fragment);
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it.each(["\uFEFF{}\r\n", '\uFEFF{\r\n\t// BOM, tabs and trailing commas\r\n\t"user": { "keep": true, },\r\n}\r\n'])("retains the UTF-8 BOM while modifying a valid config %#", async (original) => {
    const file = path.join(workspace, "kilo.jsonc");
    writeFixture(file, original);
    expect((await install()).ok).toBe(true);
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const updated = bytes.toString("utf8");
    expect(updated.match(/\uFEFF/g)).toHaveLength(1);
    validTree(updated);
    if (original.includes("// BOM")) expect(updated).toContain('\t// BOM, tabs and trailing commas\r\n\t"user": { "keep": true, },');
    const backups = fs.readdirSync(workspace).filter((name) => name.startsWith("kilo.jsonc.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(workspace, backups[0]))).toEqual(Buffer.from(original));
    const once = treeSnapshot([root]);
    expect((await install()).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(once);
  });

  it.each(['{\n  "mcp": { "broken": ],\n}\n', '\uFEFF{\r\n  "instructions": ["ok.md",\r\n  invalid\r\n}\r\n'])("rejects broken JSONC with its exact offset and no writes or backups %#", async (original) => {
    const file = path.join(workspace, "kilo.jsonc");
    writeFixture(file, original);
    writeFixture(path.join(home, ".config/kilo/kilo.jsonc"), "{}\n");
    writeFixture(path.join(workspace, ".kilo/rules/megamemory.md"), "# User rules\n");
    const errors: ParseError[] = [];
    parseTree(original.replace(/^\uFEFF/, " "), errors, { allowTrailingComma: true });
    expect(errors.length).toBeGreaterThan(0);
    const issue = errors[0];
    const prefix = original.slice(0, issue.offset);
    const before = treeSnapshot([root]);
    const result = await install();
    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain(file);
    expect(result.failed[0].error).toContain(`position ${issue.offset} (line ${prefix.split("\n").length}, column ${issue.offset - prefix.lastIndexOf("\n")})`);
    expect(output.join("\n")).toContain(file);
    expect(process.exitCode).toBe(1);
    expect(treeSnapshot([root])).toEqual(before);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(original));
    expect(fs.readdirSync(workspace).filter((name) => name.includes(".bak-"))).toEqual([]);
    expect(fs.existsSync(path.join(workspace, ".agents"))).toBe(false);
  });

  it.each(['{"mcp": []}', '{"mcp":{"megamemory":null}}', '{"permission":[]}', '{"instructions":"not-an-array"}', '{"instructions":null}', '{"instructions":[1]}'])("rejects malformed config shapes without any side effects: %s", async (original) => {
    writeFixture(path.join(workspace, "kilo.jsonc"), original);
    const before = treeSnapshot([root]);
    expect((await install()).ok).toBe(false);
    expect(treeSnapshot([root])).toEqual(before);
    expect(fs.existsSync(path.join(workspace, ".agents"))).toBe(false);
  });

  it.each([{ flags: [] as string[] }, { flags: ["--global", "--link"] }])("dry-run changes no config, backup, rules, agents or link files with flags $flags", async ({ flags }) => {
    const file = path.join(workspace, "kilo.jsonc");
    writeFixture(file, '// keep this\n{"instructions":["user.md"],}\n');
    writeFixture(path.join(home, ".codex/AGENTS.md"), "# User Codex instructions\n");
    const before = treeSnapshot([root]);
    expect((await install("--dry-run", ...flags)).ok).toBe(true);
    expect(treeSnapshot([root])).toEqual(before);
    expect(output.join("\n")).toMatch(/Dry-run:.*bytes/);
    expect(fs.existsSync(path.join(workspace, ".agents"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".agents"))).toBe(false);
  });
});
