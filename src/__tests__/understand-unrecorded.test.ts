import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { createConcept, measureMcpPayload, understand } from "../tools.js";
import { RECORD_FACT, UNRECORDED_READS_THRESHOLD } from "../next-hints.js";
import { createTimelineLogger, type TimelineLogger } from "../timeline.js";
import { addNode, auditFixture, deferred, type AuditFixture } from "./helpers/audit.js";
import * as search from "../search.js";

let fixture: AuditFixture;
let db: KnowledgeDB;
let logger: TimelineLogger;

beforeEach(() => {
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  ensureSchema(db);
  db.setMetaValue("embed_model", "unrecorded-disabled-vector-space");
  addNode(db, "activity", { name: "Activity", summary: "Activity logger tracks completed reads independently from persisted rows." });
  logger = createTimelineLogger(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.close();
});

function reads(count: number): void {
  for (let i = 0; i < count; i++) {
    logger.log({ tool: "get_concept", params: { id: "activity" }, result_summary: "read", is_write: false, is_error: false, affected_ids: ["activity"] });
  }
}

function nudge(count: number): string {
  return `С последней записи ${count} чтений — если это законченный вывод, запиши его.`;
}

describe("understand unrecorded nudge", () => {
  it("keeps the fresh contract below the read threshold", async () => {
    for (let i = 0; i < UNRECORDED_READS_THRESHOLD; i++) {
      const out = await understand(db, { query: "Activity" });
      expect(out.next!.record).toBe(RECORD_FACT);
      expect(out.next).not.toHaveProperty("unrecorded");
      reads(1);
    }
  });

  it("adds exactly one nudge at three reads and never duplicates it at four", async () => {
    reads(UNRECORDED_READS_THRESHOLD);
    const first = await understand(db, { query: "Activity" });
    expect(first.next!.record).toBe(`${RECORD_FACT} ${nudge(UNRECORDED_READS_THRESHOLD)}`);
    expect(first.next!.unrecorded).toEqual({ reads_since_write: UNRECORDED_READS_THRESHOLD, last_write_at: null });
    reads(1);
    const next = await understand(db, { query: "Activity" });
    expect(next.next!.record).toBe(`${RECORD_FACT} ${nudge(UNRECORDED_READS_THRESHOLD + 1)}`);
    expect(next.next!.record.split("С последней записи")).toHaveLength(2);
    expect(next.next!.record.length).toBe(first.next!.record.length);
  });

  it("removes the reminder after create_concept is logged as a write", async () => {
    reads(UNRECORDED_READS_THRESHOLD);
    expect((await understand(db, { query: "Activity" })).next).toHaveProperty("unrecorded");
    const created = await createConcept(db, {
      name: "Recorded outcome", kind: "feature",
      summary: "Completed analysis establishes a concrete recording outcome independent of logger persistence.",
      evidence: [{ ref: "src/timeline.ts:1-60", why: "The logger maintains independent activity counters." }],
    });
    expect(created.id).toBeTruthy();
    logger.log({ tool: "create_concept", params: {}, result_summary: "created", is_write: true, is_error: false, affected_ids: [created.id!] });
    const out = await understand(db, { query: "Activity" });
    expect(out.next!.record).toBe(RECORD_FACT);
    expect(out.next).not.toHaveProperty("unrecorded");
    reads(UNRECORDED_READS_THRESHOLD);
    const after = await understand(db, { query: "Activity" });
    expect(after.next!.unrecorded?.last_write_at).toBe(logger.activity().last_write_at);
  });

  it("includes the nudge in brief and full modes", async () => {
    reads(UNRECORDED_READS_THRESHOLD);
    for (const mode of ["brief", "full"] as const) {
      const out = await understand(db, { query: "Activity", mode, max_tokens: 2500 });
      expect(out.next!.record).toBe(`${RECORD_FACT} ${nudge(UNRECORDED_READS_THRESHOLD)}`);
      expect(out.next!.unrecorded?.reads_since_write).toBe(UNRECORDED_READS_THRESHOLD);
      expect(out.meta!.tokens_estimated).toBe(measureMcpPayload(out));
    }
  });

  it("uses activity after a concurrent write completes during search", async () => {
    reads(UNRECORDED_READS_THRESHOLD);
    vi.stubEnv("MEGAMEMORY_SEARCH", "hybrid");
    const started = deferred();
    const resume = deferred();
    const original = search.hybridSearch;
    vi.spyOn(search, "hybridSearch").mockImplementation(async (...args) => {
      started.resolve();
      await resume.promise;
      return original(...args);
    });
    const pending = understand(db, { query: "Activity" });
    await started.promise;
    logger.log({ tool: "create_concept", params: {}, result_summary: "created concurrently", is_write: true, is_error: false, affected_ids: [] });
    resume.resolve();
    const out = await pending;
    expect(out.next).not.toHaveProperty("unrecorded");
    expect(out.next!.record).toBe(RECORD_FACT);
  });

  it("preserves the complete record and nudge at max_tokens=500", async () => {
    reads(UNRECORDED_READS_THRESHOLD);
    const out = await understand(db, { query: "Activity", max_tokens: 500 });
    expect(out.next!.record).toContain(RECORD_FACT);
    expect(out.next!.record.endsWith(nudge(UNRECORDED_READS_THRESHOLD))).toBe(true);
    expect(out.next!.unrecorded?.reads_since_write).toBe(UNRECORDED_READS_THRESHOLD);
    expect(out.meta!.tokens_estimated).toBeLessThanOrEqual(500);
    expect(out.meta!.tokens_estimated).toBe(measureMcpPayload(out));
  });
});
