import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "../migrate-schema.js";
import { buildNodeWithContext, currentDigestsOf, getConcept } from "../tools.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";
import { startAuditHttpSrc } from "./helpers/audit-http-src.js";

const RECORD = "Узел уже есть — уточняй его через update_concept, а не создавай второй; опоры к решению — evidence в том же вызове.";
const OVERVIEW = "Это обзор; итог работы по конкретной ветке — отдельный узел, а не правка корня.";
const repository = fileURLToPath(new URL("../../", import.meta.url));
type Response = Awaited<ReturnType<Client["callTool"]>>;
type Payload = { hint?: string | { record: string }; id?: string; unchanged?: boolean; batch?: Array<{ id: string; status: string }>; meta?: { tokens_estimated?: number; version?: string; reason?: string; continuation?: string } };
let fixture: AuditFixture;
let client: Client | undefined;

beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => {
  try { await client?.close(); } finally { client = undefined; await fixture.close(); }
});

async function start(seed = true): Promise<Client> {
  const db = fixture.db("read.db");
  try {
    ensureSchema(db);
    db.setMetaValue("embed_model", "read-hints-disabled-vector-space");
    if (seed) addNode(db, "read-hints", { summary: "Read hints preserve the existing card and its evidence." });
  } finally { await fixture.release(db); }
  const profile = fixture.profile();
  const env = Object.fromEntries(Object.entries(profile.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(path.join(repository, "node_modules/tsx/dist/loader.mjs")).href,
      path.join(repository, "src/index.ts"), "--db", fixture.file("read.db")],
    cwd: fixture.root, stderr: "pipe",
    env: { ...env, NODE_OPTIONS: "", MEGAMEMORY_SEARCH: "fts", MEGAMEMORY_AUTO_MIGRATE: "0", MEGAMEMORY_AUTO_DIGEST: "0",
      MEGAMEMORY_TELEMETRY_PATH: "", XDG_CONFIG_HOME: fixture.file("config"), XDG_CACHE_HOME: fixture.file("cache"),
      XDG_DATA_HOME: fixture.file("data"), HF_HOME: fixture.file("hf"), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
  });
  client = new Client({ name: "read-hints-regression", version: "1" });
  await client.connect(transport, { timeout: 7_000 });
  return client;
}

function parse(response: Response): Payload {
  expect(response.content).toHaveLength(1);
  const item = response.content[0];
  if (item.type !== "text") throw new Error("Expected one JSON text response");
  return JSON.parse(item.text) as Payload;
}

function assertBudget(response: Response, cap: number): Payload {
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const payload = parse(response);
  const tokens = Math.ceil(Buffer.byteLength(JSON.stringify({ content: response.content }), "utf8") / 3);
  expect(tokens).toBeLessThanOrEqual(cap);
  expect(payload.meta?.tokens_estimated).toBe(tokens);
  return payload;
}

describe("MCP-only record hints on reads", () => {
  it("adds the exact record hint to an existing legacy card without changing the core card", async () => {
    const source = await start();
    const response = await source.callTool({ name: "get_concept", arguments: { id: "read-hints" } });
    expect(response.isError).not.toBe(true);
    const { hint, ...card } = parse(response);
    expect(hint).toEqual({ record: RECORD });
    const db = fixture.db("read.db");
    try { expect(card).toEqual(getConcept(db, { id: "read-hints" })); } finally { await fixture.release(db); }
  });

  it.each(["orientation", "evidence"])("adds the hint to %s and measures the final envelope", async profile => {
    const source = await start();
    const response = await source.callTool({ name: "get_concept", arguments: { id: "read-hints", profile, max_tokens: 4000 } });
    expect(assertBudget(response, 4000).hint).toEqual({ record: RECORD });
  });

  it("does not add a hint to a budget refusal", async () => {
    const source = await start();
    const response = await source.callTool({ name: "get_concept", arguments: { id: "read-hints", profile: "orientation", max_tokens: 100 } });
    expect(response.isError).toBe(true);
    expect(response.meta).toEqual({ reason: "budget" });
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("MEGAMEMORY_ERROR") });
    expect(response.content[0]).not.toHaveProperty("hint");
  });

  it("refuses rather than overflowing when the card fits but its hint does not", async () => {
    const source = await start();
    const first = await source.callTool({ name: "get_concept", arguments: { id: "read-hints", profile: "full", max_tokens: 4000 } });
    const { hint, meta, ...card } = parse(first);
    expect(hint).toEqual({ record: RECORD });
    const cap = Math.ceil(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(card, null, 2) }] }), "utf8") / 3);
    const response = await source.callTool({ name: "get_concept", arguments: { id: "read-hints", profile: "full", max_tokens: cap } });
    expect(response.isError).toBe(true);
    expect(response.meta).toEqual({ reason: "budget" });
    expect(response.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("MEGAMEMORY_ERROR") });
    expect(response.content[0]).not.toHaveProperty("hint");
  });

  it("does not repeat the hint for an unchanged delta", async () => {
    const source = await start();
    const arguments_ = { id: "read-hints", profile: "orientation", context_epoch: "read-hints-epoch", max_tokens: 4000 };
    const first = parse(await source.callTool({ name: "get_concept", arguments: arguments_ }));
    expect(first.hint).toEqual({ record: RECORD });
    expect(first.meta?.version).toEqual(expect.any(String));
    const second = parse(await source.callTool({ name: "get_concept", arguments: { ...arguments_, known_versions: { "read-hints": first.meta!.version } } }));
    expect(second.unchanged).toBe(true);
    expect(second.hint).toBeUndefined();
  });

  it("adds its separate overview hint to nonempty list_roots", async () => {
    const source = await start();
    const response = await source.callTool({ name: "list_roots", arguments: { max_tokens: 1500 } });
    expect(assertBudget(response, 1500).hint).toEqual({ record: OVERVIEW });
  });

  it("preserves the original empty-graph hint rather than adding a record hint", async () => {
    const source = await start(false);
    const payload = assertBudget(await source.callTool({ name: "list_roots", arguments: {} }), 1500);
    expect(payload.hint).toBe("Graph is empty. Run /user:bootstrap-memory to populate, or create concepts as you work.");
  });

  it("does not add a record hint to an absent concept or an all-error batch", async () => {
    const source = await start();
    const missing = await source.callTool({ name: "get_concept", arguments: { id: "missing" } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not found") });
    expect(missing.content[0]).not.toHaveProperty("hint");
    const batch = await source.callTool({ name: "get_concept", arguments: { ids: ["missing"], max_tokens: 1500 } });
    expect(assertBudget(batch, 1500).hint).toBeUndefined();
  });

  it("adds a single top-level record hint to a nonempty batch", async () => {
    const source = await start();
    const response = await source.callTool({ name: "get_concept", arguments: { ids: ["read-hints", "missing"], max_tokens: 4000 } });
    const payload = assertBudget(response, 4000);
    expect(payload.hint).toEqual({ record: RECORD });
    expect(payload.batch).toMatchObject([{ id: "read-hints", status: "ok" }, { id: "missing", status: "error" }]);
  });

  it("keeps input schemas unchanged and JSON valid for a client unaware of hints", async () => {
    const source = await start();
    const { tools } = await source.listTools();
    for (const name of ["get_concept", "list_roots"]) {
      const tool = tools.find(item => item.name === name)!;
      expect(tool.inputSchema.properties).not.toHaveProperty("hint");
      expect(tool.inputSchema.required ?? []).not.toContain("hint");
      expect(tool.outputSchema).toBeUndefined();
      const payload = parse(await source.callTool({ name, arguments: name === "get_concept" ? { id: "read-hints" } : {} }));
      expect(payload.hint).toEqual({ record: name === "get_concept" ? RECORD : OVERVIEW });
    }
  });

  it("keeps the HTTP card equal to the pre-hint payload without a new field", async () => {
    await start();
    await client!.close();
    client = undefined;
    const db = fixture.db("read.db");
    let expected: Record<string, unknown>;
    try {
      const node = db.getNode("read-hints")!;
      expected = { ...buildNodeWithContext(db, node), created_at: node.created_at, updated_at: node.updated_at,
        created_by_task: node.created_by_task, current_digests: currentDigestsOf(node) };
    } finally { await fixture.release(db); }
    const server = await startAuditHttpSrc(fixture, fixture.file("read.db"));
    try {
      const response = await server.request("/api/node/read-hints");
      expect(response.status).toBe(200);
      const payload = JSON.parse(response.text) as Record<string, unknown>;
      expect(payload).toEqual(expected);
      expect(payload).not.toHaveProperty("hint");
    } finally { await server.close(); }
  });
});
