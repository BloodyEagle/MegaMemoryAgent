import { describe, it, expect, vi } from "vitest";
import { KnowledgeDB, isNodeExpired } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { understand } from "../tools.js";
const search = vi.hoisted(() => vi.fn());
vi.mock("../search.js", () => ({ basicSearch: search, ftsSearch: search, hybridSearch: search }));
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../tools.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("tools.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
  let text = "";
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(ast).replace(/^export\s+/, "");
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === name)) text = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!text) throw new Error(`Missing placement boundary ${name}`);
  return text;
}

function place(ids: string[], supports: Record<string, string[]>, topK: number, budget = 100, initiallyFolded = false) {
  const top: Array<{ id: string; name: string; status: string }> = initiallyFolded
    ? ids.slice(0, 3).map(id => ({ id, name: id, status: "active" })) : [];
  const context = vm.createContext({
    top, eligible: ids.map(id => ({ node: { id }, score: 1 })), topK,
    nodeRowById: new Map(ids.map(id => [id, { summary: id, file_refs: null }])),
    supportIdsOf: new Map(Object.entries(supports)),
    compactMatch: (_db: unknown, node: { id: string }) => ({ id: node.id, name: node.id, status: "active" }),
    db: {}, trimSummary: (s: string) => s, parseFileRefs: () => [], isUngrounded: () => false, isNodeExpired,
    target: budget, refutedShown: [],
  });
  const placement = declaration("placeLoop").replace("while (idx < eligible.length) {", "while (idx < eligible.length) { if (++steps > eligible.length + 1) throw new Error('placement made no bounded progress');");
  const script = `let nestedByHost = new Map(); let foldedIds = new Set(); let idx = ${initiallyFolded ? 3 : 0};
let tokensEstimated = 0; let truncated = false; let steps = 0;
const displayList = () => top.filter(m => !foldedIds.has(m.id));
const measureWith = () => top.length * 10;
${declaration("parseStatusScope")}
${declaration("nodeQualification")}
${declaration("foldSupports")}
${initiallyFolded ? "foldSupports();" : ""}
${placement}
placeLoop();
globalThis.result = { idx, steps, truncated, top: displayList(), nested: [...nestedByHost.values()].flat() };`;
  vm.runInContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context, { timeout: 100 });
  return JSON.parse(JSON.stringify(context.result)) as { idx: number; steps: number; truncated: boolean; top: Array<{ id: string }>; nested: Array<{ id: string }> };
}

describe("D-01 bounded compact placement", () => {
  it("already folded support with filled top_k terminates without another unchanged pass", () => {
    const result = place(["host", "support", "a", "b"], { host: ["support"] }, 2, 100, true);
    expect(result.top.map(n => n.id)).toEqual(["host", "a"]);
    expect(result.nested.map(n => n.id)).toEqual(["support"]);
    expect(result.idx).toBe(3);
    expect(result.steps).toBeLessThanOrEqual(5);
  });

  it("folding creates only genuinely available top-level slots", () => {
    const result = place(["host", "s1", "s2", "a", "b"], { host: ["s1", "s2"] }, 2);
    expect(result.top.map(n => n.id)).toEqual(["host", "a"]);
    expect(result.nested.map(n => n.id)).toEqual(["s1", "s2"]);
    expect(result.steps).toBeLessThanOrEqual(6);
  });

  it("a support chain stays depth one and candidates exhaust with bounded progress", () => {
    const result = place(["host", "s1", "s2"], { host: ["s1"], s1: ["s2"] }, 3);
    expect(result.top.map(n => n.id)).toEqual(["host", "s2"]);
    expect(result.nested.map(n => n.id)).toEqual(["s1"]);
    expect(result.idx).toBe(3);
  });

  it("public understand keeps the folded support at filled top_k", async () => {
    const db = new KnowledgeDB(":memory:");
    ensureSchema(db);
    try {
      for (const id of ["host", "support", "a", "b"]) db.insertNode({ id, name: id, kind: "feature", summary: `Concrete evidence for ${id}.` });
      db.insertEdge({ from_id: "host", to_id: "support", relation: "informed_by", description: "The host uses this independent measurement." });
      search.mockReturnValue(["host", "support", "a", "b"].map(id => ({ id, similarity: 1 })));
      const result = await understand(db, { query: "bounded placement", top_k: 2, max_tokens: 10000 });
      expect(result.compact?.map(n => n.id)).toEqual(["host", "a"]);
      expect(result.compact?.[0].supports?.map(n => n.id)).toEqual(["support"]);
      expect(result.meta?.returned).toBe(2);
      expect(result.meta?.supports_inlined).toBe(1);
    } finally { db.close(); }
  });

  it("public understand repeats placement after refuted trimming without losing placed supports", async () => {
    const db = new KnowledgeDB(":memory:");
    ensureSchema(db);
    try {
      for (const id of ["host", "support", "a", "b"]) db.insertNode({ id, name: id, kind: "feature", summary: `Concrete evidence for ${id}.` });
      db.insertNode({ id: "wrong", name: "wrong", kind: "feature", summary: "Refuted old claim " + "word ".repeat(3000) });
      db.setEpistemicStatus("wrong", "refuted", "Independent measurement disproved this claim. " + "reason ".repeat(1500), null);
      db.insertEdge({ from_id: "host", to_id: "support", relation: "informed_by", description: "Independent measurement." });
      search.mockReturnValue(["wrong", "host", "support", "a", "b"].map(id => ({ id, similarity: 1 })));
      const result = await understand(db, { query: "trim and refill", top_k: 2, max_tokens: 1500 });
      expect(result.compact?.length).toBeLessThanOrEqual(2);
      expect(result.meta?.truncated).toBe(true);
      expect(result.meta?.tokens_estimated).toBeLessThanOrEqual(1500);
    } finally { db.close(); }
  });

  it("budget cutoff stops and retains already placed content", () => {
    const result = place(["host", "support", "a"], { host: ["support"] }, 3, 20);
    expect(result.truncated).toBe(true);
    expect(result.idx).toBe(2);
    expect(result.nested.map(n => n.id)).toEqual(["support"]);
    expect(result.steps).toBeLessThanOrEqual(4);
  });
});
