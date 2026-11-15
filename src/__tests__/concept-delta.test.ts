import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { getConceptProfile, branchConceptToolArgs } from "../concept-profile.js";
import { checkArtifacts } from "../artifacts.js";
import { measureMcpPayload } from "../tools.js";
import type {
  ConceptDeltaOutput,
  ConceptProfileOutput,
} from "../types.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// E4 (план 20+21 v3 §8.4): delta-выдача — разрешённый вариант «явный контекст
// клиента».
//
// Контракт:
// - Opt-in: клиент явно передаёт известные версии (known_versions) И
//   идентификатор своей текущей эпохи контекста (context_epoch). Нет
//   параметров — нет delta: старые вызовы байт-в-байт прежние.
// - Сервер сравнивает версию ЗАПРОШЕННОЙ проекции (та же механика, что
//   continuation-токен M3-1: sha256 канонического JSON), а не только summary
//   claim digest. Версия учитывает ВСЕ существенные выдаваемые данные:
//   статус, срок, ссылки, rationale, состав опор, состояние артефактов,
//   выбранных соседей и версию формата.
// - Изменение времени, приводящее к expiry, учитывается даже без записи в БД.
// - После compaction/restart/смены проекта/потери состояния клиента — полная
//   выдача (клиент не передаёт epoch/версии → полная).
// - Сервер без кэша: версия вычисляется из данных (stateless сравнение).
// - unchanged-ответ — компактный: {unchanged, version, epoch,
//   qualification-минимум} и обязательная пометка, что unchanged НЕ является
//   покрытием кода (чтение исходника перед правкой не отменяется).

let tmpDir: string;
let projDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-concept-delta-"));
  projDir = path.join(tmpDir, "proj");
  fs.mkdirSync(projDir, { recursive: true });
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function writeProjFile(rel: string, content: string): void {
  const abs = path.join(projDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function insertFixture(db: KnowledgeDB): void {
  writeProjFile("src/auth/refresh.ts", "export function refresh() { return 42; }\n");
  db.insertNode({
    id: "auth-refresh",
    name: "Auth refresh",
    kind: "decision",
    summary: "Тихое обновление токена за 30 секунд до истечения — фоновая проверка в refreshLoop.",
    why: "Долгие джобы падали на 401.",
    file_refs: ["src/auth/refresh.ts"],
    created_via: "agent",
  });
  db.insertNode({
    id: "sup-loop",
    name: "Refresh loop",
    kind: "feature",
    summary: "refreshLoop проверяет срок токена каждые 10 секунд.",
  });
  db.insertEdge({
    from_id: "auth-refresh",
    to_id: "sup-loop",
    relation: "informed_by",
    description: "loop даёт превентивное обновление",
  });
}

const EPOCH = "ctx-epoch-1";

function evidenceVersion(id = "auth-refresh"): string {
  const first = getConceptProfile(db, {
    id,
    profile: "evidence",
    context_epoch: EPOCH,
  }) as ConceptProfileOutput;
  const v = first.meta.version;
  if (!v) throw new Error("первый evidence-ответ обязан нести meta.version");
  return v;
}

describe("E4: opt-in delta выдача get_concept", () => {
  it("без новых параметров ответ прежний: meta.version не появляется (opt-in, нет параметра — нет delta)", () => {
    insertFixture(db);
    const result = getConceptProfile(db, { id: "auth-refresh", profile: "evidence" }) as ConceptProfileOutput;
    expect(result.meta.version).toBeUndefined();
    expect(result.meta.context_epoch).toBeUndefined();
  });

  it("первый delta-запрос (без известной версии) — полная выдача с meta.version и эхом эпохи", () => {
    insertFixture(db);
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
    }) as ConceptProfileOutput;
    expect(result.meta.version).toMatch(/^m4ver-[0-9a-f]{64}$/);
    expect(result.meta.context_epoch).toBe(EPOCH);
    expect(result.summary).toContain("Тихое обновление");
  });

  it("совпадение версии → компактный unchanged: квалификация-минимум без повторной передачи текста и опор", () => {
    insertFixture(db);
    const v = evidenceVersion();
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as unknown as ConceptDeltaOutput;
    expect(result.unchanged).toBe(true);
    expect(result.version).toBe(v);
    expect(result.context_epoch).toBe(EPOCH);
    // Минимум квалификации присутствует.
    expect(result.id).toBe("auth-refresh");
    expect(result.kind).toBe("decision");
    expect(result.qualification.status).toBe("active");
    expect(result.qualification.expired).toBe(false);
    // Текст и опоры повторно НЕ передаются.
    expect(result).not.toHaveProperty("summary");
    expect(result).not.toHaveProperty("supports");
  });

  it("unchanged-ответ НЕ содержит покрытия кода: обязательная пометка о чтении исходника", () => {
    insertFixture(db);
    const v = evidenceVersion();
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as unknown as ConceptDeltaOutput;
    expect(result.note).toMatch(/не.*покрыти|читай текущий|не заменяет чтение/i);
  });

  it("изменение только rationale опоры инвалидирует delta", () => {
    insertFixture(db);
    const v = evidenceVersion();
    db.execSqlRun("UPDATE edges SET description = 'другой rationale' WHERE from_id = 'auth-refresh'");
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as ConceptProfileOutput;
    expect((result as unknown as ConceptDeltaOutput).unchanged).toBeUndefined();
    expect(result.meta.version).toMatch(/^m4ver-/);
    expect(result.meta.version).not.toBe(v);
  });

  it("одинаковый summary не маскирует остальные изменения: правка rationale при том же тексте меняет версию", () => {
    insertFixture(db);
    const v = evidenceVersion();
    db.updateNode("sup-loop", { summary: "refreshLoop проверяет срок токена каждые 10 секунд." });
    db.execSqlRun("UPDATE edges SET description = 'обновлённый rationale' WHERE from_id = 'auth-refresh'");
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as ConceptProfileOutput;
    expect(result.meta.version).not.toBe(v);
  });

  it("изменение формулировки инвалидирует delta", () => {
    insertFixture(db);
    const v = evidenceVersion();
    db.updateNode("auth-refresh", { summary: "Другая формулировка решения." });
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as ConceptProfileOutput;
    expect(result.meta.version).not.toBe(v);
  });

  it("изменение статуса инвалидирует delta", () => {
    insertFixture(db);
    const v = evidenceVersion();
    db.setEpistemicStatus("auth-refresh", "refuted", "контрпример", null);
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as ConceptProfileOutput;
    expect(result.meta.version).not.toBe(v);
  });

  it("истечение срока учитывается даже без записи в БД (вход времени в версию)", async () => {
    insertFixture(db);
    db.execSqlRun(
      `UPDATE nodes SET valid_until = ? WHERE id = 'auth-refresh'`,
      new Date(Date.now() + 1200).toISOString()
    );
    const v = evidenceVersion();
    // Время ушло за границу valid_until — запись в БД не нужна.
    await new Promise((r) => setTimeout(r, 1500));
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as ConceptProfileOutput;
    expect(result.meta.version).not.toBe(v);
  });

  it("изменение состояния артефактов инвалидирует delta", async () => {
    insertFixture(db);
    const v = evidenceVersion();
    await checkArtifacts(db, { node_ids: ["auth-refresh"], cwd: projDir });
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as ConceptProfileOutput;
    expect(result.meta.version).not.toBe(v);
  });

  it("изменение состава соседей (новая опора) инвалидирует delta", () => {
    insertFixture(db);
    const v = evidenceVersion();
    db.insertNode({ id: "sup-extra", name: "Extra", kind: "feature", summary: "Дополнительная опора." });
    db.insertEdge({
      from_id: "auth-refresh",
      to_id: "sup-extra",
      relation: "informed_by",
      description: "добавленная опора",
    });
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as ConceptProfileOutput;
    expect(result.meta.version).not.toBe(v);
  });

  it("сброс контекста: без epoch/версий — полная выдача (compaction/restart/смена проекта)", () => {
    insertFixture(db);
    evidenceVersion();
    const result = getConceptProfile(db, { id: "auth-refresh", profile: "evidence" }) as ConceptProfileOutput;
    expect((result as unknown as ConceptDeltaOutput).unchanged).toBeUndefined();
    expect(result.summary).toContain("Тихое обновление");
    // Старый вызов без delta-параметров не несёт версии (opt-in).
    expect(result.meta.version).toBeUndefined();
  });

  it("неверное значение версии — это расхождение: полная выдача, не ошибка", () => {
    insertFixture(db);
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": "m4ver-" + "0".repeat(64) },
    }) as ConceptProfileOutput;
    expect((result as unknown as ConceptDeltaOutput).unchanged).toBeUndefined();
    expect(result.summary).toContain("Тихое обновление");
  });

  it("profile=full: версия считается по полной карточке; совпадение — unchanged, расхождение — карточка с delta_version", () => {
    insertFixture(db);
    const first = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "full",
      context_epoch: EPOCH,
    }) as ConceptProfileOutput & { delta_version?: { version: string; context_epoch: string } };
    expect(first.delta_version?.version).toMatch(/^m4ver-[0-9a-f]{64}$/);
    const v = first.delta_version!.version;
    const unchanged = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "full",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as unknown as ConceptDeltaOutput;
    expect(unchanged.unchanged).toBe(true);
    expect(unchanged.version).toBe(v);
    db.updateNode("sup-loop", { summary: "Другой смысл опоры." });
    const mismatch = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "full",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as ConceptProfileOutput & { delta_version?: { version: string } };
    expect((mismatch as unknown as ConceptDeltaOutput).unchanged).toBeUndefined();
    expect(mismatch.summary).toContain("Тихое обновление");
    expect(mismatch.delta_version?.version).not.toBe(v);
  });

  it("known_versions без context_epoch — явная ошибка (протокол требует обе части)", () => {
    insertFixture(db);
    expect(() =>
      getConceptProfile(db, {
        id: "auth-refresh",
        profile: "evidence",
        known_versions: { "auth-refresh": "m4ver-x" },
      })
    ).toThrow(/context_epoch/);
  });

  it("context_epoch без known_versions — легален: полная выдача с эхом эпохи (нечего сравнивать)", () => {
    insertFixture(db);
    const result = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
    }) as ConceptProfileOutput;
    expect(result.meta.context_epoch).toBe(EPOCH);
    expect(result.summary).toContain("Тихое обновление");
  });

  it("разбор аргументов MCP: delta — только одиночное чтение; с ids/continuation — явные ошибки", () => {
    expect(
      branchConceptToolArgs({ id: "x", context_epoch: EPOCH, known_versions: { x: "v" } }).mode
    ).toBe("profile");
    expect(() =>
      branchConceptToolArgs({ ids: ["x"], context_epoch: EPOCH, known_versions: { x: "v" } })
    ).toThrow(/delta|known_versions/i);
    expect(() =>
      branchConceptToolArgs({ continuation: "m1cont-abc", context_epoch: EPOCH, known_versions: { x: "v" } })
    ).toThrow(/delta|known_versions|continuation/i);
  });

  it("мера budget по фактической wire-форме и для unchanged, и для полной выдачи", () => {
    insertFixture(db);
    const v = evidenceVersion();
    const unchanged = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
      known_versions: { "auth-refresh": v },
    }) as unknown as Record<string, unknown>;
    expect(measureMcpPayload(unchanged)).toBeLessThan(700);
    const full = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      context_epoch: EPOCH,
    }) as unknown as Record<string, unknown>;
    expect(measureMcpPayload(full)).toBeGreaterThan(measureMcpPayload(unchanged));
  });
});
