import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
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
  kiloAgents,
  kiloRules,
  opencodeAgents,
  projectAgents,
  projectClaude,
  zcodeAgents,
} from "../install-paths.js";
import { VALID_TARGETS, type InstallTarget } from "../install.js";

const SERVER_VERSION = "2.0.0-fork.1";

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

/** Таблица «цель install → пути правил, которые она пишет» (план 29 §5.1/5.2). */
const TARGET_RULE_PATHS: Record<InstallTarget, string[]> = {
  opencode: [opencodeAgents()],
  claudecode: [claudeAgents()],
  codex: [codexAgents()],
  kilo: [kiloAgents(true), kiloRules(false, "jsonc"), kiloRules(true, "jsonc")],
  zcode: [zcodeAgents(true)],
  antigravity: [], // инструкций не пишет (только mcp_config.json)
};

const TARGET_RULE_PATH_EXCEPTIONS: Partial<Record<InstallTarget, string>> = {
  antigravity: "инструкций не пишет — путь правил у цели отсутствует",
};

describe("instructionsCandidates (план 29)", () => {
  it("перечисляет проектные файлы, канонический .agents и пути правил всех пишущих целей", () => {
    const candidates = instructionsCandidates();
    expect(candidates).toContain(projectAgents());
    expect(candidates).toContain(projectClaude());
    expect(candidates).toContain(agentsCanonical(true));
    for (const paths of Object.values(TARGET_RULE_PATHS)) {
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
      const paths = TARGET_RULE_PATHS[target];
      if (paths.length === 0) {
        expect(
          TARGET_RULE_PATH_EXCEPTIONS[target],
          `цель '${target}' не пишет путей в TARGET_RULE_PATHS — добавьте путь в install-paths.ts и сюда либо занесите цель в исключения с причиной`
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
