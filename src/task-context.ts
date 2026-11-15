/**
 * P3 (план 20+21 v3 §12): контекст под задачу и минимальный план чтения.
 *
 * Ключевые решения:
 * - Opt-in параметр task в understand (mode=compact): явная цель и ТИП задачи
 *   → детерминированные правила отбора (§12.3): тип задачи задаёт ОБЯЗАТЕЛЬНЫЕ
 *   категории источников — решения, опоры/инварианты, отрицательные результаты
 *   (refuted), тесты, зависимые выводы. Никакого платного LLM-reranker (§12.6).
 * - Отбор — не просто top-k похожих текстов: обязательные кандидаты поднимаются
 *  в размещение (в ранговом порядке среди себя), а решения/тесты по явной
 *   области задачи добавляются в выдачу даже если поиск их не ранжировал
 *   (скрытые зависимости — score 0 и пометка происхождения в notes).
 * - Смысловые повторы снимаются с верхнего уровня (§12.4), но НЕ снимаются
 *   решения, refuted с причиной, противоречащие выводы (contradicts) и
 *   неполнота — они защищены от дедупликации и от сворачивания эпохи.
 * - Приоритет включает приблизительную ПОЛНУЮ цену (§12.5): карточки (bytes/3
 *   текущей формы) + follow-up вызовы + обязательное чтение (фактические
 *   размеры файлов) + пометка о цене проверки актуальности. Явно оценочная
 *   эвристика, не токены провайдера.
 * - Если бюджет/выдача не покрывает обязательные источники (§12.7) — список
 *   непокрытого (uncovered с причиной) и продолжение в notes; «первые три
 *   ссылки» не выдаются за достаточное обследование.
 * - Legacy next сохраняет совместимость (§12.8): next.skip остаётся пустым,
 *   task_context не подменяет must_read и не утверждает whole-file coverage.
 * - Повторная выдача (§12.9): только с ЯВНО переданным context_epoch клиента
 *   (не вывод из 30-минутной сессии timeline). Состояние — in-memory этого
 *   процесса, ключ = (отпечаток проекта, эпоха); перезапуск сервера сбрасывает
 *   его — тогда просто снова полная выдача, никакого скрытого знания. Идентичность
 *   проекта входит в ключ: одинаковая эпоха в другой БД не сворачивает выдачу.
 * - Профиль задачи встраивается в understand-ответ (§12.10) — он НЕ добавляет
 *   обязательный запрос «за планом» перед прежней цепочкой.
 */

import fs from "node:fs";
import path from "node:path";
import { isNodeExpired, type KnowledgeDB } from "./db.js";
import { estimateTokens } from "./tools.js";
import { isUngrounded } from "./provenance.js";
import { parseRef } from "./refs.js";
import type {
  CompactMatch,
  NextHints,
  NodeRow,
  TaskContextCostEstimate,
  TaskContextServedEarlier,
  TaskContextView,
  TaskKind,
  UnderstandTaskInput,
} from "./types.js";

export const TASK_KINDS: TaskKind[] = [
  "find_definition",
  "explain_decision",
  "prepare_edit",
  "assess_impact",
];

/** Границы «честных списков» секции. */
const READING_PLAN_CAP = 6;
const SUPPORTS_CAP = 12;
const BOOST_DECISIONS_CAP = 5;
const BOOST_TESTS_CAP = 5;
const BOOST_REFUTED_CAP = 3;
const COST_READING_CAP = 10;

/**
 * Детерминированные правила (§12.3): тип задачи → обязательные категории
 * источников. «Инварианты» отображаются на опоры решений (rationale ребра
 * informed_by) — отдельного вида «инвариант» в схеме нет.
 */
export function mandatoryCategoriesFor(kind: TaskKind): string[] {
  switch (kind) {
    case "find_definition":
      return ["definitions"];
    case "explain_decision":
      return ["decisions", "supports", "refuted"];
    case "prepare_edit":
      return ["decisions", "tests", "refuted"];
    case "assess_impact":
      return ["decisions", "dependents", "refuted"];
  }
}

/** Тестовый файл по ссылке (для категории «тесты»; пилот без маскировки исключений). */
export function isTestRef(ref: string): boolean {
  const p = parseRef(ref).path.replace(/\\/g, "/").toLowerCase();
  if (/\.(test|spec)\.[mc]?[jt]sx?$/.test(p)) return true;
  return /(^|\/)(tests?|__tests__|spec)(\/|$)/.test(p);
}

/** Отпечаток смысла для дедупликации повторов: нормализация пробелов, без регистра. */
export function summaryFingerprint(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Нормализованные пути явной области задачи. */
export function normalizeTaskFiles(files: string[] | undefined): string[] {
  if (!files) return [];
  const out: string[] = [];
  for (const f of files) {
    if (typeof f !== "string" || f.trim() === "") continue;
    out.push(parseRef(f).path.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return [...new Set(out)];
}

/** Валидация входа task (ошибки ДО всякой работы understand). */
export function parseTaskInput(input: UnderstandTaskInput, root: string): TaskPlan {
  const goal = (input.goal ?? "").trim();
  if (!goal) {
    throw new Error("understand: task.goal обязателен — явная цель задачи (§12.1).");
  }
  if (!TASK_KINDS.includes(input.kind)) {
    throw new Error(
      `understand: task.kind должен быть одним из ${TASK_KINDS.join(", ")}, получено: ${String(input.kind)}.`
    );
  }
  if (input.context_epoch !== undefined && (typeof input.context_epoch !== "string" || input.context_epoch.trim() === "")) {
    throw new Error("understand: task.context_epoch должен быть непустой строкой (явное состояние клиента).");
  }
  return {
    goal,
    kind: input.kind,
    files: normalizeTaskFiles(input.files),
    root,
    ...(input.context_epoch !== undefined ? { context_epoch: input.context_epoch.trim() } : {}),
  };
}

export interface TaskPlan {
  goal: string;
  kind: TaskKind;
  files: string[];
  root: string;
  context_epoch?: string;
}

// ---- Явное состояние клиента: эпохи контекста (§12.9) ----
//
// In-memory per-process: ключ (отпечаток проекта, эпоха) → id узла → отпечаток
// смысла. Перезапуск сбрасывает — тогда полная выдача, ничего не теряется.
// Никогда не строится из timeline/сессий: только переданный клиентом epoch.

const epochStore = new Map<string, Map<string, string>>();
const EPOCH_STORE_CAP = 20;
const EPOCH_SERVED_CAP = 100;

function epochStoreKey(db: KnowledgeDB, epoch: string): string {
  const project = db.dbPath.replace(/\\/g, "/").toLowerCase();
  return `${project}\u0000${epoch}`;
}

function epochServed(db: KnowledgeDB, epoch: string): Map<string, string> | null {
  if (!epoch) return null;
  return epochStore.get(epochStoreKey(db, epoch)) ?? null;
}

function epochRecord(db: KnowledgeDB, epoch: string, cards: Array<{ id: string; summary: string }>): void {
  if (!epoch) return;
  const key = epochStoreKey(db, epoch);
  let served = epochStore.get(key);
  if (!served) {
    served = new Map();
    epochStore.set(key, served);
    while (epochStore.size > EPOCH_STORE_CAP) {
      const oldest = epochStore.keys().next().value;
      if (oldest === undefined) break;
      epochStore.delete(oldest);
    }
  }
  for (const c of cards) {
    served.set(c.id, summaryFingerprint(c.summary));
    while (served.size > EPOCH_SERVED_CAP) {
      const oldest = served.keys().next().value;
      if (oldest === undefined) break;
      served.delete(oldest);
    }
  }
}

// ---- Добор обязательных кандидатов по явной области (скрытые зависимости) ----

export interface TaskBoost {
  decisions: NodeRow[];
  tests: NodeRow[];
  refuted: NodeRow[];
  /** Категории, где были записи сверх лимита (непокрытое из-за бюджета). */
  overflow: Array<{ category: string; ids: string[] }>;
}

export interface TaskBoostCaps {
  decisions: number;
  tests: number;
  refuted: number;
}

/** Лимиты добора в размещение (понять масштаб: больше — только в план чтения). */
export const BOOST_DEFAULT_CAPS: TaskBoostCaps = {
  decisions: BOOST_DECISIONS_CAP,
  tests: BOOST_TESTS_CAP,
  refuted: BOOST_REFUTED_CAP,
};

/**
 * Узлы, цитирующие файлы явной области задачи (детерминированный ограниченный
 * LIKE-скан с пост-фильтром точного совпадения путей). Решения и тесты по
 * области обязательны для своего типа задачи — поиск их мог не ранжировать.
 * Без явной области добора нет: кандидатами остаются результаты поиска.
 * Записи сверх лимитов едут в overflow — непокрытое из-за бюджета НЕ молчит.
 */
export function collectTaskBoost(
  db: KnowledgeDB,
  plan: TaskPlan,
  excludeIds: Set<string>,
  caps: TaskBoostCaps = BOOST_DEFAULT_CAPS
): TaskBoost {
  const boost: TaskBoost = { decisions: [], tests: [], refuted: [], overflow: [] };
  if (plan.files.length === 0) return boost;
  const want = new Set(plan.files.map((f) => f.toLowerCase()));
  const citesTaskFile = (raw: string | null): boolean => {
    if (!raw) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return false;
      for (const ref of parsed) {
        if (typeof ref === "string" && want.has(parseRef(ref).path.replace(/\\/g, "/").toLowerCase())) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  };
  // Ограниченный кандидатский набор: LIKE только сужает выборку, точность —
  // пост-фильтр по разобранному JSON file_refs.
  const rows = db.execSqlAll(
    `SELECT id, name, kind, summary, file_refs, epistemic_status, created_via FROM nodes
     WHERE removed_at IS NULL AND file_refs IS NOT NULL
       AND (${plan.files.map(() => "file_refs LIKE ?").join(" OR ")})
     LIMIT 40`
  , ...plan.files.map((f) => `%${f}%`)) as Array<{
    id: string;
    name: string;
    kind: string;
    summary: string;
    file_refs: string;
    epistemic_status: string | null;
    created_via: string;
  }>;
  for (const row of rows) {
    if (excludeIds.has(row.id)) continue;
    if (!citesTaskFile(row.file_refs)) continue;
    const node = row as unknown as NodeRow;
    if (node.epistemic_status === "refuted") {
      if (boost.refuted.length < caps.refuted) boost.refuted.push(node);
      else pushOverflow(boost, "refuted", node.id);
      continue;
    }
    const testCiting = (() => {
      try {
        const parsed: unknown = JSON.parse(row.file_refs);
        return Array.isArray(parsed) && parsed.some((r) => typeof r === "string" && isTestRef(r));
      } catch {
        return false;
      }
    })();
    if (row.kind === "decision") {
      if (boost.decisions.length < caps.decisions) boost.decisions.push(node);
      else pushOverflow(boost, "decisions", node.id);
    } else if (testCiting && plan.kind === "prepare_edit") {
      if (boost.tests.length < caps.tests) boost.tests.push(node);
      else pushOverflow(boost, "tests", node.id);
    }
  }
  return boost;
}

function pushOverflow(boost: TaskBoost, category: string, id: string): void {
  const bucket = boost.overflow.find((o) => o.category === category);
  if (bucket) bucket.ids.push(id);
  else boost.overflow.push({ category, ids: [id] });
}

/**
 * Карточки, защищённые от дедупликации/сворачивания: решения, refuted,
 * abandoned, expired (временнАя квалификация не скрывается), тесты,
 * противоречия. Причина refuted и неполнота не снимаются никогда (§12.4).
 */
export function protectedCardIds(db: KnowledgeDB, cards: Array<{ id: string }>): Set<string> {
  const protectedIds = new Set<string>();
  for (const card of cards) {
    const row = db.getNode(card.id);
    if (!row) continue;
    if (
      row.kind === "decision" ||
      row.epistemic_status === "refuted" ||
      row.epistemic_status === "abandoned" ||
      isNodeExpired(row)
    ) {
      protectedIds.add(card.id);
      continue;
    }
    const refs = (() => {
      try {
        const parsed: unknown = JSON.parse(row.file_refs ?? "null");
        return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
      } catch {
        return [];
      }
    })();
    if (refs.some(isTestRef)) protectedIds.add(card.id);
  }
  // Противоречащие выводы (contradicts) не снимаются никогда (§12.4).
  try {
    for (const row of db.getContradictedNodes()) protectedIds.add(row.id);
  } catch {
    // merge_conflicts может отсутствовать в старой базе — защита опирается
    // на остальные предикаты.
  }
  return protectedIds;
}

/**
 * Дедупликация смысла (§12.4): повтор с тем же отпечатком саммари снимается с
 * верхнего уровня, первый (ранговый) остаётся. Защищённые категории и карты со
 * свёрнутыми опорами не снимаются — ничего не теряется и не осиротевает.
 */
export function dedupeTaskDuplicates(
  db: KnowledgeDB,
  compact: CompactMatch[]
): { removeIds: string[]; duplicates: TaskContextView["duplicates_dropped"] } {
  const protectedIds = protectedCardIds(db, compact);
  const seen = new Map<string, string>();
  const removeIds: string[] = [];
  const duplicates: TaskContextView["duplicates_dropped"] = [];
  for (const card of compact) {
    const fp = summaryFingerprint(card.summary);
    const firstId = seen.get(fp);
    if (firstId === undefined) {
      seen.set(fp, card.id);
      continue;
    }
    if (protectedIds.has(card.id) || (card.supports?.length ?? 0) > 0) continue;
    removeIds.push(card.id);
    duplicates.push({ id: card.id, name: card.name, kind: card.kind, same_summary_as: firstId });
  }
  return { removeIds, duplicates };
}

/**
 * Повторная выдача (§12.9): карточка, уже отданная в этой эпохе контекста с тем
 * же смыслом, сворачивается в served_earlier (id остаётся, полная карточка —
 * get_concept). Решения/refuted/тесты/противоречия и карты с опорами не
 * сворачиваются. Без task.context_epoch функция ничего не делает.
 */
export function applyTaskEpoch(
  db: KnowledgeDB,
  plan: TaskPlan,
  compact: CompactMatch[]
): { removeIds: string[]; servedEarlier: TaskContextServedEarlier[] } {
  const servedEarlier: TaskContextServedEarlier[] = [];
  const removeIds: string[] = [];
  const epoch = plan.context_epoch;
  if (!epoch) return { removeIds, servedEarlier };
  const served = epochServed(db, epoch);
  if (served) {
    const protectedIds = protectedCardIds(db, compact);
    for (const card of compact) {
      const seenFp = served.get(card.id);
      if (seenFp === undefined) continue;
      if (seenFp !== summaryFingerprint(card.summary)) continue; // смысл изменился — полная карточка
      if (protectedIds.has(card.id) || (card.supports?.length ?? 0) > 0) continue;
      removeIds.push(card.id);
      servedEarlier.push({
        id: card.id,
        name: card.name,
        kind: card.kind,
        note: "уже выдан в этой эпохе контекста (смысл не изменился); полная карточка — get_concept по id",
      });
    }
  }
  return { removeIds, servedEarlier };
}

/** Запомнить выданный набор эпохи (после снятия повторов). */
export function recordTaskEpoch(db: KnowledgeDB, plan: TaskPlan, compact: CompactMatch[]): void {
  epochRecord(db, plan.context_epoch ?? "", compact.map((c) => ({ id: c.id, summary: c.summary })));
}

// ---- Сборка секции task_context (после размещения и снятия повторов) ----

export interface TaskContextBuild {
  compact: CompactMatch[];
  refuted: CompactMatch[];
  next: NextHints;
}

function liveSupportsOfPlacedDecisions(db: KnowledgeDB, compact: CompactMatch[]): TaskContextView["supports_included"] {
  const nestedVisible = new Set<string>();
  for (const card of compact) {
    for (const s of card.supports ?? []) nestedVisible.add(s.id);
  }
  const out: TaskContextView["supports_included"] = [];
  const seenPairs = new Set<string>();
  for (const card of compact) {
    const row = db.getNode(card.id);
    if (!row || row.kind !== "decision") continue;
    for (const edge of db.getInformedByEdges(row.id, "ancestry", false)) {
      if (edge.other_id === row.id) continue;
      const support = db.getNode(edge.other_id);
      if (!support) continue;
      const pairKey = `${row.id}:${support.id}`;
      if (seenPairs.has(pairKey) || nestedVisible.has(support.id)) continue;
      seenPairs.add(pairKey);
      out.push({
        node_id: row.id,
        support_id: support.id,
        support_name: support.name,
        rationale: edge.description ?? null,
        ...(support.epistemic_status === "refuted" ||
        support.epistemic_status === "abandoned" ||
        isUngrounded(db, support)
          ? { weak: true }
          : {}),
      });
      if (out.length >= SUPPORTS_CAP) return out;
    }
  }
  return out;
}

function fileSizeOf(root: string, ref: string): number | null {
  try {
    const parsed = parseRef(ref);
    const abs = path.isAbsolute(parsed.path) ? parsed.path : path.resolve(root, parsed.path);
    const stat = fs.statSync(abs);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Сборка секции контекста под задачу. Только чтение; детерминированно. */
export function buildTaskContext(
  db: KnowledgeDB,
  plan: TaskPlan,
  build: TaskContextBuild
): TaskContextView {
  const { compact, refuted, next } = build;
  const mandatory = mandatoryCategoriesFor(plan.kind);
  const covered: string[] = [];
  const uncovered: TaskContextView["coverage"]["uncovered"] = [];
  const notes: string[] = [];

  // --- Категории: покрытие по фактически выданному набору и плану чтения ---
  const placedKinds = new Set<string>();
  for (const card of compact) {
    const row = db.getNode(card.id);
    placedKinds.add(row?.kind ?? card.kind);
  }
  const placedTests = compact.some((card) => {
    const row = db.getNode(card.id);
    if (!row) return false;
    try {
      const parsed: unknown = JSON.parse(row.file_refs ?? "null");
      return Array.isArray(parsed) && parsed.some((r) => typeof r === "string" && isTestRef(r));
    } catch {
      return false;
    }
  });

  const supportsIncluded = liveSupportsOfPlacedDecisions(db, compact);

  // Зависимые выводы размещённых узлов (для assess_impact).
  let dependentCount = 0;
  if (plan.kind === "assess_impact") {
    for (const card of compact) {
      for (const e of db.getEdgeRefsIn(card.id)) {
        if (e.relation === "informed_by") dependentCount += 1;
      }
    }
  }

  // --- План чтения: обязательные источники вне выдачи (§12.7) ---
  const readingPlan: TaskContextView["reading_plan"] = [];
  const uncoveredBudgetIds: string[] = [];
  const boostOverflow: Array<{ category: string; ids: string[] }> = [];
  if (plan.files.length > 0) {
    const placedIds = new Set(compact.map((c) => c.id));
    // Для плана чтения лимиты шире добора в размещение; сверх этого —
    // непокрытое из-за бюджета (ЯВНО, не молча).
    const boost = collectTaskBoost(db, plan, placedIds, {
      decisions: BOOST_DECISIONS_CAP + READING_PLAN_CAP,
      tests: BOOST_TESTS_CAP + READING_PLAN_CAP,
      refuted: BOOST_REFUTED_CAP + READING_PLAN_CAP,
    });
    boostOverflow.push(...boost.overflow);
    const candidates: Array<{ node: NodeRow; why: string }> = [];
    if (mandatory.includes("decisions")) {
      for (const d of boost.decisions) {
        candidates.push({ node: d, why: "решение по явной области задачи, не вошедшее в выдачу — прочитай и квалифицируй" });
      }
    }
    if (mandatory.includes("tests")) {
      for (const t of boost.tests) {
        candidates.push({ node: t, why: "тест по явной области задачи — вывод, опирающийся на поведение, требует тестов" });
      }
    }
    for (const r of boost.refuted) {
      candidates.push({ node: r, why: `отрицательный результат по области задачи: причина в карточке (refuted)` });
    }
    for (const c of candidates) {
      const refs = (() => {
        try {
          const parsed: unknown = JSON.parse(c.node.file_refs ?? "null");
          return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
        } catch {
          return [];
        }
      })();
      if (readingPlan.length >= READING_PLAN_CAP) {
        uncoveredBudgetIds.push(c.node.id);
        continue;
      }
      readingPlan.push({
        ref: refs[0] ?? "(без file_refs)",
        why: `${c.why}: «${c.node.name}»`,
        node_id: c.node.id,
      });
    }
  }

  // --- Покрытие обязательных категорий ---
  const overflowIds = boostOverflow.flatMap((o) => o.ids);
  for (const category of mandatory) {
    if (category === "definitions") {
      if (compact.length > 0) covered.push(category);
      else uncovered.push({ category, reason: "no_candidates" });
    } else if (category === "decisions") {
      const placedDecisions = [...placedKinds].filter((k) => k === "decision").length;
      const planDecisions = readingPlan.some((r) => db.getNode(r.node_id)?.kind === "decision");
      if (placedDecisions > 0 || planDecisions) {
        covered.push(category);
      } else if (overflowIds.length > 0 || uncoveredBudgetIds.length > 0) {
        uncovered.push({ category, reason: "budget", ...(uncoveredBudgetIds.length > 0 ? { ids: uncoveredBudgetIds } : {}) });
      } else {
        uncovered.push({ category, reason: "no_candidates" });
      }
    } else if (category === "supports") {
      if (supportsIncluded.length > 0 || compact.some((c) => (c.supports?.length ?? 0) > 0)) {
        covered.push(category);
      } else {
        uncovered.push({ category, reason: "no_candidates" });
      }
    } else if (category === "refuted") {
      if (refuted.length > 0) covered.push(category);
      else uncovered.push({ category, reason: "no_candidates" });
    } else if (category === "tests") {
      const planTests = readingPlan.some((r) => {
        const row = db.getNode(r.node_id);
        if (!row) return false;
        try {
          const parsed: unknown = JSON.parse(row.file_refs ?? "null");
          return Array.isArray(parsed) && parsed.some((x) => typeof x === "string" && isTestRef(x));
        } catch {
          return false;
        }
      });
      if (placedTests || planTests) {
        covered.push(category);
      } else if (overflowIds.length > 0 || uncoveredBudgetIds.length > 0) {
        uncovered.push({ category, reason: "budget", ...(uncoveredBudgetIds.length > 0 ? { ids: uncoveredBudgetIds } : {}) });
      } else {
        uncovered.push({ category, reason: "no_candidates" });
      }
    } else if (category === "dependents") {
      if (dependentCount > 0) covered.push(category);
      else uncovered.push({ category, reason: "no_candidates" });
    }
  }

  // --- Оценочная полная цена (§12.5) ---
  const readingRefs = new Map<string, string>();
  for (const r of next.must_read) readingRefs.set(r.ref, r.why);
  for (const r of readingPlan) if (!readingRefs.has(r.ref)) readingRefs.set(r.ref, r.why);
  const reading: TaskContextCostEstimate["reading"] = [];
  let readingBytesTotal = 0;
  for (const [ref, why] of readingRefs) {
    if (reading.length >= COST_READING_CAP) break;
    const size = fileSizeOf(plan.root, ref);
    reading.push({ ref, size_bytes: size });
    readingBytesTotal += size ?? 0;
  }
  const cost: TaskContextCostEstimate = {
    cards_tokens: estimateTokens(JSON.stringify(compact)),
    followup_calls: next.followups.length,
    reading,
    reading_bytes_total: readingBytesTotal,
    note:
      "оценка эвристическая (bytes/3 по текущей форме + фактические размеры обязательного чтения), НЕ токены провайдера; " +
      "проверка актуальности (check_freshness/check_artifacts) и подтверждение опор — дополнительные явные расходы",
  };

  // --- Notes: границы секции (§12.8) и продолжение при неполном бюджете (§12.7) ---
  notes.push(
    "task_context не подменяет must_read: next.skip остаётся пустым; чтение по плану не является покрытием файла целиком"
  );
  notes.push(
    "решения, refuted с причиной, противоречия и неполнота не снимаются дедупликацией и не сворачиваются эпохой"
  );
  if (uncovered.length > 0) {
    notes.push(
      `обязательные категории не покрыты: ${uncovered.map((u) => u.category).join(", ")} — продолжение: увеличь max_tokens, уточни запрос или прочитай reading_plan; «первые ссылки» не являются достаточным обследованием`
    );
  }
  if (uncoveredBudgetIds.length > 0) {
    notes.push(`план чтения усечён лимитом ${READING_PLAN_CAP}: ещё ${uncoveredBudgetIds.length} записей по области задачи (${uncoveredBudgetIds.join(", ")})`);
  }
  for (const o of boostOverflow) {
    notes.push(
      `добор по области задачи усечён лимитом категории "${o.category}": ${o.ids.length} записей не попали ни в выдачу, ни в план чтения (${o.ids.join(", ")}) — это НЕ полный список обязательных источников`
    );
  }
  if (plan.files.length > 0) {
    notes.push("добавленные по области задачи решения/тесты имеют score 0 — это явный добор по scope, не ранжирование похожести");
  }
  if (plan.context_epoch) {
    notes.push("состояние эпохи — in-memory этого процесса: перезапуск сервера возвращает полную выдачу (ничего не теряется)");
  }

  return {
    goal: plan.goal,
    kind: plan.kind,
    scope_files: plan.files,
    coverage: { mandatory, covered, uncovered },
    supports_included: supportsIncluded,
    reading_plan: readingPlan,
    cost_estimate: cost,
    served_earlier: [],
    duplicates_dropped: [],
    notes,
  };
}
