import type { KnowledgeDB } from "./db.js";
import { vectorChannelState, type VectorChannelState } from "./embeddings.js";
import {
  CheckBudget,
  DEFAULT_MAX_CHECK_BYTES,
  DEFAULT_MAX_CHECK_EDGES,
  computeSupportCheck,
} from "./support-baselines.js";
import { parseTimelineTs, sessionize, timelineTsString } from "./sessions.js";
import type {
  NextHintFollowup,
  NextHintRead,
  NextHints,
  NodeRow,
  TimelineActivity,
  UnderstandMeta,
} from "./types.js";

// ---- План 13 §2.1: блок next в ответе understand ----
//
// understand возвращал данные без указаний, что с ними делать — агент читал
// JSON и шёл дальше своим планом. Каждый ответ теперь заканчивается контрактом
// действия: что читать (must_read), что уже покрыто и читать целиком не нужно
// (skip), какие вызовы сделать дальше с готовыми аргументами (followups) и что
// записать по итогам (record). Вся логика живёт здесь; understand только
// собирает карточки ответа и передаёт их в buildNextHints.

/** Больше трёх — это уже чтение, а не ориентация (план 13 §2.1). */
export const MUST_READ_LIMIT = 3;

/** Напоминать после двух завершённых чтений. */
export const UNRECORDED_READS_THRESHOLD = 2;

const PREVIOUS_SESSION_RECORD =
  "В прошлой сессии после understand не было ни одной записи — если сейчас есть вывод, запиши его.";
const TIMELINE_SAMPLE_LIMIT = 200;

interface SessionHintRow {
  seq: number;
  timestamp: string;
  tool: string;
  is_write: number;
  is_error: number;
}

interface SessionHintCache {
  changes: number;
  dataVersion: number;
  rows: SessionHintRow[];
  truncated: boolean;
}

const sessionHintCache = new WeakMap<KnowledgeDB, SessionHintCache>();

function previousSession(db: KnowledgeDB, now: Date): NextHints["previous_session"] {
  // total_changes sees this connection's inserts, updates and pruning; data_version
  // also invalidates the process-local cache after commits from another connection.
  const { changes } = db.execSqlFirst("SELECT total_changes() AS changes") as { changes: number };
  const { data_version: dataVersion } = db.execSqlFirst("PRAGMA data_version") as { data_version: number };
  let cached = sessionHintCache.get(db);
  if (!cached || cached.changes !== changes || cached.dataVersion !== dataVersion) {
    const rows = (db.execSqlAll(
      "SELECT seq, timestamp, tool, is_write, is_error FROM timeline ORDER BY seq DESC LIMIT ?",
      TIMELINE_SAMPLE_LIMIT
    ) as SessionHintRow[]).reverse();
    const truncated = rows.length === TIMELINE_SAMPLE_LIMIT && Boolean(db.execSqlFirst(
      "SELECT 1 FROM timeline WHERE seq < ? LIMIT 1", rows[0].seq
    ));
    cached = { changes, dataVersion, rows, truncated };
    sessionHintCache.set(db, cached);
  }
  // A malformed/out-of-order timestamp cannot establish a complete session.
  let lastTs = -Infinity;
  for (const row of cached.rows) {
    const ts = parseTimelineTs(row.timestamp);
    if (!Number.isFinite(ts) || ts < lastTs || ts > now.getTime()) return undefined;
    lastTs = ts;
  }
  // Include the in-flight call when deciding whether the latest logged session
  // is still current. Recompute this boundary even when the cached rows match.
  const sessions = sessionize([
    ...cached.rows,
    { timestamp: timelineTsString(now.getTime()), tool: "understand", is_write: 0, is_error: 0 },
  ]);
  const previousIndex = sessions.length - 2;
  if (previousIndex < 0 || (cached.truncated && previousIndex === 0)) return undefined;
  const entries = sessions[previousIndex].entries;
  return {
    had_understand: entries.some((row) => row.tool === "understand" && row.is_error === 0),
    had_record: entries.some((row) => row.is_write === 1 && row.is_error === 0),
    ended_at: entries[entries.length - 1].timestamp,
  };
}

/** Пустой ответ описывает состояние поиска, не отсутствие знаний о мире. */
export const EMPTY_REASON_RECORD: Record<NonNullable<UnderstandMeta["reason"]>, string> = {
  empty_base: "Память пуста — это не «знаний нет», а «здесь ещё ничего не записано»: после работы запиши вывод (create_concept + evidence).",
  no_match: "Совпадений нет — база не пуста: переформулируй или запиши найденное новым узлом.",
  budget: "Бюджет исчерпан — это НЕ значит, что знаний нет: повтори understand с большим max_tokens.",
};

/** Форма записи факта: влезает в brief.LINE_MAX без обрезки. */
export const RECORD_FACT =
  'Итог запиши: create_concept kind по смыслу (решение — decision, факт — feature/module), evidence: [{ref: "файл:строки", why: "что подтверждает"}] — это и есть informed_by; file_refs связей не даёт. Состояние — с valid_until.';

/** Форма записи решения: влезает в brief.LINE_MAX без обрезки. */
export const RECORD_DECISION =
  'После правки запиши решение: create_concept kind=decision, evidence: [{ref|node, why: "что подтверждает"}] — это и есть informed_by; file_refs связей не даёт. Состояние — с valid_until.';

const KEYWORD_ONLY_WARNING =
  "Поиск только по словам: векторный канал выключен, сопоставляются ВСЕ слова запроса. Повтори 2–3 точными терминами или id на языке записей. Семантический поиск включит `megamemory reembed` — один раз для базы.";

/**
 * План 33 A3: почему пустой ответ пуст, когда семантический канал выключен.
 * Каждая строка влезает в brief.LINE_MAX без обрезки.
 */
export const SEARCH_WARNING: Record<Exclude<VectorChannelState, { state: "on" }>["reason"], string> = {
  no_generation: KEYWORD_ONLY_WARNING,
  generation_without_vectors: KEYWORD_ONLY_WARNING,
  model_mismatch:
    "Поиск только по словам: модель векторов не совпадает с текущей. Повтори 2–3 точными терминами или id. Вернёт семантику `megamemory reembed`.",
  text_only_mode:
    "Поиск только по словам (MEGAMEMORY_SEARCH=fts): сопоставляются ВСЕ слова запроса. Повтори 2–3 точными терминами или id.",
};

/** Строка hint.search в list_roots: обзор непустой базы при выключенном канале. */
export const LIST_ROOTS_SEARCH_HINT =
  "Search is keyword-only (all query words must match): run `megamemory reembed` to enable semantic search.";

/** Follow-ups тоже не более трёх: каждый исполняется дословно. */
export const FOLLOWUPS_LIMIT = 3;

/** Снимок подтверждения старше этого возраста (дней) — повод для check_artifacts. */
export const STALE_BASELINE_DAYS = 7;

/** Потолок вычислений support_check за один ответ — стоимость не взрывается. */
export const SUPPORT_CHECK_LIMIT = 3;

/** Суть узла в why — не длиннее этого (must_read/record никогда не режутся). */
const ESSENCE_MAX = 80;

/**
 * Узел, попавший в ответ understand. Достаточно id — имя, kind, summary,
 * file_refs и происхождение берутся из строки БД; visibleSupports — сколько
 * опор решения уже видно в ответе (вложенные supports компакт-карточки; в
 * full-режиме — informed_by-рёбра на карточке).
 */
export interface NextHintsCard {
  id: string;
  /** kind с карточки ответа; иначе берётся из строки БД. */
  kind?: string;
  /** Сколько опор этого решения уже видно в ответе. */
  visibleSupports?: number;
}

/** Опровергнутый узел из блока refuted — для формы записи. */
export interface NextHintsRefuted {
  name: string;
  reason?: string | null;
}

export interface NextHintsInput {
  db: KnowledgeDB;
  /** Карточки ответа в ранговом порядке: верхний уровень, затем вложенные опоры. */
  cards: NextHintsCard[];
  /** Опровергнутые узлы из блока refuted (влияют только на форму record). */
  refuted?: NextHintsRefuted[];
  /** Текущий момент — для возраста снимков подтверждения. */
  now?: Date;
  /** Завершённые вызовы текущего логгера, без чтения таблицы timeline. */
  activity?: TimelineActivity;
  /** Причина пустого ответа — перед формой записи, без нуджа для пустой базы. */
  emptyReason?: UnderstandMeta["reason"];
  /**
   * План 13.1 (F6): бюджет проверки support_check при сборе followups.
   * Дефолт — боевые DEFAULT_MAX_CHECK_*; тесты inject'ят малый лимит,
   * чтобы воспроизвести support_check: incomplete без 5000 рёбер.
   */
  checkBudget?: { edges: number; bytes: number };
}

/** file_refs узла из JSON-строки; мусор и не-строки отсеиваются. */
function fileRefsOf(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Русские окончания для числительных: pluralRu(3, "опора", "опоры", "опор")
 * → "опоры". 1/21/31 → one; 2–4 (кроме 12–14) → few; остальное → many.
 */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «Старше N …» — родительный падеж: 1 дня, 2 дней, 5 дней, 21 дня. */
function daysGenitive(n: number): string {
  return pluralRu(n, "дня", "дней", "дней");
}

/** Суть узла для why: одна строка, обрезка по границе пробела. */
function shortEssence(summary: string | null | undefined): string {
  const text = (summary ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= ESSENCE_MAX) return text;
  return text.slice(0, ESSENCE_MAX - 1).trimEnd() + "…";
}

/** Почему читать: узел-источник с именем и сутью. */
function readWhy(row: NodeRow): string {
  const essence = shortEssence(row.summary);
  const base = `«${row.name}» (${row.kind})`;
  return essence ? `${base}: ${essence}` : base;
}

/** Форма записи для опровергнутого знания: имя, сколько их и причина. */
function refutedNote(refuted: NextHintsRefuted[]): string {
  const first = refuted[0];
  const more = refuted.length > 1 ? ` (и ещё ${refuted.length - 1})` : "";
  const reason = first.reason?.trim() ? first.reason.trim() : "причина не записана";
  return `Refuted «${first.name}»${more} опорой не служит: ${reason}.`;
}

/** Записать нельзя — записывать некуда; refuted: опираться на них нельзя и почему. */
function refutedRecord(refuted: NextHintsRefuted[]): string {
  const first = refuted[0];
  const more = refuted.length > 1 ? ` (и ещё ${refuted.length - 1})` : "";
  const reason = first.reason?.trim() ? first.reason.trim() : "причина не записана";
  return (
    `Опираться на refuted «${first.name}»${more} нельзя: ${reason}. ` +
    RECORD_FACT
  );
}

/**
 * Форма записи (record) — всегда присутствует и меняется по содержимому
 * ответа: решения → форма записи решения; решения и refuted → плюс
 * предупреждение про refuted; только refuted → отказ от них и запись
 * проверенного; только факты → форма записи факта; пустой ответ →
 * форма записи факта с выбором kind по смыслу.
 */
function buildRecord(
  cards: Array<NextHintsCard & { isDecision: boolean }>,
  refuted: NextHintsRefuted[]
): string {
  const hasDecision = cards.some((c) => c.isDecision === true);
  if (hasDecision) {
    return refuted.length > 0 ? `${RECORD_DECISION} ${refutedNote(refuted)}` : RECORD_DECISION;
  }
  if (refuted.length > 0) return refutedRecord(refuted);
  return RECORD_FACT;
}

/** Next для вырожденного ответа (0 карточек, векторный ранний возврат). */
export function emptyNextHints(): NextHints {
  return {
    must_read: [],
    skip: [],
    followups: [],
    record: RECORD_FACT,
  };
}

/**
 * Собрать блок next из карточек, попавших в ответ understand.
 *
 * must_read — до 3 дословных file_refs узлов ответа (верхний уровень в
 * ранговом порядке, затем вложенные опоры), с дедупликацией; почему — узел и
 * его суть. skip сохраняется пустым: refs и summary не доказывают полного
 * покрытия файла. followups — до 3 готовых
 * вызовов по приоритету плана: check_artifacts для устаревших снимков
 * подтверждения, get_concept для решений с невидимыми в ответе опорами,
 * provenance_trace для решений с нечистым (unknown/incomplete) support_check;
 * один узел — не более одного follow-up. record — форма записи по содержимому.
 */
export function buildNextHints(input: NextHintsInput): NextHints {
  const { db } = input;
  const now = input.now ?? new Date();
  const refuted = input.refuted ?? [];
  const cards = input.cards;

  // Строки узлов ответа — источник file_refs, summary, kind, происхождения.
  const rowById = new Map<string, NodeRow>();
  for (const card of cards) {
    if (rowById.has(card.id)) continue;
    const row = db.getNode(card.id);
    if (row) rowById.set(card.id, row);
  }
  // kind решения нужен для record и followups — с карточки, если строки нет.
  const cardsWithKind: Array<NextHintsCard & { isDecision: boolean }> = cards.map((c) => ({
    ...c,
    isDecision: rowById.get(c.id)?.kind === "decision" || c.kind === "decision",
  }));

  // ---- must_read: до 3 дословных file_refs узлов ответа ----
  const mustRead: NextHintRead[] = [];
  const seenRefs = new Set<string>();
  for (const card of cards) {
    if (mustRead.length >= MUST_READ_LIMIT) break;
    const row = rowById.get(card.id);
    if (!row) continue;
    for (const ref of fileRefsOf(row.file_refs)) {
      if (mustRead.length >= MUST_READ_LIMIT) break;
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      mustRead.push({ ref, why: readWhy(row), node_id: row.id });
    }
  }

  // Citations and summaries do not prove whole-file coverage; preserve skip's shape.
  const skip: NextHints["skip"] = [];

  // ---- followups: до 3 готовых вызовов, один узел — один follow-up ----
  const followups: NextHintFollowup[] = [];
  const followupNode = new Set<string>();

  // Приоритет 1: устаревший снимок подтверждения → check_artifacts.
  for (const card of cards) {
    if (followups.length >= FOLLOWUPS_LIMIT) break;
    if (followupNode.has(card.id)) continue;
    const confirmedAt = db.lastActiveBaselineAt(card.id);
    if (!confirmedAt) continue;
    const t = Date.parse(confirmedAt);
    if (Number.isNaN(t)) continue;
    const ageDays = Math.floor((now.getTime() - t) / 86_400_000);
    if (ageDays < STALE_BASELINE_DAYS) continue;
    followupNode.add(card.id);
    followups.push({
      tool: "check_artifacts",
      args: { node_ids: [card.id] },
      why: `снимок подтверждения старше ${ageDays} ${daysGenitive(ageDays)}`,
    });
  }

  // Приоритет 2: решение с невидимыми в ответе опорами → get_concept.
  for (const card of cardsWithKind) {
    if (followups.length >= FOLLOWUPS_LIMIT) break;
    if (followupNode.has(card.id) || !card.isDecision) continue;
    const live = db
      .getInformedByEdges(card.id, "ancestry", false)
      .map((e) => e.to_id)
      .filter((sid) => sid !== card.id && db.getNode(sid) !== undefined).length;
    const visible = Math.max(0, Math.trunc(card.visibleSupports ?? 0));
    if (live <= visible) continue;
    followupNode.add(card.id);
    followups.push({
      tool: "get_concept",
      args: { id: card.id },
      why: `у решения ${live} ${pluralRu(live, "опора", "опоры", "опор")}, в ответе видно ${visible}`,
    });
  }

  // Приоритет 3: нечистый support_check решения → provenance_trace.
  // Считается ограниченно: полная проверка — это обход опор, на каждый вызов
  // свой бюджет (как в get_concept), а количество вычислений ограничено.
  let supportChecks = 0;
  for (const card of cardsWithKind) {
    if (followups.length >= FOLLOWUPS_LIMIT || supportChecks >= SUPPORT_CHECK_LIMIT) break;
    if (followupNode.has(card.id) || !card.isDecision) continue;
    supportChecks += 1;
    const view = computeSupportCheck(
      db,
      card.id,
      new CheckBudget(
        input.checkBudget?.edges ?? DEFAULT_MAX_CHECK_EDGES,
        input.checkBudget?.bytes ?? DEFAULT_MAX_CHECK_BYTES
      )
    );
    if (!view || (view.state !== "unknown" && view.state !== "incomplete")) continue;
    followupNode.add(card.id);
    followups.push({
      tool: "provenance_trace",
      args: { node_id: card.id },
      why:
        view.state === "unknown"
          ? "support_check: unknown — снимка подтверждения нет, сверь опоры трассировкой"
          : "support_check: incomplete — проверка не уложилась в бюджет, перепроверь трассировкой",
    });
  }

  const next: NextHints = { must_read: mustRead, skip, followups, record: buildRecord(cardsWithKind, refuted) };
  // All understand modes use this builder; the warning participates in their wire budgets.
  if (input.emptyReason === "no_match") {
    const channel = vectorChannelState(db);
    if (channel.state === "off") next.search_warning = SEARCH_WARNING[channel.reason];
  }
  if (input.emptyReason) next.record = `${EMPTY_REASON_RECORD[input.emptyReason]} ${next.record}`;
  if (input.emptyReason !== "empty_base" && input.activity && input.activity.reads_since_write >= UNRECORDED_READS_THRESHOLD) {
    const { reads_since_write, last_write_at } = input.activity;
    next.record += ` С последней записи ${reads_since_write} чтений — если это законченный вывод, запиши его.`;
    next.unrecorded = { reads_since_write, last_write_at };
  }
  if (input.emptyReason !== "empty_base") {
    const previous = previousSession(db, now);
    if (previous) {
      next.previous_session = previous;
      if (previous.had_understand && !previous.had_record && !next.record.includes(PREVIOUS_SESSION_RECORD)) {
        next.record += ` ${PREVIOUS_SESSION_RECORD}`;
      }
    }
  }
  return next;
}
