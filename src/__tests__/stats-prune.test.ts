/**
 * B-05 (аудит 2026-11-12): `stats --prune` — boolean-флаг. Раньше наличие
 * флага определялось через getFlag, требующий следующий аргумент argv:
 * голый `--prune` в конце списка видел undefined и очистка журнала молча
 * не запускалась. Проверяется состояние timeline (а не только вывод) и то,
 * что без флага ручная очистка не выполняется.
 *
 * runStats вызывается in-process: база в изолированном tmp-каталоге, консоль
 * замокана, process.exit перехвачен (упавшая команда не уйдёт мимо теста).
 * Сам тест держит базу закрытой между вызовами runStats — команда открывает
 * её сама, второй открытый хэндл не нужен.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { runStats } from "../stats.js";
import { cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-stats-prune-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  vi.stubEnv("MEGAMEMORY_TIMELINE_RETENTION_DAYS", "90");
  vi.stubEnv("MEGAMEMORY_DB_PATH", path.join(tmpDir, "never-opened.db"));
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  (globalThis as { gc?: () => void }).gc?.();
  await cleanupDir(tmpDir);
});

/** Свежая база с одной журнальной записью от 2000-01-01 (старше retention 90 дней). */
function seedOldEntry(): void {
  const db = new KnowledgeDB(dbPath);
  try {
    const seq = db.insertTimelineEntry({
      tool: "understand",
      params: JSON.stringify({ query: "старый вызов" }),
      result_summary: "",
      is_write: false,
      is_error: false,
      affected_ids: [],
    });
    db.execSqlRun("UPDATE timeline SET timestamp = ? WHERE seq = ?", "2000-01-01 00:00:00", seq);
  } finally {
    db.close();
  }
}

function timelineCount(): number {
  const db = new KnowledgeDB(dbPath, { readonly: true });
  try {
    const rows = db.execSqlAll("SELECT COUNT(*) AS n FROM timeline") as Array<{ n: number }>;
    return Number(rows[0].n);
  } finally {
    db.close();
  }
}

function captureConsole(): string[] {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  return out;
}

describe("B-05: stats --prune — boolean-флаг очистки журнала", () => {
  it("--prune последним аргументом удаляет запись старше retention", async () => {
    seedOldEntry();
    const out = captureConsole();

    await runStats(["--db", dbPath, "--prune"]);

    expect(timelineCount(), "B-05: --prune в конце argv обязан запустить очистку").toBe(0);
    expect(out.join("\n")).toContain("Timeline pruned");
  });

  it("--prune первым аргументом (--prune --db path) тоже удаляет", async () => {
    seedOldEntry();
    captureConsole();

    await runStats(["--prune", "--db", dbPath]);

    expect(timelineCount(), "B-05: позиция --prune в argv не влияет на очистку").toBe(0);
  });

  it("без --prune очистка не запускается — запись остаётся", async () => {
    seedOldEntry();
    const out = captureConsole();

    await runStats(["--db", dbPath]);

    expect(timelineCount()).toBe(1);
    expect(out.join("\n")).not.toContain("Timeline pruned");
  });

  it("--funnel --json --prune идёт полным путём: prune выполняется, funnel-вывод не ломается", async () => {
    seedOldEntry();
    const out = captureConsole();

    await runStats(["--funnel", "--json", "--prune", "--db", dbPath]);

    expect(timelineCount(), "B-05: --prune рядом с --funnel --json обязан выполняться").toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Timeline pruned");
    expect(text).toContain("Funnel");
  });
});
