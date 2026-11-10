import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeDB } from "../db.js";
import { buildDigest, digestSourceChildren } from "../digest.js";
import { addNode, auditFixture, deferred, sqlState, type AuditFixture } from "./helpers/audit.js";

vi.mock("../embeddings.js", () => ({ embeddingText: (name: string, kind: string, summary: string) => `${kind}: ${name} — ${summary}`, embedForStorage: vi.fn(async () => null) }));
let fixture: AuditFixture;
let db: KnowledgeDB;
beforeEach(() => {
  fixture = auditFixture(); db = fixture.db(); db.setMetaValue("embed_model", "none");
  addNode(db, "module", { name: "Original module", kind: "module" });
  addNode(db, "source", { name: "Source name", parent_id: "module", summary: "Exact source fact.", file_refs: ["b.ts", "a.ts"] });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await fixture.release(db); db = undefined as unknown as KnowledgeDB; await fixture.close(); });

describe("P09 C06 digest payload version", () => {
  it.each(["refs", "refs-order", "summary", "kind", "expiry-value", "module-name"] as const)("%s-only invalidates exact payload inputs and rebuild becomes fresh", async (axis) => {
    const { digestId } = await buildDigest(db, "module", { embed: false });
    const before = db.getNode(digestId)!;
    if (axis === "module-name") db.updateNode("module", { name: "Renamed module" });
    else if (axis === "refs") db.updateNode("source", { file_refs: ["new.ts"] });
    else if (axis === "refs-order") db.updateNode("source", { file_refs: ["a.ts", "b.ts"] });
    else if (axis === "summary") db.updateNode("source", { summary: "Changed measured fact." });
    else if (axis === "kind") db.updateNode("source", { kind: "fact" });
    else db.execSqlRun("UPDATE nodes SET valid_until = ? WHERE id = ?", "2099-01-01", "source");
    expect(digestSourceChildren(db, digestId).stale).toBe(true);
    const rebuilt = await buildDigest(db, "module", { embed: false });
    expect(rebuilt.digestId).toBe(digestId);
    expect(digestSourceChildren(db, digestId).stale).toBe(false);
    const current = db.getNode(digestId)!;
    if (axis === "module-name") {
      expect(current.name).toBe("Renamed module — digest");
      expect(current.why).toBe('Auto-generated digest of "Renamed module" children.');
    }
    if (axis === "refs") expect(JSON.parse(current.file_refs!)).toEqual(["new.ts"]);
    if (axis === "refs-order") expect(JSON.parse(current.file_refs!)).toEqual(["a.ts", "b.ts"]);
    if (axis === "summary") expect(current.summary).not.toBe(before.summary);
  });
  it("stores exact frozen hash/envelope and ignores timestamps and unrelated metadata", async () => {
    const { digestId } = await buildDigest(db, "module", { embed: false });
    const row = db.execSqlFirst("SELECT sources, format_version FROM digest_sources WHERE digest_id = ?", digestId) as { sources: string; format_version: number };
    expect(row.format_version).toBe(2);
    expect(row.sources).toBe('{"builder":{"child_summary_cap":120,"min_children":5,"refs_cap":10,"summary_cap":800},"format":"digest-sources/2","module":{"id":"module","name":"Original module"},"sources":[{"node_id":"source","version":"2e66fe6e5bf00d1f11730f37ee5b9a8d2decb2395488f174665cf299a351096f"}]}');
    db.updateNode("source", { why: "Unrelated metadata" });
    db.execSqlRun("UPDATE nodes SET updated_at = ? WHERE id = ?", "2099-01-01", "source");
    const before = sqlState(db);
    expect(digestSourceChildren(db, digestId).stale).toBe(false);
    expect(sqlState(db)).toEqual(before);
  });
  it.each(["legacy-array", "unknown-format", "absent", "bad-json", "builder-cap"] as const)("%s is not a fresh proof even with unchanged timestamps", async (axis) => {
    const { digestId } = await buildDigest(db, "module", { embed: false });
    if (axis === "absent") db.execSqlRun("DELETE FROM digest_sources WHERE digest_id = ?", digestId);
    else if (axis === "legacy-array") db.execSqlRun("UPDATE digest_sources SET sources = ?, format_version = 1 WHERE digest_id = ?", '[{"node_id":"source","version":"old-v1"}]', digestId);
    else if (axis === "bad-json") db.execSqlRun("UPDATE digest_sources SET sources = ? WHERE digest_id = ?", "broken", digestId);
    else if (axis === "unknown-format") db.execSqlRun("UPDATE digest_sources SET format_version = 99 WHERE digest_id = ?", digestId);
    else {
      const row = db.execSqlFirst("SELECT sources FROM digest_sources WHERE digest_id = ?", digestId) as { sources: string };
      const envelope = JSON.parse(row.sources); envelope.builder.refs_cap = 9;
      db.execSqlRun("UPDATE digest_sources SET sources = ? WHERE digest_id = ?", JSON.stringify(envelope), digestId);
    }
    const before = sqlState(db);
    expect(digestSourceChildren(db, digestId).stale).toBe(true);
    expect(sqlState(db)).toEqual(before);
    await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digestId).stale).toBe(false);
  });
  it.each(["removed", "reparented", "superseded", "deprecated", "refuted", "abandoned", "expired", "added"] as const)("membership/eligibility %s invalidates independently of timestamps", async (axis) => {
    const { digestId } = await buildDigest(db, "module", { embed: false });
    if (axis === "removed") db.softDeleteNode("source", "withdrawn");
    else if (axis === "reparented") { addNode(db, "other-module", { kind: "module" }); db.execSqlRun("UPDATE nodes SET parent_id = ? WHERE id = ?", "other-module", "source"); }
    else if (axis === "superseded" || axis === "deprecated") db.setNodeStatus("source", axis);
    else if (axis === "refuted" || axis === "abandoned") db.setEpistemicStatus("source", axis, "Counterexample", null);
    else if (axis === "expired") db.execSqlRun("UPDATE nodes SET valid_until = ? WHERE id = ?", "2000-01-01", "source");
    else addNode(db, "added", { parent_id: "module" });
    expect(digestSourceChildren(db, digestId).stale).toBe(true);
    await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digestId).stale).toBe(false);
    if (axis !== "added") expect(db.getNode(digestId)!.summary).toBe("0 concepts: ");
  });
  it("uses exact ID order for summary and ref-union caps despite insertion order", async () => {
    db.softDeleteNode("source", "replace fixture");
    for (const id of ["z", "b", "a"]) addNode(db, id, { name: id.toUpperCase(), parent_id: "module", summary: "x".repeat(150), file_refs: id === "a" ? Array.from({ length: 9 }, (_, i) => `${i}.ts`) : [`${id}.ts`] });
    const { digestId } = await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digestId).children.map((child) => child.id)).toEqual(["a", "b", "z"]);
    expect(db.getNode(digestId)!.summary).toBe(`3 concepts: A — ${"x".repeat(120)}; B — ${"x".repeat(120)}; Z — ${"x".repeat(120)}`);
    expect(JSON.parse(db.getNode(digestId)!.file_refs!)).toEqual(["0.ts", "1.ts", "2.ts", "3.ts", "4.ts", "5.ts", "6.ts", "7.ts", "8.ts", "b.ts"]);
  });
  it("invalid source refs stay unavailable rather than gaining a fabricated fresh version", async () => {
    db.execSqlRun("UPDATE nodes SET file_refs = ? WHERE id = ?", "invalid-json", "source");
    const { digestId } = await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digestId).stale).toBe(true);
  });
  it("caps summary at the frozen 800 chars and records the whole source membership", async () => {
    for (let i = 0; i < 8; i++) addNode(db, `extra-${i}`, { name: `Extra ${i}`, parent_id: "module", summary: "x".repeat(150) });
    const { digestId } = await buildDigest(db, "module", { embed: false });
    const summary = db.getNode(digestId)!.summary;
    expect(summary).toHaveLength(800); expect(summary.endsWith("…")).toBe(true);
    expect(digestSourceChildren(db, digestId).children).toHaveLength(9);
    expect(digestSourceChildren(db, digestId).stale).toBe(false);
  });
  it("expiry changes eligibility on the clock without rewriting source inputs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    db.execSqlRun("UPDATE nodes SET valid_until = ? WHERE id = ?", "2030-01-02", "source");
    const { digestId } = await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digestId).stale).toBe(false);
    const before = sqlState(db); vi.setSystemTime(new Date("2030-01-03T00:00:00Z"));
    expect(digestSourceChildren(db, digestId).stale).toBe(true); expect(sqlState(db)).toEqual(before);
  });
  it.each(["source-name", "module-name", "refs", "membership"] as const)("afterawait CAS refuses %s changes without publishing an unseen envelope", async (axis) => {
    const { digestId } = await buildDigest(db, "module", { embed: false });
    const { embedForStorage } = await import("../embeddings.js");
    const gate = deferred<null>(); const reached = deferred();
    vi.mocked(embedForStorage).mockImplementationOnce(async () => { reached.resolve(); return gate.promise; });
    const building = buildDigest(db, "module");
    await reached.promise;
    if (axis === "source-name") db.updateNode("source", { name: "Concurrent name" });
    else if (axis === "module-name") db.updateNode("module", { name: "Concurrent module" });
    else if (axis === "refs") db.updateNode("source", { file_refs: ["concurrent.ts"] });
    else addNode(db, "concurrent", { parent_id: "module" });
    const before = sqlState(db); gate.resolve(null);
    await expect(building).rejects.toThrow(/version_conflict/);
    expect(sqlState(db)).toEqual(before);
    expect(digestSourceChildren(db, digestId).stale).toBe(true);
  });

  it("source-name-only invalidates and rebuild refreshes the actual summary", async () => {
    const { digestId } = await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digestId).stale).toBe(false);
    db.updateNode("source", { name: "Renamed source" });
    expect(digestSourceChildren(db, digestId).stale).toBe(true);
    await buildDigest(db, "module", { embed: false });
    expect(digestSourceChildren(db, digestId).stale).toBe(false);
    expect(db.getNode(digestId)!.summary).toBe("1 concepts: Renamed source — Exact source fact.");
  });
});
