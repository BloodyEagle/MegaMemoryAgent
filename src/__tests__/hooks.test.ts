import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runHooks } from "../hooks.js";

const startMarker = "# >>> megamemory:commit-msg";
const endMarker = "# <<< megamemory:commit-msg";
let tmp: string;
let repo: string;
let hook: string;
let env: NodeJS.ProcessEnv;
let savedEnv: NodeJS.ProcessEnv;
let output: string[];

function git(args: string[], cwd = repo): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, env, shell: false, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.signal || result.status === null) throw new Error(`Git fixture failed: ${result.error?.message ?? result.signal}`);
  return { status: result.status, stdout: result.stdout.replace(/\r\n/g, "\n"), stderr: result.stderr.replace(/\r\n/g, "\n") };
}

function ok(args: string[], cwd = repo): string {
  const result = git(args, cwd);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trimEnd();
}

function stage(file: string): void {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "fixture\n", "utf8");
  ok(["add", "--", file]);
}

function hooks(action: string, target = repo): void {
  runHooks([action, "--repo", target]);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-hooks-"));
  repo = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  const templates = path.join(tmp, "templates");
  for (const dir of [repo, home, templates]) fs.mkdirSync(dir);
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_TEMPLATE_DIR: templates, GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Hook Fixture", GIT_AUTHOR_EMAIL: "hooks@example.invalid",
    GIT_COMMITTER_NAME: "Hook Fixture", GIT_COMMITTER_EMAIL: "hooks@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    LC_ALL: "C.UTF-8",
  });
  savedEnv = process.env;
  process.env = env;
  output = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => { output.push(values.join(" ")); });
  ok(["-c", "init.defaultBranch=main", "init", `--template=${templates}`]);
  for (const [key, value] of [["commit.gpgSign", "false"], ["tag.gpgSign", "false"], ["core.autocrlf", "false"], ["core.quotePath", "false"]]) {
    ok(["config", key, value]);
  }
  hook = ok(["rev-parse", "--path-format=absolute", "--git-path", "hooks/commit-msg"]);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
});

afterEach(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("hooks install/uninstall/status (T2 cases 7–15)", () => {
  it("creates an executable LF hook; status, repeat install and uninstall are idempotent", () => {
    expect(() => hooks("status")).not.toThrow();
    expect(output.join("\n")).toContain("не установлен");
    const chmod = vi.spyOn(fs, "chmodSync");
    hooks("install");
    const bytes = fs.readFileSync(hook);
    expect(bytes.toString("utf8")).toMatch(/^#!\/bin\/sh\n/);
    expect(bytes.includes(13)).toBe(false);
    expect(chmod).toHaveBeenCalledWith(hook, expect.any(Number));
    expect(Number(chmod.mock.calls[0][1]) & 0o111).toBe(0o111);
    // Windows chmod cannot expose Unix executable bits; Git execution is tested below.
    if (process.platform !== "win32") expect(fs.statSync(hook).mode & 0o111).toBe(0o111);
    hooks("install");
    expect(fs.readFileSync(hook)).toEqual(bytes);
    expect(bytes.toString("utf8").split(startMarker)).toHaveLength(2);
    expect(bytes.toString("utf8").split(endMarker)).toHaveLength(2);
    hooks("status");
    expect(output.join("\n")).toContain("commit-msg установлен");
    expect(output.join("\n")).toContain("--no-verify");
    hooks("uninstall");
    expect(fs.existsSync(hook)).toBe(false);
    expect(() => hooks("uninstall")).not.toThrow();
  });

  it("rejects staged code without memory, accepts a case-insensitive memory line and permits --no-verify", () => {
    hooks("install");
    stage("src/change.ts");
    const rejected = git(["commit", "-m", "no memory"]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("megamemory: в коммите есть код");
    expect(rejected.stderr).toContain("memory: <id узлов>");
    expect(git(["commit", "-m", "change\n\nMeMoRy: abc123"]).status).toBe(0);
    stage("bypass.ts");
    expect(git(["commit", "--no-verify", "-m", "explicit bypass"]).status).toBe(0);
  });

  it.each([true, false])("rejects Git-quoted Cyrillic code paths (core.quotePath=%s)", (quotePath) => {
    ok(["config", "core.quotePath", String(quotePath)]);
    hooks("install");
    stage("src/изменение.ts");
    const names = ok(["diff", "--cached", "--name-only"]);
    expect(names.startsWith('"')).toBe(quotePath);
    const rejected = git(["commit", "-m", "no memory for Unicode code"]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("memory: <id узлов>");
    const accepted = git(["commit", "-m", "change\n\nmemory: нечего — тестовая причина"]);
    expect(accepted.status, accepted.stderr).toBe(0);
  });

  it("rejects code paths quoted for a tab even when core.quotePath=false", () => {
    hooks("install");
    // Disable Windows path protection only in this temp fixture; no checkout is attempted.
    ok(["config", "core.protectNTFS", "false"]);
    const object = ok(["hash-object", "-w", "--", path.join(repo, ".git", "config")]);
    ok(["update-index", "--add", "--cacheinfo", "100644", object, "src/quoted\tname.ts"]);
    expect(ok(["diff", "--cached", "--name-only"])).toMatch(/^".*\.ts"$/);
    const rejected = git(["commit", "-m", "no memory for quoted code"]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("memory: <id узлов>");
  });

  it("allows a README-only commit without memory", () => {
    hooks("install");
    stage("README.md");
    expect(git(["commit", "-m", "docs only"]).status).toBe(0);
  });

  it.each(["\n", "\r\n", ""])("roundtrips foreign hook bytes with body ending %j and preserves neighboring hooks", (eol) => {
    const original = Buffer.from(`#!/bin/sh\nprintf 'foreign ran\\n' >&2${eol}`, "utf8");
    const neighbor = path.join(path.dirname(hook), "pre-commit");
    fs.writeFileSync(hook, original);
    fs.writeFileSync(neighbor, "#!/bin/sh\n# neighboring hook\n", "utf8");
    const neighborBytes = fs.readFileSync(neighbor);
    hooks("install");
    expect(fs.readFileSync(hook).subarray(0, original.length)).toEqual(original);
    expect(output.join("\n")).toContain("ранний exit/exec");
    const installed = fs.readFileSync(hook);
    hooks("install");
    expect(fs.readFileSync(hook)).toEqual(installed);
    hooks("uninstall");
    expect(fs.readFileSync(hook)).toEqual(original);
    hooks("uninstall");
    expect(fs.readFileSync(hook)).toEqual(original);
    expect(fs.readFileSync(neighbor)).toEqual(neighborBytes);
  });

  it("executes a POSIX LF foreign hook and checks the memory gate independently of byte preservation", () => {
    fs.writeFileSync(hook, "#!/bin/sh\nprintf 'foreign ran\\n' >&2\n", "utf8");
    hooks("install");
    stage("foreign.ts");
    const rejected = git(["commit", "-m", "no memory after foreign hook"]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("foreign ran");
    expect(rejected.stderr).toContain("memory: <id узлов>");
    const accepted = git(["commit", "-m", "change\n\nmemory: abc123"]);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stderr).toContain("foreign ran");
    stage("bypass.ts");
    const bypassed = git(["commit", "--no-verify", "-m", "explicit bypass"]);
    expect(bypassed.status, bypassed.stderr).toBe(0);
    expect(bypassed.stderr).not.toContain("foreign ran");
    expect(bypassed.stderr).not.toContain("memory: <id узлов>");
  });

  it.each(["relative", "absolute", "tilde"])("honors %s core.hooksPath from a subdirectory", (kind) => {
    const custom = kind === "relative" ? "custom-hooks" : kind === "absolute" ? path.join(tmp, "absolute-hooks") : "~/tilde-hooks";
    const expected = kind === "relative" ? path.join(repo, custom) : kind === "absolute" ? custom : path.join(env.HOME!, "tilde-hooks");
    ok(["config", "core.hooksPath", custom]);
    const subdir = path.join(repo, "nested");
    fs.mkdirSync(subdir);
    hooks("install", subdir);
    const target = path.join(expected, "commit-msg");
    expect(fs.readFileSync(target, "utf8")).toContain(startMarker);
    expect(fs.existsSync(hook)).toBe(false);
    hooks("status", subdir);
    expect(output.join("\n")).toContain(JSON.stringify(custom));
    expect(output.join("\n")).toContain(target.replace(/\\/g, "/"));
    hooks("uninstall", subdir);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each([false, true])("resolves linked worktree hook location (relative override=%s)", (override) => {
    stage("README.md");
    ok(["commit", "-m", "initial"]);
    const worktree = path.join(tmp, "worktree");
    ok(["worktree", "add", "-b", "fixture-worktree", worktree]);
    if (override) ok(["config", "core.hooksPath", "worktree-hooks"]);
    const subdir = path.join(worktree, "nested");
    fs.mkdirSync(subdir);
    const target = override ? path.join(worktree, "worktree-hooks", "commit-msg") : hook;
    hooks("install", subdir);
    expect(fs.readFileSync(target, "utf8")).toContain(startMarker);
    hooks("status", subdir);
    expect(output.join("\n")).toContain(target.replace(/\\/g, "/"));
    hooks("uninstall", subdir);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("defaults to cwd and rejects invalid arguments / non-repositories before modifying files", () => {
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    runHooks(["install"]);
    const before = fs.readFileSync(hook);
    for (const args of [[], ["install", "status"], ["unknown"], ["install", "--force"], ["install", "--repo"], ["install", "--repo="], ["install", "--repo", repo, "--repo=" + repo]]) {
      expect(() => runHooks(args)).toThrow();
      expect(fs.readFileSync(hook)).toEqual(before);
    }
    expect(() => hooks("install", tmp)).toThrow(/git-репозиторий/);
    expect(fs.existsSync(path.join(tmp, ".git"))).toBe(false);
  });

  it("source CLI returns correct exit codes without touching database or hook on status", () => {
    const source = fileURLToPath(new URL("../index.ts", import.meta.url));
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const cases = [
      { args: ["status", "--repo", repo], code: 0, text: /не установлен/ },
      { args: ["install", "--repo", tmp], code: 1, text: /git-репозиторий/ },
      { args: ["install", "--repo", repo, "--unknown"], code: 1, text: /неизвестный флаг/ },
    ];
    for (const { args, code, text } of cases) {
      const result = spawnSync(process.execPath, ["--import", loader, source, "hooks", ...args], {
        cwd: tmp, env: { ...env, NODE_OPTIONS: "", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", NO_COLOR: "1", MEGAMEMORY_DB_PATH: path.join(tmp, "forbidden.db") },
        encoding: "utf8", shell: false, timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(code);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(text);
      expect(fs.existsSync(hook)).toBe(false);
      expect(fs.existsSync(path.join(tmp, "forbidden.db"))).toBe(false);
      expect(fs.existsSync(path.join(tmp, ".megamemory"))).toBe(false);
    }
  });

  it("preserves foreign bytes after our block and restores an initially empty hook", () => {
    fs.writeFileSync(hook, Buffer.alloc(0));
    hooks("install");
    hooks("uninstall");
    expect(fs.readFileSync(hook)).toEqual(Buffer.alloc(0));
    const original = Buffer.from("#!/bin/sh\n# foreign\n");
    fs.writeFileSync(hook, original);
    hooks("install");
    const suffix = Buffer.from("# later foreign change\r\n");
    fs.appendFileSync(hook, suffix);
    hooks("uninstall");
    expect(fs.readFileSync(hook)).toEqual(Buffer.concat([original, suffix]));
  });

  it.each(["#!/usr/bin/python3\npass\n", "#!/bin/bash\nexit 0\n", "#!/bin/sh\r\nexit 0\r\n", "\ufeff#!/bin/sh\n", "echo no-shebang\n"])("refuses unsupported foreign hook format without modifying it: %j", (content) => {
    fs.writeFileSync(hook, content, "utf8");
    const before = fs.readFileSync(hook);
    expect(() => hooks("install")).toThrow(/POSIX sh shebang/);
    expect(fs.readFileSync(hook)).toEqual(before);
    expect(() => hooks("uninstall")).not.toThrow();
    expect(fs.readFileSync(hook)).toEqual(before);
  });

  it.each(["missing-end", "multiple", "invalid-start", "altered-body"])("refuses %s marker blocks for all actions without writing", (kind) => {
    hooks("install");
    const valid = fs.readFileSync(hook, "utf8");
    const damaged = kind === "missing-end" ? valid.replace(endMarker, "# gone") : kind === "multiple" ? valid + valid
      : kind === "altered-body" ? valid.replace('msg_file="$1"', '# foreign code in managed block')
      : valid.replace(`${startMarker} (`, `${startMarker} INVALID (`);
    fs.writeFileSync(hook, damaged, "utf8");
    for (const action of ["install", "uninstall", "status"]) {
      expect(() => hooks(action)).toThrow(/повреждённый или повторяющийся/);
      expect(fs.readFileSync(hook, "utf8")).toBe(damaged);
    }
  });

  it("refuses hook directories and file-valued hook paths", () => {
    fs.mkdirSync(hook);
    expect(() => hooks("install")).toThrow(/обычный файл/);
    fs.rmdirSync(hook);
    const file = path.join(tmp, "not-a-directory");
    fs.writeFileSync(file, "untouched", "utf8");
    ok(["config", "core.hooksPath", file]);
    expect(() => hooks("install")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("untouched");
  });

  it("refuses symlink hook targets without altering the foreign destination", () => {
    const target = path.join(tmp, "foreign-directory");
    fs.mkdirSync(target);
    const foreign = path.join(target, "commit-msg");
    fs.writeFileSync(foreign, "#!/bin/sh\n# untouched\n", "utf8");
    const link = path.join(repo, "linked-hooks");
    // A directory junction is also a symlink to Node and needs no Windows privilege.
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    ok(["config", "core.hooksPath", link]);
    for (const action of ["install", "uninstall", "status"]) expect(() => hooks(action)).toThrow(/symlink/);
    expect(fs.readFileSync(foreign, "utf8")).toBe("#!/bin/sh\n# untouched\n");
  });
});
