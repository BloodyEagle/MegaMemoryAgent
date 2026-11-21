import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractInstructionsVersion,
  instructionsCandidates,
  instructionsStamp,
  instructionsStatus,
} from "../instructions.js";
import {
  agentsCanonical,
  claudeAgents,
  codexAgents,
  codexAgentsCandidates,
  codexAgentsTarget,
  codexHome,
  kiloAgents,
  kiloRules,
  opencodeAgents,
  projectAgents,
  projectClaude,
  zcodeAgents,
} from "../install-paths.js";
import { VALID_TARGETS, type InstallTarget } from "../install.js";

// Граница изоляции для регресс-теста записи (план 30 §4.6): реальные внешние
// команды не вызываются, реальные профили не затрагиваются.
vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => { throw Object.assign(new Error("isolated executable lookup"), { code: "ENOENT" }); }),
  execSync: vi.fn(() => { throw new Error("Shell execution forbidden in instructions tests"); }),
}));

const SERVER_VERSION = "2.0.0-fork.1";
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
).version as string;

// План 30 §4.7: тест обязан контролировать три переменные — HOME,
// USERPROFILE и CODEX_HOME. На машине с заданной CODEX_HOME тест без сброса
// проверял бы не дефолтный путь, а активный профиль разработчика.
const REAL_ENV: Record<string, string | undefined> = {};
let isoRoot = "";
let isoHome = "";

beforeEach(() => {
  isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-instructions-iso-"));
  isoHome = path.join(isoRoot, "home");
  fs.mkdirSync(isoHome, { recursive: true });
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME"]) {
    REAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = isoHome;
  process.env.USERPROFILE = isoHome;
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(REAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(isoRoot, { recursive: true, force: true });
});

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-instructions-"));
  const file = path.join(dir, "AGENTS.md");
  fs.writeFileSync(file, content);
  return file;
}

describe("instructionsStatus (plan 3 step 7.3)", () => {
  it("reports stale when the stamp carries an older version (7.4.3)", () => {
    const file = tmpFile(`${instructionsStamp("1.9.0-fork.1")}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus(SERVER_VERSION, [file])).toEqual({
      instructions_stale: true,
      instructions_version: "1.9.0-fork.1",
      server_version: SERVER_VERSION,
    });
  });

  it("reports fresh when the stamp matches the server version (7.4.4)", () => {
    const file = tmpFile(`${instructionsStamp(SERVER_VERSION)}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus(SERVER_VERSION, [file])).toEqual({
      instructions_stale: false,
      instructions_version: SERVER_VERSION,
      server_version: SERVER_VERSION,
    });
  });

  it("reports false + null when there is no instructions file (7.4.5)", () => {
    const missing = path.join(os.tmpdir(), "mm-instructions-absent", "AGENTS.md");

    expect(instructionsStatus(SERVER_VERSION, [missing])).toEqual({
      instructions_stale: false,
      instructions_version: null,
      server_version: SERVER_VERSION,
    });
  });

  it("skips files without megamemory stamps instead of misfiring on them", () => {
    const own = tmpFile("# My agents file\n\nUser rules only, no megamemory here.\n");
    const installed = tmpFile(`${instructionsStamp(SERVER_VERSION)}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus(SERVER_VERSION, [own, installed]).instructions_stale).toBe(false);
  });

  it("treats a legacy v2-managed block without a version stamp as stale", () => {
    const file = tmpFile(
      "<!-- megamemory-snippet:v2 -->\n## Project Knowledge Graph\n\nold workflow\n<!-- /megamemory-snippet -->\n"
    );

    expect(instructionsStatus(SERVER_VERSION, [file])).toEqual({
      instructions_stale: true,
      instructions_version: null,
      server_version: SERVER_VERSION,
    });
  });

  it("returns the same three fields on every call — the shape understand and list_roots share (7.4.6)", () => {
    const file = tmpFile(`${instructionsStamp("0.9.0")}\n`);

    const first = instructionsStatus(SERVER_VERSION, [file]);
    const second = instructionsStatus(SERVER_VERSION, [file]);

    expect(Object.keys(first).sort()).toEqual([
      "instructions_stale",
      "instructions_version",
      "server_version",
    ]);
    expect(first).toEqual(second);
  });
});

describe("instructionsStamp / extractInstructionsVersion", () => {
  it("round-trips the package version through the stamp", () => {
    const stamp = instructionsStamp("2.0.0-fork.1");
    expect(stamp).toBe("<!-- megamemory:instructions v2.0.0-fork.1 -->");
    expect(extractInstructionsVersion(`intro\n${stamp}\nmore`)).toBe("2.0.0-fork.1");
  });

  it("returns null for content without a stamp", () => {
    expect(extractInstructionsVersion("# My agents file\n")).toBeNull();
    expect(extractInstructionsVersion("<!-- megamemory-snippet:v2 -->\n")).toBeNull();
  });
});

describe("версия из маркера сниппета kilo-правил (план 29)", () => {
  it("extractInstructionsVersion читает <!-- megamemory-snippet vX -->", () => {
    expect(
      extractInstructionsVersion("<!-- megamemory-snippet v2.12.1 -->\nUse megamemory.\n<!-- /megamemory-snippet -->")
    ).toBe("2.12.1");
    expect(extractInstructionsVersion("intro\n<!-- megamemory-snippet v2.0.0-fork.1 -->\n")).toBe("2.0.0-fork.1");
  });

  it("маркер без версии и legacy-форма версии не дают", () => {
    expect(extractInstructionsVersion("<!-- megamemory-snippet -->\n")).toBeNull();
    expect(extractInstructionsVersion("<!-- megamemory-snippet:v2 -->\n")).toBeNull();
  });

  it("сниппет текущей версии не stale, чужой — stale с версией, без версии — stale без версии", () => {
    const current = tmpFile("<!-- megamemory-snippet v2.12.1 -->\nUse megamemory.\n<!-- /megamemory-snippet -->");
    expect(instructionsStatus("2.12.1", [current])).toEqual({
      instructions_stale: false,
      instructions_version: "2.12.1",
      server_version: "2.12.1",
    });

    const older = tmpFile("<!-- megamemory-snippet v2.11.0 -->\nUse megamemory.\n<!-- /megamemory-snippet -->");
    expect(instructionsStatus("2.12.1", [older])).toEqual({
      instructions_stale: true,
      instructions_version: "2.11.0",
      server_version: "2.12.1",
    });

    const unstamped = tmpFile("<!-- megamemory-snippet -->\nUse megamemory.\n<!-- /megamemory-snippet -->");
    expect(instructionsStatus("2.12.1", [unstamped])).toEqual({
      instructions_stale: true,
      instructions_version: null,
      server_version: "2.12.1",
    });
  });
});

/**
 * План 32: устаревание — направление (блок старше сервера), а не любое
 * несовпадение. Блок новее сервера — не тревога: клиент обновился раньше,
 * сервер в открытой сессии ещё старый; действие — рестарт клиента, а не
 * install (идемпотентен, сигнал не гасит).
 */
describe("instructionsStatus — направление сигнала (план 32)", () => {
  it("блок новее сервера — stale false", () => {
    const file = tmpFile(`${instructionsStamp("2.13.0")}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus("2.12.4", [file])).toEqual({
      instructions_stale: false,
      instructions_version: "2.13.0",
      server_version: "2.12.4",
    });
  });

  it("версия штампа не разбирается (vNext) — консервативно stale true", () => {
    const file = tmpFile(`${instructionsStamp("vNext")}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus("2.12.4", [file])).toEqual({
      instructions_stale: true,
      instructions_version: "vNext",
      server_version: "2.12.4",
    });
  });

  it("равные версии — stale false (бывшее равенство после перехода на порядок)", () => {
    const file = tmpFile(`${instructionsStamp("2.12.4")}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus("2.12.4", [file])).toEqual({
      instructions_stale: false,
      instructions_version: "2.12.4",
      server_version: "2.12.4",
    });
  });

  it("порядок кандидатов не меняется: вердикт по первому файлу со штампом (регресс планов 29/30)", () => {
    const project = tmpFile(`${instructionsStamp("2.11.0")}\n## Project Knowledge Graph\n`);
    const global = tmpFile(`${instructionsStamp("2.13.0")}\n## Project Knowledge Graph\n`);

    // проектный (старый штамп) раньше глобального (новый) — старый побеждает
    expect(instructionsStatus("2.12.4", [project, global])).toEqual({
      instructions_stale: true,
      instructions_version: "2.11.0",
      server_version: "2.12.4",
    });
    // и наоборот: побеждает первый в списке, а не «самая свежая версия»
    expect(instructionsStatus("2.12.4", [global, project])).toEqual({
      instructions_stale: false,
      instructions_version: "2.13.0",
      server_version: "2.12.4",
    });
  });
});

/**
 * Таблица «цель install → пути правил, которые она пишет» (план 29 §5.1/5.2,
 * план 30 §4.3). Функция, а не константа: пути читают env в момент вызова,
 * и таблица обязана собираться после изоляции HOME/USERPROFILE/CODEX_HOME
 * из beforeEach — иначе на машине с заданной переменной гард сверял бы
 * кандидатов изолированного прогона с путями реального профиля.
 */
function targetRulePaths(): Record<InstallTarget, string[]> {
  return {
    opencode: [opencodeAgents()],
    claudecode: [claudeAgents()],
    codex: [codexAgentsTarget(), codexAgents()],
    kilo: [kiloAgents(true), kiloRules(false, "jsonc"), kiloRules(true, "jsonc")],
    zcode: [zcodeAgents(true)],
    antigravity: [], // инструкций не пишет (только mcp_config.json)
  };
}

const TARGET_RULE_PATH_EXCEPTIONS: Partial<Record<InstallTarget, string>> = {
  antigravity: "инструкций не пишет — путь правил у цели отсутствует",
};

describe("instructionsCandidates (план 29)", () => {
  it("перечисляет проектные файлы, канонический .agents и пути правил всех пишущих целей", () => {
    const candidates = instructionsCandidates();
    expect(candidates).toContain(projectAgents());
    expect(candidates).toContain(projectClaude());
    expect(candidates).toContain(agentsCanonical(true));
    for (const paths of Object.values(targetRulePaths())) {
      for (const p of paths) expect(candidates).toContain(p);
    }
  });

  it("antigravity в кандидатах нет — он инструкций не пишет", () => {
    for (const candidate of instructionsCandidates()) {
      expect(candidate.endsWith("mcp_config.json")).toBe(false);
    }
  });

  it("гард: у каждой цели VALID_TARGETS есть путь в кандидатах или явное исключение с причиной", () => {
    const candidates = instructionsCandidates();
    for (const target of VALID_TARGETS) {
      const paths = targetRulePaths()[target];
      if (paths.length === 0) {
        expect(
          TARGET_RULE_PATH_EXCEPTIONS[target],
          `цель '${target}' не пишет путей в targetRulePaths — добавьте путь в install-paths.ts и сюда либо занесите цель в исключения с причиной`
        ).toBeDefined();
        continue;
      }
      for (const p of paths) {
        expect(
          candidates,
          `путь правил цели '${target}' (${p}) отсутствует в instructionsCandidates — новая цель install не детектируется`
        ).toContain(p);
      }
    }
  });

  it("битая ссылка ~/.agents/AGENTS.md не бросает и пропускается", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-instructions-broken-"));
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    // Файловые симлинки на Windows требуют привилегий: каталог .agents
    // становится висячим junction (mklink /J — без прав администратора);
    // на POSIX — обычный битый файловый симлинк.
    if (process.platform === "win32") {
      fs.symlinkSync(path.join(home, "no-such-dir"), path.join(home, ".agents"), "junction");
    } else {
      // POSIX symlinkSync требует существующий родительский каталог (на CI
      // упало с ENOENT — junction Windows его создаёт сам).
      fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
      fs.symlinkSync(path.join(home, "no-such-file"), path.join(home, ".agents", "AGENTS.md"));
    }
    for (const [key, value] of Object.entries({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
    })) vi.stubEnv(key, value);
    try {
      const canonical = path.join(home, ".agents", "AGENTS.md");
      const candidates = instructionsCandidates();
      expect(candidates).toContain(canonical);
      expect(fs.existsSync(canonical)).toBe(false);
      expect(instructionsStatus("2.12.1", candidates)).toEqual({
        instructions_stale: false,
        instructions_version: null,
        server_version: "2.12.1",
      });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("симлинк ~/.agents/AGENTS.md дедуплицируется со своей целью (лишнего чтения нет)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-instructions-dedup-"));
    const home = path.join(root, "home");
    const kilo = path.join(home, ".config", "kilo");
    fs.mkdirSync(kilo, { recursive: true });
    fs.writeFileSync(path.join(kilo, "AGENTS.md"), `${instructionsStamp("2.12.1")}\n`);
    if (process.platform === "win32") {
      fs.symlinkSync(kilo, path.join(home, ".agents"), "junction");
    } else {
      fs.mkdirSync(path.join(home, ".agents"));
      fs.symlinkSync(path.join(kilo, "AGENTS.md"), path.join(home, ".agents", "AGENTS.md"));
    }
    for (const [key, value] of Object.entries({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
    })) vi.stubEnv(key, value);
    try {
      const canonical = path.join(home, ".agents", "AGENTS.md");
      const candidates = instructionsCandidates();
      expect(candidates).toContain(path.join(kilo, "AGENTS.md"));
      expect(candidates).not.toContain(canonical);
      expect(instructionsStatus("2.12.1", candidates)).toEqual({
        instructions_stale: false,
        instructions_version: "2.12.1",
        server_version: "2.12.1",
      });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("codexHome / codexAgentsTarget / codexAgentsCandidates (план 30)", () => {
  it("codexHome: не заданная, пустая и пробельная переменная — ~/.codex, заданная — значение как есть", () => {
    const fallback = path.join(isoHome, ".codex");
    // переменная удалена глобальным beforeEach
    expect(codexHome()).toBe(fallback);
    vi.stubEnv("CODEX_HOME", "");
    expect(codexHome()).toBe(fallback);
    vi.stubEnv("CODEX_HOME", "   ");
    expect(codexHome()).toBe(fallback);
    const custom = path.join(isoRoot, "codex-профиль & данные (тест)");
    vi.stubEnv("CODEX_HOME", custom);
    expect(codexHome()).toBe(custom);
  });

  it("codexAgentsTarget: AGENTS.md активного профиля — путь записи цели codex", () => {
    const custom = path.join(isoRoot, "tmp-x");
    vi.stubEnv("CODEX_HOME", custom);
    expect(codexAgentsTarget()).toBe(path.join(custom, "AGENTS.md"));
    vi.stubEnv("CODEX_HOME", "");
    expect(codexAgentsTarget()).toBe(path.join(isoHome, ".codex", "AGENTS.md"));
  });

  it("codexAgentsCandidates: переменная не задана или пуста — один путь, задана — два в порядке «активный, дефолтный»", () => {
    expect(codexAgentsCandidates()).toEqual([path.join(isoHome, ".codex", "AGENTS.md")]);
    vi.stubEnv("CODEX_HOME", "");
    expect(codexAgentsCandidates()).toEqual([path.join(isoHome, ".codex", "AGENTS.md")]);
    const active = path.join(isoRoot, "codex-active");
    vi.stubEnv("CODEX_HOME", active);
    expect(codexAgentsCandidates()).toEqual([
      path.join(active, "AGENTS.md"),
      path.join(isoHome, ".codex", "AGENTS.md"),
    ]);
  });
});

describe("скан Codex в instructionsCandidates (план 30)", () => {
  it("остаточный блок в ~/.codex детектируется, когда активный $CODEX_HOME пуст", () => {
    const active = path.join(isoRoot, "codex-active");
    vi.stubEnv("CODEX_HOME", active); // файла там нет
    fs.mkdirSync(path.join(isoHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(isoHome, ".codex", "AGENTS.md"),
      `${instructionsStamp("2.11.0")}\n## Project Knowledge Graph\n`
    );

    const candidates = instructionsCandidates();
    expect(candidates).toContain(path.join(active, "AGENTS.md"));
    expect(instructionsStatus("2.12.1", candidates)).toEqual({
      instructions_stale: true,
      instructions_version: "2.11.0",
      server_version: "2.12.1",
    });
  });

  it("оба файла есть — версия берётся из активного профиля, дефолтный игнорируется", () => {
    const active = path.join(isoRoot, "codex-active");
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, "AGENTS.md"), `${instructionsStamp("2.12.1")}\n`);
    fs.mkdirSync(path.join(isoHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(isoHome, ".codex", "AGENTS.md"), `${instructionsStamp("2.11.0")}\n`);
    vi.stubEnv("CODEX_HOME", active);

    const candidates = instructionsCandidates();
    expect(
      candidates.indexOf(path.join(active, "AGENTS.md")),
      "активный профиль обязан стоять в кандидатах раньше дефолтного ~/.codex"
    ).toBeLessThan(candidates.indexOf(path.join(isoHome, ".codex", "AGENTS.md")));
    expect(instructionsStatus("2.12.1", candidates)).toEqual({
      instructions_stale: false,
      instructions_version: "2.12.1",
      server_version: "2.12.1",
    });
  });
});

describe("регресс записи kilo --global при активном $CODEX_HOME (план 30)", () => {
  it("пишет блок в ~/.codex/AGENTS.md, $CODEX_HOME/AGENTS.md не создаёт", async () => {
    const active = path.join(isoRoot, "codex-active");
    vi.stubEnv("CODEX_HOME", active);
    const defaultCodexAgents = path.join(isoHome, ".codex", "AGENTS.md");
    fs.mkdirSync(path.join(isoHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      defaultCodexAgents,
      "<!-- megamemory-snippet v2.11.0 -->\nUse megamemory.\n<!-- /megamemory-snippet -->\n"
    );
    fs.writeFileSync(path.join(isoRoot, "kilo.jsonc"), "{}\n");

    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.chdir(isoRoot);
    vi.resetModules();
    try {
      const { runInstall } = await import("../install.js");
      const result = await runInstall(["--global", "--target", "kilo"]);

      expect(result.ok).toBe(true);
      expect(
        extractInstructionsVersion(fs.readFileSync(defaultCodexAgents, "utf8")),
        "kilo --global обязан обновить блок в ~/.codex/AGENTS.md — путь его записи не менялся"
      ).toBe(PACKAGE_VERSION);
      expect(
        fs.existsSync(path.join(active, "AGENTS.md")),
        "kilo --global не должен писать в активный $CODEX_HOME"
      ).toBe(false);
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
