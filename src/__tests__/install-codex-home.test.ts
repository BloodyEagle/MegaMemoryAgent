/**
 * B-10 (аудит 2026-11-12): установщик Codex обязан писать в активный
 * CODEX_HOME, а не в HOME/.codex. Раньше постоянные пути Codex вычислялись
 * только от HOME: CODEX_HOME учитывался лишь при staging-вызове Codex CLI,
 * установка «успешно» создавала HOME/.codex, а активный профиль не менялся.
 *
 * HOME (dirA) и CODEX_HOME (dirB) — разные временные каталоги; dirB
 * содержит существующий config.toml с пользовательской опцией. Механизм
 * изоляции — vi.stubEnv + vi.resetModules + динамический import, как в
 * install-profile-contract.test.ts: константы install.ts читают
 * process.env при вычислении модуля. Внешние команды замоканы — реальные
 * профили не затрагиваются.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(() => { throw new Error("Shell execution forbidden in install tests"); }),
}));
vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: boundary.execFileSync,
  execSync: boundary.execSync,
}));

let root: string;
let homeA: string;
let codexHome: string;
let out: string[];
const originalCwd = process.cwd();
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-install-codex-home-"));
  homeA = path.join(root, "home");
  // CODEX_HOME с пробелами, кириллицей и спецсимволами — путь используется как есть.
  codexHome = path.join(root, "codex-профиль & данные (тест)");
  fs.mkdirSync(homeA, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  for (const [key, value] of Object.entries({
    HOME: homeA,
    USERPROFILE: homeA,
    APPDATA: path.join(homeA, "AppData/Roaming"),
    LOCALAPPDATA: path.join(homeA, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(homeA, ".config"),
    OPENCODE_CONFIG_DIR: path.join(homeA, "opencode"),
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(homeA, ".claude"),
    MEGAMEMORY_DB_PATH: path.join(root, "never-opened.db"),
  })) vi.stubEnv(key, value);
  originalExitCode = process.exitCode;
  process.chdir(root);
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  boundary.execFileSync.mockReset().mockImplementation(() => {
    throw Object.assign(new Error("Executable absent in isolated profile"), { code: "ENOENT" });
  });
  vi.resetModules();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function install() {
  const { runInstall } = await import("../install.js");
  return runInstall(["--target", "codex"]);
}

function codexConfigPath(): string {
  return path.join(codexHome, "config.toml");
}

describe("B-10: install --target codex пишет в активный CODEX_HOME", () => {
  it("dirB/config.toml обновлён, dirB/AGENTS.md создан, dirA/.codex не создан, сообщение ссылается на dirB", async () => {
    fs.writeFileSync(
      codexConfigPath(),
      'model = "keep"\n[mcp_servers.megamemory]\ncommand = "old"\nargs = ["--old"]\nuser_option = "keep-me"\n',
      "utf8"
    );

    const result = await install();

    expect(result.ok).toBe(true);
    const updated = fs.readFileSync(codexConfigPath(), "utf8");
    expect(
      updated,
      "B-10: активный CODEX_HOME обязан получить managed-обновление"
    ).toContain('command = "node"');
    expect(updated).toContain('model = "keep"');
    expect(updated).toContain('user_option = "keep-me"');
    expect(updated).not.toContain('command = "old"');
    expect(fs.existsSync(path.join(codexHome, "AGENTS.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(homeA, ".codex")),
      "B-10: HOME/.codex не должен создаваться при активном CODEX_HOME"
    ).toBe(false);
    expect(out.join("\n")).toContain(codexConfigPath());
  });

  it("custom CODEX_HOME без существующего config.toml — оба файла создаются там же", async () => {
    const result = await install();

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(codexConfigPath(), "utf8")).toContain('[mcp_servers.megamemory]\ncommand = "node"');
    expect(fs.existsSync(path.join(codexHome, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeA, ".codex"))).toBe(false);
  });

  it("повторная установка идемпотентна — байт в байт", async () => {
    fs.writeFileSync(
      codexConfigPath(),
      'model = "keep"\n[mcp_servers.megamemory]\ncommand = "old"\nargs = ["--old"]\nenv = { DB_PATH = "keep.db" }\n',
      "utf8"
    );

    expect((await install()).ok).toBe(true);
    const first = fs.readFileSync(codexConfigPath(), "utf8");
    expect(first).toContain('env = { DB_PATH = "keep.db" }');

    expect((await install()).ok).toBe(true);
    expect(fs.readFileSync(codexConfigPath(), "utf8")).toBe(first);
    expect(fs.existsSync(path.join(homeA, ".codex"))).toBe(false);
  });

  it("пустой CODEX_HOME считается отсутствующим — прежний HOME/.codex", async () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.resetModules();

    const result = await install();

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(homeA, ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(homeA, ".codex", "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(codexConfigPath())).toBe(false);
  });

  it("ошибка Codex CLI не портит существующий config — атомарный fallback в CODEX_HOME", async () => {
    const bogus = path.join(root, "not-a-codex.cmd");
    fs.writeFileSync(bogus, "@echo off\r\necho Not an npm shim\r\n", "utf8");
    boundary.execFileSync.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "codex") return bogus + "\n";
      throw Object.assign(new Error("Absent"), { code: "ENOENT" });
    });

    const result = await install();

    expect(result.ok).toBe(true);
    const updated = fs.readFileSync(codexConfigPath(), "utf8");
    expect(updated).toContain('[mcp_servers.megamemory]\ncommand = "node"');
    expect(fs.existsSync(path.join(homeA, ".codex"))).toBe(false);
  });
});
