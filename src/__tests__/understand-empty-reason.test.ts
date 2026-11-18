import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { createConcept, measureMcpPayload, understand } from "../tools.js";
import { EMPTY_REASON_RECORD, RECORD_FACT, UNRECORDED_READS_THRESHOLD } from "../next-hints.js";
import { createTimelineLogger, type TimelineLogger } from "../timeline.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
let db: KnowledgeDB;
let logger: TimelineLogger;

beforeEach(() => {
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  ensureSchema(db);
  db.setMetaValue("embed_model", "empty-reason-disabled-vector-space");
  logger = createTimelineLogger(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.close();
});

function seedBudget(): void {
  addNode(db, "budget", { name: "Budget fixture", summary: "Budget matches a measured implementation detail. ".repeat(8) });
}

describe("understand empty reasons", () => {
  it("explains an empty base in compact, full, brief and vector-only modes", async () => {
    for (const mode of ["compact", "full", "brief"] as const) {
      const out = await understand(db, { query: "nothing", mode });
      expect(out.meta!.reason).toBe("empty_base");
      expect(out.next!.record).toBe(`${EMPTY_REASON_RECORD.empty_base} ${RECORD_FACT}`);
      expect(out.meta!.tokens_estimated).toBe(measureMcpPayload(out));
    }
    vi.stubEnv("MEGAMEMORY_SEARCH", "vector");
    const out = await understand(db, { query: "nothing" });
    expect(out.meta!.reason).toBe("empty_base");
  });

  it("distinguishes a miss and filtered candidates from an empty base", async () => {
    addNode(db, "stored", { name: "Existing module", summary: "Existing module has concrete stored implementation evidence." });
    for (const mode of ["compact", "full", "brief"] as const) {
      const out = await understand(db, { query: "zzmissingzz", mode });
      expect(out.meta!.reason).toBe("no_match");
      expect(out.next!.record).toBe(`${EMPTY_REASON_RECORD.no_match} ${RECORD_FACT}`);
    }
    addNode(db, "expired", { name: "Expiredmark", summary: "Expiredmark describes a previously measured configuration.", valid_until: "2000-01-01" });
    const filtered = await understand(db, { query: "Expiredmark" });
    expect(filtered.meta!.stale_excluded).toBe(1);
    expect(filtered.meta!.reason).toBe("no_match");
  });

  it("keeps budget as the reason when no matching card fits", async () => {
    seedBudget();
    let minimum = 0;
    try {
      await understand(db, { query: "Budget", max_tokens: 1 });
    } catch (error) {
      expect(String(error)).toMatch(/минимума \d+/);
      minimum = Number(String(error).match(/минимума (\d+)/)?.[1]);
    }
    expect(minimum).toBeGreaterThan(0);
    const out = await understand(db, { query: "Budget", max_tokens: minimum + 20 });
    expect(out.compact).toEqual([]);
    expect(out.meta!.reason).toBe("budget");
    expect(out.meta!.truncated).toBe(true);
    expect(out.next!.record).toBe(`${EMPTY_REASON_RECORD.budget} ${RECORD_FACT}`);
    expect(out.meta!.tokens_estimated).toBeLessThanOrEqual(minimum + 20);
    expect(out.meta!.tokens_estimated).toBe(measureMcpPayload(out));
  });

  it("clears the reason when the same fixture fits at max_tokens=1500", async () => {
    seedBudget();
    const out = await understand(db, { query: "Budget", max_tokens: 1500 });
    expect(out.compact!.length).toBeGreaterThan(0);
    expect(out.meta).not.toHaveProperty("reason");
    expect(out.next!.record).toBe(RECORD_FACT);
    expect(out.meta!.tokens_estimated).toBe(measureMcpPayload(out));
  });

  it("invalidates the cached empty base after the first write and after deletion", async () => {
    expect((await understand(db, { query: "zzmissingzz" })).meta!.reason).toBe("empty_base");
    const created = await createConcept(db, {
      name: "First stored result", kind: "feature",
      summary: "First stored result verifies a concrete implementation detail and makes the database nonempty.",
    });
    expect(created.id).toBeTruthy();
    logger.log({ tool: "create_concept", params: {}, result_summary: "created", is_write: true, is_error: false, affected_ids: [created.id!] });
    const countReads = vi.spyOn(db, "execSqlAll");
    expect((await understand(db, { query: "zzmissingzz" })).meta!.reason).toBe("no_match");
    expect((await understand(db, { query: "zzmissingzz" })).meta!.reason).toBe("no_match");
    expect(countReads.mock.calls.filter(([sql]) => sql.includes("COUNT(*) AS count FROM nodes"))).toHaveLength(1);
    db.softDeleteNode(created.id!, "fixture removed");
    logger.log({ tool: "remove_concept", params: {}, result_summary: "removed", is_write: true, is_error: false, affected_ids: [created.id!] });
    expect((await understand(db, { query: "zzmissingzz" })).meta!.reason).toBe("empty_base");
    expect(countReads.mock.calls.filter(([sql]) => sql.includes("COUNT(*) AS count FROM nodes"))).toHaveLength(2);
  });

  it("rechecks cached presence after a write from another connection", async () => {
    expect((await understand(db, { query: "zzmissingzz" })).meta!.reason).toBe("empty_base");
    const other = fixture.db("knowledge.db");
    addNode(other, "external", { summary: "External connection writes a concrete stored analysis result." });
    expect((await understand(db, { query: "zzmissingzz" })).meta!.reason).toBe("no_match");
    other.softDeleteNode("external", "removed externally");
    expect((await understand(db, { query: "zzmissingzz" })).meta!.reason).toBe("empty_base");
  });

  it("does not call already-served task content a budget exclusion", async () => {
    seedBudget();
    const input = { query: "Budget", max_tokens: 20000, task: { kind: "find_definition" as const, goal: "Locate the stored fixture", context_epoch: "repeat-epoch" } };
    expect((await understand(db, input)).compact!.length).toBeGreaterThan(0);
    const repeat = await understand(db, input);
    expect(repeat.compact).toEqual([]);
    expect(repeat.task_context!.served_earlier.length).toBeGreaterThan(0);
    expect(repeat.meta).not.toHaveProperty("reason");
    expect(repeat.next!.record).toBe(RECORD_FACT);
    expect(repeat.meta!.tokens_estimated).toBe(measureMcpPayload(repeat));
  });

  it("suppresses the unrecorded reminder on an empty base even above threshold", async () => {
    for (let i = 0; i <= UNRECORDED_READS_THRESHOLD; i++) {
      logger.log({ tool: "understand", params: {}, result_summary: "empty", is_write: false, is_error: false, affected_ids: [] });
    }
    const out = await understand(db, { query: "nothing" });
    expect(out.meta!.reason).toBe("empty_base");
    expect(out.next!.record).not.toContain("С последней записи");
    expect(out.next).not.toHaveProperty("unrecorded");
    expect(out.next!.record).toBe(`${EMPTY_REASON_RECORD.empty_base} ${RECORD_FACT}`);
  });
});
