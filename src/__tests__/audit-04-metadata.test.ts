import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkArtifacts } from "../artifacts.js";
import { ensureSchema } from "../migrate-schema.js";
import { provenanceTrace } from "../provenance.js";
import { getConcept, link } from "../tools.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";
import type { KnowledgeDB } from "../db.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("Audit tests must not load an inference model"); }),
}));

// План 04 (доптребование из отчёта плана 03): libsql вешает на каждую строку
// `_metadata: { duration }` — профилировочный шум. При вычислении дайджестов,
// при сравнении состояния и в ответах current_digests/supports[] поле
// вырезается у источника: повторное чтение того же состояния даёт тот же
// digest и тот же ответ независимо от duration, и шум не утекает в JSON.

let fixture: AuditFixture;
beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
});
afterEach(async () => { await fixture.close(); });

function freshDb() {
  const db = fixture.db();
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-disabled-vector-space");
  return db;
}

describe("F-02 addendum: _metadata never reaches digests, comparisons or answers", () => {
  it("two consecutive reads of the same state give identical current_digests and supports[]", async () => {
    const db: KnowledgeDB = freshDb();
    const file = fixture.file("evidence.txt");
    const fs = await import("node:fs");
    fs.writeFileSync(file, "Deterministic independently observed content.", "utf8");
    addNode(db, "source", { file_refs: [file] });
    addNode(db, "decision", { kind: "decision" });
    link(db, { from: "decision", to: "source", relation: "informed_by", description: "The independent measurement supports this decision." });
    await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });

    const first = provenanceTrace(db, { node_id: "decision" });
    const second = provenanceTrace(db, { node_id: "decision" });

    expect(second.current_digests).toEqual(first.current_digests);
    expect(JSON.stringify(second.supports)).toBe(JSON.stringify(first.supports));

    const cardFirst = getConcept(db, { id: "decision" });
    const cardSecond = getConcept(db, { id: "decision" });
    expect(cardSecond.current_digests).toEqual(cardFirst.current_digests);
    expect(cardSecond.support_check).toEqual(cardFirst.support_check);
  });

  it("read answers carry no _metadata field anywhere", async () => {
    const db: KnowledgeDB = freshDb();
    addNode(db, "module", { kind: "module" });
    addNode(db, "module-child", { parent_id: "module" });
    addNode(db, "decision", { kind: "decision" });
    link(db, { from: "decision", to: "module-child", relation: "informed_by", description: "The independent measurement supports this decision." });

    const card = getConcept(db, { id: "decision" });
    const trace = provenanceTrace(db, { node_id: "decision" });

    expect(JSON.stringify(card)).not.toContain("_metadata");
    expect(JSON.stringify(trace)).not.toContain("_metadata");
  });
});
