import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KnowledgeDB } from "../db.js";
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

function place(ids: string[], limit: number, rejected: string[] = [], initialTop: string[] = []) {
  const placed = [...initialTop];
  const visits: string[] = [];
  const failed = new Set(rejected);
  const context = vm.createContext({
    eligible: ids.map((id) => ({ node: { id } })),
    displayList: () => placed.map((id) => ({ id })),
    placeCard: (entry: { node: { id: string } }): boolean => {
      visits.push(entry.node.id);
      if (visits.length > ids.length) throw new Error("placement made no bounded progress");
      if (failed.has(entry.node.id) || placed.includes(entry.node.id)) return false;
      placed.push(entry.node.id);
      return true;
    },
    limit,
  });
  // Exercise the actual production loop, with a controlled placement delegate.
  // Folding, qualification and budget rollback are tested through public understand below.
  const script = `${declaration("placeLoop")}\nplaceLoop(limit);`;
  vm.runInContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context, { timeout: 100 });
  return { placed, visits };
}

beforeEach(() => {
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
  search.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("D-01 bounded compact placement", () => {
  it("an already filled limit delegates nothing and terminates", () => {
    const result = place(["host", "support", "a", "b"], 2, [], ["host", "a"]);
    expect(result.placed).toEqual(["host", "a"]);
    expect(result.visits).toEqual([]);
  });

  it("a rejected expensive hit cannot block a cheaper later hit", () => {
    const result = place(["expensive", "host", "a", "b"], 2, ["expensive"]);
    expect(result.placed).toEqual(["host", "a"]);
    expect(result.visits).toEqual(["expensive", "host", "a"]);
  });

  it("an exhausted pool delegates each candidate at most once", () => {
    const result = place(["host", "s1", "s2"], 3, ["s1", "s2"]);
    expect(result.placed).toEqual(["host"]);
    expect(result.visits).toEqual(["host", "s1", "s2"]);
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
      expect(result.meta?.returned).toBe(4);
      expect(result.candidates?.map((candidate) => candidate.id)).toEqual(["host", "support", "a", "b"]);
      expect(result.meta?.cards).toBe(2);
      expect(result.meta?.dropped).toBe(0); // b remains discoverable without a card
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
      const host = result.compact?.find((card) => card.id === "host");
      expect(host).toBeDefined();
      expect(host?.supports?.map((support) => support.id)).toEqual(["support"]);
      expect(host?.supports?.[0]).toMatchObject({ status: "active", epistemic_status: "open" });
      expect(host?.supports?.[0]).not.toHaveProperty("supports");
      // The atomic refuted card/reason is too large, but its locator remains
      // explicitly refuted: it is not a shortened claim an agent may cite.
      expect(result.refuted).toEqual([]);
      const rejectedLocator = result.candidates?.find((candidate) => candidate.id === "wrong");
      expect(rejectedLocator).toMatchObject({ id: "wrong", epistemic_status: "refuted" });
      expect(rejectedLocator).not.toHaveProperty("summary_short");
      const visible = new Set([
        ...(result.candidates ?? []).map((candidate) => candidate.id),
        ...(result.compact ?? []).flatMap((card) => [card.id, ...(card.supports ?? []).map((support) => support.id)]),
        ...(result.anchors ?? []).map((anchor) => anchor.id),
        ...(result.refuted ?? []).map((card) => card.id),
      ]);
      expect(result.meta?.returned).toBe(result.candidates?.length);
      expect(result.meta?.cards).toBe(result.compact?.length);
      expect(result.meta?.dropped).toBe(["wrong", "host", "support", "a", "b"].filter((id) => !visible.has(id)).length);
      // Candidate-only is not dropped, but omission of the qualified refuted
      // detail must still report truncation rather than silently look complete.
      expect(result.meta?.truncated).toBe(true);
      expect(result.meta?.tokens_estimated).toBeLessThanOrEqual(1500);
    } finally { db.close(); }
  });

  it("folding frees only real card slots and preserves depth-one supports", async () => {
    const db = new KnowledgeDB(":memory:");
    ensureSchema(db);
    try {
      for (const id of ["host", "s1", "s2", "a", "b"]) db.insertNode({ id, name: id, kind: "feature", summary: `Concrete evidence for ${id}.`, file_refs: [`src/${id}.ts`] });
      for (const id of ["s1", "s2"]) db.insertEdge({ from_id: "host", to_id: id, relation: "informed_by", description: `The host uses measurement ${id}.` });
      search.mockReturnValue(["host", "s1", "s2", "a", "b"].map((id) => ({ id, similarity: 1 })));
      const result = await understand(db, { query: "multiple folded supports", top_k: 2, max_tokens: 10000 });
      expect(result.compact?.map((card) => card.id)).toEqual(["host", "a"]);
      expect(result.compact?.[0].supports?.map((support) => support.id)).toEqual(["s1", "s2"]);
      for (const support of result.compact?.[0].supports ?? []) {
        expect(support).not.toHaveProperty("supports");
        expect(support).toMatchObject({ status: "active", epistemic_status: "open", file_refs: [`src/${support.id}.ts`] });
      }
      expect(result.meta?.cards).toBe(2);
      expect(result.meta?.returned).toBe(5);
      expect(result.meta?.supports_inlined).toBe(2);
      expect(result.meta?.dropped).toBe(0);
    } finally { db.close(); }
  });

  it("a support chain remains depth one in public understand", async () => {
    const db = new KnowledgeDB(":memory:");
    ensureSchema(db);
    try {
      for (const id of ["host", "s1", "s2"]) db.insertNode({ id, name: id, kind: "feature", summary: `Concrete evidence for ${id}.`, file_refs: [`src/${id}.ts`] });
      db.insertEdge({ from_id: "host", to_id: "s1", relation: "informed_by", description: "The first measurement supports the host." });
      db.insertEdge({ from_id: "s1", to_id: "s2", relation: "informed_by", description: "The second measurement supports the first." });
      search.mockReturnValue(["host", "s1", "s2"].map((id) => ({ id, similarity: 1 })));
      const result = await understand(db, { query: "support chain", top_k: 3, max_tokens: 10000 });
      expect(result.compact?.map((card) => card.id)).toEqual(["host", "s2"]);
      expect(result.compact?.[0].supports?.map((support) => support.id)).toEqual(["s1"]);
      expect(result.compact?.[0].supports?.[0]).not.toHaveProperty("supports");
      expect(result.compact?.[1].supports).toBeUndefined();
      expect(result.meta?.supports_inlined).toBe(1);
      expect(result.meta?.returned).toBe(3);
      expect(result.meta?.dropped).toBe(0);
    } finally { db.close(); }
  });

  it("all rejected placements exhaust the pool without repeating an unchanged pass", () => {
    const result = place(["host", "support", "a"], 3, ["host", "support", "a"]);
    expect(result.placed).toEqual([]);
    expect(result.visits).toEqual(["host", "support", "a"]);
  });
});
