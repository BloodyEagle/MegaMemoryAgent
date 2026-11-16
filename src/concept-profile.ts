/**
 * E1/E2 (план 20+21 v3 §8): бюджетные проекции get_concept (профили
 * orientation/evidence/full) и пакетное чтение.
 *
 * Ключевые решения:
 * - Старый одиночный вызов getConcept (tools.ts) не меняется: профильные и
 *   пакетные ответы собирают отдельные функции; MCP-обработчик ветвится по
 *   явным параметрам (ids/profile/max_tokens/max_neighbors/continuation).
 * - Бюджет считается по ФАКТИЧЕСКИ сериализованному wire-ответу
 *   (measureMcpPayload — pretty-JSON внутри MCP-конверта, §4.3); число —
 *   оценка существующим estimator'ом (estimateTokens, ~байты/3), не гарантия
 *   токенов провайдера — в ответе это обозначено именем tokens_estimated.
 * - Раскрытие соседей и вычисления бюджетируются по ходу сборки: полная
 *   карточка не строится ради последующего отбрасывания (лёгкие списки
 *   db.getChildrenIds/getEdgeRefsOut/getEdgeRefsIn вместо полных выборок).
 * - Обязательное ядро любого минимума: идентичность, lifecycle/epistemic
 *   квалификация, expiry, причины refuted и предупреждение weak_support —
 *   бюджет не режет их (§4.3).
 * - Существенные формулировки не обрезаются: не поместилось — явная
 *   неполнота + следующий шаг; сокращённое чтение не выдаётся за достаточное
 *   для подтверждения (§4.1).
 * - Продолжение фиксирует версию выборки: состав списка, состояние якоря и
 *   состояние уже выданных элементов; расхождение — version_conflict
 *   (повторить чтение), а не склейка страниц разных состояний. Формулировка
 *   конкретного элемента всегда едет с его собственными дайджестами, поэтому
 *   confirm_supports на устаревшей странице отклоняется независимо.
 * - Ошибка одного элемента пакета не маскирует успешных соседей, а
 *   неразрешённый id не исчезает молча.
 *
 * Схема БД не меняется: новые формы — только слой выдачи.
 */

import { createHash } from "crypto";
import type { KnowledgeDB } from "./db.js";
import { isNodeExpired } from "./db.js";
import type {
  ConceptBatchInput,
  ConceptBatchItem,
  ConceptBatchMeta,
  ConceptBatchOutput,
  ConceptDeltaOutput,
  ConceptEvidenceSupport,
  ConceptProfileIncomplete,
  ConceptProfileInput,
  ConceptProfileMeta,
  ConceptProfileNeighborCount,
  ConceptProfileOutput,
  GetConceptProfile,
  NodeKind,
  NodeRow,
  NodeWithContext,
  RelationType,
} from "./types.js";
import {
  buildNodeWithContext,
  currentDigestsOf,
  estimateTokens,
  evidenceSupportOf,
  measureMcpPayload,
  parseFileRefs,
  parseStatusScope,
  trailState,
  trimSummary,
} from "./tools.js";
import { activeArtifactRows, artifactsDigestOf } from "./artifacts.js";
import {
  CheckBudget,
  DEFAULT_MAX_CHECK_BYTES,
  DEFAULT_MAX_CHECK_EDGES,
  claimDigestOf,
  computeSupportCheck,
  statusDigestOf,
} from "./support-baselines.js";
import { isUngrounded } from "./provenance.js";

// ---- Пределы (константы + явные dropped/truncated, E2) ----

/** Максимум id в одном пакетном вызове. */
export const MAX_BATCH_ITEMS = 25;
/** Лимит раскрытия соседей на один список (по умолчанию). */
export const DEFAULT_MAX_NEIGHBORS = 20;
/** Бюджет по умолчанию для orientation (краткая карточка с указателями). */
export const ORIENTATION_DEFAULT_TOKENS = 1500;
/** Бюджет по умолчанию для evidence. */
export const EVIDENCE_DEFAULT_TOKENS = 4000;
/** Общий бюджет пакета по умолчанию. */
export const BATCH_DEFAULT_TOKENS = 4000;
/** Кап вычислений support-check на один пакет (первые элементы пакета). */
export const MAX_BATCH_SUPPORT_CHECKS = 10;
/** Минимум поддержки в max_tokens (каждый вызов стоит конверт). */
export const MIN_PROFILE_TOKENS = 100;

const PROFILES: readonly GetConceptProfile[] = ["orientation", "evidence", "full"];

type NeighborList =
  | "children"
  | "edges"
  | "incoming_edges"
  | "informed_by"
  | "informed_by_incoming"
  | "trails";

const ORIENTATION_LISTS: readonly NeighborList[] = [
  "children",
  "edges",
  "incoming_edges",
  "informed_by",
  "informed_by_incoming",
  "trails",
];

function zeroCounts(): ConceptProfileNeighborCount {
  return {
    children: 0,
    edges: 0,
    incoming_edges: 0,
    informed_by: 0,
    informed_by_incoming: 0,
    trails: 0,
  };
}

/**
 * Ключ поля выдачи для списка соседей: в evidence полные доказательства
 * опор едут в `supports` (как в understand.compact), счётчики/dropped/
 * продолжения остаются в терминах списка `informed_by`.
 */
function outputKeyOf(profile: "orientation" | "evidence", list: NeighborList): string {
  return profile === "evidence" && list === "informed_by" ? "supports" : list;
}

// ---- Отпечаток выборки (продолжение фиксирует версию, E2) ----

/** Детерминированный JSON: ключи объектов отсортированы. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(parts: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(parts)).digest("hex");
}

interface ListContinuationV1 {
  v: 1;
  kind: "list";
  anchor: string;
  list: NeighborList;
  profile: "orientation" | "evidence";
  offset: number;
  /** Отпечаток состава списка + состояния якоря + уже выданных элементов. */
  fp: string;
  max_neighbors: number;
}

interface BatchContinuationV1 {
  v: 1;
  kind: "batch";
  profile: GetConceptProfile;
  /** Весь исходный список пакета (≤ MAX_BATCH_ITEMS — токен маленький). */
  ids: string[];
  /** Сколько элементов обработано на предыдущих страницах. */
  offset: number;
  fp: string;
  max_neighbors: number;
}

type ContinuationTokenV1 = ListContinuationV1 | BatchContinuationV1;

const CONTINUATION_PREFIX = "m1cont-";

function encodeContinuation(token: ContinuationTokenV1): string {
  return CONTINUATION_PREFIX + Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

function decodeContinuation(raw: string): ContinuationTokenV1 {
  if (!raw.startsWith(CONTINUATION_PREFIX)) {
    throw new Error(
      "continuation: токен не распознан — используй токен get_concept из meta.continuation (пакет) или meta.continuations (список)."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(raw.slice(CONTINUATION_PREFIX.length), "base64url").toString("utf8")
    );
  } catch {
    throw new Error("continuation: токен не читается — повтори get_concept с исходными id/ids; токен берётся из meta.continuation/meta.continuations.");
  }
  const token = parsed as ContinuationTokenV1;
  if (token?.v !== 1 || (token.kind !== "list" && token.kind !== "batch")) {
    throw new Error("continuation: неизвестная версия или вид токена — повтори get_concept с исходными id/ids; используй meta.continuation/meta.continuations.");
  }
  return token;
}

// ---- Общие сборочные блоки ----

/**
 * Квалификация строки узла — зеркалит nodeQualification из tools.ts;byte-
 * равенство разделов проекции и полной карточки охраняют контрактные тесты.
 */
function qualificationOf(db: KnowledgeDB, node: NodeRow) {
  return {
    status: node.status ?? "active",
    epistemic_status: node.epistemic_status ?? null,
    status_scope: parseStatusScope(node.status_scope),
    valid_until: node.valid_until ?? null,
    expired: isNodeExpired(node),
    ...(node.epistemic_status === "refuted"
      ? { refuted_reason: db.getLatestEpistemicReason(node.id, "refuted") }
      : {}),
  };
}

/** Квалификация + digest-состояние якоря: входит в отпечаток продолжения. */
function anchorStateOf(db: KnowledgeDB, node: NodeRow) {
  return {
    claim: claimDigestOf(node.summary),
    status: statusDigestOf(node.status, node.epistemic_status),
    valid_until: node.valid_until ?? null,
    expired: isNodeExpired(node),
    refuted_reason: db.getLatestEpistemicReason(node.id, "refuted"),
  };
}

// ---- E4 (план 20+21 v3 §8.4): delta-выдача — версия запрошенной проекции ----
//
// Та же механика, что continuation-токен M3-1: sha256 канонического JSON
// (stableStringify с сортировкой ключей). Сравнивается версия ЗАПРОШЕННОЙ
// проекции, а не только summary claim digest: состояние включает ВСЕ
// существенные выдаваемые данные — статус, срок, ссылки, rationale, состав
// опор (полные формулировки + дайджесты claim/status/edge/artifacts),
// состояние артефактов, состав и выбранных соседей, support_check и версию
// формата. Время входит в версию через expired (isNodeExpired) и valid_until:
// истечение срока меняет версию даже без записи в БД. Сервер БЕЗ кэша:
// версия каждый раз вычисляется из данных (stateless сравнение).

const PROJECTION_VERSION_PREFIX = "m4ver-";

/** Обязательная оговорка unchanged-ответа: delta не является покрытием кода. */
const DELTA_NOTE =
  "unchanged — версия запрошенной проекции совпала с подтверждённой клиентом; " +
  "это НЕ покрытие кода: перед правкой прочитай текущий участок исходника";

/**
 * Существенное состояние проекции — вход вычисления версии. Для full — сама
 * полная карточка (она и есть выдача); для orientation/evidence — данные,
 * из которых строится проекция (состав списков + состояния выбранных
 * соседей + полные доказательства опор + support_check).
 */
function projectionStateOf(
  db: KnowledgeDB,
  anchorId: string,
  node: NodeRow,
  profile: GetConceptProfile,
  maxNeighbors: number,
  now: Date
): Record<string, unknown> {
  if (profile === "full") {
    const card = buildNodeWithContext(db, node, undefined, { withSupportCheck: true });
    card.current_digests = currentDigestsOf(node);
    // Состав опор — существенные данные и для full: версии формулировок,
    // статусов и артефактов каждой живой опоры (самма карточка показывает
    // рационалы, но не claim-версии опор; подтверждение опирается на них).
    const supportsState = db
      .getEdgeRefsOut(node.id)
      .filter((e) => e.relation === "informed_by")
      .map((ref) => {
        const row = db.getNode(ref.to_id);
        if (!row) return { id: ref.to_id, missing: true };
        return {
          id: row.id,
          claim_digest: claimDigestOf(row.summary),
          status_digest: statusDigestOf(row.status, row.epistemic_status),
          artifacts_digest: artifactsDigestOf(activeArtifactRows(row, db.getNodeArtifacts(row.id))),
        };
      });
    return { form: 1, profile: "full", card, supports_state: supportsState };
  }

  const sources = new Map<NeighborList, NeighborSource>();
  for (const list of ORIENTATION_LISTS) {
    sources.set(list, neighborSource(db, anchorId, list));
  }
  const informedByOut = sources.get("informed_by")!.refs;
  const weakMap = new Map<string, boolean>();
  for (const ref of informedByOut) {
    const target = db.getNode(ref.id);
    weakMap.set(ref.id, target ? supportIsWeak(db, target) : false);
  }

  // Опоры — полные доказательства: формулировка, rationale, квалификация и
  // готовые дайджесты (claim/status/edge/artifacts) — ровно то, что едет в
  // evidence-выдаче; изменение rationale или наблюдения артефактов меняет
  // версию (E6: rationale/artifact инвалидируют delta).
  const supports = informedByOut.map((ref) => {
    const row = db.getNode(ref.id);
    if (!row) return { to: ref.id, missing: true };
    const support = evidenceSupportOf(db, row, ref.description);
    return { ...support, weak: support.weak ?? false };
  });

  // Состав остальных списков + состояния выбранных соседей (окно раскрытия).
  const lists: Record<string, unknown> = {};
  for (const list of ORIENTATION_LISTS) {
    if (list === "informed_by") continue; // полный состав — в supports выше
    const src = sources.get(list)!;
    const selected = src.refs.slice(0, maxNeighbors).map((ref) => {
      if (list === "trails") {
        return { id: ref.id, state: trailState(db, ref.id) };
      }
      const row = db.getNode(ref.id);
      if (!row) return { id: ref.id, missing: true };
      return {
        id: ref.id,
        relation: ref.relation,
        description: ref.description,
        name: row.name,
        kind: row.kind,
        status: row.status ?? "active",
        epistemic_status: row.epistemic_status ?? null,
        valid_until: row.valid_until ?? null,
        expired: isNodeExpired(row, now),
      };
    });
    lists[list] = { ids: src.ids, selected };
  }

  const supportCheck = computeSupportCheck(
    db,
    anchorId,
    new CheckBudget(DEFAULT_MAX_CHECK_EDGES, DEFAULT_MAX_CHECK_BYTES)
  );

  return {
    form: 1,
    profile,
    max_neighbors: maxNeighbors,
    identity: {
      id: node.id,
      name: node.name,
      kind: node.kind,
      parent_id: node.parent_id ?? null,
      created_via: node.created_via ?? null,
      file_refs: parseFileRefs(node.file_refs),
    },
    qualification: {
      status: node.status ?? "active",
      epistemic_status: node.epistemic_status ?? null,
      status_scope: parseStatusScope(node.status_scope),
      valid_until: node.valid_until ?? null,
      expired: isNodeExpired(node, now),
      refuted_reason: db.getLatestEpistemicReason(node.id, "refuted"),
    },
    summary: node.summary,
    why: node.why ?? null,
    slots: db.getSlotsForNode(anchorId),
    lists,
    supports,
    // Наблюдения артефактов самого узла (состав refs — тоже версионные данные).
    anchor_artifacts: artifactsDigestOf(activeArtifactRows(node, db.getNodeArtifacts(anchorId))),
    support_check: supportCheck,
  };
}

/** Версия запрошенной проекции: m4ver- + sha256 канонического JSON состояния. */
export function projectionVersion(
  db: KnowledgeDB,
  anchorId: string,
  node: NodeRow,
  profile: GetConceptProfile,
  maxNeighbors: number,
  now: Date = new Date()
): string {
  return PROJECTION_VERSION_PREFIX + fingerprint(projectionStateOf(db, anchorId, node, profile, maxNeighbors, now));
}

/** Компактный unchanged-ответ: квалификация-минимум без повторной передачи текста. */
function buildDeltaOutput(
  db: KnowledgeDB,
  node: NodeRow,
  profile: GetConceptProfile,
  version: string,
  epoch: string
): ConceptDeltaOutput {
  const informedByOut = db
    .getEdgeRefsOut(node.id)
    .filter((e) => e.relation === "informed_by");
  const weakSupport =
    node.kind === "decision" &&
    informedByOut.length > 0 &&
    informedByOut.every((e) => {
      const target = db.getNode(e.to_id);
      return target ? supportIsWeak(db, target) : false;
    });
  return {
    unchanged: true,
    id: node.id,
    name: node.name,
    kind: node.kind as NodeKind,
    profile,
    version,
    context_epoch: epoch,
    qualification: {
      status: node.status ?? "active",
      epistemic_status: node.epistemic_status ?? null,
      valid_until: node.valid_until ?? null,
      expired: isNodeExpired(node),
      ...(node.epistemic_status === "refuted"
        ? { refuted_reason: db.getLatestEpistemicReason(node.id, "refuted") }
        : {}),
    },
    ...(weakSupport ? { weak_support: true } : {}),
    note: DELTA_NOTE,
  };
}

function resolveNodeRow(db: KnowledgeDB, id: string): { id: string; node: NodeRow } | undefined {
  const resolved = db.getAliasTarget(id) ?? id;
  const node = db.getNode(resolved);
  return node ? { id: resolved, node } : undefined;
}

/** Слабая опора: refuted/abandoned/ungrounded (как weak-пометки полной карточки). */
function supportIsWeak(db: KnowledgeDB, target: NodeRow): boolean {
  return (
    target.epistemic_status === "refuted" ||
    target.epistemic_status === "abandoned" ||
    isUngrounded(db, target)
  );
}

interface NeighborSource {
  /** Состав списка в естественном порядке (тот же, что у полной карточки). */
  ids: string[];
  /** Ссылки строк: id/ребро/рационал — для проекций элементов. */
  refs: Array<{ id: string; relation: string; description: string | null }>;
  /** Имена (только у trails; остальное — getNode по раскрытым элементам). */
  names?: Map<string, string>;
}

/** Лёгкий состав списка соседей — те же WHERE/JOIN, что у полной карточки. */
function neighborSource(db: KnowledgeDB, anchorId: string, list: NeighborList): NeighborSource {
  if (list === "children") {
    const ids = db.getChildrenIds(anchorId);
    return { ids, refs: ids.map((id) => ({ id, relation: "", description: null })) };
  }
  if (list === "trails") {
    const trails = db.getTrailsForNode(anchorId);
    return {
      ids: trails.map((t) => t.id),
      refs: trails.map((t) => ({ id: t.id, relation: "", description: null })),
      names: new Map(trails.map((t) => [t.id, t.name])),
    };
  }
  const normalize = (
    rows: Array<{ to_id?: string; from_id?: string; relation: string; description: string | null }>
  ): NeighborSource["refs"] =>
    rows.map((r) => ({ id: (r.to_id ?? r.from_id) as string, relation: r.relation, description: r.description }));
  const refs =
    list === "edges"
      ? normalize(db.getEdgeRefsOut(anchorId))
      : list === "incoming_edges"
        ? normalize(db.getEdgeRefsIn(anchorId))
        : list === "informed_by"
          ? normalize(db.getEdgeRefsOut(anchorId).filter((e) => e.relation === "informed_by"))
          : normalize(db.getEdgeRefsIn(anchorId).filter((e) => e.relation === "informed_by"));
  return { ids: refs.map((r) => r.id), refs };
}

interface ProjectionCtx {
  db: KnowledgeDB;
  profile: "orientation" | "evidence";
  maxNeighbors: number;
  /** weak-пометки целей исходящих informed_by (посчитаны один раз на узел). */
  weakMap: Map<string, boolean>;
}

/** Проекция одного элемента списка под профиль (данные текущие, не обрезанные). */
function projectListItem(
  ctx: ProjectionCtx,
  list: NeighborList,
  index: number,
  source: NeighborSource
): Record<string, unknown> | null {
  const { db, profile, weakMap } = ctx;
  const ref = source.refs[index];
  if (!ref) return null;

  if (list === "trails") {
    const trailId = ref.id;
    return {
      id: trailId,
      name: source.names?.get(trailId) ?? trailId,
      state: trailState(db, trailId),
    };
  }

  const row = db.getNode(ref.id);
  if (!row) return null; // мёртвый конец уже отфильтрован запросом; защита от гонки

  if (profile === "evidence" && list === "informed_by") {
    // Полное доказательство: формулировка, rationale и версии для
    // confirm_supports — клиент не вычисляет хеши сам. Сборка — общий
    // экспорт evidenceSupportOf (та же механика, что E3 в compact understand,
    // план 20+21 v3 §8.3): одна сборка, не дубль.
    return evidenceSupportOf(db, row, ref.description) as unknown as Record<string, unknown>;
  }

  switch (list) {
    case "children":
      // Указатель на ребёнка: квалификация едет, саммари берут карточкой.
      return { id: row.id, name: row.name, kind: row.kind as NodeKind, ...qualificationOf(db, row) };
    case "edges":
      return { to: row.id, to_name: row.name, relation: ref.relation as RelationType };
    case "incoming_edges":
      return { from: row.id, from_name: row.name, relation: ref.relation as RelationType };
    case "informed_by":
      // Карта опор без формулировок: полные доказательства — profile=evidence.
      return {
        to: row.id,
        to_name: row.name,
        ...(weakMap.get(row.id) ? { weak: true } : {}),
      };
    case "informed_by_incoming":
      return { from: row.id, from_name: row.name };
    default:
      return null;
  }
}

interface ProjectionPage {
  list: NeighborList;
  /** Сколько элементов этого списка уже выдано предыдущими страницами. */
  offset: number;
  /** Уже выданные проекции [0, offset) — проверены вызывающим (fp). */
  head: unknown[];
}

/**
 * Собрать бюджетную профильную проекцию. Раскрытие — максимум maxNeighbors
 * на список И целевой бюджет: элементы размещаются по одному с мерой
 * фактической формы (как placeLoop у understand), полная карточка не
 * строится. Без молчаливой порезки: dropped/continuations/incomplete
 * фиксируют остаток честно.
 *
 * Страница продолжения выдаёт ТОЛЬКО новые элементы окна (голова уже у
 * клиента); голова участвует в отпечатке версии и не пере выдаётся.
 */
function buildProfileProjection(
  db: KnowledgeDB,
  anchorId: string,
  node: NodeRow,
  profile: "orientation" | "evidence",
  maxNeighbors: number,
  opts?: { withSupportCheck?: boolean; page?: ProjectionPage; target?: number }
): ConceptProfileOutput {
  const sources = new Map<NeighborList, NeighborSource>();
  for (const list of ORIENTATION_LISTS) {
    sources.set(list, neighborSource(db, anchorId, list));
  }

  const informedByOut = sources.get("informed_by")!.refs;
  const weakMap = new Map<string, boolean>();
  for (const ref of informedByOut) {
    const target = db.getNode(ref.id);
    weakMap.set(ref.id, target ? supportIsWeak(db, target) : false);
  }
  const weakSupport =
    node.kind === "decision" &&
    informedByOut.length > 0 &&
    informedByOut.every((e) => weakMap.get(e.id) === true);

  const ctx: ProjectionCtx = { db, profile, maxNeighbors, weakMap };

  const counts: ConceptProfileNeighborCount = {
    children: sources.get("children")!.ids.length,
    // Полная карточка показывает в edges ВСЕ исходящие рёбра (включая
    // informed_by) — счётчик совпадает с ней, а не с картой опор.
    edges: sources.get("edges")!.ids.length,
    incoming_edges: sources.get("incoming_edges")!.ids.length,
    informed_by: informedByOut.length,
    informed_by_incoming: sources.get("informed_by_incoming")!.ids.length,
    trails: sources.get("trails")!.ids.length,
  };

  const output: Omit<ConceptProfileOutput, "meta"> = {
    id: node.id,
    name: node.name,
    kind: node.kind as NodeKind,
    parent: node.parent_id
      ? (() => {
          const p = db.getParent(node.parent_id!);
          return p ? { id: p.id, name: p.name } : null;
        })()
      : null,
    ...qualificationOf(db, node),
    ...(node.created_via != null ? { created_via: node.created_via } : {}),
    // orientation — краткая ориентация (усечение ≤240 как в compact);
    // evidence — полная существенная формулировка узла.
    summary: profile === "evidence" ? node.summary : trimSummary(node.summary),
    file_refs: parseFileRefs(node.file_refs),
    ...(weakSupport ? { weak_support: true } : {}),
    ...(profile === "evidence" ? { why: node.why } : {}),
    ...(profile === "orientation"
      ? {
          slots: db.getSlotsForNode(anchorId),
          where_next:
            "evidence — полные формулировки опор и дайджесты confirm_supports (profile=evidence); full — вся карточка: дети, рёбра, слоты, трейлы, support_check (по умолчанию или profile=full)",
        }
      : {}),
    ...(profile === "evidence" ? { current_digests: currentDigestsOf(node) } : {}),
    ...(profile === "evidence" && opts?.withSupportCheck !== false
      ? (() => {
          // Как на полной карточке: блок присутствует, только когда есть что
          // проверять; unknown/incomplete чистотой не считаются.
          const check = computeSupportCheck(
            db,
            anchorId,
            new CheckBudget(DEFAULT_MAX_CHECK_EDGES, DEFAULT_MAX_CHECK_BYTES)
          );
          return check ? { support_check: check } : {};
        })()
      : {}),
  };

  const meta: ConceptProfileMeta = {
    profile,
    form_version: 1,
    tokens_estimated: 0,
    truncated: false,
    counts,
    returned: zeroCounts(),
  };

  const target = opts?.target;
  const measure = () => measureMcpPayload({ ...output, meta });

  // Ниже минимума — понятный отказ ДО размещения: обязательное ядро
  // (идентичность, квалификация, expiry, причины refuted) не режется (§4.3).
  if (target !== undefined) {
    const minimum = measure();
    if (target < minimum) {
      throw new Error(
        `get_concept: max_tokens=${target} ниже минимума ${minimum} — обязательное ядро ` +
          `(идентичность, квалификация, expiry) и конверт ответа не режутся. Подними max_tokens.`
      );
    }
  }

  // Страница продолжения: ядро + ТОЛЬКО новые элементы запрошенного списка;
  // остальные списки не повторяются (их токены выданы на предыдущих
  // страницах).
  const lists: NeighborList[] = opts?.page
    ? [opts.page.list]
    : profile === "evidence"
      ? ["informed_by"]
      : [...ORIENTATION_LISTS];

  const continuations: Array<{ list: string; token: string }> = [];
  const dropped: Partial<ConceptProfileNeighborCount> = {};
  const incomplete: ConceptProfileIncomplete[] = [];
  const anchorState = anchorStateOf(db, node);
  let truncated = false;

  for (const list of lists) {
    const source = sources.get(list)!;
    const pageMode = opts?.page !== undefined && opts.page.list === list;
    const head = pageMode ? opts.page!.head : [];
    const offset = pageMode ? opts.page!.offset : 0;
    const end = Math.min(source.ids.length, offset + ctx.maxNeighbors);

    // Размещение новых элементов окна: по одному, с мерой фактической формы.
    const shown: unknown[] = [];
    for (let i = offset; i < end; i++) {
      const item = projectListItem(ctx, list, i, source);
      if (!item) continue;
      shown.push(item);
      (output as unknown as Record<string, unknown>)[outputKeyOf(profile, list)] = shown;
      meta.returned![list as keyof ConceptProfileNeighborCount] = shown.length;
      if (target !== undefined && measure() > target) {
        // Не поместилось в бюджет: элемент снимается, остаток окна — dropped.
        shown.pop();
        break;
      }
    }
    if (shown.length > 0 || (profile === "evidence" && list === "informed_by")) {
      // Пустой supports — явное «опор нет», не молчаливое отсутствие поля.
      (output as unknown as Record<string, unknown>)[outputKeyOf(profile, list)] = shown;
      meta.returned![list as keyof ConceptProfileNeighborCount] = shown.length;
    }

    const rest = source.ids.length - (offset + shown.length);
    if (rest > 0) {
      dropped[list as keyof ConceptProfileNeighborCount] = rest;
      truncated = true;
      // Отпечаток версии: состав списка + состояние якоря + ВСЁ выданное
      // ([0, offset+shown) — голова предыдущих страниц плюс эта).
      continuations.push({
        list,
        token: encodeContinuation({
          v: 1,
          kind: "list",
          anchor: anchorId,
          list,
          profile,
          offset: offset + shown.length,
          fp: fingerprint({
            anchor: anchorId,
            list,
            ids: source.ids,
            anchor_state: anchorState,
            head: head.concat(shown),
          }),
          max_neighbors: ctx.maxNeighbors,
        }),
      });
      if (profile === "evidence" && list === "informed_by") {
        // Не поместившиеся доказательства — явная неполнота с следующим
        // шагом; формулировки не обрезались, опор в ответе не хватает.
        incomplete.push({
          section: "informed_by",
          reason: "budget",
          count: rest,
          next_step:
            "продолжи список опор токеном continuation (list informed_by) или прочитай карточку опоры: get_concept {id опоры}",
          sample_ids: source.ids.slice(offset + shown.length, offset + shown.length + MAX_BATCH_ITEMS),
        });
      }
    }
  }

  if (Object.keys(dropped).length > 0) meta.dropped = dropped;
  if (incomplete.length > 0) meta.incomplete = incomplete;
  if (continuations.length > 0) meta.continuations = continuations;
  meta.truncated = truncated;
  if (opts?.page) {
    meta.continuation_used = { list: opts.page.list, offset: opts.page.offset };
  }
  // max_tokens включается в меру ДО фиксации tokens_estimated: оценка —
  // по фактической форме ответа целиком (§4.3), иначе оценка расходится
  // с реальной выдачей на длину вложенного числа.
  if (target !== undefined) meta.max_tokens = target;
  meta.tokens_estimated = measure();
  return { ...output, meta };
}

// ---- Валидация входа ----

function validateProfile(profile: unknown): GetConceptProfile {
  if (profile === undefined) return "full";
  if (typeof profile === "string" && (PROFILES as readonly string[]).includes(profile)) {
    return profile as GetConceptProfile;
  }
  throw new Error(
    `profile: неизвестный профиль "${String(profile)}" — доступны ${PROFILES.join(", ")}.`
  );
}

function validateBudget(maxTokens: number | undefined, minimumHint: string): number | undefined {
  if (maxTokens === undefined) return undefined;
  if (!Number.isFinite(maxTokens) || maxTokens < MIN_PROFILE_TOKENS) {
    throw new Error(
      `max_tokens: бюджет должен быть числом ≥ ${MIN_PROFILE_TOKENS} (${minimumHint}).`
    );
  }
  return maxTokens;
}

function validateMaxNeighbors(maxNeighbors: number | undefined): number {
  if (maxNeighbors === undefined) return DEFAULT_MAX_NEIGHBORS;
  if (!Number.isFinite(maxNeighbors) || maxNeighbors < 0 || maxNeighbors > 200) {
    throw new Error("max_neighbors: лимит раскрытия соседей — целое число 0..200.");
  }
  return Math.trunc(maxNeighbors);
}

// ---- Публичный вход E1 ----

/**
 * Профильное чтение get_concept (E1). profile=full без max_tokens возвращает
 * карточку, байт-в-байт равную старому getConcept; orientation/evidence —
 * проекции под бюджетом с честной неполнотой и продолжением.
 */
export function getConceptProfile(
  db: KnowledgeDB,
  input: ConceptProfileInput
): NodeWithContext | ConceptProfileOutput | ConceptDeltaOutput {
  const maxTokens = validateBudget(input.max_tokens, "минимум конверта ответа");
  const maxNeighbors = validateMaxNeighbors(input.max_neighbors);

  // --- Продолжение: страница списка под зафиксированной версией выборки ---
  if (input.continuation !== undefined) {
    const token = decodeContinuation(input.continuation);
    if (token.kind !== "list") {
      throw new Error(
        "continuation: это токен пакета — передай его в get_concept {continuation} без id."
      );
    }
    // Профиль продолжения — профиль токена; явный несовпадающий — ошибка.
    const profile = input.profile !== undefined ? validateProfile(input.profile) : token.profile;
    if (token.profile !== profile) {
      throw new Error(
        `continuation: токен выдан для profile=${token.profile}, а запрос — ${profile}; повтори чтение с тем же профилем.`
      );
    }
    if (input.id !== undefined) {
      const resolved = db.getAliasTarget(input.id) ?? input.id;
      if (resolved !== token.anchor) {
        throw new Error(
          `continuation: id "${input.id}" не совпадает с якорем продолжения "${token.anchor}" — повтори чтение целиком.`
        );
      }
    }
    const anchor = db.getNode(token.anchor);
    if (!anchor) {
      throw new Error(
        `version_conflict: якорь "${token.anchor}" исчез после предыдущей страницы — повтори чтение целиком.`
      );
    }
    const source = neighborSource(db, token.anchor, token.list);
    // Проверка версии: состав списка + состояние якоря + проекция [0, offset).
    const weakMap = new Map<string, boolean>();
    for (const ref of db.getEdgeRefsOut(token.anchor).filter((e) => e.relation === "informed_by")) {
      const target = db.getNode(ref.to_id);
      weakMap.set(ref.to_id, target ? supportIsWeak(db, target) : false);
    }
    const ctx: ProjectionCtx = {
      db,
      profile: token.profile,
      maxNeighbors: token.max_neighbors,
      weakMap,
    };
    const headEnd = Math.min(source.ids.length, token.offset);
    const head: unknown[] = [];
    for (let i = 0; i < headEnd; i++) {
      const item = projectListItem(ctx, token.list, i, source);
      if (item) head.push(item);
    }
    const fp = fingerprint({
      anchor: token.anchor,
      list: token.list,
      ids: source.ids,
      anchor_state: anchorStateOf(db, anchor),
      head,
    });
    if (fp !== token.fp) {
      throw new Error(
        "version_conflict: выборка изменилась после предыдущей страницы (состав, состояние якоря или выданных элементов) — повтори чтение целиком, не склеивай страницы разных состояний."
      );
    }
    const target =
      maxTokens ?? (token.profile === "evidence" ? EVIDENCE_DEFAULT_TOKENS : ORIENTATION_DEFAULT_TOKENS);
    const page = buildProfileProjection(db, token.anchor, anchor, token.profile, token.max_neighbors, {
      page: { list: token.list, offset: token.offset, head },
      target,
    });
    // Страница обязана продвигать выдачу: ноль новых элементов при живом
    // остатке означает, что даже одна формулировка не влезла в бюджет.
    const shownKey = outputKeyOf(token.profile, token.list);
    const shown = (page as unknown as Record<string, unknown>)[shownKey];
    const shownCount = Array.isArray(shown) ? shown.length : 0;
    const sourceCount = neighborSource(db, token.anchor, token.list).ids.length;
    if (shownCount === 0 && token.offset < sourceCount) {
      throw new Error(
        `get_concept: max_tokens=${target} не вмещает ни одного нового элемента списка ` +
          `"${token.list}" — подними max_tokens или прочитай нужные опоры по одной.`
      );
    }
    recordUsage(db, input.id ?? token.anchor, page);
    return page;
  }

  // --- Свежий профильный вызов ---
  const profile = validateProfile(input.profile);
  if (input.id === undefined) {
    throw new Error("get_concept: укажи id (или ids для пакетного чтения, или continuation).");
  }
  if (input.known_versions !== undefined && input.context_epoch === undefined) {
    throw new Error(
      "get_concept: known_versions без context_epoch — протокол delta требует обе части " +
        "(подтверждённые версии + идентификатор текущей эпохи контекста клиента)."
    );
  }
  const resolved = resolveNodeRow(db, input.id);
  if (!resolved) {
    throw new Error(`Concept "${input.id}" not found.`);
  }

  // --- E4: delta-выдача (только opt-in: нет параметров — нет delta) ---
  if (input.context_epoch !== undefined) {
    const version = projectionVersion(db, resolved.id, resolved.node, profile, maxNeighbors);
    const known =
      input.known_versions?.[input.id] ?? input.known_versions?.[resolved.id];
    if (known !== undefined && known === version) {
      return buildDeltaOutput(db, resolved.node, profile, version, input.context_epoch);
    }
    // Расхождение или неизвестная версия — полная выдача запрошенной
    // проекции с текущей версией и эхом эпохи (клиент сверит и сохранит).
    if (profile === "full") {
      const ctx = buildNodeWithContext(db, resolved.node, undefined, { withSupportCheck: true });
      ctx.current_digests = currentDigestsOf(resolved.node);
      ctx.delta_version = { version, context_epoch: input.context_epoch };
      recordUsage(db, input.id, ctx);
      if (maxTokens === undefined) return ctx;
      // Бюджет — те же ворота, что у недельта full: карточка не режется.
      const measured = measureMcpPayload(ctx);
      if (measured > maxTokens) {
        throw new Error(
          `get_concept: полная карточка не помещается в max_tokens=${maxTokens} (нужно ${measured}); ` +
            `возьми профиль evidence/orientation или подними бюджет.`
        );
      }
      return ctx;
    }
    const target =
      maxTokens ?? (profile === "evidence" ? EVIDENCE_DEFAULT_TOKENS : ORIENTATION_DEFAULT_TOKENS);
    const result = buildProfileProjection(db, resolved.id, resolved.node, profile, maxNeighbors, {
      withSupportCheck: true,
      target,
    });
    result.meta.version = version;
    result.meta.context_epoch = input.context_epoch;
    recordUsage(db, input.id, result);
    return result;
  }

  if (profile === "full") {
    const ctx = buildNodeWithContext(db, resolved.node, undefined, { withSupportCheck: true });
    ctx.current_digests = currentDigestsOf(resolved.node);
    recordUsage(db, input.id, ctx);
    if (maxTokens === undefined) return ctx;
    // Полная карточка — текущая форма: не режется и не обогащается meta;
    // max_tokens работает воротами (как у understand mode=full).
    const measured = measureMcpPayload(ctx);
    if (measured > maxTokens) {
      throw new Error(
        `get_concept: полная карточка не помещается в max_tokens=${maxTokens} (нужно ${measured}); ` +
          `возьми профиль evidence/orientation или подними бюджет.`
      );
    }
    return ctx;
  }

  const target =
    maxTokens ?? (profile === "evidence" ? EVIDENCE_DEFAULT_TOKENS : ORIENTATION_DEFAULT_TOKENS);
  const result = buildProfileProjection(db, resolved.id, resolved.node, profile, maxNeighbors, {
    withSupportCheck: true,
    target,
  });
  recordUsage(db, input.id, result);
  return result;
}

/** Телеметрия чтения — паритет со старым getConcept: usage пишется, граф/снимки не трогаются. */
function recordUsage(
  db: KnowledgeDB,
  query: string,
  result: NodeWithContext | ConceptProfileOutput
): void {
  const serialized = JSON.stringify(result);
  const tokens =
    "meta" in result && result.meta
      ? result.meta.tokens_estimated
      : estimateTokens(serialized);
  db.insertUsage({
    tool: "get_concept",
    query,
    nodes: 1,
    returnedChars: serialized.length,
    returnedTokens: tokens,
  });
}

// ---- Публичный вход E2: пакет ----

/** Состояние элемента пакета для отпечатка продолжения. */
function batchItemState(db: KnowledgeDB, id: string): Record<string, unknown> {
  const resolved = db.getAliasTarget(id) ?? id;
  const node = db.getNode(resolved);
  if (!node) return { id, status: "error" };
  return {
    id,
    resolved_id: resolved,
    claim: claimDigestOf(node.summary),
    status: statusDigestOf(node.status, node.epistemic_status),
    epistemic_status: node.epistemic_status ?? null,
    valid_until: node.valid_until ?? null,
    expired: isNodeExpired(node),
  };
}

/**
 * Пакетное чтение (E2): один общий бюджет, per-id статус/ошибка/неполнота.
 * Неразрешённый id даёт элемент error, не исчезает; не поместившиеся —
 * budget_skipped с продолжением, фиксирующим версию выданного набора.
 */
export function getConceptBatch(db: KnowledgeDB, input: ConceptBatchInput): ConceptBatchOutput {
  const maxTokens = validateBudget(input.max_tokens, "общий бюджет пакета");
  const maxNeighbors = validateMaxNeighbors(input.max_neighbors);
  let ids: string[];
  let profile: GetConceptProfile;
  let resume: BatchContinuationV1 | undefined;

  if (input.continuation !== undefined) {
    const token = decodeContinuation(input.continuation);
    if (token.kind !== "batch") {
      throw new Error(
        "continuation: это токен списка — передай его с id того же узла (get_concept {id, continuation})."
      );
    }
    if (input.ids !== undefined) {
      throw new Error(
        "continuation: список ids зашит в токен пакета — передай только continuation и бюджет."
      );
    }
    ids = token.ids;
    profile = validateProfile(input.profile ?? token.profile);
    if (profile !== token.profile) {
      throw new Error(
        `continuation: токен выдан для profile=${token.profile}, а запрос — ${profile}; повтори чтение.`
      );
    }
    // Валидация версии уже выданного набора: состав + состояние каждого
    // обработанного элемента.
    const head = ids.slice(0, token.offset).map((id) => batchItemState(db, id));
    const fp = fingerprint({ ids, head });
    if (fp !== token.fp) {
      throw new Error(
        "version_conflict: выданные элементы пакета изменились после предыдущей страницы — повтори чтение пакета целиком."
      );
    }
    resume = token;
  } else {
    if (!Array.isArray(input.ids) || input.ids.length === 0) {
      throw new Error("ids: пустой пакет — передай хотя бы один id.");
    }
    if (input.ids.length > MAX_BATCH_ITEMS) {
      throw new Error(
        `ids: не более ${MAX_BATCH_ITEMS} id за вызов (получено ${input.ids.length}) — продолжи следующим вызовом.`
      );
    }
    ids = input.ids;
    profile = validateProfile(input.profile);
  }

  const target = maxTokens ?? BATCH_DEFAULT_TOKENS;
  const items: ConceptBatchItem[] = [];
  const meta: ConceptBatchMeta = {
    total: ids.length,
    ok: 0,
    failed: 0,
    budget_skipped: 0,
    profile,
    tokens_estimated: 0,
    truncated: false,
    ...(resume ? { continuation_used: { offset: resume.offset } } : {}),
  };
  if (input.max_tokens !== undefined) meta.max_tokens = input.max_tokens;

  const buildOutput = () => ({ batch: items, meta });

  // Ниже минимума — отказ: каждый id обязан появиться в ответе поимённо.
  const minimum = measureMcpPayload({
    batch: ids.map((id) => ({ id, status: "budget_skipped" as const })),
    meta: { ...meta, tokens_estimated: 0, truncated: true },
  });
  if (target < minimum) {
    throw new Error(
      `get_concept batch: max_tokens=${target} ниже минимума ${minimum} — конверт и поимённое ` +
        `перечисление пакета не режутся. Подними max_tokens.`
    );
  }

  let checkBudget = MAX_BATCH_SUPPORT_CHECKS;
  let exhausted = false;

  const startAt = resume ? resume.offset : 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (i < startAt) continue; // уже выдано на предыдущей странице

    if (exhausted) {
      items.push({
        id,
        status: "budget_skipped",
        reason: "budget",
        next_step: "общий бюджет пакета исчерпан — продолжи с continuation (meta.continuation)",
      });
      meta.budget_skipped += 1;
      continue;
    }

    const resolved = resolveNodeRow(db, id);
    if (!resolved) {
      // Неразрешённый id не исчезает молча; соседей не маскирует.
      items.push({ id, status: "error", error: `Concept "${id}" not found.` });
      meta.failed += 1;
      continue;
    }

    let card: NodeWithContext | ConceptProfileOutput;
    let deferred = false;
    if (profile === "full") {
      const withCheck = checkBudget > 0;
      if (withCheck) checkBudget -= 1;
      const ctx = buildNodeWithContext(db, resolved.node, undefined, { withSupportCheck: withCheck });
      ctx.current_digests = currentDigestsOf(resolved.node);
      card = ctx;
      deferred = !withCheck;
    } else {
      const withCheck = checkBudget > 0;
      if (withCheck) checkBudget -= 1;
      card = buildProfileProjection(db, resolved.id, resolved.node, profile, maxNeighbors, {
        withSupportCheck: withCheck,
      });
      deferred = !withCheck;
    }

    const candidate: ConceptBatchItem = {
      id,
      resolved_id: resolved.id,
      status: "ok",
      card,
      ...(deferred ? { support_check_deferred: true } : {}),
    };
    items.push(candidate);
    if (measureMcpPayload(buildOutput()) > target) {
      // Не поместилось в ОБЩИЙ бюджет пакета: элемент и все оставшиеся —
      // budget_skipped (поимённо, не молча).
      items.pop();
      exhausted = true;
      items.push({
        id,
        status: "budget_skipped",
        reason: "budget",
        next_step: "общий бюджет пакета исчерпан — продолжи с continuation (meta.continuation)",
      });
      meta.budget_skipped += 1;
    } else {
      meta.ok += 1;
    }
  }

  // Продолжение: поимённый остаток + отпечаток обработанного набора.
  const processed = startAt + meta.ok + meta.failed;
  if (processed < ids.length) {
    const head = ids.slice(0, processed).map((id) => batchItemState(db, id));
    meta.continuation = encodeContinuation({
      v: 1,
      kind: "batch",
      profile,
      ids,
      offset: processed,
      fp: fingerprint({ ids, head }),
      max_neighbors: maxNeighbors,
    });
  }
  meta.truncated = meta.budget_skipped > 0;
  meta.tokens_estimated = measureMcpPayload(buildOutput());
  // Одна usage-строка на пакетный вызов: query — поимённый список пакета.
  const serializedBatch = JSON.stringify(buildOutput());
  db.insertUsage({
    tool: "get_concept",
    query: ids.join(","),
    nodes: meta.ok,
    returnedChars: serializedBatch.length,
    returnedTokens: meta.tokens_estimated,
  });
  return buildOutput();
}

// ---- Разбор аргументов MCP-обработчика (одна точка ветвления) ----

export interface ConceptToolArgs {
  id?: string;
  ids?: string[];
  profile?: GetConceptProfile;
  max_tokens?: number;
  max_neighbors?: number;
  continuation?: string;
  context_epoch?: string;
  known_versions?: Record<string, string>;
}

export type ConceptToolMode =
  | { mode: "legacy"; id: string }
  | { mode: "profile"; input: ConceptProfileInput }
  | { mode: "batch"; input: ConceptBatchInput };

/**
 * Ветвление параметров get_concept: старый вызов без новых параметров идёт
 * прежним путём (контракт байт-в-байт), ids — пакет, остальное — профили.
 * Конфликты параметров — явные ошибки, без скрытого приоритета.
 */
export function branchConceptToolArgs(args: ConceptToolArgs): ConceptToolMode {
  const hasProfileFields =
    args.profile !== undefined ||
    args.max_tokens !== undefined ||
    args.max_neighbors !== undefined ||
    args.continuation !== undefined ||
    args.context_epoch !== undefined ||
    args.known_versions !== undefined;
  // E4: delta — только одиночное чтение одной проекции; пакет и продолжение
  // не подтверждают наличие текста целой страницы — явный отказ.
  if ((args.context_epoch !== undefined || args.known_versions !== undefined) && args.ids !== undefined) {
    throw new Error(
      "get_concept: delta (context_epoch/known_versions) поддержана только для одиночного чтения по id, не для пакета."
    );
  }
  if ((args.context_epoch !== undefined || args.known_versions !== undefined) && args.continuation !== undefined) {
    throw new Error(
      "get_concept: delta (context_epoch/known_versions) и continuation вместе не задаются — продолжение уже фиксирует версию выборки."
    );
  }
  if (args.ids !== undefined) {
    if (args.id !== undefined) {
      throw new Error("get_concept: передай id ИЛИ ids, не оба — скрытого приоритета нет.");
    }
    if (args.continuation !== undefined) {
      throw new Error(
        "get_concept: ids и continuation вместе не задаются — список пакета зашит в токен продолжения."
      );
    }
    return {
      mode: "batch",
      input: {
        ids: args.ids,
        profile: args.profile,
        max_tokens: args.max_tokens,
        max_neighbors: args.max_neighbors,
      },
    };
  }
  if (args.continuation !== undefined) {
    const token = decodeContinuation(args.continuation);
    if (token.kind === "batch") {
      if (args.id !== undefined) {
        throw new Error("get_concept: продолжение пакета из meta.continuation передаётся без id и ids.");
      }
      return {
        mode: "batch",
        input: {
          profile: args.profile,
          max_tokens: args.max_tokens,
          max_neighbors: args.max_neighbors,
          continuation: args.continuation,
        },
      };
    }
    return {
      mode: "profile",
      input: {
        ...(args.id !== undefined ? { id: args.id } : {}),
        profile: args.profile,
        max_tokens: args.max_tokens,
        max_neighbors: args.max_neighbors,
        continuation: args.continuation,
      },
    };
  }
  if (hasProfileFields) {
    if (args.id === undefined) {
      throw new Error("get_concept: для профиля/бюджета нужен id (или ids для пакета).");
    }
    return {
      mode: "profile",
      input: {
        id: args.id,
        profile: args.profile,
        max_tokens: args.max_tokens,
        max_neighbors: args.max_neighbors,
        ...(args.context_epoch !== undefined ? { context_epoch: args.context_epoch } : {}),
        ...(args.known_versions !== undefined ? { known_versions: args.known_versions } : {}),
      },
    };
  }
  if (args.id === undefined) {
    throw new Error("get_concept: укажи id (точный идентификатор) или ids для пакетного чтения.");
  }
  return { mode: "legacy", id: args.id };
}
