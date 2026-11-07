import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../../src/db.js";
import { ensureSchema } from "../../src/migrate-schema.js";
import { cleanupDir } from "../../src/__tests__/helpers/cleanup.js";
import { AuditCleanupError, auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

// Integration (plan 3.3): real HTTP server on an ephemeral port, real
// cyrillic ids through the URL layer, killed afterwards.

let serverFixture: AuditFixture | null = null;
let tmpDir: string | null = null;
let port = 0;

afterEach(async () => {
  const errors: unknown[] = [];
  try {
    await serverFixture?.close();
  } catch (error) {
    errors.push(error);
  } finally {
    serverFixture = null;
    if (tmpDir) {
      try { await cleanupDir(tmpDir); } catch (error) { errors.push(error); }
      tmpDir = null;
    }
  }
  if (errors.length) throw new AuditCleanupError("HTTP fixture cleanup failed", { cause: new AggregateError(errors) });
});

async function startServe(dbFile: string): Promise<number> {
  serverFixture = auditFixture();
  const server = await startAuditHttp(serverFixture, dbFile);
  port = server.port;
  return port;
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

describe("serve export endpoints (U2)", () => {
  it(
    "serves the bundle and single-node markdown with attachment headers",
    { timeout: 45000 },
    async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-export-serve-"));
      const dbFile = path.join(tmpDir, "knowledge.db");
      const db = new KnowledgeDB(dbFile);
      ensureSchema(db);
      db.insertNode({ id: "книга", name: "Книга", kind: "module", summary: "заметки" });
      db.insertNode({
        id: "книга/поиск",
        name: "Поиск",
        kind: "feature",
        summary: "полнотекстовый поиск",
        parent_id: "книга",
      });
      db.close();

      const port = await startServe(dbFile);

      // Bundle: one file per node + attachment header.
      const bundleRes = await fetch(`http://127.0.0.1:${port}/api/export.json`);
      expect(bundleRes.headers.get("content-disposition")).toContain("megamemory-export.json");
      const bundle = (await bundleRes.json()) as { generated_at: string; files: Record<string, string> };
      expect(Object.keys(bundle.files)).toHaveLength(2);
      expect(Object.values(bundle.files)[0]).toContain("---"); // frontmatter present

      // Single node: attachment, valid markdown.
      const mdRes = await fetch(
        `http://127.0.0.1:${port}/api/node/${encodeURIComponent("книга/поиск")}.md`
      );
      expect(mdRes.headers.get("content-disposition")).toContain(".md");
      const md = await mdRes.text();
      expect(md.startsWith("---")).toBe(true);
      expect(md).toContain("полнотекстовый поиск");
    }
  );
});
