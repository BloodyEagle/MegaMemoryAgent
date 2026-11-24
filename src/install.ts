import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";
import { success, skip, error, info, heading, warn, multiSelect } from "./cli-utils.js";
import { INSTRUCTIONS_STAMP_MARKER, instructionsStamp } from "./instructions.js";
// План 29: пути инструкций берутся из одного источника с детектором
// instructions_stale (instructionsCandidates) — списки больше не могут
// разъезжаться при добавлении новой цели.
import {
  agentsCanonical,
  claudeAgents,
  claudeDir,
  codexAgents,
  codexAgentsTarget,
  codexHome,
  homeDir,
  kiloAgents,
  kiloConfigDir,
  kiloRules,
  opencodeAgents,
  opencodeConfigDir,
  zcodeAgents,
  zcodeDir,
} from "./install-paths.js";
// F2 (2.1.5): the snippet lives in guide.ts — `megamemory guide` prints the
// very same constant, so the printed text cannot drift from the written one.
import { AGENTS_MD_END, AGENTS_MD_SNIPPET, buildWorkflowText } from "./guide.js";

export type InstallTarget = "opencode" | "claudecode" | "antigravity" | "codex" | "kilo" | "zcode";

interface InstallOptions {
  dryRun: boolean;
  global: boolean;
  link: boolean;
  uninstall: boolean;
}

interface KiloConfig {
  filePath: string;
  format: "jsonc" | "legacy";
  priority: number;
}

const KILO_ALLOWED_TOOLS = [
  "understand", "list_roots", "get_concept", "create_concept",
  "update_concept", "link", "check_freshness", "provenance_trace",
] as const;
const KILO_RULE_REF = ".kilo/rules/megamemory.md";
const KILO_APPROVAL_KEYS = { jsonc: "permission", legacy: "alwaysAllow" } as const;

interface TargetConfig {
  label: string;
  description: string;
  steps: Array<{ name: string; critical?: boolean; run: () => Promise<void> | void }>;
}

interface StepResult {
  target: InstallTarget;
  targetLabel: string;
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * План 06 (C-01): структурированный итог установки — CLI ставит exit code
 * по нему, а не делает exit(0) всегда. Пропущенные шаги (после провала
 * критического) считаются отдельно: skipped — не успех.
 */
export interface InstallOutcome {
  ok: boolean;
  succeeded: number;
  failed: Array<{ target: string; targetLabel: string; name: string; error?: string }>;
  skipped: Array<{ target: string; targetLabel: string; name: string }>;
}

interface CommandRuntime {
  opencodeCommand: string[];
  stdioCommand: string;
  stdioArgs: string[];
}

const OPENCODE_CONFIG_DIR = opencodeConfigDir();
const OPENCODE_CONFIG_PATH = path.join(OPENCODE_CONFIG_DIR, "opencode.json");
const OPENCODE_TOOL_DIR = path.join(OPENCODE_CONFIG_DIR, "tool");
const OPENCODE_COMMANDS_DIR = path.join(OPENCODE_CONFIG_DIR, "commands");

const CLAUDE_CONFIG_PATH = path.join(homeDir(), ".claude.json");
const CLAUDE_DIR = claudeDir();
const CLAUDE_COMMANDS_DIR = path.join(CLAUDE_DIR, "commands");

// ZCode keeps MCP servers, hooks and per-skill toggles in one global config
// (~/.zcode/cli/config.json); there is no workspace-level MCP file (plan 28
// T0: confirmed against the live config and the zcode configuration guide).
const ZCODE_DIR = zcodeDir();
const ZCODE_CONFIG_PATH = path.join(ZCODE_DIR, "cli", "config.json");
const ZCODE_SKILL_PATH = path.join(ZCODE_DIR, "skills", "megamemory", "SKILL.md");
// Mirrors the wording of MCP_INSTRUCTIONS (src/index.ts) so the per-prompt
// reminder cannot drift from the server instructions; index.ts cannot be
// imported here (cycle), so the texts cross-reference each other in comments.
const ZCODE_HOOK_CONTEXT = "MegaMemory: перед задачей вызови megamemory_understand, после работы запиши вывод через create_concept с evidence.";
// Marker embedded in the hook script: the installer recognises its own
// UserPromptSubmit entry by this substring (idempotency + uninstall).
const ZCODE_HOOK_MARKER = "megamemory-user-prompt-hook";

const ANTIGRAVITY_CONFIG_PATH = path.join(process.cwd(), "mcp_config.json");

// B-10 (аудит 2026-11-12): постоянный профиль Codex — активный CODEX_HOME,
// если переменная задана непустым (после trim) значением; значение
// используется как есть — пути с пробелами и кириллицей допустимы. Иначе —
// прежний homeDir()/.codex. Резолв переехал в install-paths.ts (план 30):
// тот же codexHome()/codexAgentsTarget() читает и скан инструкций, поэтому
// цель codex и детектор больше не расходятся в путях. Один resolved target
// используется для config.toml, AGENTS.md и сообщений установки;
// изолированный staging-каталог для CLI-вызова — отдельный временный
// CODEX_HOME (см. setupCodexConfig).
const CODEX_DIR = codexHome();
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const CODEX_AGENTS_MD_PATH = codexAgentsTarget();

const AGENTS_MD_MARKER = "## Project Knowledge Graph";
// F8.2 / plan 3 step 7.2: versioned block markers — repeated installs UPDATE
// the snippet instead of skipping it, and the stamp carries the package
// version so the server can report instructions staleness over MCP.
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version as string;
const MANAGED_FILE_MARKER = "MegaMemory-managed file. Safe for megamemory install to update.";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        i += 1;
        continue;
      }
      if (char === "\n" || char === "\r") {
        result += char;
      }
      continue;
    }

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && nextChar === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

function formatConfigReadError(filePath: string, reason: string): Error {
  return new Error(
    `Could not safely update ${filePath}: ${reason}. Left the existing file unchanged.`
  );
}

function readJsonConfigForMerge(
  filePath: string,
  nestedKey: string
): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    const reason = err instanceof Error ? `could not parse JSON (${err.message})` : "could not parse JSON";
    throw formatConfigReadError(filePath, reason);
  }

  if (!isObject(parsed)) {
    throw formatConfigReadError(filePath, "top-level JSON value is not an object");
  }

  if (nestedKey in parsed && !isObject(parsed[nestedKey])) {
    throw formatConfigReadError(filePath, `'${nestedKey}' is present but is not an object`);
  }

  return parsed;
}

function isManagedInstallFile(content: string): boolean {
  return content.includes(MANAGED_FILE_MARKER);
}

function resolveServerEntryPoint(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  const fromDist = path.resolve(thisDir, "index.js");
  if (fs.existsSync(fromDist)) return fromDist;

  const fromSrc = path.resolve(thisDir, "..", "dist", "index.js");
  if (fs.existsSync(fromSrc)) return fromSrc;

  const fromRoot = path.resolve(thisDir, "..", "dist", "index.js");
  return fromRoot;
}

function resolvePluginSource(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "..", "plugin", "megamemory.ts");
}

function resolveCommandFile(filename: string): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "..", "commands", filename);
}

async function findExecutable(name: string): Promise<string | undefined> {
  const { execFileSync } = await import("child_process");
  try {
    const locator = process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "where.exe")
      : "which";
    const output = execFileSync(locator, [name], {
      shell: false, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000, windowsHide: true,
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

async function detectGlobalCommand(): Promise<CommandRuntime> {
  if (await findExecutable("megamemory")) {
    return {
      opencodeCommand: ["megamemory"],
      stdioCommand: "megamemory",
      stdioArgs: [],
    };
  }

  const entry = resolveServerEntryPoint();
  return {
    opencodeCommand: ["node", entry],
    stdioCommand: "node",
    stdioArgs: [entry],
  };
}

/** npm's Windows shim is not executable with shell:false. Read its JS entry
 * as data and run Node directly; never interpolate a path into cmd.exe. */
function codexInvocation(executable: string): { executable: string; args: string[] } {
  if (/\.[cm]?js$/i.test(executable)) return { executable: process.execPath, args: [executable] };
  if (/\.(cmd|bat)$/i.test(executable)) {
    const shim = fs.readFileSync(executable, "utf8");
    const match = /"(?:%dp0%|%~dp0)[\\/]+([^"\r\n]+\.[cm]?js)"/i.exec(shim);
    if (!match) throw new Error(`Unsupported Codex Windows shim at ${executable}; using atomic config fallback.`);
    const script = path.resolve(path.dirname(executable), match[1].replace(/[\\/]/g, path.sep));
    if (!fs.existsSync(script)) throw new Error(`Codex shim entry not found at ${script}; using atomic config fallback.`);
    return { executable: process.execPath, args: [script] };
  }
  return { executable, args: [] };
}

/**
 * Upsert the versioned megamemory block (F8.2):
 * - no marker -> append the whole block;
 * - marker present -> replace from the marker to the end marker (or to the
 *   next "## " heading when upgrading from an unmarked legacy snippet).
 * Repeated installs refresh the text instead of duplicating it.
 */
function upsertAgentsMdBlock(filePath: string, block: string): "created" | "replaced" | "appended" {
  if (!fs.existsSync(filePath)) {
    writeFileSyncAtomic(filePath, block);
    return "created";
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const markerIdx = content.indexOf(AGENTS_MD_MARKER);
  if (markerIdx === -1) {
    writeFileSyncAtomic(filePath, content.replace(/\r?\n*$/, "\n\n") + block);
    return "appended";
  }

  // A previous run left a version stamp right before the heading — start
  // there, or the old stamp survives and the marker duplicates. The stamp
  // format changed in 2.0 (megamemory:instructions vs megamemory-snippet),
  // so look for both.
  const stampIdx = content.indexOf(INSTRUCTIONS_STAMP_MARKER);
  const legacyIdx = content.indexOf("<!-- megamemory-snippet:");
  const blockStart =
    stampIdx !== -1 && stampIdx < markerIdx
      ? stampIdx
      : legacyIdx !== -1 && legacyIdx < markerIdx
        ? legacyIdx
        : markerIdx;

  // Versioned block: replace blockStart..END inclusive.
  const endIdx = content.indexOf(AGENTS_MD_END, blockStart);
  if (endIdx !== -1) {
    const updated =
      content.slice(0, blockStart) +
      block +
      content.slice(endIdx + AGENTS_MD_END.length).replace(/^\n+/, "");
    writeFileSyncAtomic(filePath, updated);
    return "replaced";
  }

  // Legacy unmarked snippet: cut to the next "## " heading (exclusive).
  const nextHeading = content.indexOf("\n## ", markerIdx);
  const cutEnd = nextHeading === -1 ? content.length : nextHeading + 1;
  const updated = content.slice(0, markerIdx) + block + content.slice(cutEnd);
  writeFileSyncAtomic(filePath, updated);
  return "replaced";
}

function setupInstructionFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const block = AGENTS_MD_SNIPPET.trimStart();
  const outcome = upsertAgentsMdBlock(filePath, block);
  if (outcome === "created") {
    success(`Created ${pc.dim(filePath)}`);
  } else if (outcome === "replaced") {
    success(`Updated knowledge graph instructions (${PACKAGE_VERSION}) in ${pc.dim(filePath)}`);
  } else {
    success(`Appended knowledge graph instructions to ${pc.dim(filePath)}`);
  }
}

function setupToolPlugin(): void {
  const source = resolvePluginSource();
  const dest = path.join(OPENCODE_TOOL_DIR, "megamemory.ts");

  if (!fs.existsSync(source)) {
    skip(`Plugin source not found at ${pc.dim(source)}`);
    return;
  }

  fs.mkdirSync(OPENCODE_TOOL_DIR, { recursive: true });

  const sourceContent = fs.readFileSync(source, "utf-8");

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf-8");
    if (existing === sourceContent) {
      skip(`Tool plugin already up to date`);
      return;
    }

    if (!isManagedInstallFile(existing)) {
      warn(
        `Existing tool plugin at ${pc.dim(dest)} is not marked as MegaMemory-managed. Left it untouched.`
      );
      return;
    }

    writeFileSyncAtomic(dest, sourceContent);
    success(`Updated tool plugin at ${pc.dim(dest)}`);
    return;
  }

  writeFileSyncAtomic(dest, sourceContent);
  success(`Installed tool plugin at ${pc.dim(dest)}`);
}

/**
 * Plan 3 step 7.2: every generated file carries the version stamp so the
 * server's staleness signal can tell which package generation wrote it.
 * A stamp from a previous install is stripped first — never duplicated.
 */
function stampCommandSource(content: string): string {
  const stampLine = instructionsStamp(PACKAGE_VERSION);
  const stripped = content.replace(
    /^<!--\s*megamemory:instructions\s+v?\S+\s*-->\r?\n/m,
    ""
  );
  const lines = stripped.split("\n");
  if (lines[0]?.includes(MANAGED_FILE_MARKER)) {
    lines.splice(1, 0, stampLine);
    return lines.join("\n");
  }
  return `${stampLine}\n${stripped}`;
}

function setupCommand(destinationDir: string, filename: string, label: string): void {
  const source = resolveCommandFile(filename);
  const dest = path.join(destinationDir, filename);

  if (!fs.existsSync(source)) {
    skip(`Command source not found at ${pc.dim(source)}`);
    return;
  }

  fs.mkdirSync(destinationDir, { recursive: true });

  const stampedSource = stampCommandSource(fs.readFileSync(source, "utf-8"));

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf-8");
    if (existing === stampedSource) {
      skip(`${label} already up to date`);
      return;
    }

    if (!isManagedInstallFile(existing)) {
      warn(`Existing ${label} at ${pc.dim(dest)} is not marked as MegaMemory-managed. Left it untouched.`);
      return;
    }

    writeFileSyncAtomic(dest, stampedSource);
    success(`Updated ${label} at ${pc.dim(dest)}`);
    return;
  }

  writeFileSyncAtomic(dest, stampedSource);
  success(`Installed ${label} at ${pc.dim(dest)}`);
}

function managedServerOptions(
  servers: Record<string, unknown>,
  filePath: string
): Record<string, unknown> {
  if (!("megamemory" in servers)) return {};
  const existing = servers["megamemory"];
  if (!isObject(existing)) {
    throw formatConfigReadError(filePath, "'megamemory' is present but is not an object");
  }
  return { ...existing };
}

async function setupOpencodeMcpConfig(runtime: CommandRuntime): Promise<void> {
  fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });

  const config = readJsonConfigForMerge(OPENCODE_CONFIG_PATH, "mcp");

  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }

  const mcp = isObject(config["mcp"]) ? config["mcp"] : {};
  const existed = "megamemory" in mcp;

  const options = managedServerOptions(mcp, OPENCODE_CONFIG_PATH);
  delete options["args"]; // OpenCode carries executable and argv in command.
  mcp["megamemory"] = {
    ...options,
    type: "local",
    command: runtime.opencodeCommand,
    enabled: options["enabled"] ?? true,
  };
  config["mcp"] = mcp;

  writeFileSyncAtomic(OPENCODE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  success(
    existed
      ? `Updated megamemory MCP in ${pc.dim(OPENCODE_CONFIG_PATH)}`
      : `Added megamemory MCP to ${pc.dim(OPENCODE_CONFIG_PATH)}`
  );
  info(`Command: ${pc.cyan(JSON.stringify(runtime.opencodeCommand))}`);
}

async function setupClaudeConfig(runtime: CommandRuntime): Promise<void> {
  const config = readJsonConfigForMerge(CLAUDE_CONFIG_PATH, "mcpServers");

  const mcpServers = isObject(config["mcpServers"]) ? config["mcpServers"] : {};
  const existed = "megamemory" in mcpServers;

  mcpServers["megamemory"] = {
    ...managedServerOptions(mcpServers, CLAUDE_CONFIG_PATH),
    type: "stdio",
    command: runtime.stdioCommand,
    args: runtime.stdioArgs,
  };
  config["mcpServers"] = mcpServers;

  writeFileSyncAtomic(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  success(
    existed
      ? `Updated megamemory MCP in ${pc.dim(CLAUDE_CONFIG_PATH)}`
      : `Added megamemory MCP to ${pc.dim(CLAUDE_CONFIG_PATH)}`
  );
  info(`Command: ${pc.cyan(JSON.stringify([runtime.stdioCommand, ...runtime.stdioArgs]))}`);
}

async function setupAntigravityConfig(runtime: CommandRuntime): Promise<void> {
  const config = readJsonConfigForMerge(ANTIGRAVITY_CONFIG_PATH, "mcpServers");

  const mcpServers = isObject(config["mcpServers"]) ? config["mcpServers"] : {};
  const existed = "megamemory" in mcpServers;

  mcpServers["megamemory"] = {
    ...managedServerOptions(mcpServers, ANTIGRAVITY_CONFIG_PATH),
    command: runtime.stdioCommand,
    args: runtime.stdioArgs,
  };
  config["mcpServers"] = mcpServers;

  writeFileSyncAtomic(ANTIGRAVITY_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  success(
    existed
      ? `Updated megamemory MCP in ${pc.dim(ANTIGRAVITY_CONFIG_PATH)}`
      : `Added megamemory MCP to ${pc.dim(ANTIGRAVITY_CONFIG_PATH)}`
  );
  info(`Command: ${pc.cyan(JSON.stringify([runtime.stdioCommand, ...runtime.stdioArgs]))}`);
}

function buildCodexToml(runtime: CommandRuntime): string {
  // JSON basic strings use the same escapes required by TOML basic strings.
  return `[mcp_servers.megamemory]\ncommand = ${JSON.stringify(runtime.stdioCommand)}\nargs = ${JSON.stringify(runtime.stdioArgs)}\n`;
}

function tomlKeySegment(part: string): string {
  if (part.startsWith('"')) return JSON.parse(part) as string;
  return part.startsWith("'") ? part.slice(1, -1) : part;
}

/** Normalize quoted or bare TOML dotted keys for exact table matching. */
function tomlHeaderKey(rawLine: string): string | null {
  const match = /^\s*\[\[?\s*([^\]]*?)\s*\]?\]\s*(?:#.*)?$/.exec(rawLine.replace(/\r$/, ""));
  if (!match) return null;
  const parts = match[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+/g);
  if (!parts) return null;
  // Keep key segments distinct: ["mcp_servers.megamemory"] is one unrelated
  // key, not the nested [mcp_servers.megamemory] server table.
  return JSON.stringify(parts.map(tomlKeySegment));
}

/** Locate the end of a TOML value without mistaking comments, quoted brackets
 * or multi-line arrays/strings for the following option. */
function tomlValueEnd(lines: string[], start: number): number {
  let depth = 0;
  let quote = "";
  let triple = false;
  let escaped = false;
  for (let lineIndex = start; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const begin = lineIndex === start ? line.indexOf("=") + 1 : 0;
    for (let i = begin; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (quote === '"' && char === "\\") { escaped = true; continue; }
        if (triple ? line.slice(i, i + 3) === quote.repeat(3) : char === quote) {
          if (triple) i += 2;
          quote = "";
          triple = false;
        }
      } else {
        if (char === "#") break;
        if (char === '"' || char === "'") {
          quote = char;
          triple = line.slice(i, i + 3) === char.repeat(3);
          if (triple) i += 2;
        } else if (char === "[" || char === "{") depth++;
        else if (char === "]" || char === "}") depth--;
      }
    }
    if (depth === 0 && !quote) return lineIndex + 1;
    if (depth < 0 || (quote && !triple)) break;
    escaped = false;
  }
  throw formatConfigReadError(CODEX_CONFIG_PATH, "unterminated TOML value");
}

function preserveCodexOptions(lines: string[], newSection: string): string {
  const kept: string[] = [];
  for (let i = 1; i < lines.length;) {
    const assignment = /^\s*([^#=]+?)\s*=/.exec(lines[i]);
    if (!assignment) { kept.push(lines[i++]); continue; }
    const end = tomlValueEnd(lines, i);
    const key = tomlKeySegment(assignment[1].trim());
    if (key !== "command" && key !== "args") kept.push(...lines.slice(i, end));
    i = end;
  }
  const options = kept.join("\n").replace(/\n*$/, "");
  return newSection.replace(/\n$/, "") + (options ? `\n${options}` : "");
}

/** Refresh command/args only in the exact target table. Neighboring tables
 * (including env and megamemory-prefixed servers) and user options survive. */
function replaceOrAppendTomlSection(
  existing: string,
  sectionKey: string,
  newSection: string
): { content: string; existed: boolean } {
  const targetKey = JSON.stringify(sectionKey.split("."));
  const lines = existing.split("\n");
  let headerIndex = -1;
  let endIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const key = tomlHeaderKey(lines[i]);
    if (key === null) {
      if (/^\s*[^#=]+\s*=/.test(lines[i])) i = tomlValueEnd(lines, i) - 1;
      continue;
    }
    if (headerIndex === -1) {
      if (key === targetKey) headerIndex = i;
    } else {
      endIndex = i;
      break;
    }
  }
  if (headerIndex === -1) {
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    return { content: existing + separator + newSection, existed: false };
  }
  const before = lines.slice(0, headerIndex).join("\n");
  const after = lines.slice(endIndex).join("\n");
  const block = preserveCodexOptions(lines.slice(headerIndex, endIndex), newSection);
  return {
    content: (before ? `${before}\n` : "") + `${block}\n${after}`,
    existed: true,
  };
}

/**
 * R02: all managed configs, instructions, commands and plugins use one
 * sibling temp + fsync + rename writer. The original is never opened for
 * writing or removed, so preparation/publish failure preserves its bytes.
 */
function writeFileSyncAtomic(filePath: string, content: string): void {
  // Preserve write-through semantics for user symlinks: publish beside the
  // real target, never replace the configured link with an ordinary file.
  const existed = fs.existsSync(filePath);
  const target = existed ? fs.realpathSync(filePath) : filePath;
  const mode = existed ? fs.statSync(target).mode & 0o7777 : 0o600;
  const tmp = `${target}.megamemory-tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  let ownsTemp = false;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    ownsTemp = true;
    fs.writeFileSync(fd, content, "utf-8");
    // open(mode) is masked by umask; restore existing permissions explicitly
    // after writing (writes may clear set-ID bits) and before durability sync.
    if (existed) fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the original write error */ }
    }
    if (ownsTemp) {
      try { fs.unlinkSync(tmp); } catch { /* cleanup is best-effort */ }
    }
    throw err;
  }
}

async function setupCodexConfig(runtime: CommandRuntime): Promise<void> {
  // Inspect the real target before any external command. Existing runtime
  // tables are updated locally: `codex mcp add` may reset env/custom options.
  const existed = fs.existsSync(CODEX_CONFIG_PATH);
  const existing = existed ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const update = replaceOrAppendTomlSection(existing, "mcp_servers.megamemory", buildCodexToml(runtime));
  const codex = update.existed ? undefined : await findExecutable("codex");

  if (codex) {
    let staging: string | undefined;
    try {
      const invocation = codexInvocation(codex);
      staging = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-codex-install-"));
      if (existed) writeFileSyncAtomic(path.join(staging, "config.toml"), existing);
      const { execFileSync } = await import("child_process");
      execFileSync(invocation.executable, [
        ...invocation.args, "mcp", "add", "megamemory", "--", runtime.stdioCommand, ...runtime.stdioArgs,
      ], {
        shell: false, stdio: "pipe", timeout: 10000, windowsHide: true,
        env: { ...process.env, CODEX_HOME: staging },
      });
      info("Codex CLI add succeeded in an isolated staging profile.");
    } catch (err) {
      warn(`Codex CLI unavailable or failed (${err instanceof Error ? err.message : String(err)}); using atomic config fallback.`);
    } finally {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  // Publish our managed-fields merge, never the CLI's potentially destructive
  // rewrite. A failed add/write/rename leaves the previous working file intact.
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSyncAtomic(CODEX_CONFIG_PATH, update.content);
  success(`${existed ? "Updated" : "Created"} megamemory MCP in ${pc.dim(CODEX_CONFIG_PATH)}`);
  info(`Command: ${pc.cyan(JSON.stringify([runtime.stdioCommand, ...runtime.stdioArgs]))}`);
}

function findKiloConfigs(): KiloConfig[] {
  const found: KiloConfig[] = [];
  const candidates: KiloConfig[] = [
    { filePath: path.join(process.cwd(), "kilo.jsonc"), format: "jsonc", priority: 1 },
    { filePath: path.join(process.cwd(), ".kilo", "kilo.jsonc"), format: "jsonc", priority: 1 },
    { filePath: path.join(kiloConfigDir(), "kilo.jsonc"), format: "jsonc", priority: 2 },
    { filePath: path.join(process.cwd(), ".kilocode", "mcp.json"), format: "legacy", priority: 3 },
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.filePath) && fs.statSync(candidate.filePath).isFile()) found.push(candidate);
  }
  const visit = (dir: string, depth: number): void => {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      warn(`Cannot inspect legacy config directory ${dir}: ${err instanceof Error ? err.message : String(err)}; continuing config discovery.`);
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "mcp_settings.json") found.push({ filePath, format: "legacy", priority: 4 });
      if (entry.isDirectory() && depth < 3) visit(filePath, depth + 1);
    }
  };
  visit(path.join(homeDir(), ".kilocode"), 0);
  return found;
}

function readKiloConfig(selected: KiloConfig): { text: string; config: Record<string, unknown> } {
  const text = fs.readFileSync(selected.filePath, "utf8");
  const errors: ParseError[] = [];
  const tree = parseTree(text.replace(/^\uFEFF/, " "), errors, {
    allowTrailingComma: selected.format === "jsonc", disallowComments: selected.format === "legacy",
  });
  if (errors.length > 0) {
    const issue = errors[0];
    const prefix = text.slice(0, issue.offset);
    const line = prefix.split("\n").length;
    const column = issue.offset - prefix.lastIndexOf("\n");
    throw formatConfigReadError(selected.filePath, `${printParseErrorCode(issue.error)} at position ${issue.offset} (line ${line}, column ${column})`);
  }
  const config: unknown = tree ? getNodeValue(tree) : undefined;
  if (!isObject(config)) throw formatConfigReadError(selected.filePath, "configuration root must be an object");
  return { text, config };
}

function editKiloConfig(text: string, jsonPath: Array<string | number>, value: unknown): string {
  const tree = parseTree(text.replace(/^\uFEFF/, " "), [], { allowTrailingComma: true });
  const current = tree && findNodeAtLocation(tree, jsonPath);
  if (current && JSON.stringify(getNodeValue(current)) === JSON.stringify(value)) return text;
  // Formatting a modify range can include neighbouring user nodes. Apply only
  // the structural edits so their comments, whitespace and EOL remain byte-identical.
  const edits = modify(text.replace(/^\uFEFF/, " "), jsonPath, value, { getInsertionIndex: () => 0 });
  return applyEdits(text, edits);
}

function kiloRuleLocation(selected: KiloConfig): { filePath: string; ref: string } {
  if (selected.format === "jsonc" && selected.priority === 2) {
    const filePath = kiloRules(true, "jsonc");
    return { filePath, ref: filePath };
  }
  const filePath = kiloRules(false, selected.format);
  return { filePath, ref: KILO_RULE_REF };
}

function mergeKiloConfig(selected: KiloConfig, runtime: CommandRuntime): string {
  const { text, config } = readKiloConfig(selected);
  const key = selected.format === "jsonc" ? "mcp" : "mcpServers";
  if (key in config && !isObject(config[key])) throw formatConfigReadError(selected.filePath, `'${key}' must be an object`);
  const servers = isObject(config[key]) ? config[key] : {};
  const options = managedServerOptions(servers, selected.filePath);
  let updated = text;
  if (selected.format === "legacy") {
    const fields = { command: runtime.stdioCommand, args: runtime.stdioArgs, [KILO_APPROVAL_KEYS.legacy]: [...KILO_ALLOWED_TOOLS] };
    for (const [name, value] of Object.entries(fields)) updated = editKiloConfig(updated, [key, "megamemory", name], value);
    return updated;
  }
  const approvalKey = KILO_APPROVAL_KEYS.jsonc;
  if (approvalKey in config && !isObject(config[approvalKey])) throw formatConfigReadError(selected.filePath, `'${approvalKey}' must be an object`);
  const instructions = "instructions" in config ? config["instructions"] : [];
  if (!Array.isArray(instructions) || !instructions.every((item): item is string => typeof item === "string")) {
    throw formatConfigReadError(selected.filePath, "'instructions' must be an array of strings");
  }
  const fields = { type: "local", command: [runtime.stdioCommand, ...runtime.stdioArgs], enabled: options["enabled"] ?? true };
  for (const [name, value] of Object.entries(fields)) updated = editKiloConfig(updated, [key, "megamemory", name], value);
  for (const tool of KILO_ALLOWED_TOOLS) updated = editKiloConfig(updated, [approvalKey, `megamemory_${tool}`], "allow");
  const ruleRef = kiloRuleLocation(selected).ref;
  const refs = instructions.map((item, index) => item === ruleRef ? index : -1).filter((index) => index >= 0);
  if (!("instructions" in config)) updated = editKiloConfig(updated, ["instructions"], [ruleRef]);
  else if (refs.length === 0) updated = editKiloConfig(updated, ["instructions", -1], ruleRef);
  for (const index of refs.slice(1).reverse()) updated = editKiloConfig(updated, ["instructions", index], undefined);
  return updated;
}

function writeKiloFile(filePath: string, content: string, dryRun: boolean): void {
  if (dryRun) {
    info(`Dry-run: ${filePath} (${Buffer.byteLength(content, "utf8")} bytes); no files written.`);
    return;
  }
  if (fs.existsSync(filePath)) {
    const original = fs.readFileSync(filePath);
    if (original.equals(Buffer.from(content, "utf8"))) {
      skip(`Already up to date: ${pc.dim(filePath)}`);
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${filePath}.bak-${timestamp}-${randomUUID()}`;
    fs.copyFileSync(filePath, backup, fs.constants.COPYFILE_EXCL);
    info(`Backup: ${pc.dim(backup)}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSyncAtomic(filePath, content);
  success(`Updated ${pc.dim(filePath)}`);
}

function kiloManagedBlock(body: string): string {
  return `<!-- megamemory-snippet v${PACKAGE_VERSION} -->\n${body.trim()}\n${AGENTS_MD_END}\n`;
}

function mergeKiloBlock(filePath: string, block: string): string {
  if (!fs.existsSync(filePath)) return block;
  const existing = fs.readFileSync(filePath, "utf8");
  const start = /<!--\s*(?:megamemory-snippet(?:\s+v|:)|megamemory:instructions\s+v)[^\r\n]*-->/.exec(existing);
  if (start) {
    const end = existing.indexOf(AGENTS_MD_END, start.index + start[0].length);
    if (end === -1) throw new Error(`Unclosed megamemory block in ${filePath}; left untouched.`);
    return existing.slice(0, start.index) + block.trimEnd() + existing.slice(end + AGENTS_MD_END.length);
  }
  warn(`No megamemory markers in ${pc.dim(filePath)}; appending the managed block.`);
  return existing.replace(/\r?\n*$/, "\n\n") + block;
}

async function setupKiloConfig(runtime: CommandRuntime, options: InstallOptions): Promise<void> {
  const found = findKiloConfigs();
  const selected = found[0];
  if (!selected) {
    warn("Kilo config not found. No files created. Add the following new-format fragment to ./kilo.jsonc, then re-run install.");
    console.log(JSON.stringify({
      mcp: { megamemory: { type: "local", command: [runtime.stdioCommand, ...runtime.stdioArgs] } },
      [KILO_APPROVAL_KEYS.jsonc]: Object.fromEntries(KILO_ALLOWED_TOOLS.map((tool) => [`megamemory_${tool}`, "allow"])),
      instructions: [KILO_RULE_REF],
    }, null, 2));
    return;
  }
  info(`Found ${selected.filePath} (priority ${selected.priority}, ${selected.format === "jsonc" ? "new JSONC" : "legacy mcpServers"} format).`);
  for (const other of found.slice(1)) info(`Skipped ${other.filePath} (priority ${other.priority}): the first config wins.`);
  const config = mergeKiloConfig(selected, runtime);
  const { filePath: rulePath, ref: ruleRef } = kiloRuleLocation(selected);
  const rules = mergeKiloBlock(rulePath, kiloManagedBlock(buildWorkflowText()));
  const agents = prepareAgentsConvention(options);
  writeKiloFile(selected.filePath, config, options.dryRun);
  writeKiloFile(rulePath, rules, options.dryRun);
  info(`${KILO_APPROVAL_KEYS[selected.format]}: ${KILO_ALLOWED_TOOLS.join(", ")}`);
  if (selected.format === "jsonc") info(`instructions: ${ruleRef}`);
  warn("Auto-approval is not empirically confirmed. Verify create_concept in Kilo without an approval dialog.");
  for (const file of agents) writeKiloFile(file.filePath, file.content, options.dryRun);
  await setupAgentsLink(options);
}

function prepareAgentsConvention(options: InstallOptions): Array<{ filePath: string; content: string }> {
  const skillPath = path.join(options.global ? homeDir() : process.cwd(), ".agents", "skills", "megamemory", "SKILL.md");
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "megamemory", "SKILL.md");
  const skill = fs.readFileSync(source, "utf8");
  const agentsPath = kiloAgents(options.global);
  const skillRef = options.global ? skillPath.replace(/\\/g, "/") : ".agents/skills/megamemory/SKILL.md";
  const block = `${instructionsStamp(PACKAGE_VERSION)}\n` + kiloManagedBlock([
    "Use megamemory before tasks and record verified conclusions afterwards.",
    `Follow the [megamemory skill](${skillRef}): evidence, next.record and granular nodes.`,
    "Full workflow contract: `megamemory guide --workflow`.",
  ].join("\n"));
  const files = [{ filePath: agentsPath, content: mergeKiloBlock(agentsPath, block) }];
  const existingSkill = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : undefined;
  if (existingSkill === undefined || existingSkill === skill || isManagedInstallFile(existingSkill)) {
    files.unshift({ filePath: skillPath, content: skill });
  } else {
    warn(`Existing skill at ${pc.dim(skillPath)} is not marked as MegaMemory-managed. Left it untouched.`);
  }
  const codexPath = codexAgents();
  if (options.global && fs.existsSync(codexPath)) files.push({ filePath: codexPath, content: mergeKiloBlock(codexPath, block) });
  return files;
}

async function setupAgentsLink(options: InstallOptions): Promise<void> {
  if (!options.link) return;
  const agentsPath = kiloAgents(options.global);
  const linkPath = agentsCanonical(options.global);
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  info(`Optional canonical link: ln -s ${quote(agentsPath)} ${quote(linkPath)}`);
  if (options.dryRun || (process.platform !== "linux" && process.platform !== "darwin")) {
    warn("Symlink not created: dry-run or unsupported environment. The native AGENTS.md already carries the instructions.");
    return;
  }
  if (fs.existsSync(linkPath) || fs.lstatSync(path.dirname(linkPath)).isSymbolicLink()) {
    warn(`Link destination already exists or has a symlink parent: ${linkPath}; left untouched.`);
    return;
  }
  try {
    const { execFileSync } = await import("child_process");
    execFileSync("ln", ["-s", agentsPath, linkPath], { shell: false, stdio: "pipe", timeout: 10000 });
    success(`Created optional link ${pc.dim(linkPath)}`);
  } catch (err) {
    warn(`Optional link was not created: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- ZCode (plan 28) -------------------------------------------------------

/**
 * ZCode config.json is user-owned JSONC: comments, key order and a BOM must
 * survive, and only our own keys may change (plan 28 T1). Parse with
 * jsonc-parser and edit text-level through editKiloConfig/writeKiloFile —
 * the same byte-preserving helpers Kilo uses, despite the Kilo-flavoured
 * names. Broken JSON refuses with path and position and never touches the
 * file.
 */
function readZcodeConfig(filePath: string): { text: string; config: Record<string, unknown>; tree: ReturnType<typeof parseTree> } {
  if (!fs.existsSync(filePath)) return { text: "{}\n", config: {}, tree: undefined };
  const text = fs.readFileSync(filePath, "utf8");
  const errors: ParseError[] = [];
  const tree = parseTree(text.replace(/^\uFEFF/, " "), errors, { allowTrailingComma: true });
  if (errors.length > 0 || !tree) {
    if (errors.length > 0) {
      const issue = errors[0];
      const prefix = text.slice(0, issue.offset);
      const line = prefix.split("\n").length;
      const column = issue.offset - prefix.lastIndexOf("\n");
      throw formatConfigReadError(filePath, `${printParseErrorCode(issue.error)} at position ${issue.offset} (line ${line}, column ${column})`);
    }
    throw formatConfigReadError(filePath, "configuration root could not be parsed");
  }
  const config: unknown = getNodeValue(tree);
  if (!isObject(config)) throw formatConfigReadError(filePath, "configuration root must be an object");
  return { text, config, tree };
}

async function setupZcodeConfig(runtime: CommandRuntime, dryRun: boolean): Promise<void> {
  const { text, config } = readZcodeConfig(ZCODE_CONFIG_PATH);
  if ("mcp" in config && !isObject(config.mcp)) throw formatConfigReadError(ZCODE_CONFIG_PATH, "'mcp' is present but is not an object");
  const mcp = isObject(config.mcp) ? config.mcp : {};
  if ("servers" in mcp && !isObject(mcp.servers)) throw formatConfigReadError(ZCODE_CONFIG_PATH, "'mcp.servers' is present but is not an object");
  // Plan 28 T0: schema confirmed against a live working config —
  // mcp.servers.<name> with { type, command, args, timeoutMs, enabled? }.
  const record: Record<string, unknown> = { type: "stdio", command: runtime.stdioCommand, args: runtime.stdioArgs, timeoutMs: 60000 };
  const servers = isObject(mcp.servers) ? mcp.servers : {};
  const existing = isObject(servers.megamemory) ? servers.megamemory : undefined;
  let updated = text;
  if (existing) {
    // The existing record belongs to the user: fill in missing fields only,
    // never overwrite values they chose.
    for (const [name, value] of Object.entries(record)) {
      if (!(name in existing)) updated = editKiloConfig(updated, ["mcp", "servers", "megamemory", name], value);
    }
  } else {
    updated = editKiloConfig(updated, ["mcp", "servers", "megamemory"], record);
  }
  writeKiloFile(ZCODE_CONFIG_PATH, updated, dryRun);
  info(`Command: ${pc.cyan(JSON.stringify([runtime.stdioCommand, ...runtime.stdioArgs]))}`);
}

function setupZcodeRules(options: InstallOptions): void {
  const target = zcodeAgents(options.global);
  if (options.dryRun) {
    const classification = !fs.existsSync(target)
      ? "created"
      : fs.readFileSync(target, "utf-8").includes(AGENTS_MD_MARKER) ? "replaced" : "appended";
    info(`Dry-run: ${target} (workflow rules block would be ${classification}); no files written.`);
  } else {
    setupInstructionFile(target);
  }
  if (options.global) {
    info("ZCode has no workspace-level MCP config; --global only moves the rules file.");
  } else if (fs.existsSync(zcodeAgents(true)) && !fs.readFileSync(zcodeAgents(true), "utf-8").includes("megamemory")) {
    warn(`Global rules at ${pc.dim(zcodeAgents(true))} contain no megamemory block; ZCode reads both files and project rules do not cover global sessions.`);
  }
}

function setupZcodeSkill(dryRun: boolean): void {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "megamemory", "SKILL.md");
  const skill = fs.readFileSync(source, "utf8");
  const existing = fs.existsSync(ZCODE_SKILL_PATH) ? fs.readFileSync(ZCODE_SKILL_PATH, "utf8") : undefined;
  if (existing !== undefined && existing !== skill && !isManagedInstallFile(existing)) {
    warn(`Existing skill at ${pc.dim(ZCODE_SKILL_PATH)} is not marked as MegaMemory-managed. Left it untouched.`);
    return;
  }
  writeKiloFile(ZCODE_SKILL_PATH, skill, dryRun);
}

function zcodeHookScript(): string {
  // process hook (argv, no shell — portable across Windows/POSIX; ZCode hooks
  // schema, plan 28 T4): stdout JSON with additionalContext injects one line.
  return `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:${JSON.stringify(ZCODE_HOOK_CONTEXT)}}}));/* ${ZCODE_HOOK_MARKER} */`;
}

function zcodeHookGroup(): Record<string, unknown> {
  return {
    hooks: [{
      type: "process",
      command: process.execPath,
      args: ["-e", zcodeHookScript()],
      timeoutMs: 10000,
      statusMessage: "MegaMemory",
    }],
  };
}

function isMegamemoryHookGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false;
  for (const entry of group.hooks) {
    if (!isObject(entry)) continue;
    const args: unknown[] = Array.isArray(entry.args) ? entry.args : [];
    if (args.some((arg) => typeof arg === "string" && arg.includes(ZCODE_HOOK_MARKER))) return true;
  }
  return false;
}

/**
 * Installs (or refreshes) our UserPromptSubmit hook: one line of context on
 * every prompt (plan 28 T4). Configuration-file hooks run only with
 * hooks.enabled: true; the rest of the hooks config is never touched.
 */
function setupZcodeHook(dryRun: boolean): void {
  const { text, config } = readZcodeConfig(ZCODE_CONFIG_PATH);
  if ("hooks" in config && !isObject(config.hooks)) throw formatConfigReadError(ZCODE_CONFIG_PATH, "'hooks' is present but is not an object");
  const hooks = isObject(config.hooks) ? config.hooks : {};
  if ("events" in hooks && !isObject(hooks.events)) throw formatConfigReadError(ZCODE_CONFIG_PATH, "'hooks.events' is present but is not an object");
  const events = isObject(hooks.events) ? hooks.events : {};
  if ("UserPromptSubmit" in events && !Array.isArray(events.UserPromptSubmit)) throw formatConfigReadError(ZCODE_CONFIG_PATH, "'hooks.events.UserPromptSubmit' must be an array");
  const groups = Array.isArray(events.UserPromptSubmit) ? events.UserPromptSubmit : [];
  if (groups.some(isMegamemoryHookGroup)) {
    skip("Prompt hook already up to date");
    return;
  }
  const group = zcodeHookGroup();
  let updated = editKiloConfig(text, ["hooks", "enabled"], true);
  updated = groups.length > 0
    ? editKiloConfig(updated, ["hooks", "events", "UserPromptSubmit", -1], group)
    : editKiloConfig(updated, ["hooks", "events", "UserPromptSubmit"], [group]);
  if (hooks.enabled === false) warn("hooks.enabled was false; configuration-file hooks run only with hooks.enabled: true.");
  writeKiloFile(ZCODE_CONFIG_PATH, updated, dryRun);
  info("UserPromptSubmit hook injects a one-line MegaMemory reminder into every prompt.");
}

/**
 * Removes only our own UserPromptSubmit entry (recognised by ZCODE_HOOK_MARKER)
 * via offset surgery on the parse tree: foreign hooks, comments and key order
 * stay byte-identical. Returns false when the hook is not installed — the file
 * is never written in that case.
 */
function uninstallZcodeHook(): boolean {
  const { text, config, tree } = readZcodeConfig(ZCODE_CONFIG_PATH);
  const hooks = isObject(config.hooks) ? config.hooks : {};
  const events = isObject(hooks.events) ? hooks.events : {};
  if (!Array.isArray(events.UserPromptSubmit)) return false;
  const groups = events.UserPromptSubmit;
  const listNode = tree ? findNodeAtLocation(tree, ["hooks", "events", "UserPromptSubmit"]) : undefined;
  if (!listNode?.children) return false;
  const targets = groups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => isMegamemoryHookGroup(group))
    .map(({ index }) => index)
    .sort((a, b) => b - a);
  if (targets.length === 0) return false;
  // BOM is replaced by a same-length space, so parse-tree offsets stay valid.
  let updated = text.replace(/^\uFEFF/, " ");
  for (const index of targets) {
    const node = listNode.children[index];
    if (!node) throw formatConfigReadError(ZCODE_CONFIG_PATH, `hook entry ${index} could not be located for removal`);
    let start = node.offset;
    let end = node.offset + node.length;
    // Eat the trailing separator when our entry is not the last element;
    // otherwise eat the preceding comma and whitespace. Install always
    // appends, so our entry is the last one and the back-scan reverses the
    // insertion byte-for-byte.
    const after = updated.slice(end).match(/^\s*/)?.[0].length ?? 0;
    if (updated.charAt(end + after) === ",") {
      end = end + after + 1;
    } else {
      while (start > 0 && /[\s,]/.test(updated.charAt(start - 1))) start -= 1;
    }
    updated = updated.slice(0, start) + updated.slice(end);
  }
  writeKiloFile(ZCODE_CONFIG_PATH, updated, false);
  return true;
}

function createTargetConfigs(runtime: CommandRuntime, options: InstallOptions): Record<InstallTarget, TargetConfig> {
  return {
    opencode: {
      label: "opencode",
      description: "MCP server, AGENTS.md, skill plugin, commands",
      steps: [
        { name: "MCP server config", critical: true, run: () => setupOpencodeMcpConfig(runtime) },
        { name: "Global AGENTS.md", run: () => setupInstructionFile(opencodeAgents()) },
        { name: "Skill tool plugin", run: () => setupToolPlugin() },
        {
          name: "Bootstrap command",
          run: () => setupCommand(OPENCODE_COMMANDS_DIR, "bootstrap-memory.md", "bootstrap command"),
        },
        {
          name: "Save memory command",
          run: () => setupCommand(OPENCODE_COMMANDS_DIR, "save-memory.md", "save memory command"),
        },
      ],
    },
    claudecode: {
      label: "Claude Code",
      description: "MCP server, CLAUDE.md, commands",
      steps: [
        { name: "MCP server config", critical: true, run: () => setupClaudeConfig(runtime) },
        { name: "Global CLAUDE.md", run: () => setupInstructionFile(claudeAgents()) },
        {
          name: "Bootstrap command",
          run: () => setupCommand(CLAUDE_COMMANDS_DIR, "bootstrap-memory.md", "bootstrap command"),
        },
        {
          name: "Save memory command",
          run: () => setupCommand(CLAUDE_COMMANDS_DIR, "save-memory.md", "save memory command"),
        },
      ],
    },
    antigravity: {
      label: "Antigravity",
      description: "MCP server config (workspace-level)",
      steps: [
        { name: "MCP server config", critical: true, run: () => setupAntigravityConfig(runtime) },
      ],
    },
    kilo: {
      label: "Kilo",
      description: "Existing JSONC/legacy MCP config, explicit permissions, workflow rules",
      steps: [
        { name: "Kilo config and workflow rules", critical: true, run: () => setupKiloConfig(runtime, options) },
      ],
    },
    codex: {
      label: "Codex",
      description: "MCP server, AGENTS.md",
      steps: [
        { name: "MCP server config", critical: true, run: () => setupCodexConfig(runtime) },
        { name: "Global AGENTS.md", run: () => setupInstructionFile(CODEX_AGENTS_MD_PATH) },
      ],
    },
    zcode: {
      label: "ZCode",
      description: "MCP server, prompt hook, workflow rules, skill",
      steps: [
        { name: "MCP server config", critical: true, run: () => setupZcodeConfig(runtime, options.dryRun) },
        { name: "Prompt hook (UserPromptSubmit)", run: () => setupZcodeHook(options.dryRun) },
        { name: "Workflow rules", run: () => setupZcodeRules(options) },
        { name: "Skill", run: () => setupZcodeSkill(options.dryRun) },
      ],
    },
  };
}

export const VALID_TARGETS: InstallTarget[] = ["opencode", "claudecode", "antigravity", "codex", "kilo", "zcode"];

function parseTargets(args: string[]): InstallTarget[] {
  const selected = new Set<InstallTarget>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target") {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`Missing value for --target. Use one of: ${VALID_TARGETS.join(", ")}`);
      }
      i += 1;
      for (const item of value.split(",")) {
        const candidate = item.trim().toLowerCase();
        if (!candidate) continue;
        if (!VALID_TARGETS.includes(candidate as InstallTarget)) {
          throw new Error(`Unknown target '${candidate}'. Use one of: ${VALID_TARGETS.join(", ")}`);
        }
        selected.add(candidate as InstallTarget);
      }
      continue;
    }

    if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      for (const item of value.split(",")) {
        const candidate = item.trim().toLowerCase();
        if (!candidate) continue;
        if (!VALID_TARGETS.includes(candidate as InstallTarget)) {
          throw new Error(`Unknown target '${candidate}'. Use one of: ${VALID_TARGETS.join(", ")}`);
        }
        selected.add(candidate as InstallTarget);
      }
      continue;
    }

    if (arg === "--dry-run" || arg === "--global" || arg === "--link" || arg === "--uninstall") continue;
    throw new Error(`Unknown install option '${arg}'. Supported: --target <name>, --dry-run, --global, --link, --uninstall`);
  }

  return [...selected];
}

async function chooseTargetsInteractively(): Promise<InstallTarget[]> {
  const selected = await multiSelect("Which editors would you like to configure?", [
    {
      label: "opencode",
      value: "opencode",
      description: "MCP server, AGENTS.md, skill plugin, commands",
    },
    {
      label: "Claude Code",
      value: "claudecode",
      description: "MCP server, CLAUDE.md, commands",
    },
    {
      label: "Antigravity",
      value: "antigravity",
      description: "MCP server config (workspace-level)",
    },
    {
      label: "Kilo",
      value: "kilo" as InstallTarget,
      description: "Existing JSONC/legacy MCP config, permissions, workflow rules",
    },
    {
      label: "Codex",
      value: "codex" as InstallTarget,
      description: "MCP server, AGENTS.md",
    },
    {
      label: "ZCode",
      value: "zcode" as InstallTarget,
      description: "MCP server, prompt hook, workflow rules, skill",
    },
  ]);

  return selected.filter((value): value is InstallTarget =>
    VALID_TARGETS.includes(value as InstallTarget)
  );
}

export async function runInstall(args: string[]): Promise<InstallOutcome> {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("megamemory"))} ${pc.dim("install")}`);
  console.log();

  const runtime = await detectGlobalCommand();
  const options: InstallOptions = { dryRun: args.includes("--dry-run"), global: args.includes("--global"), link: args.includes("--link"), uninstall: args.includes("--uninstall") };
  const targetConfigs = createTargetConfigs(runtime, options);

  let targets: InstallTarget[];
  try {
    targets = parseTargets(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    console.log(pc.dim(`  Example: ${pc.cyan("megamemory install --target claudecode")}`));
    console.log();
    process.exit(1);
  }

  if (targets.length === 0) {
    targets = await chooseTargetsInteractively();
  }

  if (targets.length === 0) {
    warn("No targets selected. Nothing to do.");
    console.log();
    return { ok: true, succeeded: 0, failed: [], skipped: [] };
  }

  if (options.uninstall && (targets.length !== 1 || targets[0] !== "zcode" || options.dryRun || options.global || options.link)) {
    const message = "--uninstall поддержан только для --target zcode (без других флагов); файлы не тронуты.";
    error(message);
    process.exitCode = 1;
    return { ok: false, succeeded: 0, failed: [{ target: "install", targetLabel: "install", name: "Install options", error: message }], skipped: [] };
  }

  if ((options.dryRun || options.global) && targets.some((target) => target !== "kilo" && target !== "zcode")) {
    const message = "--dry-run and --global are supported only with --target kilo,zcode; no files written.";
    error(message);
    process.exitCode = 1;
    return { ok: false, succeeded: 0, failed: [{ target: "install", targetLabel: "install", name: "Install options", error: message }], skipped: [] };
  }
  if (options.link && targets.some((target) => target !== "kilo")) {
    const message = "--link is supported only with --target kilo; no files written.";
    error(message);
    process.exitCode = 1;
    return { ok: false, succeeded: 0, failed: [{ target: "install", targetLabel: "install", name: "Install options", error: message }], skipped: [] };
  }

  if (options.uninstall) {
    let removed: boolean;
    try {
      removed = uninstallZcodeHook();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`Uninstall failed: ${msg}`);
      process.exitCode = 1;
      return { ok: false, succeeded: 0, failed: [{ target: "zcode", targetLabel: "ZCode", name: "Uninstall prompt hook", error: msg }], skipped: [] };
    }
    if (removed) {
      success(`Хук megamemory снят из ${pc.dim(ZCODE_CONFIG_PATH)}; MCP-сервер, правила и скилл остались на месте.`);
    } else {
      info(`Хук не установлен; ${pc.dim(ZCODE_CONFIG_PATH)} не менялся.`);
    }
    console.log();
    return { ok: true, succeeded: removed ? 1 : 0, failed: [], skipped: [] };
  }

  const steps: StepResult[] = [];
  const skipped: Array<{ target: string; targetLabel: string; name: string }> = [];

  for (const target of targets) {
    const targetConfig = targetConfigs[target];
    heading(`  ${pc.cyan(targetConfig.label)} ${pc.dim(`(${targetConfig.description})`)}`);

    for (let i = 0; i < targetConfig.steps.length; i += 1) {
      const step = targetConfig.steps[i];
      heading(`    ${i + 1}. ${step.name}`);
      try {
        await step.run();
        steps.push({
          target,
          targetLabel: targetConfig.label,
          name: step.name,
          ok: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`${step.name} failed: ${msg}`);
        steps.push({
          target,
          targetLabel: targetConfig.label,
          name: step.name,
          ok: false,
          error: msg,
        });

        if (step.critical) {
          warn(`Skipping remaining ${targetConfig.label} steps because ${step.name} failed.`);
          // План 06 (C-01): пропущенные шаги фиксируются явно — оставшиеся
          // шаги цели не были выполнены, и молча считать target настроенным
          // нельзя.
          for (const rest of targetConfig.steps.slice(i + 1)) {
            skipped.push({
              target,
              targetLabel: targetConfig.label,
              name: rest.name,
            });
          }
          break;
        }
      }
      console.log();
    }
  }

  const failed = steps.filter((s) => !s.ok);
  if (failed.length === 0) {
    console.log(`  ${pc.green(pc.bold("Done."))}`);
    if (!options.dryRun) {
      console.log(
        pc.dim(`  Semantic search is off until this project's base has a vector generation: run ${pc.cyan("megamemory reembed")} in the project once.`)
      );
    }
    if (targets.includes("opencode")) {
      console.log(
        pc.dim(`  Restart opencode, then run ${pc.cyan("/user:bootstrap-memory")} in your project.`)
      );
      console.log(
        pc.dim(`  Use ${pc.cyan("/user:save-memory")} after each session to persist learnings.`)
      );
    }
    if (targets.includes("claudecode")) {
      console.log(
        pc.dim(`  Restart Claude Code so it reloads ${pc.cyan("~/.claude.json")} and commands.`)
      );
    }
    if (targets.includes("codex")) {
      console.log(
        pc.dim(`  Restart Codex so it reloads ${pc.cyan(CODEX_CONFIG_PATH)}.`)
      );
    }
    if (targets.includes("zcode")) {
      console.log(
        pc.dim(`  Restart ZCode so it reloads ${pc.cyan(ZCODE_CONFIG_PATH)}.`)
      );
    }
  } else {
    console.log(
      `  ${pc.yellow(pc.bold("Done with issues."))} ${pc.yellow(`${failed.length} step(s) failed:`)}`
    );
    for (const f of failed) {
      console.log(
        `    ${pc.red("✗")} ${f.targetLabel} — ${f.name}: ${pc.dim(f.error ?? "unknown error")}`
      );
    }
    console.log();
    console.log(pc.dim(`  Steps that succeeded will still work. Fix the issues above and re-run.`));
  }
  if (skipped.length > 0) {
    console.log(
      `  ${pc.yellow(`${skipped.length} step(s) skipped:`)}`
    );
    for (const item of skipped) {
      console.log(`    ${pc.dim("-")} ${item.targetLabel} — ${item.name}`);
    }
  }
  console.log();
  const outcome: InstallOutcome = {
    ok: failed.length === 0,
    succeeded: steps.length - failed.length,
    failed: failed.map((f) => ({
      target: f.target,
      targetLabel: f.targetLabel,
      name: f.name,
      error: f.error,
    })),
    skipped,
  };
  // План 06 (C-01): провал виден и прямому вызывающему runInstall —
  // process.exitCode даёт ненулевой код завершения процесса без выброса
  // exit-а в in-process вызывающих (те читают структурированный итог).
  if (!outcome.ok) process.exitCode = 1;
  return outcome;
}
