import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditHarnessError, auditFixture, type AuditFixture } from "./helpers/audit.js";

const boundary = vi.hoisted(() => ({ unexpected: [] as string[] }));
vi.mock("child_process", () => {
  const blocked = (command: unknown, args?: unknown): never => {
    const text = String(command);
    const structured = /(?:^|[\\/])(?:where(?:\.exe)?|which)$/i.test(text) &&
      Array.isArray(args) && args.length === 1 && ["megamemory", "codex"].includes(String(args[0]));
    if (!structured && !/^(where|which) (megamemory|codex)$/.test(text)) boundary.unexpected.push(text);
    throw Object.assign(new Error("No external commands in installer fixtures"), { code: "ENOENT" });
  };
  return { execSync: blocked, exec: blocked, execFile: blocked, execFileSync: blocked, spawn: blocked, spawnSync: blocked, fork: blocked };
});

let fixture: AuditFixture;
let config: string;

beforeEach(() => {
  fixture = auditFixture();
  const { home } = fixture.isolateHome();
  vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(home, "opencode"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  boundary.unexpected.length = 0;
  vi.resetModules(); // install reads HOME at module evaluation time.
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.close();
  if (boundary.unexpected.length) {
    throw new AuditHarnessError(`Unexpected installer command(s), blocked before execution: ${boundary.unexpected.join(", ")}`);
  }
});

const target = '[mcp_servers.megamemory]\ncommand = "old-memory"\nargs = ["--old"]\n';
const dev = '[mcp_servers.megamemory-dev]\ncommand = "dev-server"\nargs = ["--dev", "данные"]\n';
const second = '[mcp_servers.megamemory2]\ncommand = "second-server"\nargs = ["--keep"]\n';
const features = '[features]\nweb_search = false\n';

async function installCodex() {
  const { runInstall } = await import("../install.js");
  await runInstall(["--target", "codex"]);
  return fs.readFileSync(config, "utf8");
}

describe("C-02 Codex install replaces only the exact megamemory TOML table", () => {
  it("retains megamemory-dev, megamemory2 and features after updating the target", async () => {
    fs.writeFileSync(config, `model = "kept-model"\n\n${target}\n${dev}\n${second}\n${features}`, "utf8");

    const updated = await installCodex();

    expect(updated).toContain('model = "kept-model"');
    expect(updated).toContain('[mcp_servers.megamemory]\ncommand = "node"');
    expect(updated).not.toContain('command = "old-memory"');
    expect(updated, "C-02: the -dev table is a different server, not part of the target").toContain(dev);
    expect(updated).toContain(second);
    expect(updated).toContain(features);
  });

  it("appends an absent target without changing similarly named servers", async () => {
    const original = `${dev}\n${second}\n${features}`;
    fs.writeFileSync(config, original, "utf8");

    const updated = await installCodex();

    expect(updated.startsWith(original)).toBe(true);
    expect(updated.match(/^\[mcp_servers\.megamemory\]$/gm)).toHaveLength(1);
    expect(updated).toContain('[mcp_servers.megamemory]\ncommand = "node"');
  });

  it("updates an isolated target and keeps a following unrelated table", async () => {
    fs.writeFileSync(config, `${target}\n${features}`, "utf8");

    const updated = await installCodex();

    expect(updated).not.toContain('command = "old-memory"');
    expect(updated).toContain('[mcp_servers.megamemory]\ncommand = "node"');
    expect(updated).toContain(features);
    expect(updated.match(/^\[mcp_servers\.megamemory\]$/gm)).toHaveLength(1);
  });
});
