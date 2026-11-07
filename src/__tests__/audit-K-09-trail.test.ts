import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../migrate-schema.js";
import { trailGet, trailRefresh, trailSave, updateConcept } from "../tools.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("Audit tests must not load an inference model"); }),
}));

let fixture: AuditFixture;
beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
});
afterEach(async () => {
  vi.useRealTimers();
  await fixture.close();
});

function freshDb() {
  const db = fixture.db();
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-disabled-vector-space");
  return db;
}

describe("K-09: trail freshness never launders ineligible reasoning", () => {
  it.each(["refuted", "abandoned"] as const)("T1: refreshing a %s member does not make the trail fresh", (status) => {
    const db = freshDb();
    addNode(db, "member");
    const trail = trailSave(db, { name: "eligibility", summary: "Reasoning depends on this independently observed source.", node_ids: ["member"] });
    db.setEpistemicStatus("member", status, "An external counterexample invalidates the conclusion", null);
    expect(trailGet(db, trail.id).state).toBe("stale");

    trailRefresh(db, trail.id);
    const result = trailGet(db, trail.id);

    expect(result.state).toBe("stale");
    expect(result.members).toMatchObject([{ node_id: "member", state: "stale" }]);
  });

  it("T2: editing member expiry to the past makes the trail stale", async () => {
    const db = freshDb();
    addNode(db, "member");
    const trail = trailSave(db, { name: "expiry-update", summary: "This reasoning uses a time-limited claim.", node_ids: ["member"] });
    expect(trailGet(db, trail.id).state).toBe("fresh");

    await updateConcept(db, { id: "member", changes: { valid_until: "2020-01-01" } });

    expect(trailGet(db, trail.id).state).toBe("stale");
  });

  it("detects natural expiry on read without changing the member or its fingerprint", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-06-01T12:00:00Z"));
    const db = freshDb();
    addNode(db, "member", { valid_until: "2030-06-02" });
    const trail = trailSave(db, { name: "expiry-clock", summary: "This reasoning uses a time-limited claim.", node_ids: ["member"] });
    const before = db.getNode("member")!;
    const fingerprint = db.nodeFingerprint("member");
    expect(trailGet(db, trail.id).state).toBe("fresh");

    vi.setSystemTime(new Date("2030-06-03T00:00:00Z"));
    const result = trailGet(db, trail.id);

    expect.soft(result.state).toBe("stale");
    expect(db.getNode("member")).toMatchObject({ summary: before.summary, valid_until: before.valid_until, updated_at: before.updated_at });
    expect(db.nodeFingerprint("member")).toBe(fingerprint);
  });

  it("refreshing an expired member cannot restore fresh reasoning", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-06-01T12:00:00Z"));
    const db = freshDb();
    addNode(db, "member", { valid_until: "2030-06-02" });
    const trail = trailSave(db, { name: "expired-refresh", summary: "This reasoning uses a time-limited claim.", node_ids: ["member"] });
    vi.setSystemTime(new Date("2030-06-03T00:00:00Z"));

    trailRefresh(db, trail.id);

    expect(trailGet(db, trail.id).state).toBe("stale");
  });

  it("a live unchanged chain remains fresh before and after refresh", () => {
    const db = freshDb();
    addNode(db, "member");
    const trail = trailSave(db, { name: "live", summary: "Reasoning uses an unchanged live fact.", node_ids: ["member"] });

    expect(trailGet(db, trail.id).state).toBe("fresh");
    trailRefresh(db, trail.id);

    expect(trailGet(db, trail.id)).toMatchObject({ state: "fresh", members: [{ node_id: "member", state: "fresh" }] });
  });

  it("renaming a live member without changing meaning does not invalidate the chain", async () => {
    const db = freshDb();
    addNode(db, "member");
    const trail = trailSave(db, { name: "rename", summary: "Reasoning uses an unchanged live fact.", node_ids: ["member"] });

    await updateConcept(db, { id: "member", changes: { name: "A clearer label for the same fact" } });

    expect(trailGet(db, trail.id).state).toBe("fresh");
  });

  it("refreshing a changed but still eligible claim accepts its new snapshot", async () => {
    const db = freshDb();
    addNode(db, "member");
    const trail = trailSave(db, { name: "revision", summary: "Reasoning uses a revised live fact.", node_ids: ["member"] });
    await updateConcept(db, { id: "member", changes: { summary: "A revised independent measurement describes the current cache behavior." } });
    expect(trailGet(db, trail.id).state).toBe("stale");

    trailRefresh(db, trail.id);

    expect(trailGet(db, trail.id).state).toBe("fresh");
  });

  it("a hard-deleted member stays present and broken after refresh", () => {
    const db = freshDb();
    addNode(db, "member");
    const trail = trailSave(db, { name: "broken", summary: "The missing source must remain visible in this chain.", node_ids: ["member"] });
    db.hardDeleteNode("member");

    expect(() => trailRefresh(db, trail.id)).toThrow(/broken/);

    expect(trailGet(db, trail.id)).toMatchObject({ state: "broken", members: [{ node_id: "member", state: "broken" }] });
  });
});
