/**
 * B-06 (аудит 2026-11-12): зелёный путь eval CLI с настоящей базой —
 * корректный набор работает как раньше, а честный (полный) набор проходит
 * quality gate по факту: hit + корректный miss = recall 0.5 не проходит
 * `--min 0.8`. Fail-closed разбор неполных наборов — в eval-parser.test.ts.
 *
 * runEvalCli вызывается in-process: база создаётся и закрывается до вызова
 * (команда открывает её readonly сама), консоль замокана, process.exit
 * перехвачен.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { runEvalCli } from "../eval-cli.js";
import { cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
let dbPath: string;
let out: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-eval-gate-"));
  dbPath = path.join(tmpDir, "knowledge.db");
  vi.stubEnv("MEGAMEMORY_DB_PATH", path.join(tmpDir, "never-opened.db"));
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  (globalThis as { gc?: () => void }).gc?.();
  await cleanupDir(tmpDir);
});

function seedDb(nodes: Array<{ id: string; name: string; kind: string; summary: string }>): void {
  const db = new KnowledgeDB(dbPath);
  try {
    for (const node of nodes) db.insertNode(node);
  } finally {
    db.close();
  }
}

function writeEvalFile(pairs: Array<{ query: string; expected_id: string; lang?: string }>): string {
  const file = path.join(tmpDir, "eval.jsonl");
  fs.writeFileSync(
    file,
    pairs.map((p) => JSON.stringify(p)).join("\n") + "\n",
    "utf8"
  );
  return file;
}

/** picocolors красит вывод и в захваченной консоли — сравниваем чистый текст. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("B-06: eval CLI на корректном наборе — gate по факту", () => {
  it("hit + корректный miss → recall 0.500 и --min 0.8 → exit 1", async () => {
    seedDb([{ id: "a", name: "Alpha", kind: "feature", summary: "alpha node" }]);
    const file = writeEvalFile([
      { query: "Alpha", expected_id: "a", lang: "en" },
      { query: "несуществующий запрос", expected_id: "ghost", lang: "ru" },
    ]);

    await expect(
      runEvalCli(["--db", dbPath, "--file", file, "--min", "0.8"])
    ).rejects.toThrow(/exit:1/);

    const text = stripAnsi(out.join("\n"));
    expect(text).toContain("overall: 0.500 (1/2)");
    expect(text).toContain("recall 0.500 < min 0.8");
  });

  it("полный корректный набор проходит как раньше — recall 1, exit не вызывается", async () => {
    seedDb([
      { id: "a", name: "Alpha", kind: "feature", summary: "alpha node" },
      { id: "b", name: "Beta", kind: "feature", summary: "beta node" },
    ]);
    const file = writeEvalFile([
      { query: "Alpha", expected_id: "a", lang: "en" },
      { query: "Beta", expected_id: "b", lang: "en" },
    ]);

    await runEvalCli(["--db", dbPath, "--file", file, "--min", "0.8"]);

    const text = stripAnsi(out.join("\n"));
    expect(text).toContain("overall: 1.000 (2/2)");
    expect(text).toContain("recall@10 1.000 >= 0.8");
  });
});
