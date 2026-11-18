import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import * as search from "../search.js";
import { getConcept, understand } from "../tools.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
let db: KnowledgeDB;

function rank(ids: string[]): void {
  vi.spyOn(search, "hybridSearch").mockImplementation(async (_db, _query, options) =>
    ids.slice(0, options?.topK ?? ids.length).map((id, index) => ({
      id, score: 1 / (61 + index), via: "fts" as const,
    })));
}

function anchor(id: string, ref: string): void {
  addNode(db, id, {
    name: ref, file_refs: [ref], created_via: "file_ref",
    summary: `File-fact node for "${ref}" — created as a provenance support.`,
  });
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

describe("D: stable semantic ranking and path-name demotion", () => {
  it("moves exact ranged path names after substantive knowledge without changing either group's order", async () => {
    addNode(db, "path-one", { name: "src/address/normalize.ts:20-45" });
    addNode(db, "path-two", { name: "src/address/select-region.ts:100-145" });
    addNode(db, "knowledge-one", { name: "Normalize a regional address" });
    addNode(db, "knowledge-two", { name: "Keep a stable address identifier" });
    rank(["path-one", "knowledge-one", "path-two", "knowledge-two"]);
    const out = await understand(db, { query: "address", max_tokens: 8000 });

    expect(out.compact!.map(card => card.id)).toEqual(["knowledge-one", "knowledge-two", "path-one"]);
    expect(out.candidates!.map(candidate => candidate.id)).toEqual(["knowledge-one", "knowledge-two", "path-one", "path-two"]);
    expect(out.meta).toMatchObject({ returned: 4, cards: 3, dropped: 0 });
    // Demotion is not a rewrite of the underlying retrieval evidence.
    expect(out.candidates!.find(candidate => candidate.id === "path-one")!.score)
      .toBeGreaterThan(out.candidates!.find(candidate => candidate.id === "knowledge-one")!.score);
  });

  it.each([
    "src/address/normalize.ts",
    "src/address/normalize.ts:20",
    "src/address/normalize.ts:20-45 note",
    "Normalize src/address/normalize.ts:20-45",
    "src/address/normalize.ts:20-45#branch",
    "src/адрес/normalize.ts:20-45",
  ])("does not demote a name outside the exact ranged-path predicate: %s", async name => {
    addNode(db, "near-path", { name });
    addNode(db, "knowledge", { name: "Address normalization rule" });
    rank(["near-path", "knowledge"]);
    const out = await understand(db, { query: "address", max_tokens: 8000 });

    expect(out.compact![0].id).toBe("near-path");
    expect(out.candidates![0].id).toBe("near-path");
  });

  it("an exact whole-path query retains retrieval order and exact path resolution", async () => {
    const ref = "src/address/normalize.ts:20-45";
    addNode(db, "path-target", { name: ref, file_refs: [ref] });
    addNode(db, "knowledge", { name: "Address normalization rule" });
    rank(["path-target", "knowledge"]);
    const out = await understand(db, { query: ref, max_tokens: 8000 });

    expect(out.compact![0].id).toBe("path-target");
    expect(out.candidates![0]).toMatchObject({ id: "path-target", name: ref });
    expect(getConcept(db, { id: "path-target" }).file_refs).toEqual([ref]);
  });
});

describe("D: default collapse, explicit false, and meaningful edited anchors", () => {
  it("folds a highest-ranked technical anchor by default while keeping its candidate visible", async () => {
    const ref = "src/address/normalize.ts:20-45";
    const rationale = "The address branch verifies the regional identifier before saving.";
    anchor("technical", ref);
    addNode(db, "normalization", { name: "Address normalization rule" });
    addNode(db, "region", { name: "Regional identifier validation" });
    addNode(db, "municipality", { name: "Municipality priority rule" });
    db.insertEdge({ from_id: "normalization", to_id: "technical", relation: "informed_by", description: rationale });
    rank(["technical", "normalization", "region", "municipality"]);
    const out = await understand(db, { query: "address", max_tokens: 8000 });

    expect(out.compact![0].id).toBe("normalization");
    expect(out.compact!.map(card => card.id)).toEqual(["normalization", "region", "municipality"]);
    const folded = out.compact![0].supports!.find(support => support.id === "technical");
    expect(folded).toMatchObject({ id: "technical", name: ref, collapsed_anchor: true, rationale, file_refs: [ref] });
    expect(folded).not.toHaveProperty("summary");
    expect(out.candidates!.some(candidate => candidate.id === "technical")).toBe(true);
    expect(out.meta).toMatchObject({ returned: 4, cards: 3, dropped: 0, supports_inlined: 1 });
    expect(getConcept(db, { id: "technical" }).id).toBe("technical");
    expect(db.getNode("technical")!.name).toBe(ref);
  });

  it("supports collapse_ref_anchors:false without disabling ranged-path demotion", async () => {
    const ref = "src/address/normalize.ts:20-45";
    anchor("technical", ref);
    addNode(db, "normalization", { name: "Address normalization rule" });
    rank(["technical", "normalization"]);
    const out = await understand(db, { query: "address", collapse_ref_anchors: false, max_tokens: 8000 });

    expect(out.compact!.map(card => card.id)).toEqual(["normalization", "technical"]);
    const technical = out.compact!.find(card => card.id === "technical");
    expect(technical).toMatchObject({ name: ref, file_refs: [ref] });
    expect(technical!.summary).toContain("File-fact node");
    expect(out.anchors).toBeUndefined();
    expect(out.meta).not.toHaveProperty("anchor_collapsed");
    expect(out.candidates!.map(candidate => candidate.id)).toEqual(["normalization", "technical"]);
  });

  it("keeps an edited meaningful file_ref node as a card even when its ranged name is demoted", async () => {
    const ref = "src/address/normalize.ts:20-45";
    addNode(db, "edited-anchor", {
      name: ref, file_refs: [ref], created_via: "file_ref",
      summary: "The normalization rule reads the region before choosing an address identifier; the checked branch rejects ambiguous municipality matches.",
    });
    addNode(db, "normalization", { name: "Address normalization rule" });
    rank(["edited-anchor", "normalization"]);
    const out = await understand(db, { query: "address", max_tokens: 8000 });

    expect(out.compact!.map(card => card.id)).toEqual(["normalization", "edited-anchor"]);
    const edited = out.compact!.find(card => card.id === "edited-anchor");
    expect(edited).toMatchObject({ name: ref, file_refs: [ref] });
    expect(edited!.summary).toContain("rejects ambiguous");
    expect(out.anchors?.some(item => item.id === "edited-anchor") ?? false).toBe(false);
    expect(out.meta!.dropped).toBe(0);
  });

  it("anchors-only discovery is still a result and every candidate id remains resolvable", async () => {
    anchor("only-anchor", "src/address/normalize.ts:20-45");
    rank(["only-anchor"]);
    const out = await understand(db, { query: "address", max_tokens: 8000 });

    expect(out.candidates!.map(candidate => candidate.id)).toEqual(["only-anchor"]);
    expect(out.meta!.returned).toBe(1);
    expect(out.meta!.dropped).toBe(0);
    expect(out.meta).not.toHaveProperty("reason");
    expect(getConcept(db, { id: out.candidates![0].id }).id).toBe("only-anchor");
  });
});
