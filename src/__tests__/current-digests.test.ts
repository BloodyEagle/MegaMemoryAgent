import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { getConcept, understand, link } from "../tools.js";
import { provenanceTrace } from "../provenance.js";
import {
  BASELINE_FORMAT_VERSION,
  claimDigestOf,
  confirmSupports,
  edgeDigestOf,
  statusDigestOf,
} from "../support-baselines.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// 2.1.7 F1: дайджесты до первого подтверждения. Контракт: значение
// current_digests.claim из get_concept принимается confirm_supports без
// version_conflict, если узел не менялся между вызовами; считать дайджест
// руками агент больше не обязан.

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-current-digests-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db); // FTS: без схемы поиск уходит в LIKE-fallback по всей фразе
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

const DECISION_SUMMARY = "silent refresh 30 s before token expiry";
const SUPPORT_SUMMARY = "401 on /expired broke long jobs in the scheduler";
const RATIONALE = "the scheduler trace shows the 401 storm";

function insertDecisionWithSupport(): void {
  db.insertNode({
    id: "auth-refresh",
    name: "auth-refresh",
    kind: "decision",
    summary: DECISION_SUMMARY,
  });
  db.insertNode({
    id: "auth-401-fact",
    name: "auth-401-fact",
    kind: "fact",
    summary: SUPPORT_SUMMARY,
  });
  link(db, {
    from: "auth-refresh",
    to: "auth-401-fact",
    relation: "informed_by",
    description: RATIONALE,
  });
}

describe("2.1.7 F1: current_digests в get_concept", () => {
  it("1. неподтверждённое решение: source computed, claim совпадает с claimDigestOf", () => {
    insertDecisionWithSupport();
    const ctx = getConcept(db, { id: "auth-refresh" });
    expect(ctx.current_digests).toBeDefined();
    expect(ctx.current_digests!.source).toBe("computed");
    expect(ctx.current_digests!.claim).toBe(claimDigestOf(DECISION_SUMMARY));
    expect(ctx.current_digests!.status).toBe(
      statusDigestOf("active", "open")
    );
    expect(ctx.current_digests!.format_version).toBe(BASELINE_FORMAT_VERSION);
  });

  it("2. подтверждённое решение: source snapshot, claim из снимка", () => {
    insertDecisionWithSupport();
    const before = getConcept(db, { id: "auth-refresh" });
    const edge = db.getInformedByEdges("auth-refresh", "ancestry", false)[0];
    confirmSupports(db, {
      decision_id: "auth-refresh",
      expected_claim_digest: before.current_digests!.claim,
      items: [
        {
          support_id: "auth-401-fact",
          expected_claim_digest: claimDigestOf(SUPPORT_SUMMARY),
          expected_status_digest: statusDigestOf("active", "open"),
          expected_edge_digest: edgeDigestOf(edge.description),
        },
      ],
    });
    const after = getConcept(db, { id: "auth-refresh" });
    expect(after.current_digests!.source).toBe("snapshot");
    // снимок хранит дайджест подтверждённой формулировки
    expect(after.current_digests!.claim).toBe(claimDigestOf(DECISION_SUMMARY));
  });

  it("3. confirm_supports дайджестом из get_concept проходит с первого раза", () => {
    insertDecisionWithSupport();
    const ctx = getConcept(db, { id: "auth-refresh" });
    const trace = provenanceTrace(db, { node_id: "auth-refresh" });
    const sup = trace.supports!.find((s) => s.support_id === "auth-401-fact")!;
    // ни одного ручного вычисления: всё из ответов сервера
    const result = confirmSupports(db, {
      decision_id: "auth-refresh",
      expected_claim_digest: ctx.current_digests!.claim,
      items: [
        {
          support_id: sup.support_id,
          expected_claim_digest: sup.claim_digest!,
          expected_status_digest: sup.status_digest!,
          expected_edge_digest: sup.edge_digest,
        },
      ],
    });
    expect(result.confirmed).toBe(1);
  });

  it("4. узел изменён между чтением и подтверждением: version_conflict, ноль записей", () => {
    insertDecisionWithSupport();
    const ctx = getConcept(db, { id: "auth-refresh" });
    // формулировка решения переписана ПОСЛЕ чтения
    db.updateNode("auth-refresh", { summary: "rewritten claim after the read" });
    expect(() =>
      confirmSupports(db, {
        decision_id: "auth-refresh",
        expected_claim_digest: ctx.current_digests!.claim,
        items: [],
      })
    ).toThrow(/version_conflict/);
    // ноль записей: снимка нет, состояние — unknown
    const check = getConcept(db, { id: "auth-refresh" }).support_check!;
    expect(check.state).toBe("unknown");
  });
});

describe("2.1.7 F1: provenance_trace отдаёт полные digest'ы", () => {
  it("5. supports[] несёт полные claim/status/edge digest'ы опор и current_digests корня", () => {
    insertDecisionWithSupport();
    const trace = provenanceTrace(db, { node_id: "auth-refresh" });
    expect(trace.current_digests).toBeDefined();
    expect(trace.current_digests!.claim).toBe(claimDigestOf(DECISION_SUMMARY));
    expect(trace.supports).toHaveLength(1);
    const sup = trace.supports![0];
    expect(sup.support_id).toBe("auth-401-fact");
    // полные sha256-hex, а не превью из 12 символов
    expect(sup.claim_digest).toBe(claimDigestOf(SUPPORT_SUMMARY));
    expect(sup.claim_digest).toHaveLength(64);
    expect(sup.status_digest).toBe(statusDigestOf("active", "open"));
    expect(sup.status_digest).toHaveLength(64);
    expect(sup.edge_digest).toBe(edgeDigestOf(RATIONALE));
    expect(sup.edge_digest).toHaveLength(64);
  });

  it("7. удалённый корень: current_digests null, supports не отдаётся", () => {
    insertDecisionWithSupport();
    db.softDeleteNode("auth-refresh", "superseded by v2");
    const trace = provenanceTrace(db, { node_id: "auth-refresh" });
    expect(trace.root.removed).toBe(true);
    expect(trace.current_digests).toBeNull();
    expect(trace.supports).toBeUndefined();
  });
});

describe("2.1.7 F1: компактный understand без дайджестов", () => {
  it("6. компактный understand не содержит current_digests — плата токенами на каждом чтении", async () => {
    insertDecisionWithSupport();
    const result = await understand(db, { query: "silent refresh token expiry" });
    expect(result.compact!.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("current_digests");
    expect(JSON.stringify(result)).not.toContain("claim_digest");
  });
});
