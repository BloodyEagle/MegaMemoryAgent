import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "../migrate-schema.js";
import { buildNodeWithContext, currentDigestsOf, getConcept } from "../tools.js";
import { MODEL_NAME } from "../embeddings.js";
import { reembed } from "../reembed.js";
import { LIST_ROOTS_SEARCH_HINT } from "../next-hints.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";
import { startAuditHttpSrc } from "./helpers/audit-http-src.js";

const RECORD = "Знание уже в графе: дополняй/исправляй через update_concept; новое решение с опорой на этот узел — create_concept с evidence: [{node: \"<id>\", why: \"…\"}].";
const OVERVIEW = "Это обзор; итог работы по конкретной ветке — отдельный узел, а не правка корня.";
const repository = fileURLToPath(new URL("../../", import.meta.url));
type Response = Awaited<ReturnType<Client["callTool"]>>;
type Payload = { hint?: string | { record: string }; hint_search?: string; id?: string; unchanged?: boolean; batch?: Array<{ id: string; status: string }>; meta?: { tokens_estimated?: number; version?: string; reason?: string; continuation?: string } };
let fixture: AuditFixture;
let client: Client | undefined;

beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => {
  try { await client?.close(); } finally { client = undefined; await fixture.close(); }
});

/** `seed === "vectors"`: непустая база с рабочим поколением векторов, сервер в hybrid-режиме. */
async function start(seed: boolean | "vectors" = true): Promise<Client> {
  const db = fixture.db("read.db");
  try {
    ensureSchema(db);
    db.setMetaValue("embed_model", "read-hints-disabled-vector-space");
    if (seed) addNode(db, "read-hints", { summary: "Read hints preserve the existing card and its evidence." });
    if (seed === "vectors") {
      db.setMetaValue("embed_model", MODEL_NAME);
      await reembed(db, { embedFn: async () => {
        const buffer = Buffer.alloc(8);
        buffer.writeFloatLE(1, 0);
        return buffer;
      } });
    }
  } finally { await fixture.release(db); }
  const profile = fixture.profile();
  const env = Object.fromEntries(Object.entries(profile.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(path.join(repository, "node_modules/tsx/dist/loader.mjs")).href,
      path.join(repository, "src/index.ts"), "--db", fixture.file("read.db")],
    cwd: fixture.root, stderr: "pipe",
    env: { ...env, NODE_OPTIONS: "", MEGAMEMORY_SEARCH: seed === "vectors" ? "hybrid" : "fts", MEGAMEMORY_AUTO_MIGRATE: "0", MEGAMEMORY_AUTO_DIGEST: "0",
      MEGAMEMORY_TELEMETRY_PATH: "", XDG_CONFIG_HOME: fixture.file("config"), XDG_CACHE_HOME: fixture.file("cache"),
      XDG_DATA_HOME: fixture.file("data"), HF_HOME: fixture.file("hf"), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
  });
  client = new Client({ name: "read-hints-regression", version: "1" });
  await client.connect(transport, { timeout: 7_000 });
  return client;
}

function textContent(response: Response): { type: "text"; text: string } {
  if (!Array.isArray(response.content) || response.content.length !== 1) throw new Error("Expected one text response");
  const item: unknown = response.content[0];
  if (!item || typeof item !== "object" || !("type" in item) || item.type !== "text"
    || !("text" in item) || typeof item.text !== "string") throw new Error("Expected one text response");
  return { type: "text", text: item.text };
}

function parse(response: Response): Payload {
  return JSON.parse(textContent(response).text) as Payload;
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

  it("does not add a hint to a budget refusal and names the card minimum", async () => {
    const source = await start();
    const response = await source.callTool({ name: "get_concept", arguments: { id: "read-hints", profile: "orientation", max_tokens: 100 } });
    expect(response.isError).toBe(true);
    expect(response.meta).toEqual({ reason: "budget" });
    expect(textContent(response)).toMatchObject({ type: "text", text: expect.stringContaining("MEGAMEMORY_ERROR") });
    expect(textContent(response).text).toMatch(/max_tokens=100 cannot fit the required response \(budget refusal, minimum \d+\)\./);
    expect(response.content).not.toHaveProperty("0.hint");
  });

  it("returns the card without its hint when only the hint exceeds the budget", async () => {
    const source = await start();
    const first = await source.callTool({ name: "get_concept", arguments: { id: "read-hints", profile: "orientation", max_tokens: 4000 } });
    const hinted = parse(first);
    expect(hinted.hint).toEqual({ record: RECORD });
    const withHint = hinted.meta!.tokens_estimated!;
    // Минимум ответа без hint сервер называет в отказе; cap берём посередине
    // между «влезает без hint» и «влезает с hint» — устойчиво к эху
    // max_tokens в meta и к длине подсказки (2.14.1/35 T7).
    const refusal = await source.callTool({ name: "get_concept", arguments: { id: "read-hints", profile: "orientation", max_tokens: 100 } });
    expect(refusal.isError).toBe(true);
    const base = Number(/minimum (\d+)/.exec(textContent(refusal).text)?.[1]);
    expect(base).toBeGreaterThan(0);
    expect(base).toBeLessThan(withHint);
    const cap = Math.floor((base + withHint) / 2);
    const payload = assertBudget(await source.callTool({ name: "get_concept", arguments: { id: "read-hints", profile: "orientation", max_tokens: cap } }), cap);
    expect(payload.hint).toBeUndefined();
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

  it("names keyword-only search in hint_search without changing hint", async () => {
    const source = await start();
    const response = await source.callTool({ name: "list_roots", arguments: { max_tokens: 1500 } });
    const payload = assertBudget(response, 1500);
    expect(payload.hint).toEqual({ record: OVERVIEW });
    expect(payload.hint_search).toBe(LIST_ROOTS_SEARCH_HINT);
  });

  it("omits hint_search once the vector channel is on", async () => {
    const source = await start("vectors");
    const response = await source.callTool({ name: "list_roots", arguments: { max_tokens: 1500 } });
    const payload = assertBudget(response, 1500);
    expect(payload.hint).toEqual({ record: OVERVIEW });
    expect(payload).not.toHaveProperty("hint_search");
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
    expect(textContent(missing)).toMatchObject({ type: "text", text: expect.stringContaining("not found") });
    expect(missing.content).not.toHaveProperty("0.hint");
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

  it("advertises and accepts optional keyword matching through tools/list", async () => {
    const source = await start();
    const { tools } = await source.listTools();
    const schema = tools.find((tool) => tool.name === "understand")!.inputSchema;
    expect(schema.properties?.match).toMatchObject({ type: "string", enum: ["all", "any"] });
    expect(schema.required).not.toContain("match");
    expect(schema.properties?.query).toMatchObject({ description: expect.stringContaining("by default") });
    const response = await source.callTool({ name: "understand", arguments: { query: "read-hints zzmissingzz", match: "any" } });
    const payload = assertBudget(response, 4000);
    expect(payload.meta).toMatchObject({ match: "any" });
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
