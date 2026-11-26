import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { understand, link, measureMcpPayload, estimateTokens } from "../tools.js";
import {
  claimDigestOf,
  statusDigestOf,
  edgeDigestOf,
  confirmSupports,
} from "../support-baselines.js";
import { activeArtifactRows, artifactsDigestOf } from "../artifacts.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// E3 (план 20+21 v3 §8.3): opt-in evidence-дополнение к compact understand.
//
// Контракт:
// - Без флага ответ прежний (compact understand дайджестов не несёт).
// - include_evidence: true добавляет каждому размещённому матчу
//   current_digests (текущие версии; подтверждённые — отдельно) и
//   support_evidence — ПОЛНЫЙ набор живых опор (включая не найденные поиском):
//   полная формулировка (никогда не обрезается), rationale ребра и готовые
//   дайджесты confirm_supports той же механики, что evidence-профиль
//   get_concept (M3-1) — клиент не вычисляет хеши сам.
// - Криптографические значения в подтверждаемой форме не сокращаются до
//   display-префиксов.
// - Бюджет: карточка с доказательствами размещается целиком или снимается
//   целиком; discovery-кандидат без evidence-карточки не является доказательством.
//   Частичный набор доказательств не выдаётся; усечение честно в meta,
//   а dropped считает только полностью скрытые узлы.
//   Доказательства тяжёлые (полные hex-дайджесты опор), поэтому fixture-тесты
//   флага явно поднимают max_tokens.

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-compact-evidence-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

const DECISION_SUMMARY =
  "decision: silent refresh 30 s before token expiry because 401s on /expired broke long jobs qmarker";
const S1_SUMMARY = "fact: the EBUSY race of two batches reproduced with two parallel writers qmarker";
// Кириллическая формулировка длиннее компактного усечения (240) — только полная
// форма достаточна для подтверждения.
const S2_SUMMARY =
  "Проверено: повторная выдача токена выполняется фоновым планировщиком за тридцать секунд до " +
  "истечения срока, потому что параллельные писатели вызывали занятость базы и обрывали " +
  "длинные задания; маркер для поиска кириллической опоры: гонка-писателей-воспроизведена";
const FILLER_SUMMARY =
  "fact: silent refresh token expiry qmarker — silent refresh token expiry qmarker mirror";

const RATIONALE_S1 = "the reproduced race is what the retry loop fixes";
const RATIONALE_S2 = "кириллический rationale: планировщик и есть механизм тихого обновления";
const RATIONALE_S3 = "the audit trail pins the window in which the fix landed";

function insertFixture(): void {
  db.insertNode({
    id: "dec-refresh",
    name: "dec-refresh",
    kind: "decision",
    summary: DECISION_SUMMARY,
  });
  db.insertNode({
    id: "sup-race",
    name: "sup-race",
    kind: "fact",
    summary: S1_SUMMARY,
  });
  db.insertNode({
    id: "sup-cyr",
    name: "sup-cyr",
    kind: "fact",
    summary: S2_SUMMARY,
  });
  // Опора, которую запрос НЕ находит: подтверждение обязано видеть её версии
  // без повторного поиска (это и есть дополнение, а не пере-выдача хитов).
  db.insertNode({
    id: "sup-offlog",
    name: "sup-offlog",
    kind: "fact",
    summary: "fact: unrelated audit trail note kept for the release history",
  });
  // Дешёвая карточка без опор: в бюджетных сценариях заполняет верхний уровень.
  db.insertNode({
    id: "fact-filler",
    name: "fact-filler",
    kind: "fact",
    summary: FILLER_SUMMARY,
  });
  link(db, { from: "dec-refresh", to: "sup-race", relation: "informed_by", description: RATIONALE_S1 });
  link(db, { from: "dec-refresh", to: "sup-cyr", relation: "informed_by", description: RATIONALE_S2 });
  link(db, { from: "dec-refresh", to: "sup-offlog", relation: "informed_by", description: RATIONALE_S3 });
}

const QUERY = "silent refresh token expiry qmarker";
// Доказательства тяжёлые: полные формулировки плюс 4 полных hex-дайджеста на
// каждую опору. Флаг opt-in, поэтому бюджет в тестах поднят явно.
const EVIDENCE_BUDGET = 4000;

describe("E3: компактный understand без флага — прежний ответ", () => {
  it("по умолчанию ни current_digests, ни support_evidence, ни claim_digest в ответе", async () => {
    insertFixture();
    const result = await understand(db, { query: QUERY });
    expect(result.compact!.length).toBeGreaterThan(0);
    const text = JSON.stringify(result);
    expect(text).not.toContain("current_digests");
    expect(text).not.toContain("support_evidence");
    expect(text).not.toContain("claim_digest");
  });
});

describe("E3: include_evidence: true — подтверждаемые версии в compact", () => {
  it("решение несёт current_digests: текущий claim отдельно от подтверждённого снимка", async () => {
    insertFixture();
    const result = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const dec = result.compact!.find((m) => m.id === "dec-refresh")!;
    expect(dec).toBeDefined();
    expect(dec.current_digests).toBeDefined();
    expect(dec.current_digests!.claim).toBe(claimDigestOf(DECISION_SUMMARY));
    expect(dec.current_digests!.confirmed_claim).toBeNull();
    expect(dec.current_digests!.confirmed_at).toBeNull();
    expect(dec.current_digests!.source).toBe("computed");
    // current и confirmed — разные поля, не смесь
    expect(dec.current_digests!.status).toBe(statusDigestOf("active", "open"));
  });

  it("support_evidence покрывает ВСЕ живые опоры, включая не найденные поиском; формулировки полные", async () => {
    insertFixture();
    const result = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const dec = result.compact!.find((m) => m.id === "dec-refresh")!;
    const sup = dec.support_evidence!;
    expect(sup.map((s) => s.to).sort()).toEqual(["sup-cyr", "sup-offlog", "sup-race"]);
    const cyr = sup.find((s) => s.to === "sup-cyr")!;
    // полная формулировка байт-в-байт: длинная кириллическая не обрезана
    expect(cyr.claim).toBe(S2_SUMMARY);
    expect(S2_SUMMARY.length).toBeGreaterThan(240);
    expect(cyr.rationale).toBe(RATIONALE_S2);
    const off = sup.find((s) => s.to === "sup-offlog")!;
    expect(off.claim).toBe("fact: unrelated audit trail note kept for the release history");
    expect(off.rationale).toBe(RATIONALE_S3);
  });

  it("дайджесты совпадают с общими экспортами и едут полными hex (не display-префиксы)", async () => {
    insertFixture();
    const result = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const dec = result.compact!.find((m) => m.id === "dec-refresh")!;
    const cyr = dec.support_evidence!.find((s) => s.to === "sup-cyr")!;
    expect(cyr.digests.claim_digest).toBe(claimDigestOf(S2_SUMMARY));
    expect(cyr.digests.status_digest).toBe(statusDigestOf("active", "open"));
    expect(cyr.digests.edge_digest).toBe(edgeDigestOf(RATIONALE_S2));
    expect(cyr.digests.artifacts_digest).toBe(
      artifactsDigestOf(activeArtifactRows(db.getNode("sup-cyr")!, db.getNodeArtifacts("sup-cyr")))
    );
    for (const d of [cyr.digests.claim_digest, cyr.digests.status_digest, cyr.digests.edge_digest]) {
      expect(d).toMatch(/^[0-9a-f]{64}$/);
    }
    // дайджест решения — тоже полная подтверждаемая форма
    expect(dec.current_digests!.claim).toMatch(/^[0-9a-f]{64}$/);
  });

  it("квалификация и weak-пометки едут вместе с доказательством", async () => {
    insertFixture();
    // безопорная опора (ни informed_by-исходящих, ни file_refs) — weak по
    // безопорности (provenance.ts isUngrounded), не ослабленный предикат.
    db.insertNode({
      id: "sup-weak",
      name: "sup-weak",
      kind: "fact",
      summary: "fact: another angle of the silent refresh window qmarker",
    });
    link(db, { from: "dec-refresh", to: "sup-weak", relation: "informed_by", description: "weak angle" });
    const result = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const dec = result.compact!.find((m) => m.id === "dec-refresh")!;
    const weak = dec.support_evidence!.find((s) => s.to === "sup-weak")!;
    expect(weak.weak).toBe(true);
    expect(weak.epistemic_status).toBe("open");
    // осмысленная формулировка ручного узла — quality: claim
    expect(weak.quality).toBe("claim");
  });

  it("подтверждение проходит дайджестами ТОЛЬКО из compact+include_evidence (без get_concept/provenance)", async () => {
    insertFixture();
    const result = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const dec = result.compact!.find((m) => m.id === "dec-refresh")!;
    const outcome = confirmSupports(db, {
      decision_id: "dec-refresh",
      expected_claim_digest: dec.current_digests!.claim,
      items: dec.support_evidence!.map((s) => ({
        support_id: s.to,
        expected_claim_digest: s.digests.claim_digest,
        expected_status_digest: s.digests.status_digest,
        expected_edge_digest: s.digests.edge_digest,
      })),
    });
    expect(outcome.confirmed).toBe(3);
  });

  it("current/confirmed не смешиваются: правка опоры после чтения отклоняется по версиям", async () => {
    insertFixture();
    const result = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const dec = result.compact!.find((m) => m.id === "dec-refresh")!;
    const cyr = dec.support_evidence!.find((s) => s.to === "sup-cyr")!;
    db.updateNode("sup-cyr", { summary: S2_SUMMARY + " — дописано после чтения" });
    expect(() =>
      confirmSupports(db, {
        decision_id: "dec-refresh",
        expected_claim_digest: dec.current_digests!.claim,
        items: [
          {
            support_id: "sup-cyr",
            expected_claim_digest: cyr.digests.claim_digest,
            expected_status_digest: cyr.digests.status_digest,
            expected_edge_digest: cyr.digests.edge_digest,
          },
        ],
      })
    ).toThrow(/version_conflict/);
  });

  it("meta считает добавление честно: evidence_matches и evidence_supports", async () => {
    insertFixture();
    const result = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const dec = result.compact!.find((m) => m.id === "dec-refresh")!;
    const matches = result.compact!.filter((m) => m.support_evidence !== undefined).length;
    expect(result.meta!.evidence_matches).toBe(matches);
    expect(result.meta!.evidence_supports).toBe(
      result.compact!.reduce((sum, m) => sum + (m.support_evidence?.length ?? 0), 0)
    );
    expect(result.meta!.evidence_supports).toBe(3);
    expect(dec.support_evidence).toHaveLength(3);
    // дешёвая карточка без опор несёт явный пустой набор, не отсутствие поля
    const filler = result.compact!.find((m) => m.id === "fact-filler");
    if (filler) expect(filler.support_evidence).toEqual([]);
  });

  it("бюджет: evidence-карточка снимается ЦЕЛИКОМ, discovery-кандидат не является доказательством", async () => {
    insertFixture();
    // Порог измеряется по реальной форме: filler evidence-карточка и весь
    // discovery должны помещаться, причём discovery занимает не более 25%.
    const rich = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const richDecision = rich.compact!.find((m) => m.id === "dec-refresh");
    const richFiller = rich.compact!.find((m) => m.id === "fact-filler");
    expect(richDecision).toBeDefined();
    expect(richFiller).toBeDefined();
    expect(rich.candidates!.map((candidate) => candidate.id).sort()).toEqual(["dec-refresh", "fact-filler"]);
    const discoveryTokens =
      measureMcpPayload({ candidates: rich.candidates }) - measureMcpPayload({ candidates: [] });
    const fillerPayload = {
      ...rich,
      compact: [richFiller!],
      edges_between: [],
      meta: { ...rich.meta!, cards: 1, evidence_matches: 1, evidence_supports: 0, dropped: 0 },
      next: {
        ...rich.next!,
        // 2.14.1/35 T2: полы сохраняют имена, поэтому witness обязан нести и
        // реалистичный next: решение не показано карточкой — невидимые опоры
        // дают followup get_concept (раньше бюджет добирал из обзывания имён).
        followups: [{ tool: "get_concept" as const, args: { id: "dec-refresh" }, why: "у решения 3 опоры, в ответе видно 0" }],
      },
    };
    const tight = Math.max(measureMcpPayload(fillerPayload), discoveryTokens * 4);
    expect(measureMcpPayload(fillerPayload)).toBeLessThanOrEqual(tight);
    expect(discoveryTokens).toBeLessThanOrEqual(Math.floor(tight / 4));
    // Даже обязательное evidence-ядро решения без display-полей дороже
    // tight: отсутствие полной карточки ниже не допускает частичный proof.
    expect(measureMcpPayload({
      compact: [{
        current_digests: richDecision!.current_digests,
        support_evidence: richDecision!.support_evidence,
      }],
    })).toBeGreaterThan(tight);
    const result = await understand(db, {
      query: QUERY,
      include_evidence: true,
      top_k: 10,
      max_tokens: tight,
    });
    // Решение с доказательствами не помещается — оно снято целиком.
    expect(result.compact!.some((m) => m.id === "dec-refresh")).toBe(false);
    // Дешёвая карточка размещена с явным пустым набором опор — сам матч
    // не несёт частичного доказательства.
    const filler = result.compact!.find((m) => m.id === "fact-filler");
    expect(filler).toBeDefined();
    expect(filler!.support_evidence).toEqual([]);
    expect(filler!.current_digests!.claim).toBe(claimDigestOf(FILLER_SUMMARY));
    // Решение остаётся locator-only кандидатом: подтверждать его этим нельзя.
    const candidate = result.candidates!.find((m) => m.id === "dec-refresh");
    expect(candidate).toBeDefined();
    expect(candidate).not.toHaveProperty("current_digests");
    expect(candidate).not.toHaveProperty("support_evidence");
    expect(result.meta!.returned).toBe(result.candidates!.length);
    expect(result.meta!.cards).toBe(result.compact!.length);
    expect(result.meta!.evidence_matches).toBe(1);
    expect(result.meta!.evidence_supports).toBe(0);
    expect(result.meta!.truncated).toBe(true);
    // Candidate-only — не wholly hidden: снятие карточки не увеличивает dropped.
    expect(result.meta!.dropped).toBe(0);
    expect(result.meta!.tokens_estimated).toBe(measureMcpPayload(result));
    expect(result.meta!.tokens_estimated).toBeLessThanOrEqual(tight);
  });

  it("токены с флагом измеряются по фактической wire-форме и больше ответа без флага", async () => {
    insertFixture();
    const withFlag = await understand(db, {
      query: QUERY,
      include_evidence: true,
      max_tokens: EVIDENCE_BUDGET,
    });
    const withoutFlag = await understand(db, { query: QUERY });
    // measureMcpPayload по фиксированной точке совпадает с meta.tokens_estimated
    expect(withFlag.meta!.tokens_estimated).toBe(measureMcpPayload(withFlag));
    expect(withFlag.meta!.tokens_estimated).toBeGreaterThan(withoutFlag.meta!.tokens_estimated);
    expect(withFlag.meta!.evidence_supports).toBe(3);
  });

  it("include_evidence с mode=full и mode=brief — явная ошибка, не молчаливое игнорирование", async () => {
    insertFixture();
    await expect(
      understand(db, { query: QUERY, include_evidence: true, mode: "full" })
    ).rejects.toThrow(/include_evidence/);
    await expect(
      understand(db, { query: QUERY, include_evidence: true, mode: "brief" })
    ).rejects.toThrow(/include_evidence/);
  });
});
