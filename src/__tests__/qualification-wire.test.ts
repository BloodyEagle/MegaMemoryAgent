import { describe, it, expect } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { addNode } from "./helpers/audit.js";
import { getConcept, understand, listRoots, estimateTokens } from "../tools.js";
import { buildNextHints } from "../next-hints.js";

describe("P-12 knowledge qualification and wire budget", () => {
  it("D-02 child cards preserve refuted/expired qualification in direct and full output", async () => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      addNode(db, "parent", { summary: "qualificationneedle parent" });
      addNode(db, "child", { parent_id: "parent", valid_until: "2020-01-01", summary: "Expired measured child" });
      db.setEpistemicStatus("child", "refuted", "The independent measurement disproves the child.", null);
      const direct = await getConcept(db, { id: "parent" });
      const full = await understand(db, { query: "qualificationneedle", mode: "full", max_tokens: 10000 });
      for (const children of [direct.children, full.matches[0]?.children]) {
        expect(children).toMatchObject([{ id: "child", status: "active", expired: true, epistemic_status: "refuted", refuted_reason: "The independent measurement disproves the child." }]);
      }
    } finally { db.close(); }
  });

  it.each([500, 700, 900, 1200, 1500])("D-05 list_roots fits the real MCP envelope at %i tokens", max_tokens => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      for (let i = 0; i < 10; i++) addNode(db, `root-${i}`, { name: `Root \\\" ${i} кириллица`, summary: "Measured root" });
      const extra_payload = { instructions_stale: false, instructions_version: null, server_version: "2.4.0" };
      const result = listRoots(db, { max_tokens, extra_payload });
      const wire = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ...result, ...extra_payload }, null, 2) }] });
      expect(estimateTokens(wire)).toBeLessThanOrEqual(max_tokens);
      expect(result.meta?.tokens_estimated).toBe(estimateTokens(wire));
    } finally { db.close(); }
  });

  it.each([500, 700, 900, 1200, 1500])("compact and brief respect wire caps with long Unicode references (%i)", async max_tokens => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      addNode(db, "claim", { summary: "wirebudgetneedle Measured implementation claim", file_refs: [`source/${"кириллица\\\" ".repeat(100)}.ts`] });
      for (const mode of ["compact", "brief"] as const) {
        const extra_payload = { instructions_stale: false, server_version: "2.4.0" };
        try {
          const result = await understand(db, { query: "wirebudgetneedle", mode, max_tokens, extra_payload });
          const wire = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ...result, ...extra_payload }, null, 2) }] });
          expect(estimateTokens(wire)).toBeLessThanOrEqual(max_tokens);
        } catch (error) { expect(String(error)).toMatch(/max_tokens.*(?:minimum|minimu|минимум|cannot fit)/); }
      }
    } finally { db.close(); }
  });

  it.each([undefined, "compact", "full"] as const)("D-02 %s child cards preserve lifecycle, scope, expiry and reasons", async mode => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      addNode(db, "parent", { summary: "qualifiedchildrenneedle parent" });
      db.setEpistemicStatus("parent", "validated", "Measured parent", { artifact: "parent-run" });
      addNode(db, "active", { parent_id: "parent" });
      addNode(db, "expired", { parent_id: "parent", valid_until: "2020-01-01" });
      addNode(db, "refuted", { parent_id: "parent" });
      db.setEpistemicStatus("refuted", "refuted", "Independent counterexample", null);
      addNode(db, "superseded", { parent_id: "parent" });
      db.setNodeStatus("superseded", "superseded");
      addNode(db, "validated", { parent_id: "parent" });
      db.setEpistemicStatus("validated", "validated", "Independent test", { artifact: "run-42", env: "test" });
      addNode(db, "removed", { parent_id: "parent" });
      db.softDeleteNode("removed", "Removed fixture");
      const direct = getConcept(db, { id: "parent" });
      const result = await understand(db, { query: "qualifiedchildrenneedle", mode, max_tokens: 10000 });
      const children = mode === "full" ? result.matches[0]?.children : result.compact?.[0]?.children;
      expect(mode === "full" ? result.matches[0] : result.compact?.[0]).toMatchObject({ epistemic_status: "validated", status_scope: { artifact: "parent-run" }, valid_until: null });
      for (const cards of [direct.children, children]) {
        expect(cards?.map(child => child.id).sort()).toEqual(["active", "expired", "refuted", "superseded", "validated"]);
        expect(cards).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "active", status: "active", epistemic_status: "open", status_scope: null, valid_until: null, expired: false }),
          expect.objectContaining({ id: "expired", status: "active", valid_until: "2020-01-01", expired: true }),
          expect.objectContaining({ id: "refuted", epistemic_status: "refuted", refuted_reason: "Independent counterexample" }),
          expect.objectContaining({ id: "superseded", status: "superseded" }),
          expect.objectContaining({ id: "validated", epistemic_status: "validated", status_scope: { artifact: "run-42", env: "test" } }),
        ]));
      }
    } finally { db.close(); }
  });

  it.each(["compact", "full", "brief"] as const)("D-05 %s empty response refuses the exact wire floor minus one", async mode => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      const extra_payload = { instructions_stale: false, server_version: "2.4.0", note: "\\\"\\\\\nкириллица" };
      const generous = await understand(db, { query: "nothing", mode, max_tokens: 1500, extra_payload });
      const wire = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ...generous, ...extra_payload }, null, 2) }] });
      const floor = Math.ceil(Buffer.byteLength(wire, "utf8") / 3);
      expect(generous.meta?.tokens_estimated).toBe(floor);
      await expect(understand(db, { query: "nothing", mode, max_tokens: floor - 1, extra_payload })).rejects.toThrow(/max_tokens.*(?:minimum|минимум|cannot fit)/);
      const exact = await understand(db, { query: "nothing", mode, max_tokens: floor, extra_payload });
      expect(exact.meta?.tokens_estimated).toBe(floor);
      expect(exact.next?.record).toContain("kind=feature");
    } finally { db.close(); }
  });

  it.each(["compact", "full", "brief"] as const)("D-06 %s absent claim, stale and inactive references do not grant skip", async mode => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      addNode(db, "absent-claim", { summary: "", file_refs: ["absent.ts"] });
      addNode(db, "expired-claim", { summary: "nocoverageneedle measured state", valid_until: "2020-01-01", file_refs: ["stale.ts"] });
      addNode(db, "inactive-claim", { summary: "nocoverageneedle historical state", file_refs: ["inactive.ts"] });
      db.setNodeStatus("inactive-claim", "superseded");
      expect(buildNextHints({ db, cards: [{ id: "absent-claim" }, { id: "expired-claim" }, { id: "inactive-claim" }] }).skip).toEqual([]);
      const result = await understand(db, { query: "nocoverageneedle", mode, include_stale: true, include_inactive: true, max_tokens: 10000 });
      expect(result.next?.skip).toEqual([]);
      expect(result.next?.must_read.map(hint => hint.ref).sort()).toEqual(["inactive.ts", "stale.ts"]);
    } finally { db.close(); }
  });

  it("D-02 nested supports retain current scope and expiry qualification", async () => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      addNode(db, "decision", { kind: "decision", summary: "qualifiedsupportneedle decision" });
      addNode(db, "support", { summary: "qualifiedsupportneedle support", valid_until: "2020-01-01" });
      db.setNodeStatus("support", "superseded");
      db.setEpistemicStatus("support", "validated", "Independent scope", { artifact: "run-17" });
      db.insertEdge({ from_id: "decision", to_id: "support", relation: "informed_by", description: "Measured support" });
      const output = await understand(db, { query: "qualifiedsupportneedle", include_inactive: true, include_stale: true, max_tokens: 10000 });
      expect(output.compact?.find(card => card.id === "decision")?.supports).toMatchObject([{ id: "support", status: "superseded", epistemic_status: "validated", status_scope: { artifact: "run-17" }, valid_until: "2020-01-01" }]);
    } finally { db.close(); }
  });

  it("D-06 refs alone never promise whole-file coverage or skip source validation", () => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      addNode(db, "claim", { kind: "module", summary: "A measured subsystem has a stable boundary.", file_refs: ["a.ts", "b.ts", "c.ts", "d.ts"] });
      const result = buildNextHints({ db, cards: [{ id: "claim" }] });
      expect(result.skip).toEqual([]);
      expect(result.must_read).toHaveLength(3);
    } finally { db.close(); }
  });
});
