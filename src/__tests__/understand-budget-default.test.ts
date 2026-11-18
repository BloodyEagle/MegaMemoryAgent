import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { EMPTY_REASON_RECORD, RECORD_FACT } from "../next-hints.js";
import * as search from "../search.js";
import { understand } from "../tools.js";
import type { UnderstandOutput } from "../types.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

const WRAPPER = {
  instructions_stale: false,
  instructions_version: "understand-recall-fixture",
  server_version: "2.7.0",
};
let fixture: AuditFixture;
let db: KnowledgeDB;

// Independent oracle: pretty JSON is itself escaped inside the MCP text envelope.
function wireTokens(payload: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  }), "utf8") / 3);
}

function expectWireCap(out: UnderstandOutput, cap: number): void {
  const measured = wireTokens({ ...out, ...WRAPPER });
  expect(out.meta?.tokens_estimated).toBe(measured);
  expect(measured).toBeLessThanOrEqual(cap);
}

function rank(ids: string[]): void {
  vi.spyOn(search, "hybridSearch").mockImplementation(async (_db, _query, options) =>
    ids.slice(0, options?.topK ?? ids.length).map((id, index) => ({
      id, score: 1 / (61 + index), via: "fts" as const,
    })));
}

function simpleFixture(): string[] {
  const names = ["Recall", "Ranking", "Wire budget", "Candidate list", "Anchor folding", "Qualified cards"];
  const ids = names.map((_name, index) => `recall-${index + 1}`);
  names.forEach((name, index) => addNode(db, ids[index], {
    name, kind: "module",
    summary: `${name} keeps the retrieval response useful without exceeding the measured envelope.`,
  }));
  rank(ids);
  return ids;
}

function heavyFixture(): string[] {
  const ids = Array.from({ length: 20 }, (_value, index) => `gar-rule-${String(index + 1).padStart(2, "0")}`);
  ids.forEach((id, index) => {
    addNode(db, id, {
      name: `ГАР: правила нормализации адреса и выбора региона ${index + 1}`,
      summary: "Нормализация адреса сохраняет исходный идентификатор записи ГАР, проверяет регион и муниципальное образование перед выбором адресного объекта. Неоднозначные совпадения требуют чтения правил приоритета, а не выбора первого результата поиска.",
      file_refs: [
        `src/address/normalization/region-${index + 1}.ts:120-185`,
        `src/address/normalization/municipality-${index + 1}.ts:41-98`,
        `src/__tests__/address-normalization-${index + 1}.test.ts:25-79`,
      ],
    });
    for (let child = 1; child <= 2; child++) {
      const childId = `${id}/case-${child}`;
      addNode(db, childId, {
        parent_id: id,
        name: `Проверка неоднозначного адресного объекта ${child}`,
        summary: "Регион и уровень адреса проверяются до сохранения нормализованного результата.",
      });
      db.insertEdge({ from_id: id, to_id: childId, relation: "depends_on" });
    }
  });
  rank(ids);
  return ids;
}

beforeEach(() => {
  vi.stubEnv("MEGAMEMORY_SEARCH", "hybrid");
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  ensureSchema(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.close();
});

describe("D: understand default and explicit wire budgets", () => {
  it("defaults to 4000: all six simple candidates and three cards remain visible", async () => {
    const ids = simpleFixture();
    const out = await understand(db, { query: "retrieval", extra_payload: WRAPPER });

    expect(out.candidates?.map(candidate => candidate.id)).toEqual(ids);
    expect(out.compact?.map(card => card.id)).toEqual(ids.slice(0, 3));
    expect(out.meta).toMatchObject({ returned: 6, dropped: 0, cards: 3 });
    expect(out.meta).not.toHaveProperty("reason");
    expect(out.brief).toBeUndefined();
    expectWireCap(out, 4000);

    const explicit = await understand(db, { query: "retrieval", max_tokens: 4000, extra_payload: WRAPPER });
    expect(explicit).toEqual(out);
  });

  it("an explicit 1500 shrinks the heavy candidate list and reports wholly hidden matches", async () => {
    heavyFixture();
    const generous = await understand(db, { query: "правила адреса", max_tokens: 20000, extra_payload: WRAPPER });
    const narrow = await understand(db, { query: "правила адреса", max_tokens: 1500, extra_payload: WRAPPER });

    expect(generous.candidates).toHaveLength(20);
    expect(narrow.candidates!.length).toBeLessThan(generous.candidates!.length);
    expect(narrow.meta!.dropped).toBeGreaterThan(0);
    expect(narrow.meta!.returned).toBe(narrow.candidates!.length);
    expect(narrow.meta!.cards).toBe(narrow.compact!.length);
    expect(narrow.compact!.length).toBeLessThanOrEqual(3);
    expectWireCap(generous, 20000);
    expectWireCap(narrow, 1500);
  });

  it("600 cannot fit a realistic heavy card: reason and record say budget, not no_match", async () => {
    heavyFixture();
    const out = await understand(db, { query: "правила адреса", max_tokens: 600 });

    expect(out.compact).toEqual([]);
    expect(out.meta).toMatchObject({ cards: 0, reason: "budget", truncated: true });
    expect(out.meta!.dropped).toBeGreaterThan(0);
    expect(out.next!.record).toBe(`${EMPTY_REASON_RECORD.budget} ${RECORD_FACT}`);
    expect(out.meta!.tokens_estimated).toBe(wireTokens(out));
    expect(wireTokens(out)).toBeLessThanOrEqual(600);
  });
});
