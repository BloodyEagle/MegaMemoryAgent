import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { createConcept, measureMcpPayload, understand } from "../tools.js";
import { EMPTY_REASON_RECORD, RECORD_FACT, SEARCH_WARNING, UNRECORDED_READS_THRESHOLD } from "../next-hints.js";
import { MODEL_NAME, vectorChannelState } from "../embeddings.js";
import { reembed } from "../reembed.js";
import { BRIEF_EMPTY_TEXT } from "../brief.js";
import type { BriefOutput } from "../types.js";
import { createTimelineLogger, type TimelineLogger } from "../timeline.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

// Only inference is replaced: the vector channel state stays real, so the
// "channel on" cases below run the production state checks.
vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embed: vi.fn(async () => {
      const buffer = Buffer.alloc(8);
      buffer.writeFloatLE(1, 0);
      return buffer;
    }),
  };
});

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
  // D: минимальная сжатая карточка одного дешёвого узла помещается в любой
  // успешный бюджет, поэтому сценарий «ни одна карточка не влезла» требует
  // тяжёлого пула. Причины пустоты и форма record не менялись.
  for (let index = 1; index <= 20; index += 1) {
    addNode(db, `budget-heavy-${String(index).padStart(2, "0")}`, {
      name: `Budget: правило нормализации адреса и проверки региона ${index}`,
      summary: "Правило бюджета сохраняет исходный идентификатор записи, проверяет регион и муниципальное образование перед выбором адресного объекта, а неоднозначные совпадения требует читать в исходной реализации и тесте.".repeat(3),
      file_refs: [`src/budget/rule-${index}.ts:120-185`, `src/budget/region-${index}.ts:41-98`],
    });
  }
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
    // Порог бюджета поднят до нового дефолта: успешный ответ с reason=budget
    // живёт в окне «конверт с кандидатами влезает, карточки — нет».
    const out = await understand(db, { query: "Budget", max_tokens: 600 });
    expect(out.compact).toEqual([]);
    expect(out.meta!.reason).toBe("budget");
    expect(out.meta!.truncated).toBe(true);
    expect(out.next!.record).toBe(`${EMPTY_REASON_RECORD.budget} ${RECORD_FACT}`);
    expect(out.meta!.tokens_estimated).toBeLessThanOrEqual(600);
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

describe("understand search_warning (plan 33 A3)", () => {
  const MISS = "zzmissingzz";
  const vector = () => {
    const buffer = Buffer.alloc(8);
    buffer.writeFloatLE(1, 0);
    return buffer;
  };
  const embedFn = async () => vector();
  function seedMiss(): void {
    addNode(db, "stored", { name: "Existing module", summary: "Existing module has concrete stored implementation evidence." });
  }

  it.each([
    ["no model stamp", (target: KnowledgeDB) => { target.execSqlRun("DELETE FROM meta WHERE key='embed_model'"); }],
    ["a stamp without a generation", (target: KnowledgeDB) => { target.setMetaValue("embed_model", MODEL_NAME); }],
  ])("a miss with %s names the keyword-only search in every mode", async (_name, prepare) => {
    vi.unstubAllEnvs();
    prepare(db);
    seedMiss();
    expect(vectorChannelState(db)).toEqual({ state: "off", reason: "no_generation" });
    for (const mode of ["compact", "full", "brief"] as const) {
      const out = await understand(db, { query: MISS, mode });
      expect(out.meta!.reason).toBe("no_match");
      expect(out.next!.search_warning).toBe(SEARCH_WARNING.no_generation);
      expect(out.meta!.tokens_estimated).toBe(measureMcpPayload(out));
    }
  });

  it("brief renders the warning as its own line under the empty answer", async () => {
    vi.unstubAllEnvs();
    db.setMetaValue("embed_model", MODEL_NAME);
    seedMiss();
    const out = (await understand(db, { query: MISS, mode: "brief" })) as unknown as BriefOutput;
    expect(out.brief).toBe(`${BRIEF_EMPTY_TEXT}\n${SEARCH_WARNING.no_generation}`);
  });

  it("a generation without vectors gives the same advice", async () => {
    vi.unstubAllEnvs();
    db.setMetaValue("embed_model", MODEL_NAME);
    await reembed(db, { embedFn });
    seedMiss();
    expect(vectorChannelState(db)).toEqual({ state: "off", reason: "generation_without_vectors" });
    const out = await understand(db, { query: MISS });
    expect(out.meta!.reason).toBe("no_match");
    expect(out.next!.search_warning).toBe(SEARCH_WARNING.generation_without_vectors);
  });

  it("another recorded model names the mismatch", async () => {
    vi.unstubAllEnvs();
    seedMiss();
    const out = await understand(db, { query: MISS });
    expect(out.next!.search_warning).toBe(SEARCH_WARNING.model_mismatch);
  });

  it("text-only mode names its switch", async () => {
    seedMiss();
    const out = await understand(db, { query: MISS });
    expect(out.next!.search_warning).toBe(SEARCH_WARNING.text_only_mode);
  });

  it("keeps the miss without the warning when the semantic channel is on", async () => {
    vi.unstubAllEnvs();
    db.setMetaValue("embed_model", MODEL_NAME);
    addNode(db, "gone", { summary: "Gone node carried the only vector of the base before removal." });
    await reembed(db, { embedFn });
    db.softDeleteNode("gone", "fixture removed");
    seedMiss();
    expect(vectorChannelState(db)).toEqual({ state: "on" });
    for (const mode of ["compact", "full", "brief"] as const) {
      const out = await understand(db, { query: MISS, mode });
      expect(out.meta!.reason).toBe("no_match");
      expect(out.next).not.toHaveProperty("search_warning");
    }
  });

  it("an answered search carries no warning", async () => {
    seedMiss();
    const out = await understand(db, { query: "Existing module" });
    expect(out.meta).not.toHaveProperty("reason");
    expect(out.next).not.toHaveProperty("search_warning");
  });
});
