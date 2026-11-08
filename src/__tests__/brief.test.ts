import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { estimateTokens, link, understand } from "../tools.js";
import {
  BASELINE_FORMAT_VERSION,
  claimDigestOf,
  edgeDigestOf,
  statusDigestOf,
} from "../support-baselines.js";
import { BRIEF_EMPTY_TEXT } from "../brief.js";
import type { BriefOutput, UnderstandInput } from "../types.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// План 13 §2.2: режим brief в understand — до 8 строк текста плюс блок next,
// БЕЗ карточек. compact остаётся режимом по умолчанию; brief включается только
// явным mode: "brief". Логика текста живёт в src/brief.ts, ветка режима — в
// understand (tools.ts), блок next — buildNextHints группы A как есть.

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  // FTS-режим: детерминированный ранжинг без векторной модели.
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-understand-brief-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
  db.setMetaValue("embed_model", "understand-brief-disabled-vector-space");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (db) await closeAndCleanup(db, tmpDir);
});

// ---- Фикстуры ----

/**
 * 10 узлов (2 решения, 6 фактов, 2 модуля), все с маркером «слияние» —
 * запрос «слияние» матчит весь десяток. У brief-dec-2 устаревший снимок
 * подтверждения (follow-up check_artifacts); у части фактов целый файл
 * с честным покрытием (skip).
 */
function seedTen(): void {
  db.insertNode({
    id: "brief-dec-1", name: "brief-dec-1", kind: "decision", created_via: "agent",
    summary: "Слияние: перенос задач и слотов между базами пишет журнал слияния",
    file_refs: ["src/merge.ts:120-180"],
  });
  db.insertNode({
    id: "brief-dec-2", name: "brief-dec-2", kind: "decision", created_via: "agent",
    summary: "Слияние: журнал слияния хранит ключи рёбер и пишет строки пачками",
    file_refs: ["src/merge.ts:200-240"],
  });
  const facts: Array<[string, string, string[] | null]> = [
    ["brief-fact-1", "Слияние: пул соединений возвращает строки и кэширует дайджесты узлов схемы", ["src/db.ts"]],
    ["brief-fact-2", "Слияние: схема базы хранит слоты работ и читает их пачками без задержек", ["src/db.ts"]],
    ["brief-fact-3", "Слияние: журнал пишет строки пачками и переживает перезапуск процесса", ["src/journal.ts:10-40"]],
    ["brief-fact-4", "Слияние: ключи рёбер собираются из концов связи и времени создания", ["src/keys.ts"]],
    ["brief-fact-5", "Слияние: слоты задач освобождаются после записи журнала в базу", ["src/slots.ts"]],
    ["brief-fact-6", "Слияние: дайджесты узлов считаются от формулировки и статуса записи", ["src/digests.ts:5-25"]],
  ];
  for (const [id, summary, refs] of facts) {
    db.insertNode({ id, name: id, kind: "fact", created_via: "agent", summary, file_refs: refs });
  }
  db.insertNode({
    id: "brief-mod-1", name: "brief-mod-1", kind: "module", created_via: "agent",
    summary: "Слияние: модуль миграции поднимает схему базы и заполняет слоты заново",
    file_refs: ["src/migrate.ts:1-60"],
  });
  db.insertNode({
    id: "brief-mod-2", name: "brief-mod-2", kind: "module", created_via: "agent",
    summary: "Слияние: модуль проверки сверяет журналы двух баз перед обменом данными",
    file_refs: null,
  });
  db.upsertSupportBaseline({
    decision_id: "brief-dec-2",
    support_id: "none",
    edge_key: "1",
    claim_digest: claimDigestOf("x"),
    status_digest: statusDigestOf("active", "open"),
    edge_digest: edgeDigestOf("x"),
    format_version: BASELINE_FORMAT_VERSION,
    confirmed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    confirmed_by: "test",
    superseded_at: null,
    artifacts_digest: null,
  });
}

/** Решение с устаревшим снимком + факт с целым файлом + refuted-узел. */
function seedBudget(): void {
  db.insertNode({
    id: "budget-decision", name: "budget-decision", kind: "decision", created_via: "agent",
    summary: "Бюджет ответа считает байты и блокирует перерасход wire-формы",
    file_refs: ["src/tools.ts:600-700"],
  });
  db.insertNode({
    id: "wire-fact", name: "wire-fact", kind: "fact", created_via: "agent",
    summary: "Wire-форма ответа хранит секции meta и возвращает счётчики",
    file_refs: ["src/tools.ts:710-760", "src/index.ts:100-140", "src/search.ts:20-40", "src/db.ts"],
  });
  db.insertNode({
    id: "refuted-claim", name: "refuted-claim", kind: "feature", created_via: "agent",
    summary: "Кэширует все ответы без разбора",
    file_refs: ["src/cache.ts"],
  });
  db.setEpistemicStatus("refuted-claim", "refuted", "Измерение показало обратное: кэш не даёт выигрыша", null);
  link(db, { from: "budget-decision", to: "wire-fact", relation: "informed_by", description: "wire-форма подтверждает бюджет" });
  const edge = db.getInformedByEdges("budget-decision", "ancestry", false)[0];
  db.upsertSupportBaseline({
    decision_id: "budget-decision",
    support_id: "wire-fact",
    edge_key: String(edge.id),
    claim_digest: claimDigestOf("Бюджет ответа считает байты и блокирует перерасход wire-формы"),
    status_digest: statusDigestOf("active", "open"),
    edge_digest: edgeDigestOf("wire-форма подтверждает бюджет"),
    format_version: BASELINE_FORMAT_VERSION,
    confirmed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    confirmed_by: "test",
    superseded_at: null,
    artifacts_digest: null,
  });
}

// ---- Помощники ----

type BriefResult = BriefOutput & { matches: unknown[] };

const briefMode = (input: UnderstandInput) => ({ ...input, mode: "brief" as const });

/** Честная мера wire-формы: та же, что у MCP-обработчика (K-03). */
function wireTokensOf(payload: unknown): number {
  return estimateTokens(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] })
  );
}

/** Ключевые пары (имя, главный file_ref) фикстуры seedTen. */
const KEY_PAIRS: Array<[string, string | null]> = [
  ["brief-dec-1", "src/merge.ts:120-180"],
  ["brief-dec-2", "src/merge.ts:200-240"],
  ["brief-fact-1", "src/db.ts"],
  ["brief-fact-3", "src/journal.ts:10-40"],
  ["brief-fact-4", "src/keys.ts"],
  ["brief-fact-5", "src/slots.ts"],
  ["brief-fact-6", "src/digests.ts:5-25"],
  ["brief-mod-1", "src/migrate.ts:1-60"],
  ["brief-mod-2", null],
];

describe("План 13 §2.2: режим brief в understand", () => {
  it("brief укладывается в 8 строк на фикстуре с 10 узлами", async () => {
    seedTen();
    const out = (await understand(
      db,
      briefMode({ query: "слияние", top_k: 10, max_tokens: 3000 })
    )) as unknown as BriefResult;
    const lines = out.brief.split("\n");
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(out.meta.returned).toBe(10);
    expect(out.meta.truncated).toBe(false);
    // (1) Сколько чего нашлось по видам: 6 фактов, 2 решения, 2 модуля.
    expect(lines[0]).toBe("Найдено: 6 фактов, 2 решения, 2 модуля.");
    // (2) Ключевой узел — имя + главный file_ref (первый по рангу).
    expect(
      KEY_PAIRS.some(([name, ref]) =>
        ref === null
          ? out.brief.includes(`Ключевое: ${name}.`)
          : out.brief.includes(`Ключевое: ${name} (${ref})`)
      )
    ).toBe(true);
    // (3) «Не читай X целиком — покрыто» из next.skip.
    expect(out.next.skip.length).toBeGreaterThanOrEqual(1);
    expect(out.brief).toContain("Не читай ");
    // (4) Следующий шаг из next.followups: устаревший снимок brief-dec-2.
    expect(out.next.followups[0]?.tool).toBe("check_artifacts");
    expect(out.brief).toContain("Дальше: check_artifacts для узла brief-dec-2");
    // (5) Последняя строка текста — строка next.record.
    expect(lines[lines.length - 1]).toBe(out.next.record);
  });

  it("в выводе нет карточек (matches пуст, compact отсутствует), next на месте", async () => {
    seedTen();
    const out = (await understand(
      db,
      briefMode({ query: "слияние", top_k: 10, max_tokens: 3000 })
    )) as unknown as BriefResult;
    const raw = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["matches", "brief", "next", "meta"]);
    expect(raw.matches).toEqual([]);
    expect("compact" in raw).toBe(false);
    expect(typeof raw.brief).toBe("string");
    expect((raw.brief as string).length).toBeGreaterThan(0);
    const next = raw.next as Record<string, unknown>;
    expect(Object.keys(next)).toEqual(["must_read", "skip", "followups", "record"]);
    expect(typeof next.record).toBe("string");
    expect((next.record as string).length).toBeGreaterThan(0);
  });

  it("текст содержит имя ключевого узла и его file_ref", async () => {
    seedTen();
    // Узкий запрос: матчит только brief-dec-1 — ранг первого узла детерминирован.
    const out = (await understand(
      db,
      briefMode({ query: "перенос задач и слотов", top_k: 5, max_tokens: 1500 })
    )) as unknown as BriefResult;
    expect(out.meta.returned).toBe(1);
    expect(out.brief).toContain("Ключевое: brief-dec-1 (src/merge.ts:120-180)");
    // Линия «Дальше» появляется только при follow-ups: у решения без опор и
    // без снимка support_check не «unknown», поэтому здесь followups пуст.
    expect(out.next.followups).toEqual([]);
    expect(out.brief).not.toContain("Дальше:");
    expect(out.brief.split("\n").length).toBeLessThanOrEqual(8);
    // Последняя строка текста — строка next.record.
    const lines = out.brief.split("\n");
    expect(lines[lines.length - 1]).toBe(out.next.record);
  });

  it("бюджет: малый max_tokens режет next (skip → followups), must_read и record живы, мера сходится байт-в-байт", async () => {
    seedBudget();
    const extra = { instructions_stale: false, server_version: "2.3.0-brief-test" };

    // Щедрый бюджет показывает, что skip и followup в этой базе есть вообще.
    const generous = (await understand(
      db,
      briefMode({ query: "ответа wire", top_k: 5, max_tokens: 2500, extra_payload: extra })
    )) as unknown as BriefResult;
    expect(generous.next.skip.map((s) => s.ref)).toEqual(["src/db.ts"]);
    expect(generous.next.followups.map((f) => f.tool)).toEqual(["check_artifacts"]);
    expect(generous.next.must_read.length).toBeGreaterThanOrEqual(1);
    expect(generous.meta.truncated).toBe(false);
    expect(generous.meta.tokens_estimated).toBe(wireTokensOf({ ...generous, ...extra }));

    // Малый бюджет: сначала режется skip, затем followups; must_read и
    // record не режутся никогда; текст брифа не режется (ограничен 8 строками
    // по построению); усечение помечается в meta.
    const tight = (await understand(
      db,
      briefMode({ query: "ответа wire", top_k: 5, max_tokens: 400, extra_payload: extra })
    )) as unknown as BriefResult;
    expect(tight.next.skip).toEqual([]);
    expect(tight.next.followups).toEqual([]);
    expect(tight.next.must_read.length).toBeGreaterThanOrEqual(1);
    expect(tight.next.record.length).toBeGreaterThan(0);
    expect(tight.brief.split("\n").length).toBeLessThanOrEqual(8);
    expect(tight.meta.truncated).toBe(true);
    // Мера считается по той же wire-форме, что уходит по проводу (K-03),
    // включая extra_payload обработчика, — байт-в-байт.
    expect(tight.meta.tokens_estimated).toBe(wireTokensOf({ ...tight, ...extra }));
  });

  it("дефолтный режим не изменился: без mode ответ — compact-форма с next", async () => {
    seedBudget();
    const out = await understand(db, { query: "ответа wire", top_k: 5, max_tokens: 2500 });
    expect(Object.keys(out)).toEqual([
      "matches",
      "compact",
      "refuted",
      "edges_between",
      "meta",
      "next",
    ]);
    expect("brief" in out).toBe(false);
    expect(out.matches).toEqual([]);
    expect(out.compact).toHaveLength(1);
    expect(out.compact![0].id).toBe("budget-decision");
    expect(typeof out.compact![0].summary).toBe("string");
    expect(out.meta!.returned).toBe(1);
    expect(out.next!.record).toContain("запиши решение");
    // Мера compact-формы по-прежнему сходится с wire-формой (K-03).
    expect(out.meta!.tokens_estimated).toBe(wireTokensOf(out));
  });

  it("пустой ответ: строка «по запросу ничего не нашлось» + next с пустыми списками и record", async () => {
    // База пуста — ответ 0 узлов.
    const out = (await understand(
      db,
      briefMode({ query: "совершенно посторонний запрос", top_k: 5, max_tokens: 600 })
    )) as unknown as BriefResult;
    const raw = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["matches", "brief", "next", "meta"]);
    expect(raw.matches).toEqual([]);
    expect(out.brief).toBe(BRIEF_EMPTY_TEXT);
    expect(out.brief).toContain("ничего не нашлось");
    expect(out.meta.returned).toBe(0);
    expect(out.meta.tokens_estimated).toBeGreaterThan(0);
    expect(out.next.must_read).toEqual([]);
    expect(out.next.skip).toEqual([]);
    expect(out.next.followups).toEqual([]);
    expect(out.next.record).toContain("create_concept kind=fact");
  });
});
