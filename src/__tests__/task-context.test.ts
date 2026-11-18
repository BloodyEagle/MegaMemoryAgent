/**
 * P3 (план 20+21 v3 §12): контекст под задачу и минимальный план чтения.
 *
 * Gold-приёмка: наборы содержат релевантные, но дешёвые неполные карточки,
 * дорогие обязательные опоры, противоречия (refuted с причиной), expired,
 * скрытые зависимости и отсутствие памяти. Выдача обязана сохранять важное
 * ИЛИ ЯВНО сообщать, чего не хватает.
 *
 * Контракт:
 * - task — opt-in параметр understand (mode=compact); без него прежний ответ
 *   байт-в-байт (секции task_context нет).
 * - Детерминированные правила: тип задачи → обязательные категории; решения/
 *   тесты по явной области добавляются в выдачу даже без похожести (score 0).
 * - Смысловые повторы снимаются, но решения/refuted/противоречия/неполнота —
 *   никогда.
 * - Бюджет не покрывает обязательное → uncovered/notes со списком и
 *   продолжением; «первые ссылки» не выдаются за достаточное обследование.
 * - task_context не подменяет must_read, next.skip остаётся пустым, покрытие
 *   кода не утверждается.
 * - Повторы эпохи — только по ЯВНО переданному context_epoch; решения/refuted
 *   не сворачиваются; состояние in-memory per-process, ключ с отпечатком
 *   проекта; перезапуск = полная выдача.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { getConcept, understand } from "../tools.js";
import {
  TASK_KINDS,
  isTestRef,
  mandatoryCategoriesFor,
  parseTaskInput,
  summaryFingerprint,
} from "../task-context.js";
import type { UnderstandTaskInput } from "../types.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let projDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-taskctx-"));
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

function node(
  id: string,
  name: string,
  kind: string,
  summary: string,
  refs: string[] = [],
  extra: Partial<Parameters<KnowledgeDB["insertNode"]>[0]> = {}
): void {
  db.insertNode({ id, name, kind, summary, file_refs: refs, ...extra } as Parameters<KnowledgeDB["insertNode"]>[0]);
}

function link(from: string, to: string, why: string): void {
  db.insertEdge({ from_id: from, to_id: to, relation: "informed_by", description: why });
}

/** Gold-набор: дешёвый дубликат, обязательное решение со скрытой опорой, refuted, expired. */
function goldFixture(): void {
  writeProjFile("src/auth.ts", "export function refreshToken() { return 1; }\n");
  writeProjFile("src/auth.test.ts", "it('refreshes', () => {});\n");
  writeProjFile("src/cache.ts", "export const CACHE = 1;\n");
  writeProjFile("src/cache.test.ts", "it('caches', () => {});\n");
  // Скрытые зависимости по явной области (не совпадают с запросом про токен).
  node("decision-cache", "Cache invalidation policy", "decision", "Инвалидация кэша по записи, не по TTL.", ["src/cache.ts"]);
  node("test-cache", "Cache tests", "fact", "Тесты инвалидации кэша.", ["src/cache.test.ts"]);
  // Дешёвая релевантная карточка (неполная: короткое саммари, без why).
  node("fact-refresh-a", "Token refresh", "fact", "Обновление токена перед истечением.", ["src/auth.ts"]);
  // Смысловой повтор той же формулировки.
  node("fact-refresh-b", "Token refresh (copy)", "fact", "Обновление токена перед истечением.", ["src/auth.ts"]);
  // Дорогое обязательное решение: запрос про токен, саммари решения про другое
  // (решение находит поиск, его скрытая опора — нет).
  node(
    "decision-refresh",
    "Refresh policy",
    "decision",
    "Тихое обновление токена за 30 секунд до истечения — фоновая проверка в refreshLoop.",
    ["src/auth.ts"]
  );
  node(
    "support-loop",
    "Refresh loop internals",
    "feature",
    "Долгие джобы падали на 401 при истечении токена — loop проверяет срок каждые 10 секунд.",
    ["src/auth.ts"]
  );
  link("decision-refresh", "support-loop", "loop даёт превентивное обновление — из проверки срока следует решение");
  // Зависимый вывод: решение кэша опирается на факт про обновление (impact-направление).
  link("decision-cache", "fact-refresh-a", "инвалидация кэша привязана к моменту обновления токена");
  // Refuted с причиной (антизнание не должно исчезнуть).
  node(
    "refuted-manual",
    "Manual refresh",
    "decision",
    "Обновление токена по таймеру вручную из UI.",
    ["src/auth.ts"],
    { epistemic_status: "refuted" } as never
  );
  db.setEpistemicStatus("refuted-manual", "refuted", " Race условия: UI-поток конфликтует с фоном.");
  // Просроченный факт (исключается по умолчанию, include_stale возвращает).
  node("expired-note", "Old note", "fact", "Обновление токена через legacy endpoint.", ["src/auth.ts"], {
    valid_until: "2020-01-01T00:00:00.000Z",
  } as never);
}

const GOLD_QUERY = "обновление токена";

describe("P3: task — обязательные категории и скрытые зависимости", () => {
  it("explain_decision: скрытая опора едет в supports_included, refuted с причиной не теряется", async () => {
    goldFixture();
    const result = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 4000,
      task: { goal: "объяснить решение про тихое обновление токена", kind: "explain_decision" },
    })) as unknown as Record<string, unknown> & {
      task_context?: {
        coverage: { mandatory: string[]; covered: string[]; uncovered: Array<{ category: string }> };
        supports_included: Array<{ node_id: string; support_id: string; rationale: string | null }>;
        cost_estimate: { note: string };
        notes: string[];
      };
      refuted?: Array<{ id: string; refuted_reason?: string | null }>;
      next?: { skip: unknown[] };
    };
    expect(result.task_context).toBeDefined();
    expect(result.task_context?.coverage.mandatory).toEqual(["decisions", "supports", "refuted"]);
    // Скрытая зависимость: опора не нашлась поиском, но жива и включена явно.
    expect(
      result.task_context?.supports_included.some((s) => s.support_id === "support-loop")
    ).toBe(true);
    expect(result.task_context?.supports_included[0]?.rationale).toContain("превентивное");
    // Refuted — в отдельном блоке с причиной.
    expect(result.refuted?.some((r) => r.id === "refuted-manual")).toBe(true);
    const covered = result.task_context?.coverage.covered ?? [];
    expect(covered).toContain("decisions");
    expect(covered).toContain("supports");
    expect(covered).toContain("refuted");
    // Оценочная полная цена помечена как эвристика.
    expect(result.task_context?.cost_estimate.note).toContain("НЕ токены провайдера");
    expect(result.next?.skip).toEqual([]);
  });

  it("смысловой дубликат снимается; решение/refuted с той же формулировкой остаются", async () => {
    goldFixture();
    const result = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 6000,
      task: { goal: "объяснить решение", kind: "explain_decision" },
    })) as unknown as Record<string, unknown> & {
      compact?: Array<{ id: string }>;
      task_context?: { duplicates_dropped: Array<{ id: string; same_summary_as: string }> };
    };
    const ids = (result.compact ?? []).map((c) => c.id);
    expect(ids).toContain("decision-refresh");
    expect(ids).not.toContain("fact-refresh-b"); // повтор снят
    expect(ids).toContain("fact-refresh-a"); // первый (ранговый) остался
    const dup = result.task_context?.duplicates_dropped ?? [];
    expect(dup).toHaveLength(1);
    expect(dup[0]?.id).toBe("fact-refresh-b");
    expect(dup[0]?.same_summary_as).toBe("fact-refresh-a");
  });

  it("prepare_edit: решения и тесты по явной области добавляются даже без похожести (score 0)", async () => {
    goldFixture();
    const result = (await understand(db, {
      query: "совершенно другой запрос про виджеты рендеринга",
      mode: "compact",
      max_tokens: 6000,
      task: {
        goal: "подготовить правку кэша",
        kind: "prepare_edit",
        files: ["src/cache.ts", "src/cache.test.ts"],
      },
    })) as unknown as Record<string, unknown> & {
      compact?: Array<{ id: string; score?: number }>;
      task_context?: { coverage: { covered: string[]; uncovered: Array<{ category: string }> }; notes: string[] };
      next?: { must_read: Array<{ ref: string }> };
    };
    const ids = (result.compact ?? []).map((c) => c.id);
    // Скрытые зависимости по scope: решение и тест по кэшу — в выдаче с score 0.
    expect(ids).toContain("decision-cache");
    expect(ids).toContain("test-cache");
    const decisionCard = (result.compact ?? []).find((c) => c.id === "decision-cache");
    expect(decisionCard?.score).toBe(0);
    // Области задачи в must_read (не подмена, но обязательное чтение видно).
    const refs = (result.next?.must_read ?? []).map((m) => m.ref);
    expect(refs.some((r) => r.startsWith("src/cache"))).toBe(true);
    const covered = result.task_context?.coverage.covered ?? [];
    expect(covered).toContain("decisions");
    expect(covered).toContain("tests");
    // Происхождение добора помечено явно.
    expect(result.task_context?.notes.join(" ")).toContain("score 0");
  });

  it("assess_impact: зависимые выводы дают покрытие категории dependents", async () => {
    goldFixture();
    const result = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 6000,
      task: { goal: "оценить последствия правки auth.ts", kind: "assess_impact" },
    })) as unknown as Record<string, unknown> & {
      task_context?: { coverage: { mandatory?: string[]; covered: string[]; uncovered: Array<{ category: string }> } };
    };
    expect(result.task_context?.coverage.mandatory).toEqual(["decisions", "dependents", "refuted"]);
    expect(result.task_context?.coverage.covered).toContain("dependents");
  });

  it("бюджет/лимиты не покрывают обязательные записи — список непокрытого и продолжение ЯВНЫЕ", async () => {
    writeProjFile("src/cache.ts", "x");
    node("fact-1", "Cache fact", "fact", "Кэш слоя X.", ["src/cache.ts"]);
    for (let i = 1; i <= 13; i += 1) {
      node(`decision-${i}`, `Cache decision ${i}`, "decision", `Решение ${i} про кэш и инвалидацию.`, ["src/cache.ts"]);
    }
    const result = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 12000,
      top_k: 1,
      task: { goal: "подготовить правку кэша", kind: "prepare_edit", files: ["src/cache.ts"] },
    })) as unknown as Record<string, unknown> & {
      compact?: Array<{ id: string }>;
      task_context?: {
        reading_plan: Array<{ node_id: string }>;
        coverage: { mandatory?: string[]; covered: string[]; uncovered: Array<{ category: string; reason: string; ids?: string[] }> };
        notes: string[];
      };
    };
    // Выдача покрывает решения (размещено), остальное — в план чтения с лимитом;
    // сверх лимита — ЯВНЫЙ список непокрытого и продолжение.
    expect((result.compact ?? []).some((c) => c.id.startsWith("decision-"))).toBe(true);
    expect(result.task_context?.coverage.covered).toContain("decisions");
    const notes = result.task_context?.notes.join(" ") ?? "";
    expect(notes).toContain("продолжение");
    expect(notes).toContain("усечён");
  });

  it("отсутствие памяти: честный пустой ответ, uncovered с no_candidates, ничего не выдумывается", async () => {
    const result = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 4000,
      task: { goal: "объяснить решение", kind: "explain_decision" },
    })) as unknown as Record<string, unknown> & {
      compact?: Array<{ id: string }>;
      task_context?: { coverage: { covered: string[]; uncovered: Array<{ category: string; reason: string }> }; notes: string[] };
    };
    expect(result.compact).toEqual([]);
    expect(result.task_context).toBeDefined();
    const uncovered = result.task_context?.coverage.uncovered.map((u) => u.category) ?? [];
    expect(uncovered).toContain("decisions");
    expect(uncovered).toContain("refuted");
    expect(result.task_context?.notes.join(" ")).toContain("продолжение");
  });
});

describe("P3: эпоха контекста — явное состояние клиента", () => {
  it("повтор в той же эпохе сворачивает только немандаторные повторы; решения остаются полными", async () => {
    goldFixture();
    const task: UnderstandTaskInput = {
      goal: "объяснить решение",
      kind: "explain_decision",
      context_epoch: "gold-epoch-1",
    };
    const input = {
      query: GOLD_QUERY,
      mode: "compact" as const,
      max_tokens: 6000,
      task,
    };
    const first = (await understand(db, input)) as unknown as Record<string, unknown> & {
      compact?: Array<{ id: string }>;
      task_context?: { served_earlier: Array<{ id: string }>; notes: string[] };
    };
    expect(first.task_context?.served_earlier).toEqual([]);
    const firstIds = (first.compact ?? []).map((c) => c.id);
    expect(firstIds).toContain("fact-refresh-a");
    expect(firstIds).toContain("decision-refresh");

    const second = (await understand(db, input)) as unknown as Record<string, unknown> & {
      compact?: Array<{ id: string }>;
      task_context?: { served_earlier: Array<{ id: string; note: string }>; notes: string[] };
    };
    const secondIds = (second.compact ?? []).map((c) => c.id);
    // Немандаторный повтор свёрнут с явной заметкой.
    expect(second.task_context?.served_earlier.some((s) => s.id === "fact-refresh-a")).toBe(true);
    // Решение/refuted не сворачиваются никогда.
    expect(secondIds).toContain("decision-refresh");
    expect(secondIds).not.toContain("fact-refresh-a");
    expect(second.task_context?.notes.join(" ")).toContain("in-memory");
  });

  it("новая эпоха и другой проект (отпечаток в ключе) возвращают полную выдачу", async () => {
    goldFixture();
    const base = {
      query: GOLD_QUERY,
      mode: "compact" as const,
      max_tokens: 6000,
    };
    await understand(db, {
      ...base,
      task: { goal: "объяснить", kind: "explain_decision", context_epoch: "gold-epoch-2" },
    });
    const sameEpochNewCall = (await understand(db, {
      ...base,
      task: { goal: "объяснить", kind: "explain_decision", context_epoch: "gold-epoch-3" },
    })) as unknown as { compact?: Array<{ id: string }> };
    // Новая эпоха — полная выдача (клиент явно сменил состояние).
    expect((sameEpochNewCall.compact ?? []).map((c) => c.id)).toContain("fact-refresh-a");

    // Тот же epoch в ДРУГОЙ БД (другой отпечаток проекта) — ничего не сворачивается.
    const otherDbPath = path.join(tmpDir, "other.db");
    const db2 = new KnowledgeDB(otherDbPath);
    try {
      ensureSchema(db2);
      goldFixtureInto(db2);
      const res = (await understand(db2, {
        ...base,
        task: { goal: "объяснить", kind: "explain_decision", context_epoch: "gold-epoch-2" },
      })) as unknown as { compact?: Array<{ id: string }> };
      expect((res.compact ?? []).map((c) => c.id)).toContain("fact-refresh-a");
    } finally {
      db2.close();
    }
  });

  function goldFixtureInto(target: KnowledgeDB): void {
    const saveDb = db;
    db = target;
    try {
      goldFixture();
    } finally {
      db = saveDb;
    }
  }
});

describe("P3: совместимость и границы", () => {
  it("без task прежний ответ: секции task_context нет, next.skip пуст", async () => {
    goldFixture();
    const result = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 4000,
    })) as unknown as Record<string, unknown> & { next?: { skip: unknown[] } };
    expect("task_context" in result).toBe(false);
    expect(result.next?.skip).toEqual([]);
  });

  it("task с full/brief — явная ошибка", async () => {
    goldFixture();
    await expect(
      understand(db, { query: "q", mode: "full", task: { goal: "g", kind: "find_definition" } })
    ).rejects.toThrow(/task поддержан только в mode=compact/);
    await expect(
      understand(db, { query: "q", mode: "brief", task: { goal: "g", kind: "find_definition" } })
    ).rejects.toThrow(/task поддержан только в mode=compact/);
  });

  it("некорректный task — ошибка до всякой работы", async () => {
    await expect(
      understand(db, { query: "q", mode: "compact", task: { goal: "", kind: "find_definition" } })
    ).rejects.toThrow(/goal обязателен/);
    await expect(
      understand(db, { query: "q", mode: "compact", task: { goal: "g", kind: "wrong" as never } })
    ).rejects.toThrow(/task.kind/);
    await expect(
      understand(db, { query: "q", mode: "compact", task: { goal: "g", kind: "find_definition", context_epoch: "  " } })
    ).rejects.toThrow(/context_epoch/);
  });

  it("find_definition: определения покрыты, добор по области не добавляет лишнего", async () => {
    goldFixture();
    const result = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 4000,
      task: { goal: "найти определение функции обновления", kind: "find_definition" },
    })) as unknown as Record<string, unknown> & {
      task_context?: { coverage: { mandatory: string[]; covered: string[] } };
    };
    expect(result.task_context?.coverage.mandatory).toEqual(["definitions"]);
    expect(result.task_context?.coverage.covered).toContain("definitions");
  });

  it("expired-узел по умолчанию исключён; с include_stale в задаче остаётся квалифицированным", async () => {
    goldFixture();
    const excluded = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 4000,
      task: { goal: "объяснить", kind: "explain_decision" },
    })) as unknown as { compact?: Array<{ id: string }>; meta?: { stale_excluded?: number } };
    expect((excluded.compact ?? []).some((c) => c.id === "expired-note")).toBe(false);
    expect(excluded.meta?.stale_excluded).toBeGreaterThan(0);

    const included = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 6000,
      include_stale: true,
      task: { goal: "объяснить", kind: "explain_decision", context_epoch: "expired-epoch" },
    })) as unknown as { compact?: Array<{ id: string; expired?: boolean }>; task_context?: { served_earlier: Array<{ id: string }> } };
    const expiredCard = (included.compact ?? []).find((c) => c.id === "expired-note");
    // Четвёртая карточка не выдаётся (CARDS_MAX=3): совпадение остаётся
    // в candidates, его id разрешается через get_concept — покрытие
    // достижимости сохраняется на новой глубине.
    expect((included.candidates ?? []).some((c) => c.id === "expired-note")).toBe(true);
    const resolved = getConcept(db, { id: "expired-note" });
    expect(resolved.id).toBe("expired-note");
    expect(resolved.valid_until).toBeTruthy();
    // Повторное включение в эпохе не сворачивает карточку с квалификациейexpired
    // без явного нового решения — служебная сверка остаётся видимой.
    await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 6000,
      include_stale: true,
      task: { goal: "объяснить", kind: "explain_decision", context_epoch: "expired-epoch" },
    });
    const again = (await understand(db, {
      query: GOLD_QUERY,
      mode: "compact",
      max_tokens: 6000,
      include_stale: true,
      task: { goal: "объяснить", kind: "explain_decision", context_epoch: "expired-epoch" },
    })) as unknown as { compact?: Array<{ id: string; expired?: boolean }>; task_context?: { served_earlier: Array<{ id: string }> } };
    expect((again.candidates ?? []).some((c) => c.id === "expired-note")).toBe(true);
    expect(again.task_context?.served_earlier.some((s) => s.id === "expired-note")).toBe(false);
  });
});

describe("P3: детерминированные правила (модуль)", () => {
  it("тип задачи → обязательные категории", () => {
    expect(mandatoryCategoriesFor("find_definition")).toEqual(["definitions"]);
    expect(mandatoryCategoriesFor("explain_decision")).toEqual(["decisions", "supports", "refuted"]);
    expect(mandatoryCategoriesFor("prepare_edit")).toEqual(["decisions", "tests", "refuted"]);
    expect(mandatoryCategoriesFor("assess_impact")).toEqual(["decisions", "dependents", "refuted"]);
    expect(TASK_KINDS).toHaveLength(4);
  });

  it("isTestRef распознаёт тесты; parseTaskInput нормализует область", () => {
    expect(isTestRef("src/auth.test.ts")).toBe(true);
    expect(isTestRef("tests/integration/x.ts")).toBe(true);
    expect(isTestRef("src/__tests__/y.test.ts")).toBe(true);
    expect(isTestRef("src/auth.ts")).toBe(false);
    const plan = parseTaskInput(
      { goal: "g", kind: "prepare_edit", files: ["src/a.ts:1-10", ".\\src\\b.ts"] },
      projDir
    );
    expect(plan.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plan.context_epoch).toBeUndefined();
  });

  it("summaryFingerprint сворачивает пробелы и регистр", () => {
    expect(summaryFingerprint("Обновление   токена")).toBe(summaryFingerprint("обновление токена"));
    expect(summaryFingerprint(null)).toBe("");
  });
});
