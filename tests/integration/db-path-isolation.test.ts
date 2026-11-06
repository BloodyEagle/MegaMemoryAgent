import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../../src/db.js";
import { ensureSchema } from "../../src/migrate-schema.js";
import { cleanupDir } from "../../src/__tests__/helpers/cleanup.js";

// 2.1.13 F6, тесты (34) и (35): интеграционный тест находит базу в temp,
// а не в домашнем каталоге; MEGAMEMORY_DB_PATH из окружения не влияет —
// явный --db всегда выигрывает, база по env-пути не создаётся и не читается.

const repoRoot = path.resolve(import.meta.dirname, "../..");
const serveScript = path.join(repoRoot, "dist", "index.js");

let child: ChildProcess | null = null;
let tmpDir: string | null = null;

afterEach(async () => {
  if (child) {
    child.kill();
    child = null;
  }
  if (tmpDir) {
    await cleanupDir(tmpDir);
    tmpDir = null;
  }
});

describe("db path isolation (F6 2.1.13)", () => {
  it(
    "serve uses explicit --db; poisoned MEGAMEMORY_DB_PATH is ignored and its db is not created",
    { timeout: 45000 },
    async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-dbpath-"));
      const realDb = path.join(tmpDir, "real", "knowledge.db");
      fs.mkdirSync(path.dirname(realDb));
      const db = new KnowledgeDB(realDb);
      ensureSchema(db);
      db.insertNode({
        id: "изолированный-узел",
        name: "Изолированный",
        kind: "module",
        summary: "база в temp, а не в домашнем каталоге",
      });
      db.close();

      // Отравленный env-путь: если serve его прочитает, здесь появится база.
      const poisonedDir = path.join(tmpDir, "home-catalog-не-создавать");
      const poisonedDb = path.join(poisonedDir, "knowledge.db");

      const port = 43000 + Math.floor(Math.random() * 10000);
      child = spawn(
        process.execPath,
        [serveScript, "serve", "--port", String(port), "--db", realDb],
        {
          env: { ...process.env, MEGAMEMORY_DB_PATH: poisonedDb, MEGAMEMORY_SEARCH: "fts" },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let out = "";
      let exitInfo: string | null = null;
      child.stdout?.on("data", (d) => {
        out += String(d);
      });
      child.stderr?.on("data", (d) => {
        out += String(d);
      });
      // ранний выход фиксируем, а не бросаем из обработчика — kill в
      // afterEach тоже проходит через exit
      child.on("exit", (code) => {
        exitInfo = `serve exited early (${code}): ${out}`;
      });

      // ждём подъёма и читаем граф
      const started = Date.now();
      let payload: { nodes: Array<{ id: string }> } | null = null;
      while (Date.now() - started < 20000) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/graph`);
          if (res.ok) {
            payload = (await res.json()) as { nodes: Array<{ id: string }> };
            break;
          }
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(exitInfo).toBeNull();
      expect(payload).not.toBeNull();
      expect(payload!.nodes.map((n) => n.id)).toContain("изолированный-узел");

      // (35): база по env-пути не создана, каталог не появился
      expect(fs.existsSync(poisonedDb)).toBe(false);
      expect(fs.existsSync(poisonedDir)).toBe(false);
    }
  );
});
