import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { auditFixture, addNode, type AuditFixture } from "./helpers/audit.js";
import { ensureSchema } from "../migrate-schema.js";
import { trailSave } from "../tools.js";
import type { BoardOutput, TrailView } from "../types.js";

let fixture: AuditFixture;
let child: ChildProcessWithoutNullStreams | undefined;
afterEach(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>(resolve => child!.once("close", () => resolve()));
    child.kill("SIGTERM");
    await stopped;
  }
  child = undefined;
  await fixture?.close();
});

async function start(seed: (db: ReturnType<AuditFixture["db"]>) => void) {
  fixture = auditFixture();
  const db = fixture.db("board-wire.db");
  ensureSchema(db);
  seed(db);
  await fixture.release(db);
  const profile = fixture.profile();
  const root = fileURLToPath(new URL("../../", import.meta.url));
  child = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href, path.join(root, "src/index.ts"), "--db", fixture.file("board-wire.db")], {
    cwd: fixture.root, env: { ...profile.env, NODE_OPTIONS: "", MEGAMEMORY_SEARCH: "fts", MEGAMEMORY_AUTO_MIGRATE: "0", MEGAMEMORY_AUTO_DIGEST: "0",
      XDG_CONFIG_HOME: fixture.file("config"), XDG_CACHE_HOME: fixture.file("cache"), XDG_DATA_HOME: fixture.file("data"),
      OPENCODE_CONFIG_DIR: fixture.file("opencode"), CODEX_HOME: fixture.file("codex"), CLAUDE_CONFIG_DIR: fixture.file("claude"),
      HF_HOME: fixture.file("hf"), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    shell: false, windowsHide: true,
  });
  let buffered = "", stderr = "", nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.stdin.on("error", () => {});
  child.stdout.on("data", chunk => {
    buffered += chunk.toString();
    const lines = buffered.split("\n"); buffered = lines.pop()!;
    for (const line of lines) {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); request.resolve(message); }
    }
  });
  child.on("error", error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
  child.on("close", code => { for (const request of pending.values()) request.reject(new Error(`MCP exited ${code}: ${stderr}`)); pending.clear(); });
  async function rpc(method: string, params: unknown) {
    const id = ++nextId;
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${stderr}`)); }, 8000);
      pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    expect(result.error, JSON.stringify(result)).toBeUndefined();
    return result.result;
  }
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "board-trail-regression", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    rpc,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await rpc("tools/call", { name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return JSON.parse(result.content[0].text);
    },
  };
}

describe("P-13 genuine source MCP board and trail routing", () => {
  it.each([0, 20, 21, 87])("D-03 %i done tasks paginate without duplicates in stable keyset order", async count => {
    const expected = Array.from({ length: count }, (_, i) => `done-${String(i).padStart(3, "0")}`).reverse();
    const mcp = await start(db => {
      for (let i = 0; i < count; i++) {
        const id = `done-${String(i).padStart(3, "0")}`;
        addNode(db, id, { kind: "task" }); db.setTaskState(id, "done");
        db.execSqlRun("UPDATE nodes SET updated_at = ? WHERE id = ?", i < Math.floor(count / 2) ? "2026-01-01 00:00:00" : "2026-02-01 00:00:00", id);
      }
      addNode(db, "open", { kind: "task" }); db.setTaskState("open", "open");
    });
    const first = await mcp.call("board") as BoardOutput;
    const firstDone = first.columns.find(column => column.name === "done")!;
    expect(firstDone).toMatchObject({ count, returned: Math.min(count, 20), has_more: count > 20, terminal: true });
    expect(first.columns.find(column => column.name === "open")?.cards.map(card => card.id)).toEqual(["open"]);
    expect((await mcp.call("board") as BoardOutput).columns).toEqual(first.columns);
    const seen = firstDone.cards.map(card => card.id);
    let page = firstDone;
    while (page.has_more) {
      expect(page.next_cursor).toEqual(expect.any(String));
      const next = await mcp.call("board", { done_cursor: page.next_cursor, done_limit: 7 }) as BoardOutput;
      page = next.columns.find(column => column.name === "done")!;
      expect(page.count).toBe(count);
      expect(page.returned).toBe(page.cards.length);
      expect(page.returned).toBeLessThanOrEqual(7);
      seen.push(...page.cards.map(card => card.id));
      expect(seen.length).toBeLessThanOrEqual(count);
    }
    expect(page.next_cursor).toBeNull();
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(count);
    const listed = await mcp.rpc("tools/list", {});
    const schema = listed.tools.find((tool: any) => tool.name === "board").inputSchema;
    expect(schema.properties.done_cursor.type).toBe("string");
    expect(schema.properties.done_limit).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
    for (const args of [{ done_cursor: "not-a-cursor" }, { done_cursor: "" }, { done_limit: 0 }, { done_limit: 101 }, { done_limit: 1.5 }]) {
      const result = await mcp.rpc("tools/call", { name: "board", arguments: args });
      expect(result.isError).toBe(true);
    }
  });

  it.each(["fresh", "expired", "refuted", "broken"] as const)("D-04 %s trail refresh reports actual post-state and reasons", async scenario => {
    let id = "";
    const mcp = await start(db => {
      addNode(db, "member");
      id = trailSave(db, { node_ids: ["member"], summary: "Independent reasoning chain", name: scenario }).id;
      if (scenario === "expired") db.execSqlRun("UPDATE nodes SET valid_until = '2020-01-01' WHERE id = 'member'");
      if (scenario === "refuted") db.setEpistemicStatus("member", "refuted", "Independent counterexample", null);
      if (scenario === "broken") db.execSqlRun("DELETE FROM nodes WHERE id = 'member'");
    });
    const before = await mcp.call("trail_get", { id }) as TrailView;
    if (scenario === "broken") {
      const rejected = await mcp.rpc("tools/call", { name: "trail_refresh", arguments: { id } });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toMatch(/chain is broken, refresh impossible/);
      expect(await mcp.call("trail_get", { id })).toEqual(before);
      return;
    }
    const refresh = await mcp.call("trail_refresh", { id });
    const actual = await mcp.call("trail_get", { id }) as TrailView;
    const state = scenario === "fresh" ? "fresh" : "stale";
    expect(refresh.state).toBe(state);
    expect(actual.state).toBe(state);
    expect(refresh.message).toContain(`chain is ${state}`);
    expect(refresh.reasons).toEqual(actual.members.filter(member => member.state !== "fresh").map(member => member.reason));
    expect(refresh.reasons.length).toBe(scenario === "fresh" ? 0 : 1);
    if (scenario !== "fresh") expect(refresh.reasons[0]).toEqual(expect.any(String));
  });
});
