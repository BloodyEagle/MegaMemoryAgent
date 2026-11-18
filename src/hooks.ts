import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { valueFlag } from "./cli-flags.js";

const startMarker = "# >>> megamemory:commit-msg";
const endMarker = "# <<< megamemory:commit-msg";
const begin = `${startMarker} (managed block — не править вручную)\n`;
const end = `${endMarker}\n`;
const header = Buffer.from("#!/bin/sh\n");
type Origin = "created" | "empty" | "append" | "append-lf";
interface ManagedBlock { start: number; end: number; origin: Origin }

function managedScript(origin: Origin): string {
  return `${begin}# megamemory:origin=${origin}
msg_file="$1"
if git diff --cached --name-only | grep -Eq '\\.(ts|tsx|js|jsx|py|php|java|kt|kts|go|rs|rb|cs|cpp|c|h)"?$'; then
  if ! grep -Eiq '^memory:' "$msg_file"; then
    echo "megamemory: в коммите есть код, но нет строки 'memory:'." >&2
    echo "  добавь 'memory: <id узлов>' или 'memory: нечего — <причина>'." >&2
    exit 1
  fi
fi
${end}`;
}

function git(repo: string, args: string[], optional = false): string | undefined {
  const result = spawnSync("git", args, {
    cwd: repo, encoding: "utf8", shell: false, timeout: 30_000,
  });
  if (result.error) throw new Error(`megamemory hooks: не удалось запустить Git: ${result.error.message}`, { cause: result.error });
  if (result.signal || result.status === null) throw new Error("megamemory hooks: Git не завершился.");
  if (optional && result.status === 1) return undefined;
  if (result.status !== 0) {
    throw new Error(`megamemory hooks: ошибка Git (нужен git-репозиторий): ${result.stderr.trim()}`);
  }
  return result.stdout.replace(/\r?\n$/, "");
}

function invocation(args: string[]): { action: string; repo: string } {
  const repo = valueFlag(args, "--repo") ?? process.cwd();
  const actions: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--repo") { i++; continue; }
    if (token.startsWith("--repo=")) continue;
    if (token.startsWith("-")) throw new Error(`megamemory hooks: неизвестный флаг ${token}.`);
    actions.push(token);
  }
  if (actions.length !== 1 || !["install", "uninstall", "status"].includes(actions[0])) {
    throw new Error("Использование: megamemory hooks install|uninstall|status [--repo <path>].");
  }
  return { action: actions[0], repo: path.resolve(repo) };
}

function stat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function checkPath(file: string): fs.Stats | undefined {
  const target = stat(file);
  if (target && (target.isSymbolicLink() || !target.isFile())) {
    throw new Error(`megamemory hooks: ожидается обычный файл, не symlink/каталог: ${file}`);
  }
  let parent = path.dirname(file);
  while (true) {
    const entry = stat(parent);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) {
      throw new Error(`megamemory hooks: небезопасный каталог хуков (symlink/не каталог): ${parent}`);
    }
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return target;
}

function blockIn(bytes: Buffer): ManagedBlock | undefined {
  const start = bytes.indexOf(startMarker);
  const stop = bytes.indexOf(endMarker);
  if (start === -1 && stop === -1) return undefined;
  const fail = (): never => { throw new Error("megamemory hooks: повреждённый или повторяющийся managed block; файл не изменён."); };
  if (start === -1 || stop <= start || bytes.indexOf(startMarker, start + 1) !== -1
    || bytes.indexOf(endMarker, stop + 1) !== -1) return fail();
  if ((start > 0 && bytes[start - 1] !== 10)
    || !bytes.subarray(start, start + Buffer.byteLength(begin)).equals(Buffer.from(begin))
    || bytes[stop - 1] !== 10
    || !bytes.subarray(stop, stop + Buffer.byteLength(end)).equals(Buffer.from(end))) return fail();
  const text = bytes.subarray(start, stop).toString("utf8");
  const match = text.slice(begin.length).match(/^# megamemory:origin=(created|empty|append|append-lf)\n/);
  if (!match || text.includes("\r") || text.includes("\0")) return fail();
  const origin = match[1] as Origin;
  const blockEnd = stop + Buffer.byteLength(end);
  if (!bytes.subarray(start, blockEnd).equals(Buffer.from(managedScript(origin)))) return fail();
  const prefix = bytes.subarray(0, start);
  if ((origin === "created" || origin === "empty") && !prefix.equals(header)) return fail();
  if (origin === "append-lf" && (prefix.length === 0 || prefix[prefix.length - 1] !== 10)) return fail();
  return { start, end: stop + Buffer.byteLength(end), origin };
}

function checkForeign(bytes: Buffer): void {
  if (bytes.length === 0) return;
  const newline = bytes.indexOf(10);
  const shebang = bytes.subarray(0, newline === -1 ? bytes.length : newline).toString("utf8");
  // Do not rewrite BOM/CRLF or convert another interpreter into sh.
  if (bytes.includes(0) || !/^#![ \t]*(?:\/(?:usr\/)?bin\/sh|\/usr\/bin\/env[ \t]+sh)[ \t]*$/.test(shebang)) {
    throw new Error("megamemory hooks: чужой commit-msg должен иметь POSIX sh shebang с LF, без BOM; файл не изменён.");
  }
}

/**
 * Manage only the megamemory commit-msg block; throw on invalid arguments, Git or I/O errors.
 * @param args Arguments after `hooks`: one action and optional `--repo` (default cwd).
 * @returns Nothing; prints CLI status without accessing a database or network.
 */
export function runHooks(args: string[]): void {
  const { action, repo } = invocation(args);
  const root = git(repo, ["rev-parse", "--show-toplevel"])!;
  // Resolve from the directory where Git runs commit-msg, not the caller's subdirectory.
  const hook = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/commit-msg"])!;
  const lexicalHook = git(root, ["rev-parse", "--git-path", "hooks/commit-msg"])!;
  checkPath(path.resolve(root, lexicalHook));
  const hooksPath = git(root, ["config", "--get", "core.hooksPath"], true);
  // Absolute rev-parse resolves symlinks: also validate the uncanonicalized config path.
  const configuredPath = git(root, ["config", "--path", "--get", "core.hooksPath"], true);
  if (configuredPath !== undefined) checkPath(path.resolve(root, configuredPath, "commit-msg"));
  const entry = checkPath(hook);
  const bytes = entry ? fs.readFileSync(hook) : Buffer.alloc(0);
  const block = blockIn(bytes);
  console.log(`Путь commit-msg: ${hook}`);
  console.log(`core.hooksPath: ${hooksPath === undefined ? "не задан (Git default)" : JSON.stringify(hooksPath)}`);

  if (action === "status") {
    console.log(`megamemory: commit-msg ${block ? "установлен" : "не установлен"}.`);
    if (process.platform !== "win32" && block && entry && (entry.mode & 0o111) === 0) console.log("Предупреждение: файл не исполняемый; повторите hooks install.");
    console.log("Хук обходится git commit --no-verify; строка memory: не проверяется по базе.");
    return;
  }
  if (action === "uninstall") {
    if (!block) { console.log("megamemory: блок отсутствует, изменений нет."); return; }
    let prefix = bytes.subarray(0, block.start);
    const suffix = bytes.subarray(block.end);
    // The extra delimiter belongs to our block, not the original newline-less hook.
    if (block.origin === "append-lf") prefix = prefix.subarray(0, prefix.length - 1);
    if ((block.origin === "created" || block.origin === "empty") && suffix.length === 0) {
      if (block.origin === "created") fs.unlinkSync(hook);
      else fs.writeFileSync(hook, Buffer.alloc(0));
    } else {
      fs.writeFileSync(hook, Buffer.concat([prefix, suffix]));
    }
    console.log("megamemory: managed block удалён; чужие байты сохранены.");
    return;
  }
  if (block) {
    fs.chmodSync(hook, entry!.mode | 0o111);
    console.log("megamemory: блок уже установлен, повторного добавления нет.");
    return;
  }
  checkForeign(bytes);
  const origin: Origin = !entry ? "created" : bytes.length === 0 ? "empty"
    : bytes[bytes.length - 1] === 10 ? "append" : "append-lf";
  if (bytes.length > 0) {
    console.log("Предупреждение: блок дописан после чужого хука; ранний exit/exec может обойти проверку memory:.");
  }
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  if (bytes.length === 0) {
    fs.writeFileSync(hook, Buffer.concat([header, Buffer.from(managedScript(origin))]), { flag: entry ? "w" : "wx" });
  } else {
    fs.appendFileSync(hook, `${origin === "append-lf" ? "\n" : ""}${managedScript(origin)}`);
  }
  fs.chmodSync(hook, (entry?.mode ?? 0o644) | 0o111);
  console.log("megamemory: commit-msg установлен.");
}
