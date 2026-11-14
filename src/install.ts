import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { success, skip, error, info, heading, warn, multiSelect } from "./cli-utils.js";
import { INSTRUCTIONS_STAMP_MARKER, instructionsStamp } from "./instructions.js";
// F2 (2.1.5): the snippet lives in guide.ts — `megamemory guide` prints the
// very same constant, so the printed text cannot drift from the written one.
import { AGENTS_MD_END, AGENTS_MD_SNIPPET } from "./guide.js";

export type InstallTarget = "opencode" | "claudecode" | "antigravity" | "codex";

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

const OPENCODE_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ??
  path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(homeDir(), ".config"),
    "opencode"
  );
const OPENCODE_CONFIG_PATH = path.join(OPENCODE_CONFIG_DIR, "opencode.json");
const OPENCODE_AGENTS_MD_PATH = path.join(OPENCODE_CONFIG_DIR, "AGENTS.md");
const OPENCODE_TOOL_DIR = path.join(OPENCODE_CONFIG_DIR, "tool");
const OPENCODE_COMMANDS_DIR = path.join(OPENCODE_CONFIG_DIR, "commands");

const CLAUDE_CONFIG_PATH = path.join(homeDir(), ".claude.json");
const CLAUDE_DIR = path.join(homeDir(), ".claude");
const CLAUDE_MD_PATH = path.join(CLAUDE_DIR, "CLAUDE.md");
const CLAUDE_COMMANDS_DIR = path.join(CLAUDE_DIR, "commands");

const ANTIGRAVITY_CONFIG_PATH = path.join(process.cwd(), "mcp_config.json");

// B-10 (аудит 2026-11-12): постоянный профиль Codex — активный CODEX_HOME,
// если переменная задана непустым (после trim) значением; значение
// используется как есть — пути с пробелами и кириллицей допустимы. Иначе —
// прежний homeDir()/.codex. CODEX_HOME и раньше учитывался при
// staging-вызове Codex CLI, но целевые пути считались только от HOME:
// установщик писал конфигурацию не в активный профиль и сообщал ложный
// успех. Один resolved target используется для config.toml, AGENTS.md и
// сообщений установки; изолированный staging-каталог для CLI-вызова —
// отдельный временный CODEX_HOME (см. setupCodexConfig).
const CODEX_DIR =
  process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ""
    ? process.env.CODEX_HOME
    : path.join(homeDir(), ".codex");
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const CODEX_AGENTS_MD_PATH = path.join(CODEX_DIR, "AGENTS.md");

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

/**
 * os.homedir() ignores $HOME on Windows (it reads USERPROFILE), so the test
 * sandbox leaked into the real user profile — install tests rewrote the real
 * ~/.claude.json and ~/.claude/CLAUDE.md. Honor $HOME explicitly: prod runs
 * are unaffected (Git Bash sets it to the same value), sandboxes are airtight.
 */
function homeDir(): string {
  return process.env.HOME ?? os.homedir();
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
    fs.writeFileSync(filePath, block);
    return "created";
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const markerIdx = content.indexOf(AGENTS_MD_MARKER);
  if (markerIdx === -1) {
    fs.writeFileSync(filePath, content.replace(/\r?\n*$/, "\n\n") + block);
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
    fs.writeFileSync(filePath, updated);
    return "replaced";
  }

  // Legacy unmarked snippet: cut to the next "## " heading (exclusive).
  const nextHeading = content.indexOf("\n## ", markerIdx);
  const cutEnd = nextHeading === -1 ? content.length : nextHeading + 1;
  const updated = content.slice(0, markerIdx) + block + content.slice(cutEnd);
  fs.writeFileSync(filePath, updated);
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

    fs.writeFileSync(dest, sourceContent);
    success(`Updated tool plugin at ${pc.dim(dest)}`);
    return;
  }

  fs.writeFileSync(dest, sourceContent);
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

    fs.writeFileSync(dest, stampedSource);
    success(`Updated ${label} at ${pc.dim(dest)}`);
    return;
  }

  fs.writeFileSync(dest, stampedSource);
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

  fs.writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

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

  fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

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

  fs.writeFileSync(ANTIGRAVITY_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

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
 * C-02 (plan 05): sibling temp file + rename — a failed or interrupted write
 * can never leave a truncated config behind; the previous bytes stay intact
 * until the rename succeeds.
 */
function writeFileSyncAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.megamemory-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* the tmp file is best-effort */ }
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
      if (existed) fs.writeFileSync(path.join(staging, "config.toml"), existing, "utf8");
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

function createTargetConfigs(runtime: CommandRuntime): Record<InstallTarget, TargetConfig> {
  return {
    opencode: {
      label: "opencode",
      description: "MCP server, AGENTS.md, skill plugin, commands",
      steps: [
        { name: "MCP server config", critical: true, run: () => setupOpencodeMcpConfig(runtime) },
        { name: "Global AGENTS.md", run: () => setupInstructionFile(OPENCODE_AGENTS_MD_PATH) },
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
        { name: "Global CLAUDE.md", run: () => setupInstructionFile(CLAUDE_MD_PATH) },
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
    codex: {
      label: "Codex",
      description: "MCP server, AGENTS.md",
      steps: [
        { name: "MCP server config", critical: true, run: () => setupCodexConfig(runtime) },
        { name: "Global AGENTS.md", run: () => setupInstructionFile(CODEX_AGENTS_MD_PATH) },
      ],
    },
  };
}

const VALID_TARGETS: InstallTarget[] = ["opencode", "claudecode", "antigravity", "codex"];

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

    throw new Error(`Unknown install option '${arg}'. Supported: --target <name>`);
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
      label: "Codex",
      value: "codex" as InstallTarget,
      description: "MCP server, AGENTS.md",
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
  const targetConfigs = createTargetConfigs(runtime);

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
