import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { renderDroppedText } from "../brief.js";
import * as search from "../search.js";
import { getConcept, understand } from "../tools.js";
import type { UnderstandCandidate, UnderstandOutput } from "../types.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
let db: KnowledgeDB;

function wireTokens(payload: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  }), "utf8") / 3);
}

function fixedWireTokens(payload: Record<string, unknown>): number {
  let tokens = 0;
  for (;;) {
    const meta = payload.meta as Record<string, unknown> | undefined;
    const measured = wireTokens(meta ? { ...payload, meta: { ...meta, tokens_estimated: tokens } } : payload);
    if (tokens === measured) return tokens;
    tokens = measured;
  }
}

function candidateCost(candidates: UnderstandCandidate[]): number {
  return wireTokens({ candidates }) - wireTokens({ candidates: [] });
}

function expectTieredCap(out: UnderstandOutput, cap: number): void {
  expect(out.candidates).toBeDefined();
  expect(out.meta!.returned).toBe(out.candidates!.length);
  expect(out.meta!.cards).toBe(out.compact!.length);
  expect(out.compact!.length).toBeLessThanOrEqual(3);
  expect(out.meta!.tokens_estimated).toBe(wireTokens(out));
  expect(wireTokens(out)).toBeLessThanOrEqual(cap);
  expect(candidateCost(out.candidates!)).toBeLessThanOrEqual(Math.floor(cap / 4));
  for (const candidate of out.candidates!) {
    expect(candidateCost([candidate])).toBeLessThanOrEqual(90);
    expect(candidate.name.length).toBeLessThanOrEqual(60);
    expect(candidate.summary_short?.length ?? 0).toBeLessThanOrEqual(80);
  }
}

function rank(ids: string[]): void {
  vi.spyOn(search, "hybridSearch").mockImplementation(async (_db, _query, options) =>
    ids.slice(0, options?.topK ?? ids.length).map((id, index) => ({
      id, score: 1 / (61 + index), via: "both" as const,
    })));
}

function poolFixture(): string[] {
  const ids = Array.from({ length: 19 }, (_item, index) => `claim-${String(index + 1).padStart(2, "0")}`);
  ids.forEach((id, index) => addNode(db, id, {
    name: index === 0 ? "Address normalization" : `Address rule ${index + 1}`,
    summary: `Address rule ${index + 1} selects a verified regional identifier before storing the normalized result.`,
  }));
  const ref = "src/address/normalize.ts:20-45";
  addNode(db, "ref-anchor", {
    name: ref, file_refs: [ref], created_via: "file_ref",
    summary: `File-fact node for "${ref}" — created as a provenance support.`,
  });
  db.insertEdge({ from_id: ids[0], to_id: "ref-anchor", relation: "informed_by", description: "The normalization branch verifies the regional identifier before saving." });
  return ["ref-anchor", ...ids];
}

beforeEach(() => {
  vi.stubEnv("MEGAMEMORY_SEARCH", "hybrid");
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  ensureSchema(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.close();
});

describe("D: candidates are discovery, cards are qualified detail", () => {
  it("uses the default 20-entry search pool instead of slicing discovery to default top_k=10", async () => {
    const ids = poolFixture();
    rank(ids);
    const out = await understand(db, { query: "address", max_tokens: 20000 });

    expect(search.hybridSearch).toHaveBeenCalledWith(db, "address", { topK: 20 });
    expect(new Set(out.candidates!.map(candidate => candidate.id))).toEqual(new Set(ids));
    expect(out.meta).toMatchObject({ returned: 20, cards: 3, dropped: 0 });
    expectTieredCap(out, 20000);
  });

  it("discovers every filtered survivor in the bounded pool, including a folded technical anchor", async () => {
    const ids = poolFixture();
    addNode(db, "expired-hit", { valid_until: "2000-01-01" });
    addNode(db, "superseded-hit");
    expect(db.setNodeStatus("superseded-hit", "superseded")).toBe(true);
    expect(db.getNode("superseded-hit")!.status).toBe("superseded");
    rank(["expired-hit", "superseded-hit", ...ids]);
    const out = await understand(db, { query: "address", top_k: 20, max_tokens: 20000 });
    // top_k=20 widens retrieval to 40 before lifecycle/expiry filtering.
    expect(search.hybridSearch).toHaveBeenCalledWith(db, "address", { topK: 40 });
    expect(new Set(out.candidates!.map(candidate => candidate.id))).toEqual(new Set(ids));
    expect(out.meta).toMatchObject({ returned: 20, cards: 3, dropped: 0, stale_excluded: 1, inactive_excluded: 1 });
    expect(out.compact![0].id).toBe("claim-01");
    expect(out.compact![0].supports).toContainEqual(expect.objectContaining({ id: "ref-anchor", collapsed_anchor: true }));
    expect(out.compact!.some(card => card.id === "ref-anchor")).toBe(false);
    expect(getConcept(db, { id: "ref-anchor" }).id).toBe("ref-anchor");
    expectTieredCap(out, 20000);
    for (const candidate of out.candidates!) {
      expect(candidate).not.toHaveProperty("status_scope");
      expect(candidate).not.toHaveProperty("current_digests");
      expect(candidate).not.toHaveProperty("support_evidence");
    }
  });

  it("caps discovery and preserves tail names, removing summary_short before shortening the name", async () => {
    const name = "Regional address normalization rule ".repeat(5) + "KEEP-THIS-TAIL";
    const ids = Array.from({ length: 8 }, (_item, index) => index === 0 ? "tail-" + "x".repeat(85) : `tail-${index}`);
    ids.forEach(id => addNode(db, id, {
      name, summary: "Правило нормализации адреса проверяет регион до сохранения результата и не подменяет идентификатор совпадением имени.".repeat(4),
    }));
    rank(ids);
    const out = await understand(db, { query: "address", max_tokens: 8000 });

    expect(out.candidates).toHaveLength(8);
    expectTieredCap(out, 8000);
    expect(out.candidates![0].name.length).toBeLessThan(60);
    expect(out.candidates![0].summary_short).toBeUndefined();
    for (const [index, candidate] of out.candidates!.entries()) {
      expect(candidate.id).toBe(ids[index]);
      expect(candidate.name).toBe("…" + name.slice(-(candidate.name.length - 1)));
      expect(candidate.name.endsWith("KEEP-THIS-TAIL")).toBe(true);
      if (candidate.name.length < 60) expect(candidate.summary_short).toBeUndefined();
    }
  });

  it("narrow window keeps every visible entry named and above the floors (2.14.1/35 T2)", async () => {
    const name = "Regional address normalization rule ".repeat(5) + "KEEP-THIS-TAIL";
    const ids = Array.from({ length: 8 }, (_item, index) => index === 0 ? "tail-" + "x".repeat(85) : `tail-${index}`);
    ids.forEach(id => addNode(db, id, {
      name, summary: "Правило нормализации адреса проверяет регион до сохранения результата и не подменяет идентификатор совпадением имени.".repeat(4),
    }));
    rank(ids);
    const out = await understand(db, { query: "address", max_tokens: 700 });

    expect(out.meta!.truncated).toBe(true);
    expect(out.candidates!.length).toBeGreaterThan(0);
    for (const candidate of out.candidates!) {
      expect(candidate.name).not.toBe("");
      expect(candidate.name.length).toBeGreaterThanOrEqual(12);
    }
    for (const card of out.compact ?? []) {
      expect(card.summary === undefined || card.summary === "" || card.summary.length >= 40).toBe(true);
    }
    const visible = new Set([...out.candidates!.map(c => c.id), ...(out.compact ?? []).map(c => c.id)]);
    expect(out.meta!.returned).toBe(out.candidates!.length);
    expect(out.meta!.dropped).toBe(8 - visible.size);
    expectTieredCap(out, 700);
  });

  it("keeps a pathological 120+ character id exact when its entry fits, and get_concept resolves it", async () => {
    vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
    const id = "exact-" + "x".repeat(124);
    addNode(db, id, { name: "Needle", summary: "Needle validates an address identifier before storage." });
    vi.spyOn(search, "basicSearch").mockReturnValue([{ id, similarity: 1 }]);
    const out = await understand(db, { query: "needle", max_tokens: 8000 });

    expect(id.length).toBeGreaterThan(120);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0].id).toBe(id);
    expect(candidateCost([out.candidates![0]])).toBeGreaterThan(40);
    expectTieredCap(out, 8000);
    expect(getConcept(db, { id: out.candidates![0].id }).id).toBe(id);
  });

  it("reserves a minimally feasible first card before the quarter-budget discovery list", async () => {
    const ids = Array.from({ length: 20 }, (_item, index) => `small-${index}`);
    ids.forEach(id => addNode(db, id, { name: id, summary: "A verified small address rule." }));
    rank(ids);
    const generous = await understand(db, { query: "address", top_k: 20, max_tokens: 20000 });
    const meta = { ...generous.meta!, returned: 0, cards: 1, dropped: 19, truncated: true, tokens_estimated: 0 };
    const witness = {
      ...generous,
      candidates: [],
      compact: [{ ...generous.compact![0], summary: "" }],
      edges_between: [],
      meta,
      brief: renderDroppedText(meta),
      next: { ...generous.next!, followups: [] },
    };
    const cap = fixedWireTokens(witness) + 12;
    expect(cap).toBeLessThan(1500);
    const out = await understand(db, { query: "address", top_k: 20, max_tokens: cap });

    expect(out.compact![0]?.id).toBe(ids[0]);
    expect(out.meta!.cards).toBeGreaterThanOrEqual(1);
    expect(out.meta).not.toHaveProperty("reason");
    expectTieredCap(out, cap);
  });

  it("flags refuted and abandoned discovery without manufacturing validation evidence", async () => {
    addNode(db, "live");
    addNode(db, "refuted", { epistemic_status: "refuted" });
    addNode(db, "abandoned", { epistemic_status: "abandoned" });
    rank(["live", "refuted", "abandoned"]);
    const out = await understand(db, { query: "address", max_tokens: 8000 });

    expect(out.candidates!.find(candidate => candidate.id === "refuted")).toMatchObject({ epistemic_status: "refuted" });
    expect(out.candidates!.find(candidate => candidate.id === "abandoned")).toMatchObject({ epistemic_status: "abandoned" });
    for (const candidate of out.candidates!) {
      expect(candidate).not.toHaveProperty("digests");
      expect(candidate).not.toHaveProperty("support_check");
    }
    expectTieredCap(out, 8000);
  });

  it("full mode preserves selected legacy cards and does not add discovery or card counts", async () => {
    const ids = Array.from({ length: 6 }, (_item, index) => `full-${index}`);
    ids.forEach(id => addNode(db, id, { name: id, why: "The normalized identifier must remain stable." }));
    addNode(db, "full-child", { parent_id: ids[0] });
    db.insertEdge({ from_id: ids[0], to_id: ids[1], relation: "depends_on" });
    rank(ids);
    const out = await understand(db, { query: "address", mode: "full", max_tokens: 20000 });

    expect(out.matches.map(card => card.id)).toEqual(ids);
    expect(out.matches[0]).toMatchObject({ why: "The normalized identifier must remain stable." });
    expect(out.matches[0].children).toContainEqual(expect.objectContaining({ id: "full-child" }));
    expect(out.matches[0].edges).toContainEqual(expect.objectContaining({ to: ids[1], relation: "depends_on" }));
    expect(out.compact).toBeUndefined();
    expect(out.candidates).toBeUndefined();
    expect(out.meta).not.toHaveProperty("cards");
    expect(out.meta!.returned).toBe(6);
    expect(out.brief).toBeUndefined();
    expect(out.meta!.tokens_estimated).toBe(wireTokens(out));
  });
});

// Execute the actual route callback with a mocked understand call; no server or build.
async function httpSearchBoundary(result: UnderstandOutput): Promise<{ status: number; body: unknown }> {
  const source = fs.readFileSync(new URL("../web.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("web.ts", source, ts.ScriptTarget.Latest, true);
  const functions: string[] = [];
  let callback = "";
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && ["json", "notFound", "hostMatches", "sameOrigin", "webSecurityHeaders"].includes(node.name.text)) functions.push(node.getText(ast));
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "http.createServer") callback = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(callback).not.toBe("");
  let status = 0;
  let body: unknown;
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const req = { url: "/api/search?q=address&top_k=10", method: "GET", headers: { host: "127.0.0.1:8765" } };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: (code: number): void => { status = code; res.headersSent = true; },
    end: (text: string): void => { body = JSON.parse(text) as unknown; complete(); },
  };
  const call = vi.fn(async () => result);
  const context = vm.createContext({
    URL, Buffer, req, res, db, port: 8765,
    csp: "default-src 'self'; frame-ancestors 'none'",
    console: { error: vi.fn() }, pc: { red: (text: string): string => text },
    ALLOWED_HOSTNAMES: new Set(["localhost", "127.0.0.1", "[::1]"]),
    embeddingsReady: false, embeddingInitError: null,
    isTextOnlySearchMode: () => true, vectorSearchEnabled: () => false,
    understand: call,
  });
  const run = (text: string): unknown => vm.runInContext(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  run(functions.join("\n"));
  run(`(${callback})(req, res)`);
  await completed;
  expect(call).toHaveBeenCalledWith(db, { query: "address", top_k: 10 });
  return { status, body };
}

describe("D: HTTP compatibility", () => {
  it("maps results.compact to matches unchanged and never replaces cards with candidates", async () => {
    rank(poolFixture());
    const result = await understand(db, { query: "address", max_tokens: 20000 });
    expect(result.candidates!.length).toBeGreaterThan(result.compact!.length);
    const response = await httpSearchBoundary(result);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ matches: result.compact, meta: result.meta });
  });
});
