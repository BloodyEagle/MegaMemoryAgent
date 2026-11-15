/**
 * Этап A (план 20+21 v3 §6.A4): CLI-поведение stats --health.
 *
 * - `stats --health --json` (без --prune) — readonly-путь: JSON-only,
 *   признаки полноты в ответе, байты базы не меняются;
 * - `--window 7d|30d|all` задаёт окно всем секциям; неверное значение —
 *   явная ошибка, а не молчаливое игнорирование;
 * - отсутствие записей — данные, не неисправность: exit 0 на пустой базе.
 *
 * Тесты spawn-ят собранный dist (как readonly-commands): полный прогон
 * требует npm run build до старта (CI строит перед npm test).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { KnowledgeDB } from "../db.js";
import { cleanupDir } from "./helpers/cleanup.js";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-health-cli-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  const db = new KnowledgeDB(dbPath);
  try {
    db.insertTimelineEntry({
      tool: "understand",
      params: JSON.stringify({ query: "q" }),
      result_summary: "",
      is_write: false,
      is_error: false,
      affected_ids: [],
    });
  } finally {
    db.close();
  }
});

afterEach(async () => {
  await cleanupDir(tmpDir);
});

function sha(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function spawnCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  if (!fs.existsSync(cli)) throw new Error("Build dist before running health-cli tests");
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      MEGAMEMORY_DB_PATH: "",
      MEGAMEMORY_SEARCH: "fts",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      NO_COLOR: "1",
    },
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error(`Subprocess did not complete: ${result.error?.message ?? result.signal}`, {
      cause: result.error,
    });
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("stats --health --json: readonly-путь", () => {
  it("JSON-only с группами A1 и признаками полноты; база байт в байт та же", () => {
    const before = sha(dbPath);
    const r = spawnCli(["stats", "--health", "--json", "--db", dbPath]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ["activity_window", "completeness", "db", "generated_at", "state_now", "window"].sort()
    );
    const completeness = parsed.completeness as Record<string, unknown>;
    expect(completeness.coverage).toBeTypeOf("string");
    expect(Array.isArray(completeness.reasons)).toBe(true);
    expect(parsed.state_now).toBeDefined();
    expect(parsed.activity_window).toBeDefined();
    // Байты не изменились (readonly-путь без side-эффектов).
    expect(sha(dbPath)).toBe(before);
  });

  it("вывод только JSON: воронка и health вместе — объект с двумя секциями", () => {
    const r = spawnCli(["stats", "--funnel", "--health", "--json", "--db", dbPath]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["funnel", "health"].sort());
    // Легаси-поля воронки не переименованы.
    const funnel = parsed.funnel as Record<string, unknown>;
    expect(funnel).toHaveProperty("with_record");
    expect(funnel).toHaveProperty("must_read_opened");
  });

  it("легаси `stats --funnel --json` не изменил форму — ровно поля эталона", () => {
    const r = spawnCli(["stats", "--funnel", "--json", "--db", dbPath]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "db",
        "window",
        "session_gap_minutes",
        "sessions_total",
        "understand_sessions",
        "started_with_understand",
        "with_follow_up",
        "with_record",
        "avg_calls_per_understand_session",
        "must_read_issued",
        "must_read_opened",
        "shares",
      ].sort()
    );
  });
});

describe("stats --window", () => {
  it("30d задаёт окно всем секциям (health.from = now-30d)", () => {
    const r = spawnCli(["stats", "--health", "--json", "--window", "30d", "--db", dbPath]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { window: { requested: string; from: string } };
    expect(parsed.window.requested).toBe("30d");
    expect(parsed.window.from).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("all — окно без нижней границы", () => {
    const r = spawnCli(["stats", "--health", "--json", "--window=all", "--db", dbPath]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { window: { requested: string; from: string | null } };
    expect(parsed.window.requested).toBe("all");
    expect(parsed.window.from).toBeNull();
  });

  it("неверное значение — явная ошибка и exit 1", () => {
    const r = spawnCli(["stats", "--health", "--json", "--window", "2w", "--db", dbPath]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("7d|30d|all");
  });
});

describe("stats --health: отсутствие записей не ломает exit code", () => {
  it("пустая база — exit 0, человекочитаемая секция без проблем", () => {
    const emptyDb = path.join(tmpDir, "empty.db");
    const db = new KnowledgeDB(emptyDb);
    db.close();
    const r = spawnCli(["stats", "--health", "--db", emptyDb]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Health");
    expect(r.stdout).toContain("Completeness");
    expect(r.stdout).toContain("unknown"); // честный unknown на пустой базе
  });
});
