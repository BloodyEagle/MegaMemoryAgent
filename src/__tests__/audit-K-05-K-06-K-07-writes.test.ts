import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../migrate-schema.js";
import { claimDigestOf, statusDigestOf } from "../support-baselines.js";
import { createConcept, getConcept, link, updateConcept } from "../tools.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";
import type { KnowledgeDB } from "../db.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("Audit tests must not load an inference model"); }),
}));

let fixture: AuditFixture;
beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
  vi.stubEnv("MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT", "0");
  vi.stubEnv("MEGAMEMORY_REQUIRE_SUPPORT", "0");
  vi.stubEnv("MEGAMEMORY_PROVENANCE_AUTO_GROUND", "0");
  vi.stubEnv("MEGAMEMORY_AUTO_DIGEST", "0");
});
afterEach(async () => {
  try { await fixture.close(); } finally { vi.unstubAllEnvs(); }
});

function freshDb() {
  const db = fixture.db();
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-disabled-vector-space");
  return db;
}

const SUMMARY = "The replacement stores an independent baseline and handles the measured cache invalidation case.";
const SCOPE = { artifact: "isolated-run-before", env: "audit-fixture" };

function validatedClaim(db: KnowledgeDB) {
  addNode(db, "claim");
  db.setEpistemicStatus("claim", "validated", "Measured independently", SCOPE);
}

function requireSupport() {
  vi.stubEnv("MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT", "1");
  vi.stubEnv("MEGAMEMORY_REQUIRE_SUPPORT", "1");
}

describe("K-05: create with supersedes is one atomic write", () => {
  it("M1: a missing supersedes target leaves every table unchanged, including support snapshots and history", async () => {
    const db = freshDb();
    addNode(db, "old");
    addNode(db, "evidence");
    const before = sqlState(db);

    await expect(createConcept(db, {
      name: "replacement", kind: "feature", summary: SUMMARY, force: true,
      supersedes: ["old", "missing"],
      evidence: [{ node: "evidence", why: "The independent measurement demonstrates the replacement behavior." }],
    })).rejects.toThrow(/missing/);

    expect(sqlState(db)).toEqual(before);
  });

  it("creates the replacement and supersedes all existing targets with their edges and history", async () => {
    const db = freshDb();
    addNode(db, "old-one");
    addNode(db, "old-two");
    addNode(db, "evidence");

    const evidenceRow = db.getNode("evidence")!;
    const result = await createConcept(db, {
      name: "replacement", kind: "feature", summary: SUMMARY, force: true,
      supersedes: ["old-one", "old-two"],
      evidence: [{
        node: "evidence",
        why: "The independent measurement demonstrates the replacement behavior.",
        // Frozen C-02: only an asserted expectation confirms the pair.
        expect: { claim_digest: claimDigestOf(evidenceRow.summary), status_digest: statusDigestOf(evidenceRow.status, evidenceRow.epistemic_status) },
      }],
    });

    expect(result.id).toBe("replacement");
    expect(db.getNode("replacement")).toMatchObject({ summary: SUMMARY, status: "active" });
    for (const id of ["old-one", "old-two"]) {
      expect(db.getNode(id)).toMatchObject({ status: "superseded" });
      expect(db.getStatusHistory(id)).toMatchObject([{ from_status: "active", to_status: "superseded" }]);
    }
    expect(db.getAllEdges().filter((edge) => edge.relation === "supersedes").map((edge) => edge.to_id).sort()).toEqual(["old-one", "old-two"]);
    expect(db.getActiveSupportBaselines("replacement")).toMatchObject([{ support_id: "evidence" }]);
  });
});

describe("K-06: validated state retains its external artifact", () => {
  it("M2: repeating validated without a new scope preserves the scope and transition history", async () => {
    const db = freshDb();
    validatedClaim(db);
    const history = db.getStatusHistory("claim");

    await updateConcept(db, { id: "claim", changes: { epistemic_status: "validated", epistemic_reason: "Repeat the same status" } });

    expect(getConcept(db, { id: "claim" })).toMatchObject({ epistemic_status: "validated", status_scope: SCOPE });
    expect(db.getStatusHistory("claim")).toEqual(history);
  });

  it("rejects a replacement validated scope without an artifact and makes no writes", async () => {
    const db = freshDb();
    validatedClaim(db);
    const before = sqlState(db);

    await expect.soft(updateConcept(db, {
      id: "claim", changes: { epistemic_status: "validated", epistemic_reason: "Replace scope", status_scope: { env: "unverified" } },
    })).rejects.toThrow(/artifact/);

    expect(sqlState(db)).toEqual(before);
  });

  it("records a revision when a validated claim receives a different external artifact", async () => {
    const db = freshDb();
    validatedClaim(db);
    const before = db.getStatusHistory("claim");
    const scope = { artifact: "isolated-run-after", env: "audit-fixture" };

    await updateConcept(db, {
      id: "claim", changes: { epistemic_status: "validated", epistemic_reason: "A new independent run checked this scope", status_scope: scope },
    });

    expect(getConcept(db, { id: "claim" }).status_scope).toEqual(scope);
    expect(db.getStatusHistory("claim")).toHaveLength(before.length + 1);
  });

  it("accepts open to validated with an external artifact and records the reason", async () => {
    const db = freshDb();
    addNode(db, "claim");

    await updateConcept(db, {
      id: "claim", changes: { epistemic_status: "validated", epistemic_reason: "Independent run passed", status_scope: SCOPE },
    });

    expect(getConcept(db, { id: "claim" })).toMatchObject({ epistemic_status: "validated", status_scope: SCOPE });
    expect(db.getStatusHistory("claim")).toMatchObject([
      { from_status: "open", to_status: "validated", reason: "Independent run passed" },
    ]);
  });
});

describe("K-07: update validates the resulting concept like create", () => {
  it("M3: refuses a feature-to-decision placeholder under require_support without changing any table", async () => {
    const db = freshDb();
    addNode(db, "converted", { created_via: "agent" });
    requireSupport();
    const before = sqlState(db);

    await expect.soft(updateConcept(db, { id: "converted", changes: { kind: "decision", summary: "placeholder" } })).rejects.toThrow();

    expect(sqlState(db)).toEqual(before);
  });

  it("refuses an unsupported decision even when its new summary is substantive", async () => {
    const db = freshDb();
    addNode(db, "converted", { created_via: "agent" });
    requireSupport();
    const before = sqlState(db);

    await expect.soft(updateConcept(db, {
      id: "converted", changes: { kind: "decision", summary: "Choose cache invalidation after rename because independent measurements show stale lookups otherwise." },
    })).rejects.toThrow(/evidence|опор/i);

    expect(sqlState(db)).toEqual(before);
  });

  it("refuses replacing a supported decision summary with a placeholder", async () => {
    const db = freshDb();
    addNode(db, "decision", { kind: "decision", created_via: "agent" });
    addNode(db, "evidence");
    link(db, { from: "decision", to: "evidence", relation: "informed_by", description: "Independent measurements justify this decision." });
    requireSupport();
    const before = sqlState(db);

    await expect.soft(updateConcept(db, { id: "decision", changes: { summary: "placeholder" } })).rejects.toThrow();

    expect(sqlState(db)).toEqual(before);
  });

  it("allows converting an already supported feature to a substantive decision", async () => {
    const db = freshDb();
    addNode(db, "converted", { created_via: "agent" });
    addNode(db, "evidence");
    link(db, { from: "converted", to: "evidence", relation: "informed_by", description: "Independent measurements justify this decision." });
    requireSupport();

    await updateConcept(db, { id: "converted", changes: { kind: "decision", summary: SUMMARY } });

    expect(db.getNode("converted")).toMatchObject({ kind: "decision", summary: SUMMARY });
    expect(db.getInformedByEdges("converted", "ancestry", false)).toMatchObject([{ to_id: "evidence" }]);
  });

  it("create already rejects an unsupported decision without writes", async () => {
    const db = freshDb();
    requireSupport();
    const before = sqlState(db);

    await expect(createConcept(db, { name: "unsupported", kind: "decision", summary: SUMMARY, force: true })).rejects.toThrow(/evidence|опор/i);

    expect(sqlState(db)).toEqual(before);
  });

  it("an invalid expiry rejects the whole update, including a simultaneous summary change", async () => {
    const db = freshDb();
    addNode(db, "claim");
    const before = sqlState(db);

    await expect(updateConcept(db, { id: "claim", changes: { summary: SUMMARY, valid_until: "not-a-date" } })).rejects.toThrow(/valid_until/);

    expect(sqlState(db)).toEqual(before);
  });
});
