/**
 * 2.1.13 F4: предупреждение о «вечных» утверждениях. «PR #3 не влит»,
 * «релиз опубликован» верны в момент записи — без valid_until узел со
 * временем тихо врёт. Сервер не блокирует и срок сам не ставит: мягкое
 * предупреждение в ответе, решение за агентом.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { createConcept, updateConcept, looksLikeStateClaim } from "../tools.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embed: vi.fn(async () => Buffer.alloc(0)),
    embedForStorage: vi.fn(async () => null),
    vectorSearchEnabled: vi.fn(() => false),
  };
});

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-state-claims-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
  delete process.env.MEGAMEMORY_DB_PATH;
});

describe("state claim warnings (F4 2.1.13)", () => {
  it("«PR #3 не влит» без срока → предупреждение, узел создан (тест 22)", async () => {
    const result = await createConcept(db, {
      name: "pr-3-state",
      kind: "feature",
      summary: "PR #3 не влит в main, ждём ревью: правки в feat/2.1.13, конфликтов нет, CI зелёный, ревьюер назначен.",
    });
    expect(result.id).toBe("pr-3-state");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0].code).toBe("state_claim_without_expiry");
    expect(result.warnings![0].hint).toContain("valid_until");
    // не блокирует
    expect(db.getNode("pr-3-state")).not.toBeNull();
  });

  it("то же саммари с valid_until → предупреждения нет (тест 23)", async () => {
    const result = await createConcept(db, {
      name: "pr-4-state",
      kind: "feature",
      summary: "PR #4 merged 2026-11-06 в main: консолидация опор, тесты зелёные, changelog дополнен.",
      valid_until: "2099-01-01",
    });
    expect(result.id).toBe("pr-4-state");
    expect(result.warnings).toBeUndefined();
  });

  it("архитектурный текст без маркеров состояния → предупреждения нет (тест 24)", async () => {
    const result = await createConcept(db, {
      name: "search-arch",
      kind: "module",
      summary:
        "Поиск работает через FTS5 с implicit AND; векторный канал включается после reembed",
    });
    expect(result.warnings).toBeUndefined();
  });

  it("update_concept при смене саммари на утверждение о состоянии → предупреждение (тест 25)", async () => {
    await createConcept(db, {
      name: "plain-node",
      kind: "module",
      summary: "обычное описание без маркеров",
    });
    const updated = await updateConcept(db, {
      id: "plain-node",
      changes: { summary: "релиз 2.1.13 выпущен, тег стоит на main" },
    });
    expect(updated.warnings).toHaveLength(1);
    expect(updated.warnings![0].code).toBe("state_claim_without_expiry");

    // правка с действующим сроком не предупреждает
    const withExpiry = await updateConcept(db, {
      id: "plain-node",
      changes: { summary: "влит в main, окно наблюдения до конца месяца", valid_until: "2099-06-01" },
    });
    expect(withExpiry.warnings).toBeUndefined();

    // правка без смены саммари не проверяется вовсе
    const noSummary = await updateConcept(db, {
      id: "plain-node",
      changes: { why: "уточнение" },
    });
    expect(noSummary.warnings).toBeUndefined();
  });

  it("просроченный valid_until → expired_on_create (тест 26)", async () => {
    const result = await createConcept(db, {
      name: "past-node",
      kind: "feature",
      summary: "Поиск отдаёт результаты через FTS5 с implicit AND — устойчивое знание без маркеров состояния.",
      valid_until: "2020-01-01",
    });
    expect(result.id).toBe("past-node");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0].code).toBe("expired_on_create");
  });

  it("kind=digest пропускает проверку утверждения о состоянии (тест 26а)", async () => {
    const result = await createConcept(db, {
      name: "digest-node",
      kind: "digest",
      summary: "Сводка модуля: релиз 2.1.13, PR #5 merged",
    });
    expect(result.id).toBe("digest-node");
    expect(result.warnings).toBeUndefined();
  });

  it("детектор: маркеры состояния, PR, semver, дата (юнит)", () => {
    for (const s of [
      "смержено в main",
      "PR влит",
      "не начат",
      "релиз опубликован",
      "v2.1.13",
      "2026-11-06",
      "issue закрыт",
      "merged into main",
      "pending review",
      "PR #42",
      "ветка закрыта",
    ]) {
      expect(looksLikeStateClaim(s), s).toBe(true);
    }
    for (const s of [
      "поиск через FTS5",
      "модуль отвечает за маршрутизацию",
      "конфиг читается из meta",
    ]) {
      expect(looksLikeStateClaim(s), s).toBe(false);
    }
  });
});
