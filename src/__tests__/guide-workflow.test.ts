import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupDir } from "./helpers/cleanup.js";
import { buildWorkflowText, resolveGuideMode, WorkflowDocError } from "../guide.js";

// W2 (план 20+21 v3): `megamemory guide --workflow` печатает поставляемый
// документ docs/agent-workflow.md байт в байт — UTF-8, ровно один завершающий
// LF, без баннеров, без открытия базы, без сети. Работает из произвольного cwd
// и из установленного пакета (последнее проверяет smoke в scripts/package.mjs).

const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href;
const entry = path.join(root, "src", "index.ts");
const WORKFLOW_DOC = path.join(root, "docs", "agent-workflow.md");

function isolatedEnv(cwd: string): NodeJS.ProcessEnv {
  const home = path.join(cwd, "profile");
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "roaming"),
    LOCALAPPDATA: path.join(home, "local"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    CODEX_HOME: path.join(home, "codex"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    OPENCODE_CONFIG_DIR: path.join(home, "opencode"),
    MEGAMEMORY_DB_PATH: "",
    MEGAMEMORY_SEARCH: "fts",
    MEGAMEMORY_AUTO_MIGRATE: "0",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    NODE_OPTIONS: "",
  };
}

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, entry, ...args], {
      cwd,
      env: isolatedEnv(cwd),
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("guide run timed out"));
    }, 45000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe("docs/agent-workflow.md — полный договор workflow (W1)", () => {
  it("документ существует, UTF-8, заканчивается ровно одним LF и не содержит CR", () => {
    const text = fs.readFileSync(WORKFLOW_DOC, "utf-8");
    expect(text.length).toBeGreaterThan(0);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text.includes("\r")).toBe(false);
    // кириллица читается корректно, заголовок на месте
    expect(text.startsWith("# Порядок работы агента")).toBe(true);
  });

  it("buildWorkflowText возвращает содержимое документа дословно", () => {
    expect(buildWorkflowText()).toBe(fs.readFileSync(WORKFLOW_DOC, "utf-8"));
  });

  it("документ несёт обязательные смысловые правила ядра W1", () => {
    const text = fs.readFileSync(WORKFLOW_DOC, "utf-8");
    // порядок: проверка проекта, один релевантный запрос, квалификация
    expect(text).toContain("подходящим структурным инструментом");
    // must_read не доказывает покрытие; чистое чтение законно без записи
    expect(text).toContain("не доказательство полного покрытия");
    expect(text).toContain("чистом чтении");
    // расхождение код/память — разбор, не автоматическое опровержение
    expect(text).toContain("не автоматическое опровержение");
    // подтверждение — только явное
    expect(text).toContain("confirm_supports");
    expect(text).toContain("не выполняется автоматически");
    // секреты и fallback без памяти
    expect(text).toContain("секреты");
    expect(text).toContain("Если MegaMemory недоступна");
    // указатели: capabilities и краткий сниппет
    expect(text).toContain("docs/capabilities.md");
    expect(text).toContain("megamemory guide --workflow");
  });
});

describe("megamemory guide --workflow (W2)", () => {
  it("печатает документ байт в байт (ровно один завершающий LF) из произвольного cwd", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mm-guide-workflow-"));
    try {
      const { code, stdout, stderr } = await runCli(["guide", "--workflow"], cwd);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe(fs.readFileSync(WORKFLOW_DOC, "utf-8"));
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.endsWith("\n\n")).toBe(false);
    } finally {
      await cleanupDir(cwd);
    }
  }, 60000);

  it("в пустом временном каталоге не создаётся .megamemory/", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mm-guide-nodb-"));
    try {
      const { code } = await runCli(["guide", "--workflow"], cwd);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(cwd, ".megamemory"))).toBe(false);
    } finally {
      await cleanupDir(cwd);
    }
  }, 60000);

  it("обычный guide сохраняет прежний смысл: онбординг-сниппет первым", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mm-guide-plain-"));
    try {
      const { code, stdout } = await runCli(["guide"], cwd);
      expect(code).toBe(0);
      expect(stdout.startsWith("<!-- megamemory:instructions v")).toBe(true);
      expect(stdout).toContain("## Project Knowledge Graph");
    } finally {
      await cleanupDir(cwd);
    }
  }, 60000);

  it.each([
    [["--workflow", "--workflow"]],
    [["--db", "unused.db"]],
    [["extra-arg"]],
    [["--workflow", "extra"]],
  ])("неподдерживаемые аргументы guide %j — явная ошибка, не молчаливое игнорирование", async (args) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mm-guide-args-"));
    try {
      const { code, stderr } = await runCli(["guide", ...args], cwd);
      expect(code).toBe(1);
      expect(stderr.trim()).not.toBe("");
    } finally {
      await cleanupDir(cwd);
    }
  }, 60000);
});

describe("resolveGuideMode — контракт разбора флага", () => {
  it("без аргументов — обычный guide", () => {
    expect(resolveGuideMode([])).toBe("guide");
  });

  it("--workflow — печатает поставляемый документ", () => {
    expect(resolveGuideMode(["--workflow"])).toBe("workflow");
  });

  it("дубликат --workflow — ошибка", () => {
    expect(() => resolveGuideMode(["--workflow", "--workflow"])).toThrow(WorkflowDocError);
  });

  it("чужой аргумент — ошибка", () => {
    expect(() => resolveGuideMode(["--db", "x"])).toThrow(WorkflowDocError);
  });
});
