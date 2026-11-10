import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { auditFixture, addNode, type AuditFixture } from "./helpers/audit.js";

// Frozen schema-contract r2: constructor/migration/profile and confirmation seams.
let fixture: AuditFixture;
afterEach(async () => { await fixture?.close(); });

describe("schema 14 atomic format", () => {
  it("creates every declared pair and validation field without eager optional profiles", () => {
    fixture = auditFixture();
    const db = fixture.db();
    expect(db.getUserVersion()).toBe(14);
    expect(db.getMetaValue("schema_contract")).toBe("megamemory-schema-14");
    const columns = (table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
    expect(columns("nodes")).toEqual(expect.arrayContaining(["validation_claim_digest", "validation_scope_digest", "embedding_generation"]));
    expect(columns("support_baselines")).toContain("decision_claim_digest");
    expect(columns("support_revisions")).toEqual(expect.arrayContaining(["artifacts_digest", "decision_claim_digest", "confirmed_by", "superseded_at"]));
    expect(columns("status_history")).toEqual([]);
    expect(columns("digest_sources")).toEqual([]);
    expect(columns("merge_conflicts")).toEqual([]);
    ensureSchema(db);
    expect(columns("status_history")).toEqual(expect.arrayContaining(["claim_digest", "scope_digest", "status_scope"]));
  });

  it("rejects future schemas even when auto migration is disabled", async () => {
    fixture = auditFixture();
    const db = fixture.db("future.db");
    addNode(db, "sentinel");
    db.pragma("user_version = 15");
    await fixture.release(db);
    expect(() => new KnowledgeDB(fixture.file("future.db"), { autoMigrate: false })).toThrow(/15/);
  });
});
