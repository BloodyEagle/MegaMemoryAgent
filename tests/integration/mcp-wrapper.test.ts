import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../../src/db.js";
import { cleanupDir } from "../../src/__tests__/helpers/cleanup.js";

// F1 (2.1.1): the tool descriptions promise "reading writes nothing to the
// graph or snapshots" while the wrapper DOES log service telemetry to the
// timeline table. This test pins exactly that contract at the wrapper layer
// (the DB-level tests cannot see the timeline.log calls): counts in nodes,
// edges, support_baselines and provenance_audit_runs stay put, timeline grows
// by the number of read calls. It is the guard against "fixing" the wording
// by silently disabling the telemetry.

const repoRoot = path.resolve(import.meta.dirname, "../..");
const serverScript = path.join(repoRoot, "dist", "index.js");

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

interface Pending {
  id: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Minimal MCP stdio client: newline-delimited JSON-RPC over the pipes. */
async function startServer(dbFile: string): Promise<{
  request: (method: string, params: unknown) => Promise<unknown>;
  notify: (method: string) => void;
}> {
  child = spawn(process.execPath, [serverScript], {
    env: { ...process.env, MEGAMEMORY_DB_PATH: dbFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  const pending = new Map<number, Pending>();
  let nextId = 1;
  child.stdout?.on("data", (d) => {
    out += String(d);
    for (;;) {
      const nl = out.indexOf("\n");
      if (nl === -1) break;
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout must not crash the reader
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`rpc error: ${msg.error.message ?? "unknown"}`));
        else p.resolve(msg.result);
      }
    }
  });
  let errText = "";
  child.stderr?.on("data", (d) => {
    errText += String(d);
  });
  const exited = new Promise<never>((_, reject) => {
    child!.on("exit", (code) =>
      reject(new Error(`mcp server exited early (${code}): ${errText}`))
    );
  });

  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const p = new Promise<unknown>((resolve, reject) =>
      pending.set(id, { id, resolve, reject })
    );
    child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout on ${method}: ${errText}`)), 20000)
      ),
      exited,
    ]);
  };
  const notify = (method: string): void => {
    child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  };

  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "megamemory-test", version: "0.0.0" },
  });
  notify("notifications/initialized");
  return { request, notify };
}

function countRows(db: KnowledgeDB, table: string): number {
  const exists = db.execSqlFirst(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
    table
  );
  if (!exists) return 0;
  return Number((db.execSqlFirst(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n);
}

describe("mcp wrapper read contract (F1, 2.1.1)", () => {
  it(
    "get_concept and provenance_trace write telemetry only: graph, snapshots and audit runs stay put, timeline grows",
    { timeout: 60000 },
    async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-mcp-wrapper-"));
      const dbFile = path.join(tmpDir, "knowledge.db");

      // Fixture: a decision with one confirmed support, so provenance_trace
      // runs the support check on its way through.
      const seed = new KnowledgeDB(dbFile);
      seed.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
      seed.insertNode({ id: "f", name: "F", kind: "config", summary: "fact f" });
      seed.insertEdgeRaw({
        from_id: "d",
        to_id: "f",
        relation: "informed_by",
        description: "why f",
      });
      seed.close();

      const before = {
        timeline: 0, // fresh db — the wrapper is the only timeline writer
        nodes: 2,
        edges: 1,
        baselines: 0,
        auditRuns: 0,
      };

      const { request } = await startServer(dbFile);

      const call = (name: string, args: unknown): Promise<{ content: Array<{ text: string }> }> =>
        request("tools/call", { name, arguments: args }) as Promise<{
          content: Array<{ text: string }>;
        }>;

      const concept = await call("get_concept", { id: "d" });
      expect(JSON.parse(concept.content[0].text).id).toBe("d");

      const trace = await call("provenance_trace", { node_id: "d" });
      const parsed = JSON.parse(trace.content[0].text);
      expect(parsed.total_within_depth).toBeGreaterThanOrEqual(2);

      child!.kill();
      child = null;

      const after = new KnowledgeDB(dbFile);
      try {
        expect(countRows(after, "nodes")).toBe(before.nodes);
        expect(countRows(after, "edges")).toBe(before.edges);
        expect(countRows(after, "support_baselines")).toBe(before.baselines);
        expect(countRows(after, "provenance_audit_runs")).toBe(before.auditRuns);

        const entries = after.getTimelineEntries();
        expect(entries).toHaveLength(before.timeline + 2);
        expect(entries.map((e) => e.tool)).toEqual(["get_concept", "provenance_trace"]);
        for (const e of entries) {
          expect(e.is_write).toBe(0);
          expect(e.is_error).toBe(0);
        }
      } finally {
        after.close();
      }
    }
  );
});
