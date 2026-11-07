import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDigest, digestSourceChildren } from "../digest.js";
import { ensureSchema } from "../migrate-schema.js";
import { understand } from "../tools.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("Audit tests must not load an inference model"); }),
}));

let fixture: AuditFixture;
beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
});
afterEach(async () => {
  vi.useRealTimers();
  try { await fixture.close(); } finally { vi.unstubAllEnvs(); }
});

function freshDb() {
  const db = fixture.db();
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-disabled-vector-space");
  addNode(db, "module", { kind: "module", summary: "Container for independently observed source facts." });
  return db;
}

describe("K-08: digest source eligibility and membership", () => {
  it.each(["expired", "refuted", "abandoned", "superseded", "deprecated"] as const)(
    "D1: does not republish a %s source as current knowledge through a searchable digest", async (state) => {
      const db = freshDb();
      addNode(db, "ineligible", {
        parent_id: "module", summary: "digestneedle The release is pending approval according to the obsolete observation.",
        ...(state === "expired" ? { valid_until: "2020-01-01" } : {}),
      });
      if (state === "refuted" || state === "abandoned") db.setEpistemicStatus("ineligible", state, "Independent counterexample", null);
      if (state === "superseded" || state === "deprecated") db.setNodeStatus("ineligible", state);
      addNode(db, "current", { parent_id: "module", summary: "Current measurements establish the cache invalidation sequence." });

      const digest = await buildDigest(db, "module", { embed: false });
      const result = await understand(db, { query: "digestneedle", max_tokens: 10000 });
      const returnedDigest = result.compact?.find((hit) => hit.id === digest.digestId);

      expect(returnedDigest?.summary ?? "").not.toContain("pending approval");
      expect(digestSourceChildren(db, digest.digestId).children.map((child) => child.id)).toEqual(["current"]);
    },
  );

  it("D2: deleting the only source makes the existing digest stale", async () => {
    const db = freshDb();
    addNode(db, "source", { parent_id: "module" });
    const digest = await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digest.digestId).stale).toBe(false);

    db.softDeleteNode("source", "The source was withdrawn after a counterexample");

    expect(digestSourceChildren(db, digest.digestId).stale).toBe(true);
  });

  it("adding a source invalidates membership even when its timestamp equals the digest timestamp", async () => {
    const db = freshDb();
    addNode(db, "source", { parent_id: "module" });
    const digest = await buildDigest(db, "module", { embed: false });
    addNode(db, "new-source", { parent_id: "module" });
    // SQLite timestamps have second precision; represent two legitimate writes in the same tick.
    db.execSqlRun("UPDATE nodes SET updated_at = ? WHERE id = ?", db.getNode(digest.digestId)!.updated_at, "new-source");

    expect(digestSourceChildren(db, digest.digestId).stale).toBe(true);
  });

  it("reparenting the only source invalidates the old module digest", async () => {
    const db = freshDb();
    addNode(db, "elsewhere", { kind: "module" });
    addNode(db, "source", { parent_id: "module" });
    const digest = await buildDigest(db, "module", { embed: false });

    // Raw fixture mutation models reparent/import; updateNode does not expose parent_id.
    db.execSqlRun("UPDATE nodes SET parent_id = ? WHERE id = ?", "elsewhere", "source");
    expect(db.getNode("source")?.parent_id).toBe("elsewhere");

    expect(digestSourceChildren(db, digest.digestId).stale).toBe(true);
  });

  it("expiry makes a digest stale on reading, without a write to the source", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-06-01T12:00:00Z"));
    const db = freshDb();
    addNode(db, "source", { parent_id: "module", valid_until: "2030-06-02" });
    const digest = await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digest.digestId).stale).toBe(false);
    const before = sqlState(db);

    vi.setSystemTime(new Date("2030-06-03T00:00:00Z"));
    const result = digestSourceChildren(db, digest.digestId);

    expect.soft(result.stale).toBe(true);
    expect(sqlState(db)).toEqual(before);
  });

  it("an unchanged live source yields a fresh digest with its fact and file reference", async () => {
    const db = freshDb();
    const ref = fixture.file("evidence.txt");
    addNode(db, "source", { parent_id: "module", summary: "digestneedle The measured cache policy invalidates renamed entries.", file_refs: [ref] });

    const digest = await buildDigest(db, "module", { embed: false });
    const result = await understand(db, { query: "digestneedle", max_tokens: 10000 });

    expect(digest.children).toBe(1);
    expect(digestSourceChildren(db, digest.digestId)).toMatchObject({ children: [{ id: "source" }], stale: false });
    expect(result.compact?.find((hit) => hit.id === digest.digestId)).toMatchObject({ file_refs: [ref] });
    expect(db.getNode(digest.digestId)?.summary).toContain("measured cache policy");
  });

  it("rebuilding after a source deletion removes the old fact and restores fresh membership", async () => {
    const db = freshDb();
    addNode(db, "source", { parent_id: "module", summary: "An obsolete measurement of a pending release." });
    const original = await buildDigest(db, "module", { embed: false });
    db.softDeleteNode("source", "Obsolete measurement");

    const rebuilt = await buildDigest(db, "module", { embed: false });

    expect(rebuilt).toMatchObject({ digestId: original.digestId, created: false, children: 0 });
    expect(db.getNode(rebuilt.digestId)?.summary).not.toContain("pending release");
    expect(digestSourceChildren(db, rebuilt.digestId)).toEqual({ children: [], stale: false });
  });
});
