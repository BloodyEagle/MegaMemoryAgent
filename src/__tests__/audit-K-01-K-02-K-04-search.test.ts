import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../migrate-schema.js";
import { ftsSearch } from "../search.js";
import { formatError, link, understand } from "../tools.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";
import type { KnowledgeDB } from "../db.js";

// FTS is not an inference guard for every write path. Fail closed at the SDK boundary.
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("Audit tests must not load an inference model"); }),
}));

let fixture: AuditFixture;

beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
});

function freshDb() {
  const db = fixture.db();
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-disabled-vector-space");
  return db;
}

afterEach(async () => {
  try { await fixture.close(); } finally { vi.unstubAllEnvs(); }
});

describe("K-01: top_k counts eligible search results", () => {
  it.each(["compact", "full"] as const)("Q1: fills top_k=1 after excluding an expired first hit (%s)", async (mode) => {
    const db = freshDb();
    addNode(db, "expired", { summary: "needlefilter", valid_until: "2020-01-01" });
    addNode(db, "fresh", { summary: `${"filler ".repeat(200)} needlefilter` });
    expect(ftsSearch(db, "needlefilter", 1).map((hit) => hit.id)).toEqual(["expired"]);

    const result = await understand(db, { query: "needlefilter", top_k: 1, max_tokens: 1500, mode });

    expect((mode === "compact" ? result.compact : result.matches)?.map((hit) => hit.id)).toEqual(["fresh"]);
    expect(result.meta?.stale_excluded).toBe(1);
  });

  it("fills top_k after excluding a superseded first hit", async () => {
    const db = freshDb();
    addNode(db, "superseded", { summary: "lifecycleneedle" });
    db.setNodeStatus("superseded", "superseded");
    addNode(db, "current", { summary: `${"filler ".repeat(200)} lifecycleneedle` });
    expect(ftsSearch(db, "lifecycleneedle", 1)[0]?.id).toBe("superseded");

    const result = await understand(db, { query: "lifecycleneedle", top_k: 1 });

    expect(result.compact?.map((hit) => hit.id)).toEqual(["current"]);
  });

  it("keeps a fresh first hit and applies top_k", async () => {
    const db = freshDb();
    addNode(db, "first", { summary: "freshneedle" });
    addNode(db, "second", { summary: `${"filler ".repeat(200)} freshneedle` });

    const result = await understand(db, { query: "freshneedle", top_k: 1 });

    expect(result.compact?.map((hit) => hit.id)).toEqual(["first"]);
    expect(result.meta?.stale_excluded).toBe(0);
  });

  it("returns an expired first hit only when explicitly requested, with its expiry flag", async () => {
    const db = freshDb();
    addNode(db, "expired", { summary: "optinneedle", valid_until: "2020-01-01" });
    addNode(db, "fresh", { summary: `${"filler ".repeat(200)} optinneedle` });

    const result = await understand(db, { query: "optinneedle", top_k: 1, include_stale: true });

    expect(result.compact).toMatchObject([{ id: "expired", expired: true }]);
    expect(result.meta?.stale_excluded).toBe(0);
  });
});

function supportedDecision(db: KnowledgeDB, source: Parameters<typeof addNode>[2] = {}) {
  addNode(db, "decision", {
    kind: "decision", summary: "nestedneedle The decision retains measurements used to choose the cache policy.",
  });
  addNode(db, "source", {
    summary: "nestedneedle The source records an independent cache measurement.", ...source,
  });
  link(db, {
    from: "decision", to: "source", relation: "informed_by",
    description: "The independent measurement explains the cache policy.",
  });
}

describe("K-02: folding supports preserves knowledge qualification", () => {
  it("Q2: retains abandoned status and expiry on a nested support", async () => {
    const db = freshDb();
    supportedDecision(db, { epistemic_status: "abandoned", valid_until: "2020-01-01" });

    const result = await understand(db, { query: "nestedneedle", include_stale: true, max_tokens: 10000 });
    const support = result.compact?.find((hit) => hit.id === "decision")?.supports?.[0];

    expect(support).toMatchObject({ id: "source", status: "active", epistemic_status: "abandoned", expired: true });
  });

  it("retains lifecycle status when an inactive support is explicitly included", async () => {
    const db = freshDb();
    supportedDecision(db);
    db.setNodeStatus("source", "superseded");

    const result = await understand(db, { query: "nestedneedle", include_inactive: true, max_tokens: 10000 });

    expect(result.compact?.find((hit) => hit.id === "decision")?.supports).toMatchObject([
      { id: "source", status: "superseded" },
    ]);
  });

  it("folds a live support once without losing its identity or wording", async () => {
    const db = freshDb();
    supportedDecision(db);

    const result = await understand(db, { query: "nestedneedle", max_tokens: 10000 });

    expect(result.compact?.map((hit) => hit.id)).toEqual(["decision"]);
    expect(result.compact?.[0].supports).toEqual([
      expect.objectContaining({ id: "source", name: "source", summary: "nestedneedle The source records an independent cache measurement." }),
    ]);
    expect(result.meta?.supports_inlined).toBe(1);
  });

  it("keeps a support standalone when its decision does not match", async () => {
    const db = freshDb();
    supportedDecision(db);
    db.updateNode("decision", { summary: "An unrelated policy description without the search marker." });

    const result = await understand(db, { query: "nestedneedle", max_tokens: 10000 });

    expect(result.compact?.map((hit) => hit.id)).toEqual(["source"]);
    expect(result.meta?.supports_inlined).toBe(0);
  });
});

const REFUTED_REASON = "Measured cache invalidation fails after rename";

function refutedClaim(db: KnowledgeDB) {
  addNode(db, "wrong", { summary: "wrongneedle The old cache conclusion was contradicted by an external measurement." });
  db.setEpistemicStatus("wrong", "refuted", REFUTED_REASON, null);
}

describe("K-04: refuted search results carry their reason", () => {
  it("Q4: preserves the reason in compact output at max_tokens=1500", async () => {
    const db = freshDb();
    refutedClaim(db);

    const result = await understand(db, { query: "wrongneedle", max_tokens: 1500 });

    expect(result.compact).toEqual([]);
    expect(result.refuted).toMatchObject([
      { id: "wrong", epistemic_status: "refuted", refuted_reason: REFUTED_REASON },
    ]);
  });

  it("Q4: a tight budget preserves the refuted reason or explicitly truncates/refuses within the cap", async () => {
    const db = freshDb();
    refutedClaim(db);
    const maxTokens = 150;
    let result: Awaited<ReturnType<typeof understand>>;
    try {
      result = await understand(db, { query: "wrongneedle", max_tokens: maxTokens });
    } catch (error) {
      const refusal = formatError(error);
      expect(refusal.content[0].text).toMatch(/budget|max_tokens|бюджет|токен/i);
      expect(refusal.content[0].text).toMatch(/exceed|insufficient|too (?:small|low)|cannot fit|does not fit|не помещ|недостат|слишком мал|превыш|ниже минимума/i);
      expect(Math.ceil(Buffer.byteLength(JSON.stringify(refusal), "utf8") / 3)).toBeLessThanOrEqual(maxTokens);
      return;
    }

    expect(result.compact ?? []).toEqual([]);
    expect(result.matches).toEqual([]);
    if ((result.refuted?.length ?? 0) > 0) {
      expect(result.refuted).toMatchObject([
        { id: "wrong", epistemic_status: "refuted", refuted_reason: REFUTED_REASON },
      ]);
    } else {
      // This fixture has no stale/inactive candidates: dropping its sole hit
      // must be explicit budget truncation, not an unexplained empty search.
      const meta = result.meta;
      const explicitlyTruncated = (meta?.dropped ?? 0) > 0 ||
        (meta !== undefined && "truncated" in meta && meta.truncated === true);
      expect(explicitlyTruncated, "Omitted refuted knowledge requires an explicit budget truncation marker").toBe(true);
    }
    const wire = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    expect(Math.ceil(Buffer.byteLength(wire, "utf8") / 3)).toBeLessThanOrEqual(maxTokens);
    expect(result.meta?.truncated).toBe(true);
  });

  it("full output keeps refuted knowledge separate from current facts and includes the reason", async () => {
    const db = freshDb();
    refutedClaim(db);
    addNode(db, "current", { summary: "wrongneedle Current policy uses the independently measured invalidation sequence." });

    const result = await understand(db, { query: "wrongneedle", mode: "full" });

    expect(result.matches.map((hit) => hit.id)).toEqual(["current"]);
    expect(result.refuted).toMatchObject([
      { id: "wrong", epistemic_status: "refuted", refuted_reason: REFUTED_REASON },
    ]);
  });
});
