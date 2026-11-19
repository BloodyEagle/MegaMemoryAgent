import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditHarnessError, auditFixture, type AuditFixture } from "./helpers/audit.js";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const install = new URL("../../dist/install.js", import.meta.url).href;
let fixture: AuditFixture;

beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function runInstaller(home: ReturnType<AuditFixture["profile"]>, entry: "runInstall" | "CLI", target: "claudecode" | "kilo" = "claudecode") {
  if (!fs.existsSync(cli)) throw new AuditHarnessError("Build dist before running C-01 subprocess tests");
  const guard = fixture.file("installer-process-boundary.mjs");
  // Mock only the OS-command boundary, not the installer. No where/which,
  // installed CLI, shell, or external command is ever executed in these tests.
  fs.writeFileSync(guard, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const blocked = (command) => {
  console.error("[HARNESS_BLOCKED_COMMAND]", command);
  throw new Error("Unexpected external command in isolated installer");
};
// The installer locates global commands via execFileSync(<where.exe|which>, [name])
// (System32 absolute path on win32) — that lookup is mocked to ENOENT. Everything
// else on the process boundary is blocked outright.
const isLocator = (command, args) => /(?:^|[\\\\/])(?:where(?:\\.exe)?|which)$/i.test(String(command)) &&
  Array.isArray(args) && args.length === 1 && ["megamemory", "codex"].includes(String(args[0]));
childProcess.execFileSync = (command, args) => {
  if (isLocator(command, args)) {
    throw Object.assign(new Error("Not installed in the audit fixture"), { code: "ENOENT" });
  }
  return blocked(command);
};
childProcess.execSync = (command) => {
  if (/^(where|which) (megamemory|codex)$/.test(command)) {
    throw Object.assign(new Error("Not installed in the audit fixture"), { code: "ENOENT" });
  }
  return blocked(command);
};
for (const key of ["exec", "execFile", "spawn", "spawnSync", "fork"]) {
  childProcess[key] = blocked;
}
syncBuiltinESMExports();
`, "utf8");
  const args = entry === "CLI"
    ? [cli, "install", "--target", target]
    : ["--input-type=module", "--eval", `const { runInstall } = await import(${JSON.stringify(install)}); await runInstall(${JSON.stringify(["--target", target])});`];
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, ...args], {
    cwd: fixture.root,
    env: {
      ...home.env, NODE_OPTIONS: "", NO_COLOR: "1", MEGAMEMORY_DB_PATH: "",
      OPENCODE_CONFIG_DIR: path.join(home.home, ".config", "opencode"),
      XDG_CONFIG_HOME: path.join(home.home, ".config"),
    },
    shell: false, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.error || result.signal || result.status === null || result.stderr.includes("[HARNESS_BLOCKED_COMMAND]")) {
    throw new AuditHarnessError(`Installer subprocess failed outside its contract: ${result.error?.message ?? result.signal ?? result.stderr}`, { cause: result.error });
  }
  return result;
}

function profileState(root: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? [[file, "directory"], ...Object.entries(profileState(file))] :
      [[file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]];
  }));
}

describe("C-01 installer reports configuration failure to its caller", () => {
  it("CLI warns with a usable Kilo snippet and changes no files when the config is missing", () => {
    const profile = fixture.profile();
    const before = profileState(fixture.root);

    const result = runInstaller(profile, "CLI", "kilo");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Kilo config not found. No files created.");
    expect(result.stdout).toContain("./kilo.jsonc");
    expect(result.stdout).toContain('"mcp"');
    expect(result.stdout).toContain('"megamemory"');
    expect(result.stdout).toContain('"megamemory_create_concept": "allow"');
    expect(result.stdout).toContain('"instructions"');
    expect(result.stdout).toContain(".kilo/rules/megamemory.md");
    expect(result.stderr).not.toContain("failed:");
    const after = profileState(fixture.root);
    // The only extra file is the subprocess guard created by this harness.
    delete after[fixture.file("installer-process-boundary.mjs")];
    expect(after).toEqual(before);
  });

  it.each(["runInstall", "CLI"] as const)("%s rejects malformed Kilo JSONC without any generated files", (entry) => {
    const profile = fixture.profile();
    const config = fixture.file("kilo.jsonc");
    const malformed = '{\n  // preserve this malformed user configuration\n  "mcp": {\n';
    fs.writeFileSync(config, malformed, "utf8");
    const before = profileState(fixture.root);

    const result = runInstaller(profile, entry, "kilo");

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(config, "utf8")).toBe(malformed);
    expect(result.stderr).toContain("Kilo config and workflow rules failed:");
    expect(result.stderr).toContain("Left the existing file unchanged.");
    expect(result.stdout).toContain("Done with issues. 1 step(s) failed:");
    expect(result.stdout).toContain(config);
    const after = profileState(fixture.root);
    delete after[fixture.file("installer-process-boundary.mjs")];
    expect(after).toEqual(before);
    for (const generated of [".kilo", ".kilocode", ".agents", "AGENTS.md"]) {
      expect(fs.existsSync(path.join(fixture.root, generated))).toBe(false);
    }
  });

  it.each(["runInstall", "CLI"] as const)("%s fails on malformed JSON without changing the profile", (entry) => {
    const profile = fixture.profile();
    const config = path.join(profile.home, ".claude.json");
    const malformed = '{"mcpServers": '; // Deliberately incomplete; never a real profile.
    fs.writeFileSync(config, malformed, "utf8");

    const result = runInstaller(profile, entry);

    expect(fs.readFileSync(config, "utf8")).toBe(malformed);
    expect(fs.existsSync(path.join(profile.home, ".claude", "CLAUDE.md"))).toBe(false);
    expect(result.status, "C-01: a failed critical config step must produce a nonzero exit").not.toBe(0);
  });

  it("successfully merges a valid profile while preserving unrelated settings", () => {
    const profile = fixture.profile();
    const config = path.join(profile.home, ".claude.json");
    const existing = { theme: "dark", mcpServers: { neighbour: { command: "existing-server", args: ["--offline"] } } };
    fs.writeFileSync(config, `${JSON.stringify(existing)}\n`, "utf8");

    const result = runInstaller(profile, "CLI");

    expect(result.status).toBe(0);
    const updated = JSON.parse(fs.readFileSync(config, "utf8"));
    expect(updated.theme).toBe("dark");
    expect(updated.mcpServers.neighbour).toEqual(existing.mcpServers.neighbour);
    expect(updated.mcpServers.megamemory).toMatchObject({ command: "node", args: [cli] });
  });
});
