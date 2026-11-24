import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS_MD_SNIPPET } from "../guide.js";
import type { VectorChannelState } from "../embeddings.js";
import { cleanupDir } from "./helpers/cleanup.js";

const { execFileSyncMock, execSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => {
    throw Object.assign(new Error("not found in isolated profile"), { code: "ENOENT" });
  }),
  execSyncMock: vi.fn(() => {
    throw new Error("Shell execution is forbidden in install tests");
  }),
}));

vi.mock("child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execSyncMock,
}));

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_SOURCE_PATH = path.join(PROJECT_ROOT, "plugin", "megamemory.ts");
const BOOTSTRAP_SOURCE_PATH = path.join(PROJECT_ROOT, "commands", "bootstrap-memory.md");
const SAVE_SOURCE_PATH = path.join(PROJECT_ROOT, "commands", "save-memory.md");
const EXPECTED_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8")
).version as string;
const EXPECTED_STAMP = `<!-- megamemory:instructions v${PACKAGE_VERSION} -->`;

interface Sandbox {
  root: string;
  homeDir: string;
  workspaceDir: string;
  opencodeDir: string;
}

const sandboxes: Sandbox[] = [];
const originalCwd = process.cwd();
let originalExitCode: typeof process.exitCode;
const realHomes = [...new Set([process.env.HOME, process.env.USERPROFILE, os.homedir()].filter((dir): dir is string => Boolean(dir)))];
const realConfigPaths = [
  ...realHomes.flatMap((home) => [
    path.join(home, ".claude.json"), path.join(home, ".claude", "CLAUDE.md"),
    path.join(home, ".codex", "config.toml"), path.join(home, ".codex", "AGENTS.md"),
    path.join(home, ".config", "kilo", "kilo.jsonc"), path.join(home, ".config", "kilo", "AGENTS.md"),
    path.join(home, ".kilocode", "mcp_settings.json"), path.join(home, ".kilocode", "settings", "mcp_settings.json"),
    path.join(home, ".config", "opencode", "opencode.json"), path.join(home, ".config", "opencode", "AGENTS.md"),
    path.join(home, ".zcode", "cli", "config.json"), path.join(home, ".zcode", "AGENTS.md"),
    path.join(home, ".zcode", "skills", "megamemory", "SKILL.md"),
  ]),
  ...[process.env.APPDATA, process.env.LOCALAPPDATA].filter((dir): dir is string => Boolean(dir)).flatMap((dir) => [
    path.join(dir, "Code", "User", "globalStorage", "kilocode.kilo-code", "settings", "mcp_settings.json"),
    path.join(dir, "Kilo", "kilo.jsonc"), path.join(dir, "opencode", "opencode.json"),
  ]),
  ...[process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.OPENCODE_CONFIG_DIR, process.env.XDG_CONFIG_HOME]
    .filter((dir): dir is string => Boolean(dir))
    .flatMap((dir) => ["config.toml", "AGENTS.md", "CLAUDE.md", "opencode.json", "kilo/kilo.jsonc"].map((file) => path.join(dir, file))),
];

function configHashes(files: string[]): Record<string, string | null> {
  return Object.fromEntries(files.map((file) => [file,
    fs.existsSync(file) && fs.statSync(file).isFile()
      ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null,
  ]));
}

function sandboxTree(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? [file, ...sandboxTree(file)] : [file];
  }).sort();
}

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-install-test-"));
  const homeDir = path.join(root, "home");
  const workspaceDir = path.join(root, "workspace");
  const opencodeDir = path.join(root, "opencode-config");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(opencodeDir, { recursive: true });

  const sandbox = { root, homeDir, workspaceDir, opencodeDir };
  sandboxes.push(sandbox);
  return sandbox;
}

async function loadInstallModule(sandbox: Sandbox) {
  for (const [key, value] of Object.entries({
    HOME: sandbox.homeDir, USERPROFILE: sandbox.homeDir,
    APPDATA: path.join(sandbox.homeDir, "AppData/Roaming"),
    LOCALAPPDATA: path.join(sandbox.homeDir, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(sandbox.homeDir, ".config"),
    XDG_CACHE_HOME: path.join(sandbox.homeDir, ".cache"),
    XDG_DATA_HOME: path.join(sandbox.homeDir, ".local/share"),
    OPENCODE_CONFIG_DIR: sandbox.opencodeDir,
    CODEX_HOME: path.join(sandbox.homeDir, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(sandbox.homeDir, ".claude"),
    MEGAMEMORY_DB_PATH: path.join(sandbox.root, "never-opened.db"),
  })) vi.stubEnv(key, value);
  process.chdir(sandbox.workspaceDir);
  vi.resetModules();
  return import("../install.js");
}

beforeEach(() => {
  originalExitCode = process.exitCode;
  execFileSyncMock.mockClear();
  execSyncMock.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  for (const sandbox of sandboxes.splice(0)) {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

describe("runInstall", () => {
  it.each(["opencode", "claudecode", "antigravity", "codex", "kilo", "zcode", "opencode,zcode,kilo"])(
    "prints once-per-project reembed advice once for successful target(s) %s", async (targets) => {
      const sandbox = makeSandbox();
      fs.writeFileSync(path.join(sandbox.workspaceDir, "kilo.jsonc"), "{}\n", "utf8");
      const realHashes = configHashes(realConfigPaths);
      const { runInstall } = await loadInstallModule(sandbox);
      expect((await runInstall(["--target", targets])).ok).toBe(true);
      const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(printed.match(/Semantic search is off until this project's base has a vector generation/g)).toHaveLength(1);
      expect(printed).toContain("megamemory reembed");
      expect(printed).toContain("in the project once.");
      expect(fs.existsSync(path.join(sandbox.root, "never-opened.db"))).toBe(false);
      expect(configHashes(realConfigPaths)).toEqual(realHashes);
    }
  );

  it.each([
    { name: "dry-run", args: ["--target", "zcode", "--dry-run"], malformed: false },
    { name: "uninstall", args: ["--target", "zcode", "--uninstall"], malformed: false },
    { name: "failed install", args: ["--target", "antigravity"], malformed: true },
  ])("does not print successful-install reembed advice for $name", async ({ args, malformed }) => {
    const sandbox = makeSandbox();
    if (malformed) fs.writeFileSync(path.join(sandbox.workspaceDir, "mcp_config.json"), '{"mcpServers": ', "utf8");
    const { runInstall } = await loadInstallModule(sandbox);
    expect((await runInstall(args)).ok).toBe(!malformed);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("Semantic search is off until");
  });

  it.each(["kilo,opencode", "opencode,kilo", "kilo,claudecode"]) (
    "rejects mixed --dry-run targets %s before any file operation", async (targets) => {
      const sandbox = makeSandbox();
      const kiloConfig = path.join(sandbox.workspaceDir, "kilo.jsonc");
      const opencodeConfig = path.join(sandbox.opencodeDir, "opencode.json");
      fs.writeFileSync(kiloConfig, '{"mcp": {}}\n', "utf8");
      fs.writeFileSync(opencodeConfig, '{"theme": "dark"}\n', "utf8");
      const tree = sandboxTree(sandbox.root);
      const hashes = configHashes(tree);
      const realHashes = configHashes(realConfigPaths);
      const { runInstall } = await loadInstallModule(sandbox);
      const writes = [
        vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "mkdirSync"),
        vi.spyOn(fs, "copyFileSync"), vi.spyOn(fs, "renameSync"), vi.spyOn(fs, "symlinkSync"),
      ];

      const outcome = await runInstall(["--target", targets, "--dry-run"]);

      expect(outcome).toMatchObject({ ok: false, succeeded: 0, skipped: [] });
      expect(outcome.failed).toHaveLength(1);
      expect(outcome.failed[0]).toMatchObject({ target: "install", name: "Install options" });
      expect(outcome.failed[0].error).toContain("supported only with --target kilo");
      expect(process.exitCode).toBe(1);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(sandboxTree(sandbox.root)).toEqual(tree);
      expect(configHashes(tree)).toEqual(hashes);
      expect(configHashes(realConfigPaths)).toEqual(realHashes);
    }
  );

  it("merges a valid opencode config without removing unrelated keys", async () => {
    const sandbox = makeSandbox();
    const opencodeConfigPath = path.join(sandbox.opencodeDir, "opencode.json");

    fs.writeFileSync(
      opencodeConfigPath,
      `${JSON.stringify(
        {
          theme: "dark",
          mcp: {
            existing: { type: "remote", url: "https://example.test" },
          },
        },
        null,
        2
      )}\n`
    );

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    const updated = JSON.parse(fs.readFileSync(opencodeConfigPath, "utf-8"));

    expect(updated.theme).toBe("dark");
    expect(updated.$schema).toBe("https://opencode.ai/config.json");
    expect(updated.mcp.existing).toEqual({ type: "remote", url: "https://example.test" });
    expect(updated.mcp.megamemory).toEqual({
      type: "local",
      command: ["node", EXPECTED_ENTRY],
      enabled: true,
    });
  });

  it("leaves malformed antigravity config untouched", async () => {
    const sandbox = makeSandbox();
    const antigravityConfigPath = path.join(sandbox.workspaceDir, "mcp_config.json");
    const malformed = '{"mcpServers": '; 

    fs.writeFileSync(antigravityConfigPath, malformed);

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "antigravity"]);

    expect(fs.readFileSync(antigravityConfigPath, "utf-8")).toBe(malformed);
    expect(fs.existsSync(`${antigravityConfigPath}.bak`)).toBe(false);
  });

  it("leaves claude config untouched when mcpServers has an unsupported shape", async () => {
    const sandbox = makeSandbox();
    const claudeConfigPath = path.join(sandbox.homeDir, ".claude.json");
    const original = `${JSON.stringify({ mcpServers: [] }, null, 2)}\n`;

    fs.writeFileSync(claudeConfigPath, original);

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "claudecode"]);

    expect(fs.readFileSync(claudeConfigPath, "utf-8")).toBe(original);
  });

  it("skips later opencode steps when the MCP config step fails", async () => {
    const sandbox = makeSandbox();
    const opencodeConfigPath = path.join(sandbox.opencodeDir, "opencode.json");

    fs.writeFileSync(opencodeConfigPath, '{"mcp": ');

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    expect(fs.readFileSync(opencodeConfigPath, "utf-8")).toBe('{"mcp": ');
    expect(fs.existsSync(path.join(sandbox.opencodeDir, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.opencodeDir, "tool", "megamemory.ts"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.opencodeDir, "commands", "bootstrap-memory.md"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.opencodeDir, "commands", "save-memory.md"))).toBe(false);
  });

  it("updates managed files and skips conflicting unmarked files", async () => {
    const sandbox = makeSandbox();
    const opencodeConfigPath = path.join(sandbox.opencodeDir, "opencode.json");
    const pluginPath = path.join(sandbox.opencodeDir, "tool", "megamemory.ts");
    const bootstrapPath = path.join(sandbox.opencodeDir, "commands", "bootstrap-memory.md");
    const savePath = path.join(sandbox.opencodeDir, "commands", "save-memory.md");

    fs.writeFileSync(opencodeConfigPath, `${JSON.stringify({}, null, 2)}\n`);
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(
      pluginPath,
      "// MegaMemory-managed file. Safe for megamemory install to update.\nexport default 'old';\n"
    );
    fs.writeFileSync(bootstrapPath, "# My custom command\n");

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    expect(fs.readFileSync(pluginPath, "utf-8")).toBe(fs.readFileSync(PLUGIN_SOURCE_PATH, "utf-8"));
    expect(fs.readFileSync(bootstrapPath, "utf-8")).toBe("# My custom command\n");
    // Step 7.2: generated command files carry the version stamp on top of
    // the source content.
    const saved = fs.readFileSync(savePath, "utf-8");
    expect(saved).toContain(EXPECTED_STAMP);
    expect(saved.replace(`${EXPECTED_STAMP}\n`, "")).toBe(fs.readFileSync(SAVE_SOURCE_PATH, "utf-8"));
  });

  it("is idempotent on repeated opencode installs", async () => {
    const sandbox = makeSandbox();
    const { runInstall } = await loadInstallModule(sandbox);

    await runInstall(["--target", "opencode"]);

    const firstConfig = fs.readFileSync(path.join(sandbox.opencodeDir, "opencode.json"), "utf-8");
    const firstAgents = fs.readFileSync(path.join(sandbox.opencodeDir, "AGENTS.md"), "utf-8");
    const firstPlugin = fs.readFileSync(path.join(sandbox.opencodeDir, "tool", "megamemory.ts"), "utf-8");
    const firstBootstrap = fs.readFileSync(
      path.join(sandbox.opencodeDir, "commands", "bootstrap-memory.md"),
      "utf-8"
    );
    const firstSave = fs.readFileSync(
      path.join(sandbox.opencodeDir, "commands", "save-memory.md"),
      "utf-8"
    );

    await runInstall(["--target", "opencode"]);

    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "opencode.json"), "utf-8")).toBe(firstConfig);
    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "AGENTS.md"), "utf-8")).toBe(firstAgents);
    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "tool", "megamemory.ts"), "utf-8")).toBe(firstPlugin);
    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "commands", "bootstrap-memory.md"), "utf-8")).toBe(
      firstBootstrap
    );
    expect(fs.readFileSync(path.join(sandbox.opencodeDir, "commands", "save-memory.md"), "utf-8")).toBe(firstSave);
    expect(firstPlugin).toBe(fs.readFileSync(PLUGIN_SOURCE_PATH, "utf-8"));
    // Stamp lands on line 2, right after the managed-file marker.
    const stamped = (file: string): string => {
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      lines.splice(1, 0, EXPECTED_STAMP);
      return lines.join("\n");
    };
    expect(firstBootstrap).toBe(stamped(BOOTSTRAP_SOURCE_PATH));
    expect(firstSave).toBe(stamped(SAVE_SOURCE_PATH));
  });

  it("keeps the claudecode install inside the $HOME sandbox", async () => {
    const sandbox = makeSandbox();
    const realHashes = configHashes(realConfigPaths);
    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "claudecode"]);

    // os.homedir() ignores $HOME on Windows — without the homeDir() override
    // this run rewrote the REAL ~/.claude/CLAUDE.md and ~/.claude.json.
    const claudeMd = fs.readFileSync(path.join(sandbox.homeDir, ".claude", "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain(EXPECTED_STAMP);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox.homeDir, ".claude.json"), "utf-8")).mcpServers.megamemory).toBeTruthy();
    expect(configHashes(realConfigPaths)).toEqual(realHashes);
  });

  it("writes a version-stamped block with supersedes rules into a fresh AGENTS.md", async () => {
    const sandbox = makeSandbox();
    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    const agents = fs.readFileSync(path.join(sandbox.opencodeDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain(EXPECTED_STAMP);
    expect(agents).toContain("/megamemory-snippet");
    expect(agents).toContain("supersedes");
    // план 31: контракт установщика — в файл записан AGENTS_MD_SNIPPET целиком;
    // max_tokens/reembed уехали из сниппета в docs/agent-workflow.md
    // (греп-тест «термины в workflow-документе» в guide.test.ts)
    expect(agents).toContain(AGENTS_MD_SNIPPET.trimStart());
  });

  it("stamps every generated command file with the package.json version (step 7.4.2)", async () => {
    const sandbox = makeSandbox();
    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    for (const filename of ["bootstrap-memory.md", "save-memory.md"]) {
      const dest = fs.readFileSync(
        path.join(sandbox.opencodeDir, "commands", filename),
        "utf-8"
      );
      expect(dest).toContain(EXPECTED_STAMP);
      expect(dest.match(/megamemory:instructions/g)).toHaveLength(1);
    }
  });

  it("replaces a legacy unmarked block instead of skipping or duplicating", async () => {
    const sandbox = makeSandbox();
    const agentsPath = path.join(sandbox.opencodeDir, "AGENTS.md");
    fs.mkdirSync(sandbox.opencodeDir, { recursive: true });
    fs.writeFileSync(
      agentsPath,
      "# My agents file\n\n## Project Knowledge Graph\n\nOLD TEXT without any version markers.\n\n## Something Else\n\nKeep me.\n"
    );

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    const agents = fs.readFileSync(agentsPath, "utf-8");
    expect(agents).not.toContain("OLD TEXT");
    expect(agents).toContain(EXPECTED_STAMP);
    expect(agents).toContain("## Something Else"); // untouched sibling section
    expect(agents).toContain("Keep me.");
    expect(agents.match(/## Project Knowledge Graph/g)).toHaveLength(1);
  });

  it("repeated install refreshes the block byte-for-byte idempotently", async () => {
    const sandbox = makeSandbox();
    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);
    const first = fs.readFileSync(path.join(sandbox.opencodeDir, "AGENTS.md"), "utf-8");
    await runInstall(["--target", "opencode"]);
    const second = fs.readFileSync(path.join(sandbox.opencodeDir, "AGENTS.md"), "utf-8");
    expect(second).toBe(first);
    expect(second.match(/megamemory:instructions/g)).toHaveLength(1);
  });

  it("re-install updates the block between the markers and keeps surrounding text (step 7.4.1)", async () => {
    const sandbox = makeSandbox();
    const agentsPath = path.join(sandbox.opencodeDir, "AGENTS.md");
    fs.mkdirSync(sandbox.opencodeDir, { recursive: true });
    fs.writeFileSync(
      agentsPath,
      [
        "# My agents file\n",
        `<!-- megamemory:instructions v0.0.1 -->\n`,
        "## Project Knowledge Graph\n\n",
        "STALE WORKFLOW TEXT from an older package.\n\n",
        "<!-- /megamemory-snippet -->\n\n",
        "## User Section\n\nUser rules stay.\n",
      ].join("")
    );

    const { runInstall } = await loadInstallModule(sandbox);
    await runInstall(["--target", "opencode"]);

    const agents = fs.readFileSync(agentsPath, "utf-8");
    expect(agents).toContain("# My agents file");
    expect(agents).toContain(EXPECTED_STAMP);
    expect(agents).not.toContain("STALE WORKFLOW TEXT");
    expect(agents).not.toContain("v0.0.1");
    expect(agents).toContain("## User Section");
    expect(agents).toContain("User rules stay.");
    expect(agents.match(/megamemory:instructions/g)).toHaveLength(1);
  });
});

describe("Plan 33 A5 runReembed messages", () => {
  const cases: Array<{ name: string; channel: VectorChannelState; recorded?: string; expected: string; forbidden: string[] }> = [
    { name: "first generation without a model stamp", channel: { state: "off", reason: "no_generation" }, expected: "no vector generation yet — this run creates it (first run downloads the model once)", forbidden: ["model changed:", "embeddings already match"] },
    { name: "first generation with the current model stamp", channel: { state: "off", reason: "no_generation" }, recorded: "current", expected: "no vector generation yet — this run creates it", forbidden: ["model changed:", "embeddings already match"] },
    { name: "generation with no published vectors", channel: { state: "off", reason: "generation_without_vectors" }, recorded: "current", expected: "has no published vectors yet — reembedding eligible nodes", forbidden: ["model changed:", "embeddings already match"] },
    { name: "matching fully indexed generation", channel: { state: "on" }, recorded: "current", expected: "embeddings already match", forbidden: ["model changed:", "no vector generation yet", "reindexing anyway"] },
    { name: "partial vector coverage", channel: { state: "partial", missing: 3, total: 5 }, recorded: "current", expected: "is incomplete: 3/5 node(s) have no vectors — continuing reembed", forbidden: ["embeddings already match", "model changed:"] },
    { name: "another recorded model", channel: { state: "off", reason: "model_mismatch" }, recorded: "other-model", expected: "model changed: other-model ->", forbidden: ["embeddings already match", "no vector generation yet"] },
    { name: "same-model incompatible profile", channel: { state: "off", reason: "model_mismatch" }, recorded: "current", expected: "vector generation profile does not match", forbidden: ["model changed:", "embeddings already match"] },
    { name: "explicit text-only mode", channel: { state: "off", reason: "text_only_mode" }, recorded: "current", expected: "semantic search remains disabled while MEGAMEMORY_SEARCH=fts", forbidden: ["model changed:", "embeddings already match", "vector search starts after"] },
  ];

  it.each(cases)("reports $name truthfully without downloading a model", async ({ channel, recorded, expected, forbidden }) => {
    const sandbox = makeSandbox();
    try {
      await loadInstallModule(sandbox);
      const { KnowledgeDB } = await import("../db.js");
      const embeddings = await import("../embeddings.js");
      const reembedModule = await import("../reembed.js");
      const dbPath = path.join(sandbox.workspaceDir, "reembed.db");
      const fixture = new KnowledgeDB(dbPath);
      try {
        if (recorded) fixture.setMetaValue("embed_model", recorded === "current" ? embeddings.MODEL_NAME : recorded);
      } finally {
        fixture.close();
      }
      const channelSpy = vi.spyOn(embeddings, "vectorChannelState").mockReturnValue(channel);
      const reembedSpy = vi.spyOn(reembedModule, "reembed").mockResolvedValue({ processed: 2, total: 2, dim: 4, model: embeddings.MODEL_NAME });
      const closeSpy = vi.spyOn(KnowledgeDB.prototype, "close");
      const { runReembed } = await import("../reembed-cli.js");

      await runReembed(["--db", dbPath, "--batch", "2"]);

      const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(printed).toContain(expected);
      for (const text of forbidden) expect(printed).not.toContain(text);
      if (channel.state === "partial") {
        expect(printed).toContain("vector search covers indexed nodes only");
        expect(printed).toContain("every query word must occur");
      }
      expect(channelSpy).toHaveBeenCalledOnce();
      expect(reembedSpy).toHaveBeenCalledWith(expect.any(KnowledgeDB), expect.objectContaining({ batch: 2, onProgress: expect.any(Function) }));
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(printed).toContain("reembedded 2 node(s), dim=4");
    } finally {
      process.chdir(originalCwd);
      // Mock call arguments retain the closed DB; release them before native GC.
      vi.clearAllMocks();
      vi.restoreAllMocks();
      (globalThis as { gc?: () => void }).gc?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await cleanupDir(sandbox.root);
      expect(fs.existsSync(sandbox.root), "CLI native DB sandbox must be removed").toBe(false);
    }
  });
});
