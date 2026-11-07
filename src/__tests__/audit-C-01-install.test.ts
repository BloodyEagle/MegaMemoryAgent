import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditHarnessError, auditFixture, type AuditFixture } from "./helpers/audit.js";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const install = new URL("../../dist/install.js", import.meta.url).href;
let fixture: AuditFixture;

beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function runInstaller(home: ReturnType<AuditFixture["profile"]>, entry: "runInstall" | "CLI") {
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
childProcess.execSync = (command) => {
  if (/^(where|which) (megamemory|codex)$/.test(command)) {
    throw Object.assign(new Error("Not installed in the audit fixture"), { code: "ENOENT" });
  }
  return blocked(command);
};
for (const key of ["exec", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
  childProcess[key] = blocked;
}
syncBuiltinESMExports();
`, "utf8");
  const args = entry === "CLI"
    ? [cli, "install", "--target", "claudecode"]
    : ["--input-type=module", "--eval", `const { runInstall } = await import(${JSON.stringify(install)}); await runInstall(["--target", "claudecode"]);`];
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

describe("C-01 installer reports configuration failure to its caller", () => {
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
