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
  confirmSupports,
  edgeDigestOf,
  statusDigestOf,
} from "../support-baselines.js";
import { buildNextHints } from "../next-hints.js";
import type { UnderstandOutput } from "../types.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// План 13 §2.1: блок next в ответе understand — машинно-исполнимый контракт
// действия (must_read/skip/followups/record). Логика живёт в src/next-hints.ts;
// здесь проверяются контракт, честность покрытия, приоритеты follow-ups,
// бюджетная обрезка и обратная совместимость формы ответа.

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  // FTS-режим: детерминированный ранжинг без векторной модели.
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-understand-next-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
  db.setMetaValue("embed_model", "understand-next-disabled-vector-space");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (db) await closeAndCleanup(db, tmpDir);
});

// ---- Фикстуры (детерминированные, совпадают с базовой линией совместимости) ----

function seedMerge(): void {
  db.insertNode({
    id: "merge-plan", name: "merge-plan", kind: "decision", created_via: "agent",
    summary: "Перенос задач и слотов между базами пишет журнал слияния",
    file_refs: ["src/merge.ts:120-180"],
  });
  db.insertNode({
    id: "merge-log", name: "merge-log", kind: "fact", created_via: "agent",
    summary: "Журнал слияния хранит ключи рёбер и пишет строки пачками",
    file_refs: ["src/merge.ts:200-240"],
  });
  db.insertNode({
    id: "db-pool", name: "db-pool", kind: "fact", created_via: "agent",
    summary: "Пул соединений возвращает строки и кэширует дайджесты узлов",
    file_refs: ["src/db.ts"],
  });
  db.insertNode({
    id: "schema-slots", name: "schema-slots", kind: "fact", created_via: "agent",
    summary: "Схема базы хранит слоты задач и читает их пачками",
    file_refs: ["src/db.ts"],
  });
  db.insertNode({
    id: "stub-anchor", name: "stub-anchor", kind: "fact", created_via: "agent",
    summary: "file-fact node for src/stub.ts",
    file_refs: ["src/stub.ts"],
  });
  db.insertNode({
    id: "short-note", name: "short-note", kind: "fact", created_via: "agent",
    summary: "заметка о модуле",
    file_refs: ["src/notes.ts"],
  });
  link(db, { from: "merge-plan", to: "merge-log", relation: "informed_by", description: "журнал подтверждает перенос" });
  link(db, { from: "merge-plan", to: "db-pool", relation: "informed_by", description: "пул даёт дайджесты" });
  link(db, { from: "merge-plan", to: "schema-slots", relation: "informed_by", description: "схема даёт слоты" });
}

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
    claim_digest: claimDigestOf("Wire-форма ответа хранит секции meta и возвращает счётчики"),
    status_digest: statusDigestOf("active", "open"),
    edge_digest: edgeDigestOf("wire-форма подтверждает бюджет"),
    format_version: BASELINE_FORMAT_VERSION,
    confirmed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    confirmed_by: "test",
    superseded_at: null,
    artifacts_digest: null,
  });
}

function seedEdges(): void {
  db.insertNode({
    id: "alpha", name: "alpha", kind: "module", created_via: "agent",
    summary: "Alpha node описывает модуль сборки и читает конфигурацию",
  });
  db.insertNode({
    id: "beta", name: "beta", kind: "feature", created_via: "agent",
    summary: "Beta node пишет отчёты сборки",
  });
  db.insertEdge({ from_id: "alpha", to_id: "beta", relation: "connects_to" });
}

/** Четверка узлов, у каждого 3 диапазонных ref и 1 целый файл. */
function seedHonesty(): void {
  db.insertNode({
    id: "stub-cov", name: "stub-cov", kind: "fact", created_via: "agent",
    summary: "file-fact node for src/stub-covered.ts: проба D1-mark",
    file_refs: ["src/stub1.ts:1-10", "src/stub1.ts:11-20", "src/stub1.ts:21-30", "src/stub-covered.ts"],
  });
  db.insertNode({
    id: "short-cov", name: "short-cov", kind: "fact", created_via: "agent",
    summary: "заметка о модуле D1-mark",
    file_refs: ["src/short1.ts:1-10", "src/short1.ts:11-20", "src/short1.ts:21-30", "src/short-covered.ts"],
  });
  db.insertNode({
    id: "honest-cov", name: "honest-cov", kind: "fact", created_via: "agent",
    summary: "Хранит пулы соединений D1-mark и пишет журнал миграций",
    file_refs: ["src/honest1.ts:1-10", "src/honest1.ts:11-20", "src/honest1.ts:21-30", "src/honest-covered.ts"],
  });
  db.insertNode({
    id: "weak-cov", name: "weak-cov", kind: "fact", created_via: "agent",
    summary: "Хранит пулы соединений D1-mark и пишет журнал миграций",
    file_refs: ["src/weak1.ts:1-10", "src/weak1.ts:11-20", "src/weak1.ts:21-30", "src/weak-covered.ts"],
  });
  db.setEpistemicStatus("weak-cov", "abandoned", "Подход бросили, узел больше не поддерживаем", null);
}

/** Малая база бюджета: решение с устаревшим снимком + факт. */
function seedSmallBudget(): void {
  db.insertNode({
    id: "b-dec", name: "b-dec", kind: "decision", created_via: "agent",
    summary: "Решение хранит порог слияния и пишет журнал операций",
    file_refs: ["src/bdec.ts:5-15"],
  });
  db.insertNode({
    id: "b-fact", name: "b-fact", kind: "fact", created_via: "agent",
    summary: "Wire-форма ответа хранит секции meta и возвращает счётчики",
    file_refs: ["src/bfact1.ts:1-10", "src/bfact1.ts:11-20", "src/bfact2.ts:1-10", "src/bfact-whole.ts"],
  });
  db.upsertSupportBaseline({
    decision_id: "b-dec",
    support_id: "none",
    edge_key: "1",
    claim_digest: claimDigestOf("x"),
    status_digest: statusDigestOf("active", "open"),
    edge_digest: edgeDigestOf("x"),
    format_version: BASELINE_FORMAT_VERSION,
    confirmed_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    confirmed_by: "test",
    superseded_at: null,
    artifacts_digest: null,
  });
}

/** Четыре устаревших решения — потолок followups. */
function seedStaleDecisions(): void {
  for (let i = 1; i <= 4; i++) {
    db.insertNode({
      id: `stale-${i}`, name: `stale-${i}`, kind: "decision", created_via: "agent",
      summary: `Стале-маркер: решение ${i} хранит порог слияния`,
      file_refs: [`src/stale-${i}.ts`],
    });
    db.upsertSupportBaseline({
      decision_id: `stale-${i}`,
      support_id: "no-such-support",
      edge_key: String(i),
      claim_digest: claimDigestOf("x"),
      status_digest: statusDigestOf("active", "open"),
      edge_digest: edgeDigestOf("x"),
      format_version: BASELINE_FORMAT_VERSION,
      confirmed_at: new Date(Date.now() - (30 + i * 10) * 24 * 60 * 60 * 1000).toISOString(),
      confirmed_by: "test",
      superseded_at: null,
      artifacts_digest: null,
    });
  }
}

/** Ответы 2.2.0 (до блока next) на тех же фикстурах — базовая линия. */
const CAPTURED: Record<string, string> = {
  A1: `{"matches":[],"compact":[{"id":"merge-plan","name":"merge-plan","kind":"decision","status":"active","epistemic_status":"open","summary":"Перенос задач и слотов между базами пишет журнал слияния","file_refs":["src/merge.ts:120-180"],"score":1,"similarity":1,"children":[],"edges":[{"to":"merge-log","to_name":"merge-log","relation":"informed_by"},{"to":"db-pool","to_name":"db-pool","relation":"informed_by"},{"to":"schema-slots","to_name":"schema-slots","relation":"informed_by"}]}],"refuted":[],"edges_between":[],"meta":{"returned":1,"dropped":0,"tokens_estimated":423,"estimated_full_tokens":95,"supports_inlined":0,"stale_excluded":0,"inactive_excluded":0,"truncated":false}}`,
  A2: `{"matches":[],"compact":[{"id":"db-pool","name":"db-pool","kind":"fact","status":"active","epistemic_status":"open","summary":"Пул соединений возвращает строки и кэширует дайджесты узлов","file_refs":["src/db.ts"],"score":1,"similarity":1,"children":[],"edges":[]}],"refuted":[],"edges_between":[],"meta":{"returned":1,"dropped":0,"tokens_estimated":279,"estimated_full_tokens":97,"supports_inlined":0,"stale_excluded":0,"inactive_excluded":0,"truncated":false}}`,
  A3: `{"matches":[],"compact":[{"id":"merge-plan","name":"merge-plan","kind":"decision","status":"active","epistemic_status":"open","summary":"Перенос задач и слотов между базами пишет журнал слияния","file_refs":["src/merge.ts:120-180"],"score":0.875,"similarity":0.875,"children":[],"edges":[{"to":"merge-log","to_name":"merge-log","relation":"informed_by"},{"to":"db-pool","to_name":"db-pool","relation":"informed_by"},{"to":"schema-slots","to_name":"schema-slots","relation":"informed_by"}],"supports":[{"id":"schema-slots","name":"schema-slots","summary":"Схема базы хранит слоты задач и читает их пачками","status":"active","epistemic_status":"open","file_refs":["src/db.ts"]},{"id":"db-pool","name":"db-pool","summary":"Пул соединений возвращает строки и кэширует дайджесты узлов","status":"active","epistemic_status":"open","file_refs":["src/db.ts"]},{"id":"merge-log","name":"merge-log","summary":"Журнал слияния хранит ключи рёбер и пишет строки пачками","status":"active","epistemic_status":"open","file_refs":["src/merge.ts:200-240"]}]}],"refuted":[],"edges_between":[],"meta":{"returned":1,"dropped":0,"tokens_estimated":812,"estimated_full_tokens":377,"supports_inlined":3,"stale_excluded":0,"inactive_excluded":0,"truncated":false}}`,
  B1: `{"matches":[],"compact":[{"id":"budget-decision","name":"budget-decision","kind":"decision","status":"active","epistemic_status":"open","summary":"Бюджет ответа считает байты и блокирует перерасход wire-формы","file_refs":["src/tools.ts:600-700"],"score":0.9375,"similarity":0.9375,"children":[],"edges":[{"to":"wire-fact","to_name":"wire-fact","relation":"informed_by"}],"supports":[{"id":"wire-fact","name":"wire-fact","summary":"Wire-форма ответа хранит секции meta и возвращает счётчики","status":"active","epistemic_status":"open","file_refs":["src/tools.ts:710-760","src/index.ts:100-140","src/search.ts:20-40","src/db.ts"]}]}],"refuted":[],"edges_between":[],"meta":{"returned":1,"dropped":0,"tokens_estimated":513,"estimated_full_tokens":191,"supports_inlined":1,"stale_excluded":0,"inactive_excluded":0,"truncated":false}}`,
  B2: `{"matches":[],"compact":[],"refuted":[{"id":"refuted-claim","name":"refuted-claim","kind":"feature","status":"active","epistemic_status":"refuted","refuted_reason":"Измерение показало обратное: кэш не даёт выигрыша","summary":"Кэширует все ответы без разбора","file_refs":["src/cache.ts"],"score":1,"similarity":1}],"edges_between":[],"meta":{"returned":0,"dropped":0,"tokens_estimated":293,"estimated_full_tokens":0,"supports_inlined":0,"stale_excluded":0,"inactive_excluded":0,"truncated":false}}`,
  C1: `{"matches":[],"compact":[{"id":"beta","name":"beta","kind":"feature","status":"active","epistemic_status":"open","summary":"Beta node пишет отчёты сборки","file_refs":null,"score":1,"similarity":1,"children":[],"edges":[]},{"id":"alpha","name":"alpha","kind":"module","status":"active","epistemic_status":"open","summary":"Alpha node описывает модуль сборки и читает конфигурацию","file_refs":null,"score":0.9375,"similarity":0.9375,"children":[],"edges":[{"to":"beta","to_name":"beta","relation":"connects_to"}]}],"refuted":[],"edges_between":[{"from":"alpha","to":"beta","relation":"connects_to"}],"meta":{"returned":2,"dropped":0,"tokens_estimated":468,"estimated_full_tokens":168,"supports_inlined":0,"stale_excluded":0,"inactive_excluded":0,"truncated":false}}`,
  C2: `{"matches":[],"compact":[],"refuted":[],"edges_between":[],"meta":{"returned":0,"dropped":0,"tokens_estimated":125,"estimated_full_tokens":0,"supports_inlined":0,"stale_excluded":0,"inactive_excluded":0,"truncated":false}}`,
};

/** Честная мера wire-формы: та же, что у MCP-обработчика (K-03). */
function wireTokensOf(payload: unknown): number {
  return estimateTokens(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] })
  );
}

/**
 * Обратная совместимость: ответ без next один в один совпадает с базовой
 * линией 2.2.0; исключение — meta.tokens_estimated: next входит в ту же
 * wire-меру (K-03), поэтому число выросло и по-прежнему сходится с реальной
 * длиной wire-формы.
 */
function expectCompatibleWith220(out: UnderstandOutput, captured: string): void {
  const old = JSON.parse(captured) as Record<string, unknown>;
  const fresh = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
  const freshNoNext = { ...fresh };
  delete freshNoNext.next;
  const oldMeta = { ...(old.meta as Record<string, unknown>) };
  const freshMeta = { ...(freshNoNext.meta as Record<string, unknown>) };
  const oldTokens = oldMeta.tokens_estimated;
  const newTokens = freshMeta.tokens_estimated;
  delete oldMeta.tokens_estimated;
  delete freshMeta.tokens_estimated;
  expect({ ...freshNoNext, meta: freshMeta }).toEqual({ ...old, meta: oldMeta });
  expect(newTokens).toBeGreaterThanOrEqual(oldTokens as number);
  expect(newTokens).toBe(wireTokensOf(out));
}

describe("План 13 §2.1: блок next в understand", () => {
  it("next присутствует; ключи compact-ответа ровно [matches, compact, refuted, edges_between, meta, next]", async () => {
    seedEdges();
    const out = await understand(db, { query: "node сборки", top_k: 5, max_tokens: 1500 });
    expect(Object.keys(out)).toEqual(["matches", "compact", "refuted", "edges_between", "meta", "next"]);
    expect(Object.keys(out.next!)).toEqual(["must_read", "skip", "followups", "record"]);
    expect(Array.isArray(out.next!.must_read)).toBe(true);
    expect(Array.isArray(out.next!.skip)).toBe(true);
    expect(Array.isArray(out.next!.followups)).toBe(true);
    expect(typeof out.next!.record).toBe("string");
    expect(out.next!.record.length).toBeGreaterThan(0);
  });

  it("must_read не больше 3, дословно из file_refs узлов ответа, с node_id и why", async () => {
    seedMerge();
    const out = await understand(db, { query: "и", top_k: 5, max_tokens: 2500 });
    const next = out.next!;
    expect(next.must_read.length).toBe(3);
    expect(next.must_read.length).toBeLessThanOrEqual(3);
    // Ровно те ref, что лежат в file_refs узлов ответа (карточки + вложенные).
    const answerRefs = new Set<string>();
    const answerIds = new Set<string>();
    for (const card of out.compact ?? []) {
      answerIds.add(card.id);
      for (const ref of card.file_refs ?? []) answerRefs.add(ref);
      for (const sup of card.supports ?? []) {
        answerIds.add(sup.id);
        for (const ref of sup.file_refs ?? []) answerRefs.add(ref);
      }
    }
    const seen = new Set<string>();
    for (const hint of next.must_read) {
      expect(answerRefs.has(hint.ref)).toBe(true); // дословный file_ref
      expect(answerIds.has(hint.node_id)).toBe(true);
      expect(hint.why.length).toBeGreaterThan(0);
      expect(hint.why).toContain("«");
      expect(seen.has(hint.ref)).toBe(false); // дедупликация
      seen.add(hint.ref);
    }
    expect(next.must_read.map((m) => m.ref)).toEqual([
      "src/merge.ts:120-180",
      "src/db.ts",
      "src/merge.ts:200-240",
    ]);
  });

  it("followups: устаревший снимок подтверждения — check_artifacts с готовыми node_ids", async () => {
    seedBudget();
    const out = await understand(db, { query: "ответа wire", top_k: 5, max_tokens: 2500 });
    const follow = out.next!.followups;
    expect(follow).toHaveLength(1);
    expect(follow[0].tool).toBe("check_artifacts");
    expect(follow[0].args).toEqual({ node_ids: ["budget-decision"] });
    expect(follow[0].why).toBe("снимок подтверждения старше 30 дней");
  });

  it("followups: решение с невидимыми в ответе опорами — get_concept с id", async () => {
    seedMerge();
    const out = await understand(db, { query: "перенос задач и слотов", top_k: 5, max_tokens: 2000 });
    const follow = out.next!.followups;
    expect(follow).toHaveLength(1);
    expect(follow[0].tool).toBe("get_concept");
    expect(follow[0].args).toEqual({ id: "merge-plan" });
    expect(follow[0].why).toBe("у решения 3 опоры, в ответе видно 0");
  });

  it("followups: нечистый support_check (unknown) — provenance_trace; все опоры видны, get_concept не нужен", async () => {
    seedMerge();
    const out = await understand(db, { query: "и", top_k: 5, max_tokens: 2500 });
    const follow = out.next!.followups;
    expect(follow).toHaveLength(1);
    expect(follow[0].tool).toBe("provenance_trace");
    expect(follow[0].args).toEqual({ node_id: "merge-plan" });
    expect(follow[0].why).toContain("support_check: unknown");
    // Все 3 опоры сложены в карточку — невидимых нет, get_concept не предлагается.
    expect(out.compact![0].supports).toHaveLength(3);
    expect(follow.some((f) => f.tool === "get_concept")).toBe(false);
  });

  it("followups: нечистый support_check (incomplete) — provenance_trace; бюджет — инъекция малого лимита (план 13.1 F6)", () => {
    seedMerge();
    // Подтверждённый снимок решения: без него support_check — unknown.
    const decision = db.getNode("merge-plan")!;
    const edges = db.getInformedByEdges("merge-plan", "ancestry", false);
    confirmSupports(db, {
      decision_id: "merge-plan",
      expected_claim_digest: claimDigestOf(decision.summary),
      items: edges.map((e) => {
        const support = db.getNode(e.other_id)!;
        return {
          support_id: e.other_id,
          expected_claim_digest: claimDigestOf(support.summary),
          expected_status_digest: statusDigestOf(support.status, support.epistemic_status),
          expected_edge_digest: edgeDigestOf(e.description),
        };
      }),
    });
    // Боевой бюджет (5000 рёбер) на такой базе даёт unchanged; ветку incomplete
    // воспроизводит инъекция малого лимита — 3 опоры не влезают в 1 ребро.
    const hints = buildNextHints({
      db,
      cards: [{ id: "merge-plan", kind: "decision", visibleSupports: 3 }],
      checkBudget: { edges: 1, bytes: 1_000_000 },
    });
    const follow = hints.followups;
    expect(follow).toHaveLength(1);
    expect(follow[0].tool).toBe("provenance_trace");
    expect(follow[0].args).toEqual({ node_id: "merge-plan" });
    expect(follow[0].why).toContain("support_check: incomplete");
    // Снимок на месте — без инъекции бюджет а недостижим: боевой вызов
    // (understand, тест выше) остаётся unknown-веткой.
    expect(db.lastActiveBaselineAt("merge-plan")).not.toBeNull();
  });

  it("followups не больше 3, каждый с дословно исполнимыми аргументами", async () => {
    seedStaleDecisions();
    const out = await understand(db, { query: "стале маркер", top_k: 10, max_tokens: 4000 });
    const follow = out.next!.followups;
    expect(follow).toHaveLength(3); // 4 устаревших решения — потолок 3
    for (const f of follow) {
      expect(f.tool).toBe("check_artifacts");
      expect(Object.keys(f.args)).toEqual(["node_ids"]);
      expect(Array.isArray(f.args.node_ids)).toBe(true);
      expect((f.args.node_ids as string[]).length).toBe(1);
      expect(f.why).toMatch(/^снимок подтверждения старше \d+ дней$/);
    }
    expect(follow.map((f) => f.why)).toEqual([
      "снимок подтверждения старше 40 дней",
      "снимок подтверждения старше 50 дней",
      "снимок подтверждения старше 60 дней",
    ]);
  });

  it("skip только при честном покрытии: заглушечное, короткое и слабое саммари файл не покрывают", async () => {
    seedHonesty();
    const out = await understand(db, { query: "D1 mark", top_k: 6, max_tokens: 3000 });
    const next = out.next!;
    // Целые файлы есть у всех четырёх узлов — но skip даёт только честное покрытие.
    expect(next.skip).toEqual([
      {
        ref: "src/honest-covered.ts",
        why: "целиком покрыт узлом «honest-cov» (fact), читать файл не нужно",
      },
    ]);
    const skipRefs = next.skip.map((s) => s.ref);
    expect(skipRefs).not.toContain("src/stub-covered.ts"); // шаблонное саммари (stub.ts)
    expect(skipRefs).not.toContain("src/short-covered.ts"); // короче 80, без глагола
    expect(skipRefs).not.toContain("src/weak-covered.ts"); // abandoned
    // Диапазонные ref в skip не попадают — только целые файлы.
    for (const s of next.skip) expect(s.ref).not.toMatch(/:\d+(-\d+)?$/);
  });

  it("skip: файл из must_read в skip не попадает", async () => {
    seedMerge();
    const out = await understand(db, { query: "Пул соединений возвращает строки", top_k: 3, max_tokens: 2000 });
    expect(out.next!.must_read.map((m) => m.ref)).toEqual(["src/db.ts"]);
    expect(out.next!.skip).toEqual([]);
  });

  it("record меняется по содержимому: решения, факты, refuted", async () => {
    seedMerge();
    const withDecision = await understand(db, { query: "перенос задач и слотов", top_k: 5, max_tokens: 2000 });
    expect(withDecision.next!.record).toBe(
      "После правки запиши решение: create_concept kind=decision, evidence на файл+строки, informed_by на опоры."
    );

    seedEdges();
    const factsOnly = await understand(db, { query: "node сборки", top_k: 5, max_tokens: 1500 });
    expect(factsOnly.next!.record).toBe(
      "Запиши найденное по задаче: create_concept kind=fact с evidence на файл+строки."
    );

    seedBudget();
    const withRefuted = await understand(db, { query: "кэширует все ответы", top_k: 3, max_tokens: 1200 });
    expect(withRefuted.next!.record).toBe(
      "Опираться на refuted «refuted-claim» нельзя: Измерение показало обратное: кэш не даёт выигрыша. " +
        "Запиши проверенное: create_concept kind=fact с evidence на файл+строки."
    );
  });

  it("пустой ответ: next с пустыми списками и формой записи присутствует", async () => {
    // База пуста — ответ 0 карточек.
    const out = await understand(db, { query: "совершенно посторонний запрос", top_k: 5, max_tokens: 600 });
    expect(out.compact).toEqual([]);
    expect(out.meta!.returned).toBe(0);
    expect(out.next!.must_read).toEqual([]);
    expect(out.next!.skip).toEqual([]);
    expect(out.next!.followups).toEqual([]);
    expect(out.next!.record).toBe(
      "По ходу задачи записывай найденное: create_concept kind=fact с evidence на файл+строки."
    );
  });

  it("бюджет max_tokens=500: skip режется, must_read и record остаются, мера сходится с wire-формой", async () => {
    seedBudget();
    const extra = { instructions_stale: false, server_version: "2.3.0-test" };
    const tight = await understand(db, {
      query: "ответа wire", top_k: 5, max_tokens: 500, extra_payload: extra,
    });
    // Щедрый бюджет показывает, что skip и followups в этой базе есть вообще.
    const generous = await understand(db, { query: "ответа wire", top_k: 5, max_tokens: 2500 });
    expect(generous.next!.skip.map((s) => s.ref)).toEqual(["src/db.ts"]);
    expect(generous.next!.followups.map((f) => f.tool)).toEqual(["check_artifacts"]);

    expect(tight.next!.skip).toEqual([]); // порезан
    expect(tight.next!.followups).toEqual([]); // порезан
    expect(tight.next!.must_read.length).toBeGreaterThanOrEqual(1); // не резался
    expect(tight.next!.record.length).toBeGreaterThan(0); // не резался
    expect(tight.meta!.truncated).toBe(true);
    // Мера считается по той же wire-форме, что уходит по проводу (K-03),
    // включая extra_payload обработчика и блок next.
    expect(tight.meta!.tokens_estimated).toBe(
      wireTokensOf({ ...tight, ...extra })
    );
  });

  it("бюджет: followups режутся раньше must_read и record", async () => {
    seedSmallBudget();
    const generous = await understand(db, { query: "хранит", top_k: 5, max_tokens: 2500 });
    expect(generous.next!.followups.map((f) => f.tool)).toEqual(["check_artifacts"]);
    expect(generous.next!.followups[0].args).toEqual({ node_ids: ["b-dec"] });

    const tight = await understand(db, { query: "хранит", top_k: 5, max_tokens: 520 });
    expect(tight.next!.followups).toEqual([]); // порезан
    // must_read не резался: все ссылки узлов ответа на месте
    expect(tight.next!.must_read.map((m) => m.ref)).toContain("src/bdec.ts:5-15");
    expect(tight.next!.must_read.length).toBeGreaterThanOrEqual(1);
    expect(tight.next!.record.length).toBeGreaterThan(0); // остался
    expect(tight.meta!.truncated).toBe(true);
  });

  it("full-режим тоже завершается блоком next", async () => {
    seedBudget();
    const out = await understand(db, {
      query: "бюджет ответа считает байты", top_k: 5, max_tokens: 2500, mode: "full",
    });
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.next).toBeDefined();
    const answerRefs = new Set(out.matches.flatMap((m) => m.file_refs ?? []));
    for (const hint of out.next!.must_read) {
      expect(answerRefs.has(hint.ref)).toBe(true);
    }
    expect(out.next!.record.length).toBeGreaterThan(0);
  });

  it("совместимость, фикстура решений и опор: ответ без next совпадает с 2.2.0", async () => {
    seedMerge();
    const a1 = await understand(db, { query: "перенос задач и слотов", top_k: 5, max_tokens: 2000 });
    const a2 = await understand(db, { query: "Пул соединений возвращает строки", top_k: 3, max_tokens: 2000 });
    const a3 = await understand(db, { query: "и", top_k: 5, max_tokens: 2500 });
    expectCompatibleWith220(a1, CAPTURED.A1);
    expectCompatibleWith220(a2, CAPTURED.A2);
    expectCompatibleWith220(a3, CAPTURED.A3);
  });

  it("совместимость, фикстура бюджета и refuted: ответ без next совпадает с 2.2.0", async () => {
    seedBudget();
    const b1 = await understand(db, { query: "ответа wire", top_k: 5, max_tokens: 2500 });
    const b2 = await understand(db, { query: "кэширует все ответы", top_k: 3, max_tokens: 1200 });
    expectCompatibleWith220(b1, CAPTURED.B1);
    expectCompatibleWith220(b2, CAPTURED.B2);
  });

  it("совместимость, фикстура рёбер и пустого ответа: без next совпадает с 2.2.0", async () => {
    seedEdges();
    const c1 = await understand(db, { query: "node сборки", top_k: 5, max_tokens: 1500 });
    const c2 = await understand(db, { query: "совершенно посторонний запрос без совпадений", top_k: 5, max_tokens: 600 });
    expectCompatibleWith220(c1, CAPTURED.C1);
    expectCompatibleWith220(c2, CAPTURED.C2);
  });
});
