import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { renderDroppedText } from "../brief.js";
import { ensureSchema } from "../migrate-schema.js";
import * as search from "../search.js";
import { understand } from "../tools.js";
import type { UnderstandOutput } from "../types.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
let db: KnowledgeDB;

function wireTokens(payload: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  }), "utf8") / 3);
}

function fixedWireTokens(payload: Record<string, unknown>): number {
  let tokens = 0;
  for (;;) {
    const meta = payload.meta as Record<string, unknown>;
    const measured = wireTokens({ ...payload, meta: { ...meta, tokens_estimated: tokens } });
    if (tokens === measured) return tokens;
    tokens = measured;
  }
}

function visibleIds(out: UnderstandOutput): Set<string> {
  return new Set([
    ...(out.candidates ?? []).map(candidate => candidate.id),
    ...(out.compact ?? []).flatMap(card => [card.id, ...(card.supports ?? []).map(support => support.id)]),
    ...(out.anchors ?? []).map(anchor => anchor.id),
    ...(out.refuted ?? []).map(card => card.id),
  ]);
}

function rank(ids: string[]): void {
  vi.spyOn(search, "hybridSearch").mockImplementation(async (_db, _query, options) =>
    ids.slice(0, options?.topK ?? ids.length).map((id, index) => ({
      id, score: 1 / (61 + index), via: "fts" as const,
    })));
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

describe("D: renderDroppedText uses wholly hidden matches", () => {
  it.each([
    { returned: 6, dropped: 14 },
    { returned: 0, dropped: 20 },
    { returned: 1, dropped: 1 },
  ])("renders the exact notice for returned=$returned dropped=$dropped", meta => {
    expect(renderDroppedText(meta)).toBe(`Показано ${meta.returned} совпадений из ${meta.returned + meta.dropped} (${meta.dropped} скрыто бюджетом) — уточни запрос или подними max_tokens.`);
  });

  it.each([0, 1, 6, 20])("has no text when dropped=0, even with %s visible candidates", returned => {
    expect(renderDroppedText({ returned, dropped: 0 })).toBeUndefined();
  });

  it("six visible candidates and three cards are not a budget loss", async () => {
    const ids = Array.from({ length: 6 }, (_value, index) => `visible-${index}`);
    ids.forEach(id => addNode(db, id, { name: id, summary: "Address normalization verifies the regional identifier." }));
    rank(ids);
    const out = await understand(db, { query: "address", max_tokens: 8000 });

    expect(out.candidates).toHaveLength(6);
    expect(out.compact).toHaveLength(3);
    expect(out.meta).toMatchObject({ returned: 6, cards: 3, dropped: 0 });
    expect(ids.filter(id => !out.compact!.some(card => card.id === id))).toHaveLength(3);
    expect(out.brief).toBeUndefined();
    expect(renderDroppedText(out.meta!)).toBeUndefined();
  });

  it("reports only ids invisible in every section on a realistic tight-budget pool", async () => {
    const ids = Array.from({ length: 20 }, (_value, index) => `address-rule-${index}`);
    ids.forEach((id, index) => {
      addNode(db, id, {
        name: `Правило адресной нормализации муниципального образования ${index + 1}`,
        summary: "Правило нормализации адреса сохраняет идентификатор ГАР, проверяет регион и муниципальное образование, а при неоднозначном совпадении требует чтения исходной реализации и теста.",
        file_refs: [`src/address/municipality-${index}.ts:45-110`],
      });
      addNode(db, `${id}/case`, { name: "Проверка неоднозначного адреса", parent_id: id });
    });
    rank(ids);
    const out = await understand(db, { query: "address", max_tokens: 1500 });
    const invisible = ids.filter(id => !visibleIds(out).has(id));

    expect(invisible.length).toBeGreaterThan(0);
    expect(out.meta!.dropped).toBe(invisible.length);
    expect(out.meta!.returned).toBe(out.candidates!.length);
    expect(out.brief).toBe(renderDroppedText(out.meta!));
    expect(out.brief).toBe(`Показано ${out.meta!.returned} совпадений из ${out.meta!.returned + invisible.length} (${invisible.length} скрыто бюджетом) — уточни запрос или подними max_tokens.`);
    expect(out.meta!.tokens_estimated).toBe(wireTokens(out));
    expect(wireTokens(out)).toBeLessThanOrEqual(1500);
  });

  it("shortens optional card text before losing the notice, exact qualification, or first card", async () => {
    const ids = Array.from({ length: 6 }, (_value, index) => `notice-${index}`);
    const ref = "src/address/normalize.ts:20-45";
    ids.forEach((id, index) => addNode(db, id, {
      name: `Правило нормализации адреса и проверки региона ${index + 1}`,
      summary: "Правило сохраняет исходный идентификатор адресного объекта, проверяет регион и муниципальное образование до выбора результата. Неоднозначные совпадения требуют проверки исходного правила; случайный порядок поиска не доказывает приоритет региона.",
      ...(index === 0 ? { file_refs: [ref] } : {}),
    }));
    rank(ids);
    const generous = await understand(db, { query: "address", max_tokens: 20000 });
    const first = generous.compact![0];
    const meta = { ...generous.meta!, returned: 0, cards: 1, dropped: 5, truncated: true, tokens_estimated: 0 };
    const witness = {
      ...generous,
      candidates: [], compact: [{ ...first, summary: "" }], edges_between: [],
      meta, brief: renderDroppedText(meta), next: { ...generous.next!, followups: [] },
    };
    const cap = fixedWireTokens(witness) + 12;
    expect(wireTokens(generous)).toBeGreaterThan(cap);
    const out = await understand(db, { query: "address", max_tokens: cap });

    expect(out.compact![0]?.id).toBe(first.id);
    expect(first.summary).toBeDefined();
    if (out.compact![0].summary !== undefined) {
      expect(out.compact![0].summary.length).toBeLessThan(first.summary!.length);
      expect(first.summary!.startsWith(out.compact![0].summary.replace(/…$/, ""))).toBe(true);
    } else {
      expect(out.compact![0]).not.toHaveProperty("summary");
    }
    expect(out.compact![0]).toMatchObject({
      id: first.id, kind: first.kind, status: first.status,
      epistemic_status: first.epistemic_status, status_scope: first.status_scope,
      valid_until: first.valid_until, file_refs: [ref],
    });
    expect(out.next!.must_read).toContainEqual(expect.objectContaining({ ref }));
    expect(out.next!.record).toBeTruthy();
    expect(out.meta!.dropped).toBeGreaterThan(0);
    expect(out.brief).toBe(renderDroppedText(out.meta!));
    expect(out.meta).not.toHaveProperty("reason");
    expect(out.meta!.tokens_estimated).toBe(wireTokens(out));
    expect(wireTokens(out)).toBeLessThanOrEqual(cap);
  });

  it("does not add a dropped-budget notice to the legacy full form", async () => {
    const ids = Array.from({ length: 6 }, (_value, index) => `full-${index}`);
    ids.forEach(id => addNode(db, id));
    rank(ids);
    const out = await understand(db, { query: "address", mode: "full", top_k: 2, max_tokens: 20000 });

    expect(out.matches).toHaveLength(2);
    expect(out.meta!.dropped).toBe(4);
    expect(out.brief).toBeUndefined();
    expect(out.candidates).toBeUndefined();
  });
});
