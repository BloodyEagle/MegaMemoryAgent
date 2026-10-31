import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../../src/db.js";
import { ensureSchema } from "../../src/migrate-schema.js";
import { cleanupDir } from "../../src/__tests__/helpers/cleanup.js";

// Integration (plan 3.3): real HTTP server on an ephemeral port, real
// cyrillic ids through the URL layer, killed afterwards.

const repoRoot = path.resolve(import.meta.dirname, "../..");
const serveScript = path.join(repoRoot, "dist", "index.js");

let child: ChildProcess | null = null;
let tmpDir: string | null = null;
let port = 0;

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

function startServe(dbFile: string): Promise<number> {
  port = 43000 + Math.floor(Math.random() * 10000);
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [serveScript, "serve", "--port", String(port)], {
      env: { ...process.env, MEGAMEMORY_DB_PATH: dbFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.stderr?.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (code) => reject(new Error(`serve exited early (${code}): ${out}`)));

    const started = Date.now();
    const poll = async (): Promise<void> => {
      while (Date.now() - started < 20000) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
          if (res.ok) {
            resolve(port);
            return;
          }
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      reject(new Error(`serve did not start in 20s: ${out}`));
    };
    void poll();
  });
}

describe("serve integration", () => {
  it(
    "exposes graph, search and node APIs with cyrillic ids over HTTP",
    { timeout: 45000 },
    async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-serve-"));
      const dbFile = path.join(tmpDir, "knowledge.db");
      const db = new KnowledgeDB(dbFile);
      ensureSchema(db);
      db.insertNode({ id: "книга", name: "Книга", kind: "module", summary: "рецепты и заметки" });
      db.insertNode({
        id: "книга/поиск",
        name: "Поиск",
        kind: "feature",
        summary: "полнотекстовый поиск",
        parent_id: "книга",
      });
      db.insertNode({ id: "模块", name: "模块设计", kind: "module", summary: "支付模块" });
      db.close();

      const actualPort = await startServe(dbFile);
      expect(actualPort).toBeGreaterThan(0);

      // /api/graph: all nodes present with status field.
      const graph = (await (await fetch(`http://127.0.0.1:${actualPort}/api/graph`)).json()) as {
        nodes: Array<{ id: string; status: string }>;
      };
      const ids = graph.nodes.map((n) => n.id);
      expect(ids).toContain("книга");
      expect(ids).toContain("книга/поиск");
      expect(ids).toContain("模块");
      expect(graph.nodes.every((n) => typeof n.status === "string")).toBe(true);

      // /api/search with cyrillic query.
      const search = (await (
        await fetch(`http://127.0.0.1:${actualPort}/api/search?q=${encodeURIComponent("Книга")}`)
      ).json()) as { matches: Array<{ id: string; via?: string }>; meta: { returned: number } | null };
      expect(search.matches.length).toBeGreaterThan(0);
      expect(search.matches[0].id).toBe("книга");
      expect(search.meta).not.toBeNull();

      // /api/node with a cyrillic nested id (URL-encoded).
      const nodeRes = await fetch(
        `http://127.0.0.1:${actualPort}/api/node/${encodeURIComponent("книга/поиск")}`
      );
      expect(nodeRes.status).toBe(200);
      const node = (await nodeRes.json()) as {
        id: string;
        name: string;
        parent: { id: string } | null;
      };
      expect(node.id).toBe("книга/поиск");
      expect(node.parent?.id).toBe("книга");

      // /api/stats: embeddings + usage blocks surfaced.
      const stats = (await (await fetch(`http://127.0.0.1:${actualPort}/api/stats`)).json()) as {
        nodes: number;
        embeddings: { model: string | null; vector_search: boolean };
        usage: { total_queries: number };
      };
      expect(stats.nodes).toBe(3);
      expect(stats.embeddings).toBeDefined();
      expect(stats.usage).toBeDefined();
    }
  );
});
