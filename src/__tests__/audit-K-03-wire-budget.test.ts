import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ensureSchema } from "../migrate-schema.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";
import type { KnowledgeDB } from "../db.js";
import type { UnderstandInput, UnderstandOutput, ConceptBatchOutput } from "../types.js";
import type { ConceptToolArgs } from "../concept-profile.js";

type WireResponse = { content: Array<{ type: string; text: string }>; isError?: boolean; meta?: { reason: string } };
type Handler = (params: UnderstandInput | ConceptToolArgs) => Promise<WireResponse>;
const boundary = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), schemas: new Map<string, unknown>() }));

// Only the SDK transport/registration boundary is replaced. The production
// index.ts callback, tool, database, instruction fields and pretty serializer run.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, _description: string, schema: unknown, handler: Handler) {
      boundary.schemas.set(name, schema);
      boundary.handlers.set(name, handler);
      return this;
    }
    async connect() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("Audit tests must not load an inference model"); }),
}));

let fixture: AuditFixture;
let originalArgv: string[];
beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
  originalArgv = process.argv;
  process.argv = [process.execPath, fileURLToPath(new URL("../index.ts", import.meta.url))];
  vi.stubEnv("MEGAMEMORY_DB_PATH", fixture.file("wire.db"));
  vi.stubEnv("MEGAMEMORY_AUTO_MIGRATE", "0");
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
  vi.stubEnv("XDG_CONFIG_HOME", fixture.file("config"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", fixture.file("opencode"));
  vi.spyOn(process, "cwd").mockReturnValue(fixture.root);
});
afterEach(async () => {
  try { await fixture.close(); } finally {
    boundary.handlers.clear();
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

async function wireResponse(seed: (db: KnowledgeDB) => void, input: UnderstandInput, allowError = false) {
  const db = fixture.db("wire.db");
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-disabled-vector-space");
  seed(db);
  await fixture.release(db);

  boundary.handlers.clear();
  let shutdown: (() => void) | undefined;
  fixture.track({ close() {
    try { shutdown?.(); } finally { shutdown = undefined; boundary.handlers.clear(); }
  } });
  const originalOn = process.on;
  const on = vi.spyOn(process, "on").mockImplementation(function (event, listener) {
    if (event === "SIGINT" || event === "SIGTERM") {
      if (event === "SIGTERM") shutdown = listener as () => void;
      return process;
    }
    return originalOn.call(process, event, listener);
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    if (code !== 0) throw new Error(`MCP harness startup exited with code ${String(code)}`);
    return undefined as never;
  });
  vi.resetModules();
  try { await import("../index.js"); } finally { on.mockRestore(); }
  const handler = boundary.handlers.get("understand");
  if (!handler) throw new Error("MCP harness did not register understand");
  const response = await handler(input);
  if (!allowError) expect(response.isError).not.toBe(true);
  expect(response.content).toHaveLength(1);
  const text = response.content[0].text;
  return { response, text, output: (response.isError ? {} : JSON.parse(text)) as UnderstandOutput & { instructions_stale: boolean; server_version: string } };
}

// Independent oracle for the documented UTF-8/3 estimate, applied to the actual wire shape.
function wireTokens(value: string) { return Math.ceil(Buffer.byteLength(value, "utf8") / 3); }

describe("K-03: the actual pretty MCP response obeys the token cap", () => {
  it("A06 MCP wrapper resumes a budget-truncated batch using only its continuation", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `mcp-batch-${i}`);
    await wireResponse(db => {
      for (const id of ids) addNode(db, id, { summary: "A complete consumer claim. ".repeat(12) });
    }, { query: "bootstrap", max_tokens: 1500 });
    const handler = boundary.handlers.get("get_concept")!;
    const first = await handler({ ids, max_tokens: 1300 });
    expect(first.isError).not.toBe(true);
    const page1 = JSON.parse(first.content[0].text) as ConceptBatchOutput;
    const placed = page1.batch.filter(item => item.status === "ok").map(item => item.id);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(ids.length);
    expect(page1.meta.continuation).toEqual(expect.any(String));

    const second = await handler({ continuation: page1.meta.continuation });
    expect(second.isError, second.content[0].text).not.toBe(true);
    const page2 = JSON.parse(second.content[0].text) as ConceptBatchOutput;
    expect(page2.batch.filter(item => item.status === "ok").map(item => item.id)).toEqual(ids.slice(placed.length));
    expect(page2.meta.budget_skipped).toBe(0);
  });

  it.each(["orientation", "evidence", "full"] as const)("A05 MCP %s final wire fits all metadata, delta and unchanged or explicitly refuses", async profile => {
    await wireResponse(db => {
      addNode(db, "cap-anchor", { name: "Имя 中文 \\\"", summary: "Complete UTF-8 wording 中文. ".repeat(5), why: "Complete rationale", file_refs: ["src/кириллица.ts"] });
      for (let i = 0; i < 4; i++) {
        addNode(db, `cap-support-${i}`, { summary: `Complete support wording ${i} 中文`, file_refs: [`src/${i}.ts`] });
        db.insertEdge({ from_id: "cap-anchor", to_id: `cap-support-${i}`, relation: "informed_by", description: `Rationale ${i}` });
      }
    }, { query: "bootstrap", max_tokens: 1500 });
    const get = boundary.handlers.get("get_concept")!;
    const epoch = "client-context";
    const generous = await get({ id: "cap-anchor", profile, max_neighbors: 1, context_epoch: epoch, max_tokens: 10000 });
    expect(generous.isError).not.toBe(true);
    const issued = JSON.parse(generous.content[0].text);
    const version = issued.meta?.version ?? issued.delta_version.version;
    for (const max_tokens of [100, 300, 500, 700, 900, 1300, 2000, 4000]) {
      for (const delta of [undefined, { context_epoch: epoch }, { context_epoch: epoch, known_versions: { "cap-anchor": version } }]) {
        const response = await get({ id: "cap-anchor", profile, max_neighbors: 1, max_tokens, ...delta });
        if (response.isError) {
          expect(response.content[0].text).toMatch(/max_tokens|budget/i);
          expect(response.meta?.reason).toBe("budget");
        } else {
          expect.soft(wireTokens(JSON.stringify(response)), `profile=${profile}, cap=${max_tokens}, delta=${JSON.stringify(delta)}`).toBeLessThanOrEqual(max_tokens);
          const out = JSON.parse(response.content[0].text);
          if (out.meta) expect.soft(out.meta.tokens_estimated).toBe(wireTokens(JSON.stringify(response)));
          for (const next of out.meta?.continuations ?? []) {
            const resumed = await get({ continuation: next.token, max_tokens });
            if (resumed.isError) expect(resumed.content[0].text).toMatch(/max_tokens|budget/i);
            else {
              expect.soft(wireTokens(JSON.stringify(resumed))).toBeLessThanOrEqual(max_tokens);
              const continuationOutput = JSON.parse(resumed.content[0].text);
              expect.soft(continuationOutput.meta.tokens_estimated).toBe(wireTokens(JSON.stringify(resumed)));
            }
          }
        }
      }
    }
  });

  it.each(["orientation", "evidence", "full"] as const)("A05 MCP %s batch final wire and continuation fit the shared budget", async profile => {
    const ids = Array.from({ length: 5 }, (_, i) => `wire-batch-${i}`);
    await wireResponse(db => {
      for (const id of ids) addNode(db, id, { summary: "Complete quoted 中文 consumer wording. ".repeat(5), file_refs: ["src/кириллица.ts"] });
    }, { query: "bootstrap", max_tokens: 1500 });
    const get = boundary.handlers.get("get_concept")!;
    for (const max_tokens of [300, 500, 900, 1300, 2000, 4000]) {
      for (const requested of [ids, [ids[0], "missing-wire-card", ...ids.slice(1)]]) {
        const response = await get({ ids: requested, profile, max_tokens });
        if (response.isError) expect(response.content[0].text).toMatch(/max_tokens|budget/i);
        else {
          expect.soft(wireTokens(JSON.stringify(response)), `batch ${profile}, cap=${max_tokens}`).toBeLessThanOrEqual(max_tokens);
          const page = JSON.parse(response.content[0].text) as ConceptBatchOutput;
          expect(page.batch.map(item => item.id)).toEqual(requested);
          expect(page.meta.tokens_estimated).toBe(wireTokens(JSON.stringify(response)));
          if (page.meta.continuation) {
            const resumed = await get({ continuation: page.meta.continuation, max_tokens });
            if (resumed.isError) expect(resumed.content[0].text).toMatch(/max_tokens|budget/i);
            else expect.soft(wireTokens(JSON.stringify(resumed))).toBeLessThanOrEqual(max_tokens);
          }
        }
      }
    }
  });

  it("A05 MCP and SDK reject oversized context_epoch before echoing client input", async () => {
    await wireResponse(db => addNode(db, "epoch-anchor", { summary: "Epoch-bounded consumer claim" }), { query: "bootstrap", max_tokens: 1500 });
    const args = { id: "epoch-anchor", profile: "orientation" as const, context_epoch: "e".repeat(257) };
    const response = await boundary.handlers.get("get_concept")!(args);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/context_epoch.*256/);
    const schema = boundary.schemas.get("get_concept") as z.ZodRawShape;
    expect(z.object(schema).safeParse(args).success).toBe(false);
    expect(z.object(schema).safeParse({ ...args, context_epoch: "e".repeat(256) }).success).toBe(true);
    const accepted = await boundary.handlers.get("get_concept")!({ ...args, context_epoch: "e".repeat(256), max_tokens: 2000 });
    expect(accepted.isError).not.toBe(true);
    expect(JSON.parse(accepted.content[0].text).meta.context_epoch).toBe("e".repeat(256));
    expect(wireTokens(JSON.stringify(accepted))).toBeLessThanOrEqual(2000);
  });

  it.each([undefined, "compact", "full", "brief"] as const)("D-05 actual %s MCP wire fits caps 500..1500 or refuses required floor", async mode => {
    const { response, output } = await wireResponse(db => {
      addNode(db, "escaped-claim", { name: "Имя \\\" 中文", summary: "escapedwireneedle Measured claim", file_refs: [`src/${"кириллица\\\"\\\\\n".repeat(80)}.ts:10-30`] });
    }, { query: "escapedwireneedle", mode, max_tokens: 10000 });
    const handler = boundary.handlers.get("understand")!;
    expect(output.next?.must_read).toHaveLength(1);
    expect(output.meta?.tokens_estimated).toBe(wireTokens(JSON.stringify(response)));
    for (const max_tokens of [500, 700, 900, 1200, 1500]) {
      const actual = await handler({ query: "escapedwireneedle", mode, max_tokens });
      if (actual.isError) {
        expect(actual.content[0].text).toMatch(/max_tokens.*(?:минимум|minimum|cannot fit)/);
      } else {
        const payload = JSON.parse(actual.content[0].text) as UnderstandOutput;
        expect(wireTokens(JSON.stringify(actual))).toBeLessThanOrEqual(max_tokens);
        expect(payload.meta?.tokens_estimated).toBe(wireTokens(JSON.stringify(actual)));
        expect(payload.next?.record).toContain("kind=feature");
        if (payload.meta?.returned) expect(payload.next?.must_read).toEqual(output.next?.must_read);
      }
    }
  });

  it.each(["compact", "full", "brief"] as const)("D-05 actual %s MCP empty floor rejects without success payload", async mode => {
    const { response } = await wireResponse(() => {}, { query: "emptyfloor", mode, max_tokens: 1500 });
    const floor = wireTokens(JSON.stringify(response));
    const rejected = await boundary.handlers.get("understand")!({ query: "emptyfloor", mode, max_tokens: floor - 1 });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toMatch(/max_tokens.*(?:минимум|minimum|cannot fit)/);
  });

  it.each([undefined, "compact", "full", "brief"] as const)("D-05 actual %s MCP retains useful qualified content when it fits", async mode => {
    await wireResponse(db => addNode(db, "useful", { summary: "usefulwireneedle Measured result", file_refs: ["src/quoted\\\"\\\\файл.ts:10-20"] }), { query: "usefulwireneedle", mode, max_tokens: 1500 });
    const handler = boundary.handlers.get("understand")!;
    for (const max_tokens of [500, 700, 900, 1200, 1500]) {
      const response = await handler({ query: "usefulwireneedle", mode, max_tokens });
      if (response.isError) expect(response.content[0].text).toMatch(/max_tokens.*cannot fit/);
      else {
        const output = JSON.parse(response.content[0].text) as UnderstandOutput;
        expect(wireTokens(JSON.stringify(response))).toBeLessThanOrEqual(max_tokens);
        expect(output.meta?.tokens_estimated).toBe(wireTokens(JSON.stringify(response)));
        expect(output.next?.skip).toEqual([]);
        if (max_tokens === 1500) {
          expect(output.meta?.returned).toBe(1);
          expect(output.next?.must_read.map(hint => hint.ref)).toEqual(["src/quoted\\\"\\\\файл.ts:10-20"]);
        }
      }
    }
  });

  it("D-05 actual list_roots MCP includes stats, instructions and escaped content under all caps", async () => {
    await wireResponse(db => {
      for (let i = 0; i < 30; i++) addNode(db, `root-${i}`, { name: `Корень \\\"\\\\中文 ${i}`, summary: "Measured root" });
    }, { query: "nothing", max_tokens: 1500 });
    const handler = boundary.handlers.get("list_roots")!;
    for (const max_tokens of [500, 700, 900, 1200, 1500]) {
      const response = await handler({ max_tokens } as UnderstandInput);
      expect(response.isError).not.toBe(true);
      const output = JSON.parse(response.content[0].text);
      expect(output.stats.nodes).toBe(30);
      expect(output.server_version).toBe(
        JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version
      );
      expect(output.instructions_stale).toBe(false);
      expect(output.meta.tokens_estimated).toBe(wireTokens(JSON.stringify(response)));
      expect(wireTokens(JSON.stringify(response))).toBeLessThanOrEqual(max_tokens);
      expect(output.meta.dropped + output.meta.returned).toBe(30);
    }
  });

  it("Q3: budgets refuted-only output including metadata and the MCP content envelope", async () => {
    const { response, text, output } = await wireResponse((db) => {
      for (let i = 0; i < 8; i++) {
        addNode(db, `refuted-${i}`, { summary: `budgetneedle ${"text ".repeat(100)}` });
        db.setEpistemicStatus(`refuted-${i}`, "refuted", "An independent counterexample invalidates this claim", null);
      }
    }, { query: "budgetneedle", top_k: 8, max_tokens: 500 });

    expect.soft(wireTokens(text)).toBeLessThanOrEqual(500);
    expect.soft(wireTokens(JSON.stringify(response))).toBeLessThanOrEqual(500);
    expect(output.meta?.tokens_estimated).toBeGreaterThanOrEqual(wireTokens(JSON.stringify(response)));
  });

  it.each([
    ["cyrillic", "Проверенное описание независимого измерения"],
    ["cjk", "独立测量验证缓存失效行为"],
  ])("budgets long identifiers, references and %s text on the real wire", async (_label, wording) => {
    const { response, output } = await wireResponse((db) => {
      const ids = Array.from({ length: 4 }, (_, i) => `budget-${i}-${"long-identifier-".repeat(8)}`);
      for (const id of ids) addNode(db, id, {
        summary: `multilingualneedle ${wording.repeat(25)}`,
        file_refs: [`src/${wording.repeat(6)}.ts:10-30`],
      });
      for (let i = 1; i < ids.length; i++) db.insertEdge({ from_id: ids[0], to_id: ids[i], relation: "connects_to" });
    }, { query: "multilingualneedle", top_k: 4, max_tokens: 700 });

    expect.soft(wireTokens(JSON.stringify(response))).toBeLessThanOrEqual(700);
    expect(output.meta?.tokens_estimated).toBeGreaterThanOrEqual(wireTokens(JSON.stringify(response)));
  });

  it("budgets edges_between and the duplicated context edges", async () => {
    const { response, output } = await wireResponse((db) => {
      for (let i = 0; i < 6; i++) addNode(db, `node-${i}`, { summary: "edgebudget Independent measured cache behavior." });
      for (let from = 0; from < 6; from++) {
        for (let to = from + 1; to < 6; to++) db.insertEdge({ from_id: `node-${from}`, to_id: `node-${to}`, relation: "connects_to" });
      }
    }, { query: "edgebudget", top_k: 6, max_tokens: 900 });

    expect.soft(wireTokens(JSON.stringify(response))).toBeLessThanOrEqual(900);
    expect(output.meta?.truncated).toBe(true);
    expect(output.meta?.tokens_estimated).toBeGreaterThanOrEqual(wireTokens(JSON.stringify(response)));
  });

  it("a small successful response retains real instruction metadata and graph edges within a generous cap", async () => {
    const { response, text, output } = await wireResponse((db) => {
      addNode(db, "one", { summary: "smallwire Independent measured cache behavior." });
      addNode(db, "two", { summary: "smallwire Another independent cache measurement." });
      db.insertEdge({ from_id: "one", to_id: "two", relation: "connects_to" });
    }, { query: "smallwire", max_tokens: 3000 });

    expect(text).toContain("\n  \"");
    expect(output.compact?.map((hit) => hit.id).sort()).toEqual(["one", "two"]);
    expect(output.edges_between).toEqual([{ from: "one", to: "two", relation: "connects_to" }]);
    expect(output.instructions_stale).toBe(false);
    expect(output.server_version).toEqual(expect.any(String));
    expect(wireTokens(JSON.stringify(response))).toBeLessThanOrEqual(3000);
  });

  it("an empty search still produces a valid bounded MCP envelope", async () => {
    const { response, output } = await wireResponse(() => {}, { query: "nomatches", max_tokens: 500 });

    expect(output.compact).toEqual([]);
    expect(output.meta?.returned).toBe(0);
    expect(wireTokens(JSON.stringify(response))).toBeLessThanOrEqual(500);
  });
});
