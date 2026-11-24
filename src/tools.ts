import { KnowledgeDB, isNodeExpired } from "./db.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  cosineSimilarity,
  embed,
  embeddingText,
  embedForStorage,
  findTopK,
  queryText,
  vectorSearchEnabled,
  vectorChannelState,
} from "./embeddings.js";
import { basicSearch, ftsSearch, hybridSearch, type SearchVia } from "./search.js";
import { normalizeName, normalizeNameForDedupe } from "./norm.js";
import type {
  UnderstandInput,
  GetConceptInput,
  CreateConceptInput,
  UpdateConceptInput,
  LinkInput,
  RemoveConceptInput,
  ResolveConflictInput,
  NodeWithContext,
  UnderstandOutput,
  ListRootsInput,
  ListRootsOutput,
  ListConflictsOutput,
  ConflictGroup,
  CompactMatch,
  CompactCardView,
  NestedSupportView,
  UnderstandMeta,
  UnderstandCandidate,
  CurrentDigestsView,
  BriefOutput,
  NextHints,
  NodeRow,
  RelationType,
  ConceptEvidenceSupport,
  CollapsedAnchorView,
  NodeKind,
  EdgeRow,
} from "./types.js";
import { buildNextHints, LIST_ROOTS_SEARCH_HINT, type NextHintsCard } from "./next-hints.js";
import { scheduleFirstGeneration } from "./auto-reembed.js";
import { timelineActivity } from "./timeline.js";
import { renderBrief, renderDroppedText, type BriefNodeInfo } from "./brief.js";
import { stripMergeSuffix, MERGE_SUFFIX_LEFT, MERGE_SUFFIX_RIGHT, resolveEdgeConflicts } from "./merge.js";
import { moveNodeEdges, transferNodeIdentity } from "./consolidate.js";
import {
  readProvenanceConfig,
  REQUIRE_SUPPORT_MESSAGE,
  isUngrounded,
  resolveFileRef,
} from "./provenance.js";
import {
  BASELINE_FORMAT_VERSION,
  CheckBudget,
  DEFAULT_MAX_CHECK_BYTES,
  DEFAULT_MAX_CHECK_EDGES,
  claimDigestOf,
  computeSupportCheck,
  edgeDigestOf,
  journalSnapshotWrite,
  statusDigestOf,
} from "./support-baselines.js";
import { activeArtifactRows, artifactsDigestOf } from "./artifacts.js";
import { STUB_CHECK_KINDS, STUB_REJECTION_MESSAGE, isStubSummary, isTechnicalRefAnchor } from "./stub.js";
import { validationState } from "./validation.js";
import { readExpiryConfig, journalDefaultExpiry } from "./expiry.js";
import { readRefLines, type SourceSkipReason } from "./source-reader.js";
import { parseRef } from "./refs.js";
import {
  applyTaskEpoch,
  buildTaskContext,
  collectTaskBoost,
  dedupeTaskDuplicates,
  isTestRef,
  parseTaskInput,
  recordTaskEpoch,
} from "./task-context.js";
import type { TaskContextView } from "./types.js";

export function formatError(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const errorMsg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `MEGAMEMORY_ERROR: ${errorMsg}` }],
    isError: true,
  };
}

/**
 * Generate a slug ID from a name, optionally prefixed with parent ID.
 * Unicode-aware: keeps letters and digits from any script (Cyrillic, CJK,
 * Arabic, Hebrew...), strips diacritics only after Latin/Cyrillic/Greek/
 * Hebrew bases (katakana dakuten ジ = シ + U+3099 and Hangul jamo are NOT
 * diacritics — stripping them silently changes the syllable), turns '/' into
 * a dash (a/b and ab must not collide), collapses separators, and never
 * emits decomposed forms (final NFC). Falls back to a name hash when
 * nothing survives stripping (emoji-only, punctuation-only names).
 */
export function makeId(name: string, parentId?: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(
      /(?<=[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hebrew}])\p{M}+/gu,
      ""
    )
    .toLowerCase()
    .replace(/[\s_/]+/gu, "-")          // spaces, underscores AND slashes
    .replace(/[^\p{L}\p{N}\p{M}-]+/gu, "")  // letters/digits/marks of ANY script (NFC recomposes)
    .replace(/-+/g, "-")                 // collapse multiple hyphens
    .replace(/^-|-$/g, "")               // trim leading/trailing hyphens
    .normalize("NFC");                   // never emit decomposed ids

  const safe =
    slug || "node-" + createHash("sha1").update(name).digest("hex").slice(0, 8);
  return parentId ? `${parentId}/${safe}` : safe;
}


/**
 * Collision disambiguator for createConcept: same slug, different name.
 * Appends a short name-hash suffix so both concepts coexist.
 */
export function disambiguateId(id: string, name: string): string {
  const suffix = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${id}-${suffix}`;
}

/**
 * Parse file_refs from JSON string to array. Exported for the E1 profile
 * module — single source of the card's parsing rules.
 */
export function parseFileRefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Plan 1: status_scope is stored as a JSON string; unparseable = no scope.
 * Exported for the E1 profile module — single source of the card's parsing
 * rules.
 */
export function parseStatusScope(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// ---- Epistemic transitions (plan 1 §5.2) ----

/**
 * "stub" (2.1.9 F2) is not agent-driven: it is written only by createConcept
 * with allow_stub — the conscious bypass for placeholder supports. Updates
 * FROM stub are free (the owner replaced it with a real claim); no transition
 * TO stub exists outside creation.
 */
export type EpistemicStatus = "open" | "validated" | "refuted" | "abandoned" | "stub";

/**
 * Allowed epistemic transitions. Enforced ONLY at the MCP tool boundary —
 * internal callers (soft-delete, merge, supersede) bypass this so the system
 * never blocks its own lifecycle writes.
 */
const EPISTEMIC_TRANSITIONS: Record<EpistemicStatus, EpistemicStatus[]> = {
  open: ["validated", "refuted", "abandoned"],
  validated: ["refuted", "abandoned"],
  refuted: ["open"], // reopening, reason mandatory
  abandoned: ["open"],
  stub: ["open", "validated", "refuted", "abandoned"], // stub replaced by a real claim
};

/** `validated` needs a scope with an artifact — no self-confirmation (plan 1 §5.2). */
function requireValidatedScope(scope?: Record<string, unknown>): void {
  const artifact = scope && typeof scope === "object" ? (scope as { artifact?: unknown }).artifact : undefined;
  if (!scope || typeof scope !== "object" || !artifact) {
    throw new Error(
      `epistemic_status "validated" requires status_scope with an "artifact" ` +
        `(id of the test/benchmark run that confirms it). Without an external ` +
        `artifact the agent would be confirming its own claim.`
    );
  }
}

/**
 * Validate an agent-driven epistemic transition. Throws with a human-readable
 * message on an illegal move; `validated` additionally requires a scope with
 * an artifact (an agent confirming a fact by itself is circular validation).
 *
 * Plan 04 K-06: a same-status write is not a transition — the only kind that
 * goes through is a SCOPE replacement, and for `validated` it obeys the same
 * artifact rule (the old early return let a repeated `validated` skip the
 * check while the write still erased status_scope to NULL).
 */
export function validateEpistemicTransition(
  from: EpistemicStatus | null,
  to: EpistemicStatus,
  scope?: Record<string, unknown>
): void {
  if (from === to) {
    if (to === "validated") requireValidatedScope(scope);
    return;
  }
  const allowed = from === null ? ["validated", "refuted", "abandoned"] : EPISTEMIC_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid epistemic transition: ${from ?? "unknown"} -> ${to}. ` +
        `Allowed from ${from ?? "unknown"}: ${allowed.join(", ")}.`
    );
  }
  if (to === "validated") {
    requireValidatedScope(scope);
  }
}

/** Qualification shared by child cards and nested supports. */
function nodeQualification(db: KnowledgeDB, node: NodeRow) {
  return {
    status: node.status ?? "active",
    epistemic_status: node.epistemic_status ?? null,
    status_scope: parseStatusScope(node.status_scope),
    valid_until: node.valid_until ?? null,
    expired: isNodeExpired(node),
    ...(node.epistemic_status === "refuted" ? { refuted_reason: db.getLatestEpistemicReason(node.id, "refuted") } : {}),
  };
}

/**
 * Build a NodeWithContext from a node row and DB lookups.
 */
export function buildNodeWithContext(
  db: KnowledgeDB,
  node: NodeRow,
  similarity?: number,
  opts?: { withSupportCheck?: boolean }
): NodeWithContext {
  const children = db.getChildren(node.id).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind as NodeWithContext["kind"],
    summary: c.summary,
    ...nodeQualification(db, c),
  }));

  const outgoing = db.getOutgoingEdges(node.id).map((e) => ({
    to: e.to_id,
    to_name: e.to_name,
    relation: e.relation as RelationType,
    description: e.description,
  }));

  const incoming = db.getIncomingEdges(node.id).map((e) => ({
    from: e.from_id,
    from_name: e.from_name,
    relation: e.relation as RelationType,
    description: e.description,
  }));

  let parent: { id: string; name: string } | null = null;
  if (node.parent_id) {
    const p = db.getParent(node.parent_id);
    if (p) {
      parent = { id: p.id, name: p.name };
    }
  }

  // Plan 4 §4: the node card shows incoming and outgoing informed_by with
  // their rationales as dedicated blocks. getOutgoingEdges/getIncomingEdges
  // already filter tombstoned edges and dead endpoints; the blocks are
  // present only when non-empty.
  const informedByOut = db
    .getOutgoingEdges(node.id)
    .filter((e) => e.relation === "informed_by");
  const informedByIn = db
    .getIncomingEdges(node.id)
    .filter((e) => e.relation === "informed_by");

  // Plan 3 §4.2: weak-link marks on the card. A support is weak when it is
  // refuted/abandoned or ungrounded; a decision all of whose supports are
  // weak must not be quoted as proven knowledge.
  const informedByEntries = informedByOut.map((e) => {
    const target = db.getNode(e.to_id);
    let weak = false;
    if (target) {
      weak =
        target.epistemic_status === "refuted" ||
        target.epistemic_status === "abandoned" ||
        isUngrounded(db, target);
    }
    return {
      to: e.to_id,
      to_name: e.to_name,
      rationale: e.description,
      ...(weak ? { weak: true } : {}),
    };
  });
  const weakSupport =
    node.kind === "decision" &&
    informedByEntries.length > 0 &&
    informedByEntries.every((e) => e.weak === true);

  // Plan 4 v8 §4: the support check travels on the node card NEXT TO the
  // epistemic verdict — otherwise "verified" keeps meaning "was validated
  // once, nobody knows about the supports". Opt-in: search results (compact
  // and full) must not pay for it; get_concept turns it on.
  const supportCheck = opts?.withSupportCheck
    ? computeSupportCheck(
        db,
        node.id,
        new CheckBudget(DEFAULT_MAX_CHECK_EDGES, DEFAULT_MAX_CHECK_BYTES)
      )
    : undefined;

  return {
    id: node.id,
    name: node.name,
    kind: node.kind as NodeWithContext["kind"],
    summary: node.summary,
    why: node.why,
    file_refs: parseFileRefs(node.file_refs),
    children,
    edges: outgoing,
    incoming_edges: incoming,
    parent,
    // T4: lifecycle status surfaces in the node card.
    status: node.status ?? "active",
    valid_until: node.valid_until ?? null,
    // 2.1.12 F1: факт просрочен — на карточке это видно без вычислений.
    expired: isNodeExpired(node),
    // UX-01 (план 07): происхождение, задача и слоты на карточке — сравнение
    // перед слиянием показывает то, что влияет на последствия (создатель,
    // дедлайн и роли переезжают или теряются вместе с дублем).
    created_via: node.created_via ?? null,
    task_state: node.task_state ?? null,
    due_at: node.due_at ?? null,
    slots: db.getSlotsForNode(node.id),
    // Plan 1 §5.3: both axes on the card, plus the scope of a `validated`.
    epistemic_status: node.epistemic_status ?? null,
    status_scope: parseStatusScope(node.status_scope),
    // Refuted nodes always carry the reason — that is the whole point of
    // keeping them in the graph.
    ...(node.epistemic_status === "refuted"
      ? { refuted_reason: db.getLatestEpistemicReason(node.id, "refuted") }
      : {}),
    ...(similarity !== undefined ? { similarity } : {}),
    // Plan 2 §1: the "participates in chains" block on the node card, with
    // the chain state — a stale/broken chain on the card is a warning sign.
    trails: db.getTrailsForNode(node.id).map((t) => {
      return { id: t.id, name: t.name, state: trailState(db, t.id) };
    }),
    ...(informedByEntries.length > 0
      ? {
          informed_by: informedByEntries,
        }
      : {}),
    ...(informedByIn.length > 0
      ? {
          informed_by_incoming: informedByIn.map((e) => ({
            from: e.from_id,
            from_name: e.from_name,
            rationale: e.description,
          })),
        }
      : {}),
    ...(weakSupport ? { weak_support: true } : {}),
    ...(supportCheck ? { support_check: supportCheck } : {}),
  };
}

// ---- Tool handlers ----

/**
 * Conservative token estimate: ~3 chars per token. Cyrillic/CJK encode
 * worse than English in most tokenizers, so this stays on the safe side.
 */
export function estimateTokens(text: string): number {
  // Bytes, not JS chars (patch А6): CJK is ~1 token per char but 3 bytes,
  // so chars/3 underestimates ~3x for Chinese. In bytes the estimate is
  // conservative for every script (latin ~4 B/token, cyrillic ~5, CJK ~3).
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

/**
 * Actual MCP content wrapper, including pretty JSON escaping and its own
 * estimate. Exported for the E1/E2 budget modules (concept-profile.ts): the
 * profile and batch budgets are measured over the same serialized wire shape
 * the handler really sends (§4.3).
 */
export function measureMcpPayload(payload: unknown): number {
  const value = payload as { meta?: { tokens_estimated: number } };
  let tokens = 0;
  for (;;) {
    const measured = estimateTokens(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(value.meta ? { ...value, meta: { ...value.meta, tokens_estimated: tokens } } : value, null, 2) }],
    }));
    if (measured === tokens) return tokens;
    tokens = measured;
  }
}

/**
 * Truncate to maxChars at a word boundary with an ellipsis. Operates on
 * UTF-16 code units but never splits a surrogate pair.
 */
export function trimSummary(text: string, maxChars = 240): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars - 1;
  // Do not cut inside a surrogate pair.
  const low = text.charCodeAt(cut);
  if (low >= 0xdc00 && low <= 0xdfff) cut -= 1;
  const space = text.lastIndexOf(" ", cut);
  if (space > maxChars / 2) cut = space;
  return text.slice(0, cut).trimEnd() + "…";
}

/**
 * 2.1.12 F1: validate the agent-supplied expiry. Any ISO-8601 date/time the
 * platform parses is accepted ("2026-12-31", "2026-12-31T23:59:59Z",
 * "2026-12-31T23:59:59+03:00") and stored AS GIVEN — the reading side
 * compares via Date.parse, not by string shape. undefined = не трогать,
 * null = снять срок; garbage is a hard error, not a silent no-expiry.
 */
export function normalizeValidUntil(
  value: string | null | undefined,
  field = "valid_until"
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = value.trim();
  if (text === "") return null; // пустая строка = снять срок
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(
      `${field}: "${value}" не разбирается как дата (нужен ISO-8601, напр. "2026-12-31").`
    );
  }
  return text;
}

/**
 * 2.1.13 F4: «вечные» утверждения о состоянии. «PR #3 не влит», «релиз
 * опубликован», «issue закрыт» — верно в момент записи и тихо врёт спустя
 * месяц, если у узла нет срока годности. Сервер valid_until сам не ставит
 * («Чего не делать») и запись не блокирует: мягкое предупреждение в ответе
 * инструмента, решение за агентом. kind=digest — серверная сводка, её не
 * проверяем.
 */
export interface ConceptWarning {
  code: "state_claim_without_expiry" | "expired_on_create";
  hint: string;
}

const STATE_CLAIM_RE =
  /смержен\w*|влит\w*|не\s+влит|не\s+начат|выпущен\w*|релиз\w*|закрыт\w*|в\s+работе|ожидает\w*|not\s+merged|merged|released|pending|#\d+|\d+\.\d+\.\d+|\d{4}-\d{2}-\d{2}/i;

export function looksLikeStateClaim(summary: string): boolean {
  return STATE_CLAIM_RE.test(summary);
}

const STATE_CLAIM_HINT =
  "Утверждение о состоянии («смержен», номер PR, версия, дата) без срока годности " +
  "со временем начнёт утверждать то, чего уже нет. Передай valid_until " +
  "(ISO-8601, напр. \"2026-12-01\") или переформулируй как устойчивое знание.";
const EXPIRED_HINT =
  "valid_until уже в прошлом — узел создан, но сразу выпадет из выдачи. Проверь дату или сними срок (null).";

const JOURNAL_NULL_HINT =
  "Journal — изменчивая запись о состоянии. По умолчанию срок ставится автоматически " +
  "(expiry.journal_days / MEGAMEMORY_EXPIRY_JOURNAL_DAYS, fallback 90 дней); явный null " +
  "автопростановку отключает. Запись без срока не объявляется безопасной: передай valid_until " +
  "или верни автопростановку.";

/**
 * Предупреждения записи узла: срок в прошлом — всегда; утверждение о
 * состоянии без срока — когда effective expiry отсутствует (undefined или
 * null = бессрочно). M2 B2: kind=journal — по определению изменчивая запись
 * о состоянии, диагностика без срока не требует regex-совпадения; явный null
 * запрещает автопростановку, но не делает запись безопасной (R08).
 */
export function conceptWarnings(
  summary: string,
  opts: { kind?: string; validUntil: string | null | undefined }
): ConceptWarning[] {
  const warnings: ConceptWarning[] = [];
  if (opts.validUntil) {
    const t = Date.parse(opts.validUntil);
    if (!Number.isNaN(t) && t < Date.now()) {
      warnings.push({ code: "expired_on_create", hint: EXPIRED_HINT });
    }
  }
  if (opts.validUntil == null) {
    if (opts.kind === "journal") {
      warnings.push({ code: "state_claim_without_expiry", hint: JOURNAL_NULL_HINT });
    } else if (opts.kind !== "digest" && looksLikeStateClaim(summary)) {
      warnings.push({ code: "state_claim_without_expiry", hint: STATE_CLAIM_HINT });
    }
  }
  return warnings;
}

/** Compact per-node payload (plan T3): no why, trimmed summary. */
function compactMatch(
  db: KnowledgeDB,
  node: NodeRow,
  opts: {
    score?: number;
    via?: SearchVia;
    withContext: boolean;
    expired?: boolean;
    /** E3: с флагом include_evidence матч несёт подтверждаемые версии. */
    withEvidence?: boolean;
  }
): CompactMatch {
  const fileRefs = parseFileRefs(node.file_refs);
  const match: CompactMatch = {
    id: node.id,
    name: node.name,
    kind: node.kind as CompactMatch["kind"],
    ...nodeQualification(db, node),
    // План 06 (K-04): «антизнание с причиной» и в compact — причина была
    // только в full-режиме, в компактной выдаче опровержение теряло смысл.
    summary: opts.withEvidence ? node.summary : trimSummary(node.summary),
    file_refs: fileRefs,
    // План 06 (K-03): RRF-score несёт 17 значащих цифр и дублируется в
    // similarity — в компактной выдаче обе округляются до 4 знаков,
    // иначе мусорные байты съедают бюджет ответа.
    ...(opts.score !== undefined
      ? { score: Number(opts.score.toFixed(4)), similarity: Number(opts.score.toFixed(4)) }
      : {}),
    ...(opts.via ? { via: opts.via } : {}),
    // 2.1.12 F1: пометка живёт только при include_stale: true — обычная
    // выдача просроченных не показывает вовсе.
    ...(opts.expired ? { expired: true } : {}),
  };
  if (opts.withContext) {
    match.children = db
      .getChildren(node.id)
      .map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind as CompactMatch["kind"],
        ...nodeQualification(db, c),
      }));
    match.edges = db
      .getOutgoingEdges(node.id)
      .map((e) => ({
        to: e.to_id,
        to_name: e.to_name,
        relation: e.relation as RelationType,
      }));
  }
  // E3 (план 20+21 v3 §8.3): evidence-дополнение строится здесь, а не в
  // placeLoop — граница размещения (контракт D-01) не должна знать о новых
  // идентификаторах. Флаг передаётся с кандидатом (withEvidence), мера
  // фактической формы учитывает добавку до принятия кандидата.
  if (opts.withEvidence) {
    match.current_digests = currentDigestsOf(node);
    match.support_evidence = liveEvidenceSupports(db, node);
  }
  return match;
}

/**
 * E3 (план 20+21 v3 §8.3): одна сборка evidence-опоры — та же механика, что
 * evidence-профиль get_concept (M3-1, concept-profile.ts), не дубль: полная
 * формулировка (никогда не обрезается), rationale ребра, квалификация,
 * weak/quality и готовые дайджесты confirm_supports общими экспортами.
 * Криптографические значения едут полными hex — display-префиксы живут
 * только в диагностических сообщениях, не в подтверждаемой форме.
 */
export function evidenceSupportOf(
  db: KnowledgeDB,
  row: NodeRow,
  rationale: string | null
): ConceptEvidenceSupport {
  return {
    to: row.id,
    to_name: row.name,
    rationale,
    claim: row.summary,
    ...nodeQualification(db, row),
    ...(row.epistemic_status === "abandoned" ||
    row.epistemic_status === "refuted" ||
    isUngrounded(db, row)
      ? { weak: true }
      : {}),
    quality: isStubSummary(row.summary, row.kind, row.created_via) ? "stub" : "claim",
    digests: {
      claim_digest: claimDigestOf(row.summary),
      status_digest: statusDigestOf(row.status, row.epistemic_status),
      edge_digest: edgeDigestOf(rationale),
      artifacts_digest: artifactsDigestOf(
        activeArtifactRows(row, db.getNodeArtifacts(row.id))
      ),
    },
  };
}

/** E3: все живые опоры узла с rationale ребра — полный набор для подтверждения. */
function liveEvidenceSupports(db: KnowledgeDB, node: NodeRow): ConceptEvidenceSupport[] {
  return db
    .getInformedByEdges(node.id, "ancestry", false)
    .map((e) => ({ edge: e, row: db.getNode(e.to_id) }))
    .filter((x): x is { edge: EdgeRow & { other_id: string }; row: NodeRow } => x.row !== undefined)
    .map((x) => evidenceSupportOf(db, x.row, x.edge.description ?? null));
}

const understandPresence = new WeakMap<KnowledgeDB, { hasNodes: boolean; writes: number; lastWriteAt: string | null; dataVersion: number }>();

export async function understand(
  db: KnowledgeDB,
  input: UnderstandInput
): Promise<UnderstandOutput> {
  const topK = input.top_k ?? 10;
  // GAR recall measured 6103–7460 tokens for five full candidates; 1500
  // left only one useful card. Explicit budgets still take precedence.
  const maxTokens = input.max_tokens ?? 4000;
  const outputMode = input.mode ?? "compact";
  let activity: ReturnType<typeof timelineActivity>;
  let dataVersion: number | undefined;
  const emptyReason = (hasContent: boolean, hadCandidates: boolean): UnderstandMeta["reason"] => {
    if (hasContent) return undefined;
    dataVersion ??= (db.execSqlFirst("PRAGMA data_version") as { data_version: number }).data_version;
    const cached = understandPresence.get(db);
    if (activity && cached && cached.writes === activity.writes && cached.lastWriteAt === activity.last_write_at && cached.dataVersion === dataVersion) {
      if (!cached.hasNodes) return "empty_base";
    } else {
      const [count] = db.execSqlAll("SELECT COUNT(*) AS count FROM nodes WHERE removed_at IS NULL") as Array<{ count: number }>;
      const hasNodes = count.count > 0;
      // Logger writes and commits from another connection both invalidate presence.
      if (activity) understandPresence.set(db, { hasNodes, writes: activity.writes, lastWriteAt: activity.last_write_at, dataVersion });
      if (!hasNodes) return "empty_base";
    }
    return hadCandidates ? "budget" : "no_match";
  };
  // E3/D0: opt-in режимы поддержаны только в compact — full/brief отвечают
  // прежней формой; молчаливое игнорирование флага скрыло бы его отсутствие.
  if (input.include_evidence && outputMode !== "compact") {
    throw new Error(
      "understand: include_evidence поддержан только в mode=compact — full/brief не несут дайджестов подтверждения."
    );
  }
  if (input.collapse_ref_anchors && outputMode !== "compact") {
    throw new Error(
      "understand: collapse_ref_anchors поддержан только в mode=compact — верхний уровень full/brief не изменяется."
    );
  }
  if (input.reuse && outputMode !== "compact") {
    throw new Error(
      "understand: reuse поддержан только в mode=compact — full/brief не несят секции паспортов."
    );
  }
  if (input.task && outputMode !== "compact") {
    throw new Error(
      "understand: task поддержан только в mode=compact — full/brief отвечают прежней формой, task-профиль туда не встраивается."
    );
  }
  if (input.include_source && outputMode !== "compact") {
    throw new Error(
      "understand: include_source поддержан только в mode=compact — full/brief не несят verbatim-исходников."
    );
  }
  // P3 (план 20+21 v3 §12): контекст под задачу. Валидация входа — ДО всякой
  // работы; без task прежнее поведение байт-в-байт.
  const taskPlan = input.task
    ? parseTaskInput(input.task, process.cwd())
    : null;
  const includeEvidence = input.include_evidence ?? false;
  // План 26 §2: verbatim-исходник в карточках. По умолчанию выключено —
  // прежний ответ байт-в-байт; дефолт включать нельзя (остаточный контекст).
  const includeSource = input.include_source ?? false;
  const sourceMaxLines = Math.min(Math.max(Math.trunc(input.source_max_lines ?? 60), 1), 200);
  const pathQuery = /^[\w./-]+\.\w+:\d+-\d+$/.test(input.query.trim());
  const collapseAnchors = outputMode === "compact" && (input.collapse_ref_anchors ?? !pathQuery);

  // План 06 (K-01): пул кандидатов шире top_k — фильтр актуальности
  // применяется ДО финальной нарезки. Раньше top_k резал выдачу поиска, и
  // просроченный/неактивный первый хит оставлял ответ пустым (при top_k=1
  // следующий живой не добирался). Пул ограничен — это ограниченный добор,
  // а не сканирование всей базы.
  const searchPool = Math.min(50, Math.max(topK * 2, topK + 10));

  // Search mode (plan T2): hybrid by default — RRF over FTS + vector.
  // Vector-only runs when MEGAMEMORY_SEARCH=vector; text-only for fts, or
  // when vectors are disabled (model mismatch pending reembed).
  const mode = process.env.MEGAMEMORY_SEARCH ?? "hybrid";
  let topMatches: Array<{ id: string; similarity: number }>;
  const viaById = new Map<string, SearchVia>();

  if (mode === "hybrid") {
    const hits = await hybridSearch(db, input.query, { topK: searchPool });
    topMatches = hits.map((h) => ({ id: h.id, similarity: h.score }));
    for (const h of hits) viaById.set(h.id, h.via);
  } else if (mode === "vector" && vectorSearchEnabled(db)) {
    const expectedGeneration = db.getVectorGeneration();
    const candidates = db.getAllActiveNodesWithEmbeddings(expectedGeneration ?? undefined);
    if (candidates.length === 0) {
      // Empty vector results use the same budgeted envelope as every other path.
      topMatches = [];
    } else {
      const queryEmbedding = await embed(queryText(input.query));
      const currentGeneration = db.getVectorGeneration();
      if (!expectedGeneration || !currentGeneration || currentGeneration.generation !== expectedGeneration.generation || currentGeneration.profile !== expectedGeneration.profile) throw new Error("version_conflict: vector generation changed during understand.");
      topMatches = findTopK(queryEmbedding, candidates, searchPool);
    }
  } else {
    topMatches = basicSearch(db, input.query, searchPool);
  }

  activity = timelineActivity(db);
  // T4 will filter superseded/deprecated here unless include_inactive.

  // Resolve nodes once, in rank order. T4: superseded/deprecated nodes are
  // hidden by default (include_inactive: true shows them with their status).
  // Plan 1 §5.3: refuted nodes are the conscious exception — they bypass the
  // filter and go to a separate output block, because antiknowledge ("where
  // we went wrong") must never disappear behind include_inactive.
  const includeInactive = input.include_inactive ?? false;
  // 2.1.12 F1: просроченные факты (valid_until в прошлом) исключаются по
  // умолчанию; include_stale возвращает их с пометкой expired. Считаются
  // только активные: superseded/deprecated отфильтрованы своим статусом и
  // их valid_until — метка замены, а не срок годности утверждения.
  const includeStale = input.include_stale ?? false;
  let staleExcluded = 0;
  let inactiveExcluded = 0;
  // План 06 (K-01): фильтр идёт по всему пулу, нарезка top_k — после него.
  const eligible: Array<{
    node: NodeRow;
    score: number;
    via?: SearchVia;
    expired: boolean;
    /** E3: флаг едет с кандидатом — placeLoop не ссылается на новые идентификаторы. */
    evidence?: boolean;
  }> = [];
  const refutedNodes: Array<{ node: NodeRow; score: number; via?: SearchVia }> = [];
  for (const match of topMatches) {
    const node = db.getNode(match.id);
    if (!node) continue;
    if ((node.epistemic_status ?? null) === "refuted") {
      refutedNodes.push({ node, score: match.similarity, via: viaById.get(match.id) });
      continue;
    }
    const status = node.status ?? "active";
    if (!includeInactive && status !== "active") {
      inactiveExcluded += 1;
      continue;
    }
    const expired = isNodeExpired(node);
    if (expired && !includeStale) {
      staleExcluded += 1;
      continue;
    }
    eligible.push({
      node,
      score: match.similarity,
      via: viaById.get(match.id),
      expired,
      ...(includeEvidence ? { evidence: true } : {}),
    });
  }
  // top_k — это верхний уровень compact-выдачи; вложенные опоры слотов не
  // занимают, поэтому нарезка применяется к размещению (placeLoop), а не к
  // списку кандидатов.

  // ---- P3 (план 20+21 v3 §12.3): task-профиль — добор и приоритет обязательных ----
  //
  // Детерминированные правила: решения/тесты по ЯВНОЙ области задачи добавляются
  // в пул кандидатов (score 0 — явный добор по scope, не похожесть), а
  // обязательные категории поднимаются в размещение (стабильная перестановка:
  // mandatory в ранговом порядке среди себя, затем остальные в ранговом
  // порядке). Без task-параметра этот блок не выполняется вовсе.
  if (taskPlan) {
    const boost = collectTaskBoost(
      db,
      taskPlan,
      new Set([
        ...eligible.map((e) => e.node.id),
        ...refutedNodes.map((r) => r.node.id),
      ])
    );
    for (const row of boost.decisions) {
      eligible.push({ node: row, score: 0, expired: isNodeExpired(row) });
    }
    for (const row of boost.tests) {
      eligible.push({ node: row, score: 0, expired: isNodeExpired(row) });
    }
    for (const row of boost.refuted) {
      refutedNodes.push({ node: row, score: 0 });
    }
    // Обязательные категории — впереди, каждая группа в своём ранговом порядке.
    const isMandatoryCandidate = (row: NodeRow): boolean => {
      if (row.kind === "decision") return true;
      if (row.epistemic_status === "refuted") return true;
      try {
        const parsed: unknown = JSON.parse(row.file_refs ?? "null");
        if (Array.isArray(parsed)) {
          return parsed.some(
            (r) => typeof r === "string" && (taskPlan.kind === "prepare_edit" ? isTestRef(r) : false)
          );
        }
      } catch {
        return false;
      }
      return false;
    };
    const mandatoryPart = eligible.filter((e) => isMandatoryCandidate(e.node));
    const restPart = eligible.filter((e) => !isMandatoryCandidate(e.node));
    eligible.length = 0;
    eligible.push(...mandatoryPart, ...restPart);
  }

  // Stable partition: locator-like names are discovery, not the first knowledge card.
  const isLocatorName = (name: string): boolean => /^[\w./-]+\.\w+:\d+-\d+$/.test(name);
  if (outputMode === "compact" && !pathQuery) {
    const knowledge = eligible.filter(({ node }) => !isLocatorName(node.name));
    const locators = eligible.filter(({ node }) => isLocatorName(node.name));
    eligible.splice(0, eligible.length, ...knowledge, ...locators);
  }

  // ---- План 13 §2.2: режим brief — до 8 строк текста плюс next, без карточек ----
  //
  // brief — для агентов, не для людей: compact остаётся по умолчанию и при
  // явном запросе mode: "brief" остальная функция не выполняется. Основа —
  // те же узлы верхнего уровня в ранговом порядке; текст рендерится в
  // brief.ts из узлов и блока next, сам next строится buildNextHints группы
  // A как есть. Опор в brief не видно, поэтому для buildNextHints все узлы
  // идут с visibleSupports: 0 — подсказка get_concept для решений с опорами
  // остаётся честной. Бюджет считается по ТОЙ ЖЕ wire-форме, что уйдёт по
  // проводу (K-03): pretty-JSON внутри MCP-конверта с extra_payload
  // обработчика. При превышении режутся только optional followups; must_read
  // и record сохраняются. Если обязательная форма не влезает, запрос отклоняется.
  // meta.truncated отмечает реальную порезку, а не разрешение перерасхода.
  if (outputMode === "brief") {
    const extra = input.extra_payload ?? {};

    // Brief keeps its text and mandatory instructions intact; only followups may be cut.

    // Основа брифа: верхний уровень выдачи в ранговом порядке (top_k).
    const nodes = eligible.slice(0, topK);
    const briefNodes: BriefNodeInfo[] = nodes.map(({ node }) => ({
      name: node.name,
      kind: node.kind,
      fileRefs: parseFileRefs(node.file_refs) ?? [],
    }));
    const refutedForNext = refutedNodes.map(({ node }) => ({
      name: node.name,
      reason: db.getLatestEpistemicReason(node.id, "refuted"),
    }));

    const reason = emptyReason(nodes.length > 0 || refutedNodes.length > 0, eligible.length > 0);
    const next: NextHints = buildNextHints({
      db,
      cards: nodes.map(({ node }) => ({ id: node.id, visibleSupports: 0 })),
      refuted: refutedForNext,
      activity,
      emptyReason: reason,
    });

    // Полный режим по тем же сырым строкам, что и в compact-ветке (см. ниже):
    // сигнал «сколько сэкономил brief» относительно mode: "full".
    const FULL_CARD_OVERHEAD_TOKENS = 60;
    const estimatedFullTokens = nodes.reduce(
      (sum, { node }) =>
        sum +
        estimateTokens(node.summary) +
        (node.why ? estimateTokens(node.why) : 0) +
        FULL_CARD_OVERHEAD_TOKENS,
      0
    );

    const metaWith = (tokens: number, trunc: boolean): UnderstandMeta => ({
      returned: nodes.length,
      dropped: Math.max(0, eligible.length - nodes.length),
      tokens_estimated: tokens,
      estimated_full_tokens: estimatedFullTokens,
      stale_excluded: staleExcluded,
      inactive_excluded: inactiveExcluded,
      truncated: trunc,
      ...(reason ? { reason } : {}),
    });

    /** Тот объект, который уйдёт по проводу (brief + next + meta + extra). */
    const buildPayload = (tokens: number, trunc: boolean) => ({
      matches: [] as never[],
      brief: renderBrief(briefNodes, next),
      next,
      meta: metaWith(tokens, trunc),
      ...extra,
    });

    // Remove optional followups only; mandatory references and record stay intact.
    let nextCut = false;
    while (next.followups.length > 0 && measureMcpPayload(buildPayload(0, nextCut)) > maxTokens) {
      next.followups.pop();
      nextCut = true;
    }
    const truncated = nextCut;
    const tokensEstimated = measureMcpPayload(buildPayload(0, truncated));
    if (tokensEstimated > maxTokens) {
      throw new Error(`understand: max_tokens=${maxTokens} cannot fit the brief instructions and required references (minimum ${tokensEstimated}); increase the budget.`);
    }
    const output: BriefOutput & { matches: never[] } = {
      matches: [],
      brief: renderBrief(briefNodes, next),
      next,
      meta: metaWith(tokensEstimated, truncated),
    };

    const payload = JSON.stringify(output);
    db.insertUsage({
      tool: "understand",
      query: input.query,
      nodes: nodes.length,
      returnedChars: payload.length,
      returnedTokens: tokensEstimated,
      estimatedFullTokens,
    });

    // BriefOutput не входит в UnderstandOutput (matches обязателен);
    // matches: [] держит обработчик MCP безопасным (result.matches.map в
    // index.ts) и карточек по проводу не несёт.
    return output as unknown as UnderstandOutput;
  }

  if (outputMode === "full") {
    const matches: NodeWithContext[] = [];
    for (const { node, score, via, expired } of eligible.slice(0, topK)) {
      const ctx = buildNodeWithContext(db, node, score);
      if (via) ctx.via = via;
      if (expired) ctx.expired = true;
      matches.push(ctx);
    }
    const refuted = refutedNodes.map(({ node, score, via }) => {
      const ctx = buildNodeWithContext(db, node, score);
      if (via) ctx.via = via;
      return ctx;
    });
    // Full preserves every selected card and next action, refusing budgets that cannot fit.
    const reason = emptyReason(matches.length > 0 || refuted.length > 0, eligible.length > 0);
    const fullNext = buildNextHints({
      db,
      cards: matches.map((m) => ({
        id: m.id,
        kind: m.kind,
        visibleSupports: m.edges.filter((e) => e.relation === "informed_by").length,
      })),
      refuted: refuted.map((r) => ({ name: r.name, reason: r.refuted_reason ?? null })),
      activity,
      emptyReason: reason,
    });
    const output: UnderstandOutput = {
      matches,
      compact: undefined,
      refuted,
      meta: {
        returned: matches.length,
        dropped: eligible.length - matches.length,
        tokens_estimated: 0,
        stale_excluded: staleExcluded,
        inactive_excluded: inactiveExcluded,
        ...(reason ? { reason } : {}),
      },
      next: fullNext,
    };
    const tokensEstimated = measureMcpPayload({ ...output, ...input.extra_payload });
    if (tokensEstimated > maxTokens) {
      throw new Error(`understand: max_tokens=${maxTokens} cannot fit the full response, next actions, and wrapper fields (minimum ${tokensEstimated}); increase the budget or use compact mode.`);
    }
    output.meta!.tokens_estimated = tokensEstimated;
    const payload = JSON.stringify(output);
    db.insertUsage({
      tool: "understand",
      query: input.query,
      nodes: matches.length,
      returnedChars: payload.length,
      returnedTokens: tokensEstimated,
      estimatedFullTokens: tokensEstimated,
    });
    return output;
  }

  // ---- compact: единый сериализатор бюджета и MCP-ответа (план 06, K-03) ----
  //
  // Бюджет считается по ТОЙ ЖЕ форме, которую обработчик реально отправляет:
  // pretty (indent 2) внутри MCP-конверта {content:[{type,text}]}, со всеми
  // секциями (refuted, edges_between, meta) и extra_payload обработчика
  // (instructions_stale, server_version). Раньше оценка считала minified
  // обрезанный объект без refuted и конверта — при max_tokens=500 восемь
  // refuted дали реальные 1469 токенов при tokens_estimated: 0.

  const recallRows = [...eligible, ...refutedNodes].filter(
    (entry, index, rows) => rows.findIndex((other) => other.node.id === entry.node.id) === index
  );
  const CARDS_MAX = Math.min(topK, 3);
  const CANDIDATE_SOFT = 40;
  const CANDIDATE_HARD = 90;
  const candidateTarget = Math.floor(maxTokens / 4);
  let candidates: UnderstandCandidate[] = [];
  // Independently reproducible wire-ish cost, including pretty JSON and MCP escaping.
  const candidateCost = (list: UnderstandCandidate[]): number =>
    measureMcpPayload({ candidates: list }) - measureMcpPayload({ candidates: [] });
  const tailName = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    let start = text.length - Math.max(0, limit - 1);
    const low = text.charCodeAt(start);
    if (low >= 0xdc00 && low <= 0xdfff) start += 1;
    return limit > 0 ? "…" + text.slice(start) : "";
  };
  const discovery: UnderstandCandidate[] = recallRows.map(({ node, score, via }) => ({
    id: node.id,
    name: tailName(node.name, 60),
    kind: node.kind as NodeKind,
    ...(via ? { via } : {}),
    score: Number(score.toFixed(4)),
    // Refuted discovery is a locator, not a shortened rejected claim without its reason.
    ...(node.epistemic_status === "refuted" ? {} : { summary_short: trimSummary(node.summary, 80) }),
    ...(node.epistemic_status === "refuted" || node.epistemic_status === "abandoned"
      ? { epistemic_status: node.epistemic_status }
      : {}),
  }));

  const extra = input.extra_payload ?? {};

  // P1.3 (план 20+21 v3 §10): opt-in reuse — квалификация паспортов по явному
  // типу задачи и области. Только чтение: ни снимков, ни наблюдений, ни
  // записей графа; секция участвует в бюджетной мере на общих основаниях.
  const reuseView = input.reuse
    ? await qualifyReuse(db, {
        task_type: input.reuse.task_type,
        ...(input.reuse.files !== undefined ? { files: input.reuse.files } : {}),
        ...(input.reuse.trail_id !== undefined ? { trail_id: input.reuse.trail_id } : {}),
        ...(input.reuse.repo_root !== undefined ? { repo_root: input.reuse.repo_root } : {}),
        ...(input.reuse.max_candidates !== undefined
          ? { max_candidates: input.reuse.max_candidates }
          : {}),
        ...(input.reuse.negative !== undefined ? { negative: input.reuse.negative } : {}),
      })
    : undefined;
  activity = timelineActivity(db);

  // P3: секция контекста под задачу — строится ПОСЛЕ размещения и снятия
  // повторов (см. ниже); объявления здесь, чтобы бюджетная мера buildPayload
  // видела добавку на общих основаниях (K-03).
  let taskServedEarlier: TaskContextView["served_earlier"] = [];

  const edgesFor = (list: Array<{ id: string }>) =>
    list.length >= 2
      ? (db.execSqlAll(
          `SELECT DISTINCT from_id, to_id, relation FROM edges
           WHERE removed_at IS NULL
             AND from_id IN (${list.map(() => "?").join(",")})
             AND to_id IN (${list.map(() => "?").join(",")})`,
          ...list.map((m) => m.id),
          ...list.map((m) => m.id)
        ) as Array<{ from_id: string; to_id: string; relation: string }>).map(
          (e) => ({ from: e.from_id, to: e.to_id, relation: e.relation })
        )
      : [];

  const measure = measureMcpPayload;

  // План 06 (K-03, работа 5): полный граф ради оценки «сэкономленных
  // токенов» на каждом compact-запросе не строим — стоимость full-режима
  // оцениваем по уже прочитанным строкам: сырые (необрезанные) summary и
  // why плюс константа на детей/рёбра/трейлы карточки.
  const FULL_CARD_OVERHEAD_TOKENS = 60;
  const fullModeCandidates = eligible.slice(0, topK);
  const estimatedFullTokens = fullModeCandidates.reduce(
    (sum, { node }) =>
      sum +
      estimateTokens(node.summary) +
      (node.why ? estimateTokens(node.why) : 0) +
      FULL_CARD_OVERHEAD_TOKENS,
    0
  );

  // Plan 1 §5.3: separate "refuted" block, marked and with the reason —
  // these are not facts and must not blend into the match list.
  const refutedAll = refutedNodes.map(({ node, score, via }) =>
    compactMatch(db, node, { score, via, withContext: false })
  );

  // ---- 2.1.7 F2: supports fold under their decisions ----
  //
  // A support shares the query terms with its decision ("EBUSY" names both
  // the fact and the fix) and used to outrank it — the agent asked "why" and
  // got the fact without the decision it belongs to. When BOTH are in the
  // answer, the support travels nested under the decision: depth 1, no top_k
  // slot of its own, tokens still counted. A support whose decision did not
  // make the answer stays a standalone fact on the top level — knowledge is
  // never hidden, only regrouped.

  const candidateIds = new Set(eligible.map((n) => n.node.id));
  const nodeRowById = new Map(eligible.map((n) => [n.node.id, n.node]));
  // Live informed_by supports of every candidate that are candidates too.
  const supportIdsOf = new Map<string, string[]>();
  for (const { node } of eligible) {
    supportIdsOf.set(
      node.id,
      db
        .getInformedByEdges(node.id, "ancestry", false)
        .map((e) => e.to_id)
        .filter((sid) => sid !== node.id && candidateIds.has(sid))
    );
  }

  const top: CompactMatch[] = [];
  const refutedShown: CompactMatch[] = [];
  let nestedByHost = new Map<string, NestedSupportView[]>();
  let foldedIds = new Set<string>();
  const collapsedAnchors: CollapsedAnchorView[] = [];
  let truncated = false;
  // План 26 §2: причина, по которой карточка осталась без исходника.
  // Объявлено до metaFor — floor-замер читает его через buildPayload.
  let sourceSkipped: UnderstandMeta["source_skipped"];
  // План 26 §3: расхождение записи с файлом (mtime) — сигнал, не приговор.
  let staleRefsShown: NonNullable<UnderstandOutput["stale_refs"]> = [];
  let staleRefsTotal = 0;
  let staleRefsMissing = 0;
  let taskDuplicates: TaskContextView["duplicates_dropped"] = [];

  // Keep one anchor as a normal UI card when there is no meaningful hit at all.
  const hasMeaningfulCandidates = eligible.some((entry) => !isTechnicalRefAnchor(entry.node));
  const anchorEligible = collapseAnchors && hasMeaningfulCandidates
    ? eligible.filter((e) => isTechnicalRefAnchor(e.node))
    : [];
  if (anchorEligible.length > 0) {
    const anchorIds = new Set(anchorEligible.map((e) => e.node.id));
    for (let i = eligible.length - 1; i >= 0; i -= 1) {
      if (anchorIds.has(eligible[i].node.id)) eligible.splice(i, 1);
    }
  }

  const displayList = (): CompactMatch[] => top.filter((m) => !foldedIds.has(m.id));
  const withNested = (list: CompactMatch[]): CompactMatch[] =>
    list.map((m) => nestedByHost.has(m.id) ? { ...m, supports: nestedByHost.get(m.id) } : m);
  const serializeCard = (card: CompactMatch): CompactCardView => {
    if (card.summary !== "") return card;
    const view: CompactCardView = { ...card };
    delete view.summary;
    return view;
  };
  const compactEmptyReason = (): UnderstandMeta["reason"] => {
    if (displayList().length > 0 || refutedShown.length > 0 || taskServedEarlier.length > 0) return undefined;
    // Discovery/anchors are locators, not a qualified knowledge card.
    return emptyReason(false, recallRows.length > 0);
  };
  const metaFor = (tokens: number, floor = false): UnderstandMeta => {
    const visible = new Set([
      ...candidates.map((c) => c.id),
      ...top.map((c) => c.id),
      ...top.flatMap((card) => card.support_evidence?.map((support) => support.to) ?? []),
      ...foldedIds,
      ...collapsedAnchors.map((c) => c.id),
      ...collapsedAnchors.flatMap((anchor) => anchor.informed_by_incoming?.map((dependent) => dependent.from) ?? []),
      ...refutedShown.map((c) => c.id),
      ...taskServedEarlier.map((c) => c.id),
      ...taskDuplicates.map((c) => c.id),
    ]);
    const dropped = floor ? 0 : recallRows.filter(({ node }) => !visible.has(node.id)).length;
    const reason = floor ? emptyReason(false, recallRows.length > 0) : compactEmptyReason();
    return {
      returned: floor ? 0 : candidates.length,
      cards: floor ? 0 : displayList().length,
      dropped,
      tokens_estimated: tokens,
      estimated_full_tokens: estimatedFullTokens,
      supports_inlined: floor ? 0 : foldedIds.size,
      stale_excluded: staleExcluded,
      inactive_excluded: inactiveExcluded,
      // A qualified card that did not fit is a budget loss even when its
      // locator stays visible in candidates (single-hit fixtures keep dropped at 0).
      truncated: floor ? false : truncated || dropped > 0 || reason === "budget",
      ...(includeEvidence ? {
        evidence_matches: displayList().filter((m) => m.support_evidence !== undefined).length,
        evidence_supports: displayList().reduce((sum, m) => sum + (m.support_evidence?.length ?? 0), 0),
      } : {}),
      ...(collapseAnchors ? { anchor_collapsed: floor ? 0 : collapsedAnchors.length } : {}),
      ...(includeSource ? {
        source_cards: floor ? 0 : displayList().filter((m) => m.source !== undefined).length,
        ...(sourceSkipped !== undefined ? { source_skipped: sourceSkipped } : {}),
      } : {}),
      ...(staleRefsTotal > 0 ? { stale_refs_total: staleRefsTotal } : {}),
      ...(staleRefsMissing > 0 ? { stale_refs_missing: staleRefsMissing } : {}),
      ...(reason ? { reason } : {}),
    };
  };

  // One builder for placement, the final measurement and the returned wire view.
  const buildPayload = (tokens = 0, includeExtra = true, floor = false): UnderstandOutput => {
    const compact = floor ? [] : withNested(displayList());
    const refuted = floor ? [] : refutedShown;
    const meta = metaFor(tokens, floor);
    const next = buildNextHints({
      db,
      cards: compact.flatMap((card): NextHintsCard[] => [
        { id: card.id, kind: card.kind, visibleSupports: card.support_evidence?.length ?? card.supports?.length ?? 0 },
        ...(card.supports ?? []).map((support) => ({ id: support.id })),
      ]),
      refuted: refuted.map((card) => ({ name: card.name, reason: card.refuted_reason ?? null })),
      activity,
      emptyReason: meta.reason,
    });
    // План 26 §3: одна строка, только при непустых stale_refs.
    if (staleRefsShown.length > 0) {
      next.stale_warning = "файл менялся после записи: перечитай ref, прежде чем опираться";
    }
    const taskContext = taskPlan ? buildTaskContext(db, taskPlan, { compact, refuted, next }) : null;
    if (taskContext) {
      taskContext.duplicates_dropped = taskDuplicates;
      taskContext.served_earlier = taskServedEarlier;
    }
    const brief = renderDroppedText(meta);
    return {
      matches: [],
      compact: compact.map(serializeCard),
      candidates: floor ? [] : candidates,
      ...(collapseAnchors ? { anchors: floor ? [] : collapsedAnchors } : {}),
      ...(staleRefsShown.length > 0 ? { stale_refs: staleRefsShown } : {}),
      refuted,
      edges_between: edgesFor(compact),
      ...(reuseView ? { passport_reuse: reuseView } : {}),
      ...(taskContext ? { task_context: taskContext } : {}),
      meta,
      next,
      ...(brief ? { brief } : {}),
      ...(includeExtra ? extra : {}),
    };
  };
  const measuredPayload = (floor = false): { payload: UnderstandOutput; tokens: number } => {
    const payload = buildPayload(0, true, floor);
    let tokens = measure(payload);
    // Only optional followups may be cut; refs, record and qualification are indivisible.
    while (tokens > maxTokens && payload.next!.followups.length > 0) {
      payload.next!.followups.pop();
      payload.meta!.truncated = true;
      if (payload.task_context) payload.task_context.cost_estimate.followup_calls = payload.next!.followups.length;
      tokens = measure(payload);
    }
    return { payload, tokens };
  };
  const measureWith = (): number => measuredPayload().tokens;

  // This is the actual empty envelope floor, not a fabricated floor with a loss notice.
  const minBudget = measuredPayload(true).tokens;
  if (maxTokens < minBudget) {
    throw new Error(
      `understand: max_tokens=${maxTokens} ниже минимума ${minBudget} — ` +
      `конверт ответа (meta, instructions, MCP-обёртка) сам этого стоит. ` +
      `Подними max_tokens (по умолчанию 4000).`
    );
  }

  // ---- План 26 §2: verbatim-исходник в карточках (include_source) ----
  //
  // Бюджет источника — ДО раскладки карточек: стоимость блоков для первых
  // CARDS_MAX кандидатов вычитается из max_tokens, остаток идёт на карточки.
  // Источники прикрепляются после раскладки — только узлам, которые реально
  // в выдаче; не влезло — карточка отдаётся без source (source_skipped:
  // "budget"), а не наоборот. Читается первый file_ref с локатором, который
  // реально открывается; причины отказа — SourceSkipReason.
  const sourceRoot = process.cwd();
  type SourceBlock = NonNullable<CompactMatch["source"]>;
  const sourceBlocks = new Map<string, SourceBlock>();
  // Стоимость мерится на глубине card.source (compact[0].source), а не
  // верхнего уровня: pretty-JSON добавляет отступы с глубиной, резерв с
  // меньшей глубиной занижал бы стоимость прикреплённого блока.
  const sourceBlockCost = (block: SourceBlock): number =>
    measure({ compact: [{ source: block }] }) - measure({ compact: [{}] });
  const readNodeSource = (
    node: NodeRow
  ): { state: "attached"; block: SourceBlock } | { state: "unavailable"; reason?: SourceSkipReason } => {
    const refs = parseFileRefs(node.file_refs) ?? [];
    if (refs.length === 0) return { state: "unavailable" }; // нет ссылок — не «пропуск»
    let firstFailure: SourceSkipReason | undefined;
    for (const ref of refs) {
      const result = readRefLines(sourceRoot, ref, sourceMaxLines);
      if (result.ok) {
        return {
          state: "attached",
          block: { ref, start_line: result.start_line, lines: result.lines, truncated: result.truncated },
        };
      }
      if (firstFailure === undefined) firstFailure = result.reason;
    }
    return { state: "unavailable", reason: firstFailure ?? "no_range" };
  };
  let sourceReserve = 0;
  if (includeSource) {
    for (const entry of eligible.slice(0, CARDS_MAX)) {
      const block = readNodeSource(entry.node);
      if (block.state === "attached") {
        sourceBlocks.set(entry.node.id, block.block);
        sourceReserve += sourceBlockCost(block.block);
      } else if (block.reason !== undefined && sourceSkipped === undefined) {
        sourceSkipped = block.reason;
      }
    }
  }
  let target = Math.max(maxTokens - sourceReserve, minBudget);

  /**
   * Fold pass — recomputed from scratch, so repeated calls (after each
   * backfilled node) stay idempotent. Two steps:
   *
   * 1. the fold set: every placed node that some OTHER placed node informs;
   * 2. each of them nests under its first (rank order) host that is NOT
   *    itself folding — a folded support is a depth-1 leaf, its own supports
   *    stay on the top level (chain D ← S1 ← S2: S1 folds under D, S2 stays
   *    top — nothing is lost, nothing nests deeper than one level).
   *
   * A support whose every host is folding stays on the top level: nesting it
   * under a folded host would break the depth contract. Returns the number
   * of folded supports after the pass.
   *
   * План 06 (K-02): проекция вложенной опоры сохраняет квалификацию знания —
   * lifecycle, эпистемическую ось, expiry и признак слабости.
   */
  const foldSupports = (): number => {
    const inTop = new Set(top.map((m) => m.id));
    const foldSet = new Set<string>();
    for (const h of top) {
      for (const sid of supportIdsOf.get(h.id) ?? []) {
        if (sid !== h.id && inTop.has(sid) && top.find((card) => card.id === sid)?.support_evidence === undefined) foldSet.add(sid);
      }
    }
    const nextNested = new Map<string, NestedSupportView[]>();
    for (const sup of top) {
      if (!foldSet.has(sup.id)) continue;
      const row = nodeRowById.get(sup.id);
      if (!row) continue;
      for (const h of top) {
        if (h.id === sup.id || foldSet.has(h.id)) continue;
        if (supportIdsOf.get(h.id)?.includes(sup.id)) {
          const bucket = nextNested.get(h.id) ?? [];
              bucket.push({
            id: sup.id,
            name: sup.name,
            summary: sup.summary,
            ...nodeQualification(db, row),
            file_refs: parseFileRefs(row.file_refs),
            ...(row.epistemic_status === "abandoned" ||
            row.epistemic_status === "refuted" ||
            isUngrounded(db, row)
              ? { weak: true }
              : {}),
          });
          nextNested.set(h.id, bucket);
          break;
        }
      }
    }
    nestedByHost = nextNested;
    foldedIds = new Set([...nextNested.values()].flatMap((b) => b.map((n) => n.id)));
    return foldedIds.size;
  };

  let tokensEstimated = 0;

  // Optional presentation gives way before a qualified card, its refs or evidence.
  const squeezedCards = new Set<string>();
  const squeezeCard = (card: CompactMatch, fits: () => boolean): boolean => {
    if (fits()) return true;
    const initial = JSON.stringify(card);
    if (card.support_evidence === undefined) {
      while (card.summary.length > 0 && !fits()) {
        const limit = Math.max(0, card.summary.length - 24);
        card.summary = limit === 0 ? "" : trimSummary(card.summary, limit);
        if (card.summary === "…") card.summary = "";
      }
    }
    if (!fits()) delete card.children;
    if (!fits()) delete card.edges;
    while (card.name.length > 0 && !fits()) {
      card.name = tailName(card.name, Math.max(0, card.name.length - 8));
    }
    if (JSON.stringify(card) !== initial) {
      squeezedCards.add(card.id);
      truncated = true;
    }
    return fits();
  };
  const placeCard = (entry: typeof eligible[number]): boolean => {
    if (top.some((card) => card.id === entry.node.id)) return false;
    const previousNested = nestedByHost;
    const previousFolded = foldedIds;
    const previousTruncated = truncated;
    const candidate = compactMatch(db, entry.node, {
      score: entry.score,
      via: entry.via,
      withContext: true,
      expired: entry.expired,
      withEvidence: includeEvidence,
    });
    top.push(candidate);
    // Enrichment is indivisible; never fold an evidence card into a weaker projection.
    if (candidate.support_evidence === undefined) foldSupports();
    const fits = (): boolean => {
      if (candidate.support_evidence === undefined) foldSupports();
      if (displayList().length > CARDS_MAX) return false;
      return measureWith() <= target;
    };
    if (displayList().length > CARDS_MAX) {
      top.pop();
      nestedByHost = previousNested;
      foldedIds = previousFolded;
      return false;
    }
    const accepted = squeezeCard(candidate, fits);
    if (!accepted) {
      top.pop();
      nestedByHost = previousNested;
      foldedIds = previousFolded;
      truncated = previousTruncated;
      squeezedCards.delete(candidate.id);
      return false;
    }
    return true;
  };
  const placeLoop = (limit: number): void => {
    // A failed expensive hit cannot block a cheaper later candidate; every pass is bounded.
    for (let idx = 0; idx < eligible.length && displayList().length < limit; idx += 1) {
      placeCard(eligible[idx]);
    }
  };

  // Priority 1: one meaningful qualified card (or one ordinary anchor for anchors-only).
  placeLoop(Math.min(topK, 1));
  if (collapseAnchors && !hasMeaningfulCandidates) {
    const placed = new Set(top.map((card) => card.id));
    anchorEligible.push(...eligible.filter((entry) => !placed.has(entry.node.id)));
    for (let i = eligible.length - 1; i >= 0; i -= 1) {
      if (!placed.has(eligible[i].node.id)) eligible.splice(i, 1);
    }
  }

  const trimDiscovery = (list: UnderstandCandidate[], fits: () => boolean): void => {
    for (let i = list.length - 1; i >= 0 && !fits(); i -= 1) {
      if (list[i].summary_short !== undefined) truncated = true;
      delete list[i].summary_short;
    }
    for (let i = list.length - 1; i >= 0 && !fits(); i -= 1) {
      while (list[i].name.length > 0 && !fits()) {
        list[i].name = tailName(list[i].name, Math.max(0, list[i].name.length - 8));
        truncated = true;
      }
    }
  };
  // Priority 2: discovery from the full filtered bounded pool, including collapsed anchors.
  candidates = discovery.map((entry) => ({ ...entry }));
  for (const entry of candidates) {
    if (candidateCost([entry]) > CANDIDATE_SOFT) delete entry.summary_short;
    trimDiscovery([entry], () => candidateCost([entry]) <= CANDIDATE_HARD);
  }
  candidates = candidates.filter((entry) => candidateCost([entry]) <= CANDIDATE_HARD);
  const discoverySnapshots = candidates.map((entry) => ({ ...entry }));
  const fitsCandidateCap = (): boolean => candidateCost(candidates) <= candidateTarget;
  trimDiscovery(candidates, fitsCandidateCap);
  while (candidates.length > 0 && !fitsCandidateCap()) candidates.pop();
  const discoveryFits = (): boolean => fitsCandidateCap() && measureWith() <= target;
  // A minimal first card outranks discovery, not its optional presentation.
  if (!discoveryFits()) {
    for (const card of displayList()) {
      squeezeCard(card, discoveryFits);
      if (discoveryFits()) break;
    }
  }
  trimDiscovery(candidates, discoveryFits);
  while (candidates.length > 0 && !discoveryFits()) candidates.pop();
  // Reclaim presentation for survivors after an indivisible entry was dropped.
  // Add the name first, then optional summary; acceptance is measured each time.
  for (const entry of candidates) {
    const snapshot = discoverySnapshots.find((original) => original.id === entry.id);
    if (!snapshot) continue;
    const previousName = entry.name;
    entry.name = snapshot.name;
    if (!discoveryFits()) entry.name = previousName;
    if (snapshot.summary_short !== undefined) {
      entry.summary_short = snapshot.summary_short;
      if (!discoveryFits()) delete entry.summary_short;
    }
  }

  // Priority 3: second/third cards; discovery and the first card are not displaced.
  placeLoop(CARDS_MAX);
  for (const original of refutedAll) {
    const card = { ...original };
    refutedShown.push(card);
    if (!squeezeCard(card, () => measureWith() <= target)) {
      refutedShown.pop();
      truncated = true;
      squeezedCards.delete(card.id);
    }
  }

  // Fold-aware retry can reclaim a slot; without more budget, a failed hit stays skipped.
  for (const entry of eligible) {
    if (top.some((card) => card.id === entry.node.id)) continue;
    placeCard(entry);
  }

  // План 26 §2: источники прикрепляются после раскладки — только узлам,
  // которые реально в выдаче. Зарезервированный блок едет как есть; карточка
  // вне резерва (добор после fold-aware retry) читается под полный бюджет.
  // После прикрепления резерв потрачен — бюджет снова полный max_tokens,
  // иначе финальные циклы ужали бы карточки под ещё неврахованный источник.
  if (includeSource) {
    for (const card of top) {
      if (card.source !== undefined) continue;
      const reserved = sourceBlocks.get(card.id);
      if (reserved !== undefined) {
        card.source = reserved;
      } else {
        const row = nodeRowById.get(card.id);
        if (!row) continue;
        const block = readNodeSource(row);
        if (block.state !== "attached") {
          if (block.reason !== undefined && sourceSkipped === undefined) sourceSkipped = block.reason;
          continue;
        }
        card.source = block.block;
      }
      if (measureWith() > maxTokens) {
        delete card.source;
        if (sourceSkipped === undefined) sourceSkipped = "budget";
        truncated = true;
      }
    }
    // Страховка: если комбинация прикреплений всё равно перелила, источники
    // снимаются ЦЕЛИКОМ с хвоста — середина диапазона не вырезается.
    while (measureWith() > maxTokens) {
      const carrier = [...top].reverse().find((card) => card.source !== undefined);
      if (!carrier) break;
      delete carrier.source;
      if (sourceSkipped === undefined) sourceSkipped = "budget";
      truncated = true;
    }
    target = maxTokens;
  }

  // ---- План 26 §3: stale_refs — расхождение записи с файлом вместо молчания ----
  //
  // Ленивая проверка ТОЛЬКО file_refs возвращённых карточек (compact):
  // расхождение = file mtime > nodes.updated_at. Это сигнал, а не приговор —
  // mtime врёт после git checkout/распаковки; ось содержимого —
  // check_freshness с digest'ами. Ошибки stat (нет файла) — отдельный счётчик
  // stale_refs_missing, не смешиваются с расхождением. Ответ без расхождений
  // остаётся байт-в-байт прежним: ни секции, ни updated_at на карточках.
  // Кэш mtime — на один вызов understand: долгоживущий процесс-кэш прятал бы
  // правки файлов, случившиеся между запросами той же сессии.
  {
    const mtimeCache = new Map<string, number>();
    const statMtimeMs = (abs: string): number | null => {
      const cached = mtimeCache.get(abs);
      if (cached !== undefined) return cached;
      try {
        const ms = fs.statSync(abs).mtimeMs;
        mtimeCache.set(abs, ms);
        return ms;
      } catch {
        return null;
      }
    };
    const recordedMs = (row: NodeRow): number | null => {
      if (!row.updated_at) return null;
      const parsed = Date.parse(row.updated_at.includes("T") ? row.updated_at : row.updated_at.replace(" ", "T") + "Z");
      return Number.isNaN(parsed) ? null : parsed;
    };
    const staleAll: NonNullable<UnderstandOutput["stale_refs"]> = [];    for (const card of [...displayList(), ...refutedShown]) {
      const row = nodeRowById.get(card.id) ?? db.getNode(card.id);
      if (!row) continue;
      const refs = card.file_refs ?? [];
      if (refs.length === 0) continue;
      const recorded = recordedMs(row);
      if (recorded === null) continue;
      let cardStale = false;
      for (const ref of refs) {
        const parsed = parseRef(ref);
        // git-формы и ссылки без локатора stat'ом не проверяются — файловой
        // оси у них нет; содержимое проверяет check_freshness.
        if (parsed.kind !== "file" || parsed.locator === null) continue;
        const mtime = statMtimeMs(path.resolve(sourceRoot, parsed.path));
        if (mtime === null) {
          staleRefsMissing += 1;
          continue;
        }
        if (mtime > recorded) {
          cardStale = true;
          staleAll.push({
            ref,
            node_id: card.id,
            recorded_at: row.updated_at,
            file_mtime: new Date(mtime).toISOString(),
          });
        }
      }
      if (cardStale) card.updated_at = row.updated_at;
    }
    staleRefsTotal = staleAll.length;
    staleRefsShown = staleAll.slice(0, 3);
  }

  // Collapsed anchors preserve qualification and rationales; each addition is measured.
  for (const { node } of anchorEligible) {
    const host = top.find((card) => !foldedIds.has(card.id) && supportIdsOf.get(card.id)?.includes(node.id));
    if (host) {
      const bucket = nestedByHost.get(host.id) ?? [];
      const edge = db.getInformedByEdges(host.id, "ancestry", false).find((e) => e.to_id === node.id);
      const support: NestedSupportView = {
        id: node.id,
        name: node.name,
        collapsed_anchor: true,
        rationale: edge?.description ?? null,
        ...nodeQualification(db, node),
        file_refs: parseFileRefs(node.file_refs),
        ...(node.epistemic_status === "abandoned" || node.epistemic_status === "refuted" || isUngrounded(db, node)
          ? { weak: true } : {}),
      };
      nestedByHost.set(host.id, [...bucket, support]);
      foldedIds.add(node.id);
      if (measureWith() > target) {
        if (bucket.length > 0) nestedByHost.set(host.id, bucket);
        else nestedByHost.delete(host.id);
        foldedIds.delete(node.id);
        truncated = true;
      }
      continue;
    }
    const dependents = db.getEdgeRefsIn(node.id)
      .filter((e) => e.relation === "informed_by")
      .map((e) => ({ edge: e, row: db.getNode(e.from_id) }))
      .filter((x): x is { edge: { from_id: string; relation: string; description: string | null }; row: NodeRow } => x.row !== undefined)
      .map(({ edge, row }) => ({
        from: row.id,
        from_name: row.name,
        rationale: edge.description ?? null,
        ...(row.epistemic_status === "abandoned" || row.epistemic_status === "refuted" || isUngrounded(db, row)
          ? { weak: true } : {}),
      }));
    collapsedAnchors.push({
      id: node.id,
      name: node.name,
      kind: node.kind as NodeKind,
      file_refs: parseFileRefs(node.file_refs),
      collapsed_anchor: true,
      ...nodeQualification(db, node),
      ...(dependents.length > 0 ? { informed_by_incoming: dependents } : {}),
    });
    if (measureWith() > target) {
      collapsedAnchors.pop();
      truncated = true;
    }
  }

  // Task helpers use the internal presentation, never a fabricated empty/full claim.
  if (taskPlan) {
    const compact = withNested(displayList());
    const readable = compact.filter((card) => card.summary.length > 0 && !squeezedCards.has(card.id));
    const dedup = dedupeTaskDuplicates(db, readable);
    const epoch = applyTaskEpoch(db, taskPlan, readable);
    const removeIds = new Set([...dedup.removeIds, ...epoch.removeIds]);
    taskDuplicates = dedup.duplicates;
    taskServedEarlier = epoch.servedEarlier;
    for (let i = top.length - 1; i >= 0; i -= 1) {
      if (removeIds.has(top[i].id)) top.splice(i, 1);
    }
  }

  // A task epoch note can add metadata after deduplication. Reduce only optional
  // presentation/discovery and later cards; rebuild qualification after each change.
  const fitsFinal = (): boolean => measureWith() <= target;
  for (const card of [...refutedShown, ...displayList()].reverse()) {
    if (fitsFinal()) break;
    squeezeCard(card, fitsFinal);
  }
  trimDiscovery(candidates, fitsFinal);
  while (candidates.length > 0 && !fitsFinal()) candidates.pop();
  while (collapsedAnchors.length > 0 && !fitsFinal()) {
    collapsedAnchors.pop();
    truncated = true;
  }
  while (refutedShown.length > 0 && !fitsFinal()) {
    refutedShown.pop();
    truncated = true;
  }
  // План 26 §3: предупреждение о расхождении — вспомогательный сигнал; на
  // тесном бюджете оно уступает карточкам (знание важнее предупреждения).
  while (staleRefsShown.length > 0 && !fitsFinal()) {
    staleRefsShown.pop();
    truncated = true;
  }
  // Keep the first card whenever its honest minimal response fits; no partial qualification.
  while (top.length > 0 && !fitsFinal()) {
    top.pop();
    foldSupports();
    truncated = true;
  }

  const final = measuredPayload();
  tokensEstimated = final.tokens;
  if (tokensEstimated > maxTokens) {
    throw new Error(`understand: max_tokens=${maxTokens} cannot fit the instructions, qualification and loss notice (minimum ${tokensEstimated}); increase the budget.`);
  }
  const compact = withNested(displayList());
  if (taskPlan) recordTaskEpoch(db, taskPlan, compact.filter((card) => card.summary.length > 0 && !squeezedCards.has(card.id)));
  final.payload.meta!.tokens_estimated = tokensEstimated;
  // The handler adds extra_payload separately; remove those fields only after measurement.
  const output = buildPayload(tokensEstimated, false);
  output.next = final.payload.next;
  output.meta = final.payload.meta;
  if (final.payload.task_context) output.task_context = final.payload.task_context;
  const payload = JSON.stringify(output);
  db.insertUsage({
    tool: "understand",
    query: input.query,
    nodes: compact.length,
    returnedChars: payload.length,
    returnedTokens: tokensEstimated,
    estimatedFullTokens,
  });
  return output;
}

export function getConcept(
  db: KnowledgeDB,
  input: GetConceptInput
): NodeWithContext {
  // Б12: ids renamed by repair-ids stay resolvable through aliases.
  const id = db.getAliasTarget(input.id) ?? input.id;
  const node = db.getNode(id);
  if (!node) {
    throw new Error(`Concept "${input.id}" not found.`);
  }
  const ctx = buildNodeWithContext(db, node, undefined, { withSupportCheck: true });
  // 2.1.7 F1: the digests the agent can pass straight into confirm_supports —
  // the audit showed the first confirmation was impossible without
  // reproducing the hash outside the server. getNode filters tombstones, so
  // there is always a live node here; `current_digests: null` as a contract
  // belongs to the removed-root case in provenance_trace.
  ctx.current_digests = currentDigestsOf(node);
  const payload = JSON.stringify(ctx);
  db.insertUsage({
    tool: "get_concept",
    query: input.id,
    nodes: 1,
    returnedChars: payload.length,
    returnedTokens: estimateTokens(payload),
  });
  return ctx;
}

/**
 * 2.1.7 F1, revised by plan 04 K-10: the two versions travel SEPARATELY.
 * `claim` is the CURRENT computed digest — the value confirm_supports
 * compares against, so confirm → edit → reread → confirm converges instead
 * of looping on the stale snapshot value. `confirmed_claim` documents what
 * the confirmation was made on (the snapshot pins it; a divergence against
 * it is the support_check signal, not a confirmable value). status has no
 * node-level snapshot — always current.
 *
 * UX-01 (план 07): экспортирован — HTTP-карточка узла в explorer несёт те
 * же дайджесты, что и get_concept (подтверждённая формулировка видна при
 * сравнении перед слиянием).
 */
export function currentDigestsOf(node: NodeRow): CurrentDigestsView {
  const snapshotClaim = node.claim_digest ?? null;
  return {
    claim: claimDigestOf(node.summary),
    status: statusDigestOf(node.status, node.epistemic_status),
    format_version: BASELINE_FORMAT_VERSION,
    validation_claim: node.validation_claim_digest ?? null,
    validation_scope: node.validation_scope_digest ?? null,
    validation_state: validationState(node),
    confirmed_claim: snapshotClaim,
    confirmed_at: node.claim_digest_at ?? null,
    source: snapshotClaim !== null ? "snapshot" : "computed",
  };
}

/**
 * В16: detect a likely duplicate among existing nodes — same normalized
 * name or cosine >= 0.95 against the freshly computed embedding.
 * Returns a warning string ("" when nothing similar found).
 */
function findDuplicateNote(
  db: KnowledgeDB,
  node: { id: string; name: string; embedding: Buffer | null }
): string {
  for (const hit of ftsSearch(db, node.name, 3)) {
    if (hit.id === node.id) continue;
    const other = db.getNode(hit.id);
    if (!other) continue;
    const sameName =
      normalizeName(other.name) === normalizeName(node.name);
    let similar = sameName;
    if (!similar && node.embedding) {
      const row = db.execSqlFirst(
        "SELECT embedding FROM nodes WHERE id = ?",
        hit.id
      ) as { embedding: Buffer | ArrayBuffer | null } | undefined;
      const raw = row?.embedding;
      if (raw) {
        const buf = raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
        if (buf.length === node.embedding.length) {
          try {
            similar = cosineSimilarity(node.embedding, buf) >= 0.95;
          } catch {
            similar = false;
          }
        }
      }
    }
    if (similar) {
      return ` Warning: similar node exists: "${hit.id}" (${other.name}) — prefer update_concept.`;
    }
  }
  return "";
}

// ---- 2.1.10 F4: дедупликация при создании ----

const DEDUPE_THRESHOLD_DEFAULT = 0.92;

export const DUPLICATE_MESSAGE_PREFIX = "Похожий узел уже есть";

/**
 * Порог косинуса для семантического канала дедупликации. Читается СВЕЖИМ на
 * каждый вызов (как provenance-флаги, plan 3 §11): megamemory.config.json
 * рядом с базой (dedupe.threshold, по умолчанию 0.92), env-переопределение
 * MEGAMEMORY_DEDUPE_THRESHOLD. Битый конфиг и битый env не роняют вызов —
 * берётся значение по умолчанию.
 */
export function readDedupeThreshold(dbPath: string): number {
  let threshold = DEDUPE_THRESHOLD_DEFAULT;
  const file = path.join(
    path.dirname(path.resolve(dbPath)),
    "megamemory.config.json"
  );
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        dedupe?: { threshold?: unknown };
      };
      const t = parsed?.dedupe?.threshold;
      if (typeof t === "number" && Number.isFinite(t) && t > 0 && t <= 1) {
        threshold = t;
      }
    }
  } catch {
    // unreadable config -> default
  }
  const raw = process.env.MEGAMEMORY_DEDUPE_THRESHOLD;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 1) threshold = n;
  }
  return threshold;
}

export interface DuplicateHit {
  id: string;
  similarity: number;
  matched_by: "name" | "semantic";
}

/**
 * F4: найти дубликат по смыслу ДО вставки. Два канала:
 *  - имя: normalizeNameForDedupe (регистр, пробелы, пунктуация, ё/е) —
 *    точное совпадение по всем живым узлам;
 *  - смысл: вектор саммари против сохранённых векторов, топ-3 кандидатов,
 *    косинус >= threshold (канал работает только когда вектор включён —
 *    иначе/embedding null проверка честно сужается до имени).
 */
export function findDuplicateConcept(
  db: KnowledgeDB,
  opts: { name: string; embedding: Buffer | null; threshold: number }
): DuplicateHit | null {
  const nameKey = normalizeNameForDedupe(opts.name);
  if (nameKey) {
    const rows = db.execSqlAll(
      "SELECT id, name FROM nodes WHERE removed_at IS NULL"
    ) as Array<{ id: string; name: string }>;
    for (const row of rows) {
      if (normalizeNameForDedupe(row.name) === nameKey) {
        return { id: row.id, similarity: 1, matched_by: "name" };
      }
    }
  }

  if (!opts.embedding || opts.embedding.length === 0) return null;
  const hits = findTopK(
    opts.embedding,
    db.getAllActiveNodesWithEmbeddings(),
    3
  );
  for (const hit of hits) {
    if (hit.similarity >= opts.threshold) {
      return {
        id: hit.id,
        similarity: hit.similarity,
        matched_by: "semantic",
      };
    }
  }
  return null;
}

export interface CreateConceptResult {
  /** Set when the node was created; absent when refused as a duplicate. */
  id?: string;
  message: string;
  /** F4: set when the dedupe check refused the creation. */
  duplicate_of?: string;
  similarity?: number;
  matched_by?: "name" | "semantic";
  /** 2.1.13 F4: мягкие предупреждения — «вечное» утверждение, срок в прошлом. */
  warnings?: ConceptWarning[];
}

export async function createConcept(
  db: KnowledgeDB,
  input: CreateConceptInput
): Promise<CreateConceptResult> {
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("Concept name must be a non-empty string.");
  }

  // 2.1.9 F2: a stub summary is refused before anything is planned — a fake
  // support is worse than a missing one because it reads as confirmation in
  // stats and weak_links. allow_stub is the conscious bypass: the node is
  // written with epistemic_status = "stub" and stays visible as a weak link.
  // 2.1.12 F1: срок годности валидируется ещё раньше — мусорная дата отказывает
  // записи, не превращаясь в молчаливый «бессрочный».
  const explicitValidUntil = normalizeValidUntil(input.valid_until);
  // M2 B2 (план 20+21 v3 §7): автопростановка срока journal — только когда
  // поле ОТСУТСТВУЕТ. Явный null и пустая строка (снятый срок) автопростановку
  // запрещают. Политика читается свежей для операции, один раз; невалидный
  // конфиг/env — явная ошибка до записи.
  const nowAtCall = new Date();
  let validUntil: string | null | undefined = explicitValidUntil;
  if (explicitValidUntil === undefined && input.kind === "journal") {
    const expiryConfig = readExpiryConfig(db.dbPath);
    validUntil = journalDefaultExpiry(expiryConfig, nowAtCall) ?? undefined;
  }
  // 2.1.13 F4: «вечное» утверждение о состоянии без срока — предупреждение,
  // не блокировка. digest — серверная сводка, проверка её не касается.
  const warnings = conceptWarnings(input.summary, { kind: input.kind, validUntil });
  if (STUB_CHECK_KINDS.has(input.kind) && !input.allow_stub && isStubSummary(input.summary, input.kind)) {
    throw new Error(STUB_REJECTION_MESSAGE);
  }

  const parentId = input.parent_id === "" ? undefined : input.parent_id;
  let id = makeId(input.name, parentId);

  // Same slug but a different name → disambiguate with a name-hash suffix.
  // Same slug and same name stays an "already exists" error (use update_concept).
  if (db.nodeExists(id)) {
    const existing = db.getNode(id);
    if (existing && existing.name !== input.name) {
      id = disambiguateId(id, input.name);
    }
    if (db.nodeExists(id)) {
      throw new Error(`Concept "${id}" already exists. Use update_concept to modify it.`);
    }
  }

  // Validate parent exists if specified
  if (parentId && !db.nodeExists(parentId)) {
    throw new Error(`Parent concept "${parentId}" does not exist.`);
  }

  // Plan 04 K-05: every supersedes target is verified BEFORE anything is
  // written. The old flow failed on a missing target only AFTER the node,
  // its supports and the snapshots were already committed ("Created X, but
  // supersedes targets not found") — an error the agent could not safely
  // retry. Validation is pre-work; the writes themselves run in the same
  // transaction as the node below, so a target that disappears concurrently
  // rolls the whole creation back.
  const supersedesIds = input.supersedes ?? [];
  if (supersedesIds.length > 0) {
    const missing = supersedesIds.filter((t) => !db.nodeExists(t));
    if (missing.length > 0) {
      throw new Error(`supersedes: targets not found: ${missing.join(", ")}.`);
    }
  }

  // Plan 3 §4.1.3/§11: the provenance flags are read fresh on every call —
  // flipping them in the config file changes behavior without a restart.
  const provenanceConfig = readProvenanceConfig(db.dbPath);

  // Plan 1 §5.3: initial epistemic state, default open. A `validated` at
  // creation time needs the same scope discipline as a transition.
  // 2.1.9 F2: allow_stub pins "stub" — the conscious-placeholder marker; the
  // transition check applies to the agent-driven states only.
  const epistemic: EpistemicStatus = input.allow_stub
    ? "stub"
    : (input.epistemic_status ?? "open");
  if (!input.allow_stub) {
    validateEpistemicTransition("open", epistemic, input.status_scope);
  }

  // ---- Plan 3 §4.1.1: resolve the evidence shortcut ----
  // Each item becomes an informed_by edge with `why` as the rationale,
  // written in the same transaction as the node. A `ref` reuses the node
  // that already cites the file; when nothing cites it yet, a file-fact
  // node (kind=feature, file_refs=[ref]) is created — such nodes are useful
  // supports in their own right.
  interface PlannedSupport {
    toId: string;
    why: string;
    fromAutoGround: boolean;
    expect?: import("./types.js").EvidenceInput["expect"];
  }
  const factNodesToCreate: Array<{
    id: string;
    name: string;
    embedding: Buffer | null;
  }> = [];
  const supports: PlannedSupport[] = [];
  const usedEvidenceIds = new Set<string>();

  const evidence = input.evidence ?? [];
  for (const item of evidence) {
    const why = item.why?.trim() ?? "";
    if (!why) {
      throw new Error(
        "evidence.why обязателен: рационал «что именно в опоре поддерживает вывод» без которого связь нечитаема."
      );
    }
    if ((item.ref === undefined) === (item.node === undefined)) {
      throw new Error("evidence: передай ровно одно — ref (файл) или node (существующий узел).");
    }
    if (item.node !== undefined) {
      if (!db.nodeExists(item.node)) {
        throw new Error(`evidence.node "${item.node}" does not exist (or is removed).`);
      }
      supports.push({ toId: item.node, why, fromAutoGround: false, expect: item.expect });
      usedEvidenceIds.add(item.node);
      continue;
    }
    // 2.1.2 F1: the same ref twice must not plan the same fact id twice —
    // two insertNode calls with one id violate the primary key and roll back
    // the whole creation. A repeat reuses the already-planned id: the support
    // (and later the snapshot) stays single, the first `why` wins.
    const ref = item.ref!.trim();
    const found = resolveFileRef(db, ref);
    if (found) {
      if (!usedEvidenceIds.has(found.id)) {
        supports.push({ toId: found.id, why, fromAutoGround: false, expect: item.expect });
        usedEvidenceIds.add(found.id);
      }
      continue;
    }
    const factId = makeId(ref);
    const finalFactId = db.nodeExists(factId) ? disambiguateId(factId, ref) : factId;
    if (!usedEvidenceIds.has(finalFactId)) {
      factNodesToCreate.push({ id: finalFactId, name: ref, embedding: null });
      supports.push({ toId: finalFactId, why, fromAutoGround: false });
      usedEvidenceIds.add(finalFactId);
    }
  }

  // ---- Plan 3 §4.1.2: auto-ground from why + file_refs ----
  // The agent already states "this knowledge comes from this file"
  // (file_refs) and "here is why" (why) — deriving the typed support from
  // what it already wrote is not inventing provenance. Fires only for
  // decisions when neither evidence nor informed_by edges were passed.
  let autoGrounded = false;
  if (
    input.kind === "decision" &&
    provenanceConfig.auto_ground &&
    evidence.length === 0 &&
    input.why &&
    input.why.trim().length > 0 &&
    input.file_refs &&
    input.file_refs.length > 0 &&
    !(input.edges ?? []).some((e) => e.relation === "informed_by")
  ) {
    for (const ref of input.file_refs) {
      const found = resolveFileRef(db, ref);
      if (found) {
        if (!usedEvidenceIds.has(found.id)) {
          supports.push({ toId: found.id, why: input.why, fromAutoGround: true });
          usedEvidenceIds.add(found.id);
        }
        continue;
      }
      const baseFactId = makeId(ref);
      const factId = db.nodeExists(baseFactId)
        ? disambiguateId(baseFactId, ref)
        : baseFactId;
      if (!usedEvidenceIds.has(factId)) {
        factNodesToCreate.push({ id: factId, name: ref, embedding: null });
        supports.push({ toId: factId, why: input.why, fromAutoGround: true });
        usedEvidenceIds.add(factId);
      }
    }
    autoGrounded = supports.some((s) => s.fromAutoGround);
  }

  // ---- Plan 3 step 8.2: strict mode rejects unsupported decisions ----
  // A decision with zero supports (no evidence, no informed_by edge, and —
  // when auto_ground is on — nothing derived) is refused before anything is
  // written. Other kinds are not touched; link on existing decisions is not
  // affected; reads are not affected (step 8.3).
  if (
    input.kind === "decision" &&
    provenanceConfig.require_support &&
    supports.length === 0 &&
    !(input.edges ?? []).some((e) => e.relation === "informed_by")
  ) {
    throw new Error(REQUIRE_SUPPORT_MESSAGE);
  }

  // Plan 4 v8 §2.1 + plan-4-fixes-6 F1: the ONLY supports this call may
  // confirm are the evidence items — content the agent read and passed right
  // here. informed_by edges from input.edges are written but never confirm:
  // their snapshot would also pin the TARGET's summary and status digests,
  // which the agent may never have read — a snapshot without a read is
  // self-confirmation. Those pairs stay `unknown` until an explicit
  // confirm_supports.
  const confirmableSupportIds = new Set<string>();
  const newAnchorIds = new Set(factNodesToCreate.map(fact => fact.id));
  for (const s of supports) {
    if (!s.fromAutoGround && (newAnchorIds.has(s.toId) ||
        (typeof s.expect?.claim_digest === "string" && typeof s.expect?.status_digest === "string"))) {
      confirmableSupportIds.add(s.toId);
    }
  }

  // Embeddings for the file-fact nodes (computed before the transaction).
  for (const fact of factNodesToCreate) {
    fact.embedding = await embedForStorage(
      db,
      embeddingText(fact.name, "feature", `File-fact node for "${fact.name}".`)
    );
  }

  // Generate embedding (null when the vector path is disabled pending reembed)
  const text = embeddingText(input.name, input.kind, input.summary);
  const embedding = await embedForStorage(db, text);
  // The generation snapshot is taken AFTER the last await: embedForStorage
  // legitimately establishes the first generation on a fresh db, and any
  // concurrent switch after this point is caught inside the transaction.
  const generationAtEmbed = embedding ? db.getVectorGeneration() : null;

  // ---- 2.1.10 F4: дубликаты по смыслу не создаются ----
  // Вторая сессия, не посмотревшая базу, записывает ту же работу заново.
  // Проверка ДО вставки: имя (регистр/пробелы/пунктуация/ё-е) или вектор
  // саммари (топ-3, порог из конфига, по умолчанию 0.92). Не применяется к
  // digest (серверная сводка) и к серверным якорям (file_ref создаются
  // внутри транзакции ниже, мимо этой проверки). force — осознанный обход.
  if (input.kind !== "digest" && !input.force) {
    const duplicate = findDuplicateConcept(db, {
      name: input.name,
      embedding,
      threshold: readDedupeThreshold(db.dbPath),
    });
    if (duplicate) {
      const sim = Number(duplicate.similarity.toFixed(4));
      return {
        duplicate_of: duplicate.id,
        similarity: sim,
        matched_by: duplicate.matched_by,
        message:
          `${DUPLICATE_MESSAGE_PREFIX}: "${duplicate.id}" ` +
          `(matched_by: ${duplicate.matched_by}, similarity ${sim}). ` +
          "Обнови его или передай force: true.",
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
  }

  // T4: mark replaced concepts — edges new--supersedes-->old, old nodes
  // become superseded with valid_until = now. Plan 04 K-05: the writes run
  // INSIDE the creation transaction (targets validated above), so a failure
  // leaves no node, no supports, no snapshots and no status history behind.
  let supersededIds: string[] = [];

  db.runInTransaction(() => {
    for (const supportPlan of supports) {
      if (newAnchorIds.has(supportPlan.toId) || supportPlan.fromAutoGround) continue;
      const current = db.getNode(supportPlan.toId);
      if (!current) throw new Error(`version_conflict: evidence "${supportPlan.toId}" disappeared; nothing was written.`);
      const expect = supportPlan.expect;
      if (expect && ((expect.claim_digest !== undefined && expect.claim_digest !== claimDigestOf(current.summary)) ||
          (expect.status_digest !== undefined && expect.status_digest !== statusDigestOf(current.status, current.epistemic_status)) ||
          (expect.artifacts_digest !== undefined && expect.artifacts_digest !== artifactsDigestOf(activeArtifactRows(current, db.getNodeArtifacts(current.id)))))) {
        throw new Error(`version_conflict: evidence "${supportPlan.toId}" changed; nothing was written.`);
      }
    }
    for (const fact of factNodesToCreate) {
      db.insertNode({
        id: fact.id,
        name: fact.name,
        kind: "feature",
        summary: `File-fact node for "${fact.name}" — created as a provenance support.`,
        file_refs: [fact.name],
        embedding: fact.embedding,
        // 2.1.10 F1: the anchor origin — its template summary is by design,
        // never a stub.
        created_via: "file_ref",
      });
      if (fact.embedding) db.upsertVector(fact.id, fact.embedding);
    }

    db.insertNodeAndEdges(
      {
        id,
        name: input.name,
        kind: input.kind,
        summary: input.summary,
        why: input.why ?? null,
        file_refs: input.file_refs ? JSON.stringify(input.file_refs) : null,
        parent_id: parentId ?? null,
        created_by_task: input.created_by_task ?? null,
        embedding,
        epistemic_status: epistemic,
        status_scope: input.status_scope ? JSON.stringify(input.status_scope) : null,
        // 2.1.10 F1: an explicit agent call — the only origin whose rows the
        // stub checks are allowed to incriminate.
        created_via: "agent",
        // 2.1.12 F1: срок годности, заданный агентом; undefined -> NULL.
        valid_until: validUntil ?? null,
      },
      [
        ...(input.edges ?? []).map((edge) => ({
          to_id: edge.to,
          relation: edge.relation,
          description: edge.description ?? null,
          // Plan 4 v8 §1.3: an explicit agent call -> 'agent'.
          via: "agent" as const,
        })),
        ...supports.map((s) => ({
          to_id: s.toId,
          relation: "informed_by",
          description: s.why,
          // Evidence was passed by the agent in this call -> 'agent';
          // auto-ground is the server's own derivation -> 'auto' (F19:
          // server-invented edges must not masquerade as agent-declared).
          via: (s.fromAutoGround ? "auto" : "agent") as "agent" | "auto",
        })),
      ]
    );

    // Plan 4 v8 §2.1 (the single carve-out from "a mutation never confirms"):
    // create_concept with evidence may confirm the very versions it passed in
    // the same call — the agent has just written/read them. Auto-grounded
    // supports are NOT confirmed: the server invented them, and a snapshot
    // written by the server would be self-confirmation. F1: informed_by edges
    // from input.edges are NOT confirmed either — the snapshot would pin the
    // target's summary/status, which the agent may not have read. Everything
    // else stays `unknown` until an explicit confirm_supports.
    if (confirmableSupportIds.size > 0) {
      const now = new Date().toISOString();
      db.setClaimDigest(id, claimDigestOf(input.summary), now);
      for (const e of db.getInformedByEdges(id, "ancestry", false)) {
        if (!confirmableSupportIds.has(e.other_id)) continue;
        const support = db.getNode(e.other_id);
        if (!support) continue;
        const row = {
          decision_id: id,
          decision_claim_digest: claimDigestOf(input.summary),
          support_id: e.other_id,
          edge_key: String(e.id),
          claim_digest: claimDigestOf(support.summary),
          status_digest: statusDigestOf(support.status, support.epistemic_status),
          edge_digest: edgeDigestOf(e.description),
          format_version: BASELINE_FORMAT_VERSION,
          confirmed_at: now,
          confirmed_by: "agent",
          // 2.1.3 F2: the confirmed artifacts state at the moment of the call.
          // Plan 04 K-11: the ACTIVE observation set only — refs already
          // withdrawn from the support stay history, not part of the pin.
          artifacts_digest: supports.find(plan => plan.toId === e.other_id)?.expect?.artifacts_digest ?? null,
        };
        // 2.1.3 F1: the journal is written where the snapshot is written —
        // this carve-out is a first confirmation, so it opens the chain with
        // the agent/confirmed entry, in the same transaction.
        journalSnapshotWrite(db, row, now);
        db.upsertSupportBaseline(row);
      }
    }

    if (epistemic === "validated" && input.status_scope) {
      db.setEpistemicStatus(id, "validated", "Validated by the creating call.", input.status_scope);
      db.recordStatusHistory(id, null, "validated", "Validated by the creating call.", "epistemic_status");
    }
    if (supersedesIds.length > 0) {
      const { superseded, missing } = db.supersedeNodes(id, supersedesIds);
      if (missing.length > 0) {
        throw new Error(
          `supersedes: targets disappeared mid-call: ${missing.join(", ")} — nothing was written.`
        );
      }
      supersededIds = superseded;
    }
    if (embedding && generationAtEmbed) {
      // CAS applies only when an active generation exists: a blob stored
      // without one is inert history, never a current vector hit (P-10).
      const active = db.getVectorGeneration();
      if (!active || active.generation !== generationAtEmbed.generation || active.model !== generationAtEmbed.model || active.profile !== generationAtEmbed.profile) {
        throw new Error("version_conflict: vector generation changed during create; nothing was written.");
      }
      if (!db.publishNodeEmbedding({ ...active, id, name: input.name, kind: input.kind, summary: input.summary }, embedding)) throw new Error("version_conflict: created vector input changed.");
    }
  });

  // В16: warn (never block) when a near-duplicate already exists — cheaper
  // than cleaning up afterwards with consolidate.
  const duplicateNote = findDuplicateNote(db, {
    id,
    name: input.name,
    embedding,
  });

  // T4: the supersede result is already committed (same transaction above).
  const supersededNote =
    supersededIds.length > 0 ? ` Superseded: ${supersededIds.join(", ")}.` : "";

  // Plan 3 §4.1.1/§4.1.2: the agent must see what the shortcut did. F6: the
  // count is the number of DISTINCT nodes a support edge was actually written
  // to — two evidence items about the same node create one edge, not two.
  const createdFacts = factNodesToCreate.length;
  const writtenSupports = new Set(supports.map((s) => s.toId)).size;
  const supportNote =
    writtenSupports > 0
      ? ` Создано опор: ${writtenSupports}${createdFacts > 0 ? ` (из них новых узлов-источников: ${createdFacts})` : ""}.`
      : "";
  const autoNote = autoGrounded
    ? ` Добавил опор по file_refs: ${supports.filter((s) => s.fromAutoGround).length}, поправь если не то.`
    : "";
  const confirmNote =
    confirmableSupportIds.size > 0
      ? ` Снимок обоснования записан: подтверждено опор ${confirmableSupportIds.size} (изменение опор теперь видно через provenance_trace).`
      : "";
  const validNote = validUntil
    ? ` Срок годности: ${validUntil} — после этой даты узел выпадет из выдачи.`
    : "";

  void scheduleFirstGeneration(db);
  return {
    id,
    message: `Created concept "${id}"${supersededNote}${duplicateNote}${supportNote}${autoNote}${confirmNote}${validNote}`,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function updateConcept(
  db: KnowledgeDB,
  input: UpdateConceptInput
): Promise<{ message: string; warnings?: ConceptWarning[] }> {
  // Verify node exists
  const existing = db.getNode(input.id);
  if (!existing) {
    throw new Error(`Concept "${input.id}" not found.`);
  }

  // 2.1.12 F1: срок годности — мусорная дата отклоняет всю правку; null
  // снимает срок. setNodeStatus (supersede) пишет свою дату поверх — это
  // разные оси: статусная остаётся жизненным циклом узла.
  const validUntil = normalizeValidUntil(input.changes.valid_until);
  // M2 B2: время операции фиксируется один раз; применённая дата автопростановки
  // (явная смена kind на journal) используется последовательно во всей транзакции.
  const nowAtUpdate = new Date();

  // Plan 1 §5.2: epistemic transitions are validated here, at the MCP tool
  // boundary (not inside setNodeStatus/setEpistemicStatus — internal callers
  // like soft-delete and merge must never be blocked). reason is mandatory
  // together with epistemic_status; validated additionally requires a scope
  // with an artifact. The transition itself is re-validated inside the write
  // transaction against the FRESH state (K-07) — a concurrent update must not
  // carry a banned transition out of a stale snapshot.
  if (input.changes.epistemic_status !== undefined) {
    if (!input.changes.epistemic_reason || input.changes.epistemic_reason.trim().length === 0) {
      throw new Error(
        `Changing epistemic_status requires a non-empty "epistemic_reason" — every transition is recorded in status_history.`
      );
    }
  } else if (input.changes.epistemic_reason !== undefined) {
    throw new Error(`"epistemic_reason" without "epistemic_status" is a no-op — pass both or neither.`);
  }

  // If summary or name changed, regenerate embedding (skip when the vector
  // path is disabled pending reembed — reembed will fill it in). Inference
  // runs BEFORE the write transaction — no model work under the write lock
  // (plan 04, F-04.5).
  const sourceInputAtRead = JSON.stringify([existing.name, existing.kind, existing.summary]);
  let embedding: Buffer | undefined;
  if (input.changes.summary !== undefined || input.changes.name !== undefined || input.changes.kind !== undefined) {
    const name = input.changes.name ?? existing.name;
    const kind = input.changes.kind ?? existing.kind;
    const summary = input.changes.summary ?? existing.summary;
    const text = embeddingText(name, kind, summary);
    embedding = (await embedForStorage(db, text)) ?? undefined;
  }
  // Snapshot after the last await — embedForStorage may legitimately establish
  // the first generation on a fresh db; a later concurrent switch is a conflict.
  const generationAtEmbed = embedding ? db.getVectorGeneration() : null;

  let epistemicNote = "";
  let noChanges = false;
  // M2 B2: эффективный срок и признак смены kind на journal объявлены снаружи
  // транзакции — post-транзакционные предупреждения и сообщение читают
  // фактический результат правки, а не снапшот до неё.
  let effectiveValidUntil: string | null | undefined = validUntil;
  let kindChangedToJournal = false;
  db.runInTransaction(() => {
    // K-07: validation and writes read the SAME state — the fresh read inside
    // BEGIN IMMEDIATE keeps a concurrent update from carrying out a banned
    // epistemic transition or a banned kind conversion from a stale snapshot.
    const current = db.getNode(input.id);
    if (!current) {
      throw new Error(`Concept "${input.id}" not found.`);
    }

    if (JSON.stringify([current.name, current.kind, current.summary]) !== sourceInputAtRead) throw new Error("version_conflict: concept input changed during update.");
    // K-07: the RESULTING state is validated like create would. A kind change
    // must not launder a placeholder summary past create-time guarantees, and
    // feature -> decision must not bypass require_support.
    const resultingKind = input.changes.kind ?? current.kind;
    const resultingSummary = input.changes.summary ?? current.summary;
    if (isStubSummary(resultingSummary, resultingKind, current.created_via)) {
      throw new Error(
        `update_concept: итоговое саммари — заглушка, а не утверждение о поведении.\n${STUB_REJECTION_MESSAGE}`
      );
    }
    if (
      input.changes.kind !== undefined &&
      input.changes.kind !== current.kind &&
      resultingKind === "decision" &&
      readProvenanceConfig(db.dbPath).require_support
    ) {
      // Смена на decision не обходит require_support: update не принимает
      // evidence, поэтому отказ называет конкретный следующий шаг.
      const hasSupports = db.getInformedByEdges(input.id, "ancestry", false).length > 0;
      if (!hasSupports) {
        throw new Error(
          `update_concept: смена вида на decision отклонена — у узла нет ни одной опоры. ` +
            `Шаг: добавь опору — link "${input.id}" -> <узел-источник> relation=informed_by с рационалом ` +
            `«что именно в источнике подтверждает вывод», затем повтори обновление. ` +
            `Новое решение создавай через create_concept с evidence в том же вызове.`
        );
      }
    }

    // M2 B2: явная смена kind на journal — часть явной смены вида. Заданный
    // ранее срок сохраняется (и истёкший тоже); если срока нет и поле не
    // передано — применяется default политики. Остальные случаи срок не
    // трогают: update без поля не продлевает и не омолаживает (скользящего
    // TTL нет), явный null/пустая строка снимают срок как раньше.
    kindChangedToJournal =
      input.changes.kind !== undefined &&
      input.changes.kind !== current.kind &&
      input.changes.kind === "journal";
    if (kindChangedToJournal && validUntil === undefined && (current.valid_until ?? null) === null) {
      const expiryConfig = readExpiryConfig(db.dbPath);
      const auto = journalDefaultExpiry(expiryConfig, nowAtUpdate);
      if (auto !== null) effectiveValidUntil = auto;
    }

    // K-06: epistemic axis. A repeat of the SAME status without a new scope is
    // a true no-op — the stored scope and the history stay untouched (the old
    // code wrote status_scope = NULL over the artifact here). A same-status
    // write WITH a scope is a scope revision: it obeys the transition rules
    // above and is recorded in status_history as a revision.
    let epistemicWrite: {
      to: EpistemicStatus;
      reason: string;
      scope: Record<string, unknown> | null;
      revision: boolean;
    } | null = null;
    if (input.changes.epistemic_status !== undefined) {
      const from = (current.epistemic_status ?? null) as EpistemicStatus | null;
      const to = input.changes.epistemic_status;
      if (from === to && input.changes.status_scope === undefined) {
        // настоящий no-op: ось не трогаем вообще
      } else {
        validateEpistemicTransition(from, to, input.changes.status_scope);
        epistemicWrite = {
          to,
          reason: input.changes.epistemic_reason!,
          scope: input.changes.status_scope ?? null,
          revision: from === to,
        };
      }
    }

    if (current.epistemic_status === "validated" &&
        input.changes.summary !== undefined && input.changes.summary !== current.summary) {
      db.recordStatusHistory(current.id, "validated", "validated", "Claim changed; previous validation retained as history.", "epistemic_status");
    }
    const updated = db.updateNode(input.id, {
      ...input.changes,
      embedding,
      // 2.1.12 F1: undefined (поле не передано) не трогает колонку, null
      // снимает срок, строка выставляет. spread выше уже несёт значение —
      // здесь только нормализованная форма. M2 B2: автопростановка при смене
      // kind на journal подставляется как явное значение.
      valid_until: effectiveValidUntil,
    });

    // Plan 1: the epistemic write happens after the content update; both run
    // in this one transaction, so a failed validation leaves nothing behind.
    if (epistemicWrite) {
      db.setEpistemicStatus(
        input.id,
        epistemicWrite.to,
        epistemicWrite.reason,
        epistemicWrite.scope
      );
      if (epistemicWrite.revision) {
        // K-06: the scope replacement is a real revision — setEpistemicStatus
        // itself skips same-status history rows, so the revision is recorded
        // explicitly.
        db.recordStatusHistory(
          input.id,
          epistemicWrite.to,
          epistemicWrite.to,
          epistemicWrite.reason,
          "epistemic_status"
        );
      }
      epistemicNote = ` Epistemic status: ${epistemicWrite.to}.`;
    }

    if (embedding && generationAtEmbed) {
      // Same generation CAS as create: only an existing active generation is
      // guarded; a generationless blob stays inert history (P-10).
      const active = db.getVectorGeneration();
      if (!active || active.generation !== generationAtEmbed.generation || active.model !== generationAtEmbed.model || active.profile !== generationAtEmbed.profile) throw new Error("version_conflict: vector generation changed during update.");
      const updatedNode = db.getNode(input.id)!;
      if (!db.publishNodeEmbedding({ ...active, id: input.id, name: updatedNode.name, kind: updatedNode.kind, summary: updatedNode.summary }, embedding)) throw new Error("version_conflict: vector input changed during update.");
    } else if (input.changes.summary !== undefined || input.changes.name !== undefined || input.changes.kind !== undefined) {
      // No active generation: store the blob on the node (inert until
      // reembed) and drop any stale native copy.
      db.execSqlRun("UPDATE nodes SET embedding=NULL,embedding_generation=NULL WHERE id=?", input.id);
      db.deleteVector(input.id);
    }
    if (!updated && !epistemicWrite) noChanges = true;
  });

  void scheduleFirstGeneration(db);
  if (noChanges) {
    return { message: `No changes applied to "${input.id}"` };
  }

  const validNote =
    effectiveValidUntil === undefined
      ? ""
      : effectiveValidUntil === null
        ? " Срок годности снят — узел снова бессрочный."
        : ` Срок годности: ${effectiveValidUntil} — после этой даты узел выпадет из выдачи.`;

  // 2.1.13 F4: та же проверка при смене саммари. Эффективный срок — фактическое
  // состояние узла после транзакции: переданный срок, автопростановка смены
  // kind на journal или прежний/снятый срок (M2 B2 — по свежему состоянию,
  // а не по снапшоту до правки).
  let warnings: ConceptWarning[] = [];
  if (input.changes.summary !== undefined || kindChangedToJournal) {
    const after = db.getNode(input.id)!;
    warnings = conceptWarnings(
      input.changes.summary ?? after.summary,
      { kind: after.kind, validUntil: after.valid_until ?? null }
    );
  }

  return {
    message: `Updated concept "${input.id}".${epistemicNote}${validNote}`,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function link(
  db: KnowledgeDB,
  input: LinkInput
): { message: string } {
  // Validate both nodes exist
  if (!db.nodeExists(input.from)) {
    throw new Error(`Source concept "${input.from}" not found.`);
  }
  if (!db.nodeExists(input.to)) {
    throw new Error(`Target concept "${input.to}" not found.`);
  }

  const { id: edgeId, inserted } = db.insertEdge({
    from_id: input.from,
    to_id: input.to,
    relation: input.relation,
    description: input.description,
    // Plan 4 v8 §1.3: explicit tool call -> 'agent'. The link itself never
    // confirms anything (§2: a mutation does not confirm).
    via: "agent",
  });

  if (!inserted) {
    return {
      message: `Relationship "${input.relation}" from "${input.from}" to "${input.to}" already exists.`,
    };
  }

  return {
    message: `Created ${input.relation} link from "${input.from}" to "${input.to}" (edge #${edgeId})`,
  };
}

export function removeConcept(
  db: KnowledgeDB,
  input: RemoveConceptInput
): { message: string } {
  const existing = db.getNodeIncludingRemoved(input.id);
  if (!existing) {
    throw new Error(`Concept "${input.id}" not found.`);
  }
  if (existing.removed_at) {
    throw new Error(`Concept "${input.id}" was already removed.`);
  }

  // Plan 3 §4.3: incoming informed_by edges and chain participation are
  // counted in ONE pass, and the refusal is ONE message listing both kinds
  // of dependencies. Refuse-and-redirect: the text tells the agent exactly
  // what to do next instead of a bare "cannot delete".
  const supporters = db
    .getIncomingEdges(input.id)
    .filter((e) => e.relation === "informed_by")
    .map((e) => e.from_id);
  const affectedTrails = db.getTrailsForNode(input.id);

  if (supporters.length > 0 && !input.force) {
    const ids = supporters.map((s) => `"${s}"`).join(", ");
    throw new Error(
      `Удаление отклонено: на узле "${input.id}" держатся ${supporters.length} активных решений: ${ids}.\n` +
        `Физическое удаление сломает их провенанс. Выбери шаг и повтори:\n` +
        `  1. Замена: создай узел-преемник (create_concept), переведи решения\n` +
        `     на него (link informed_by с рационалом «замена ${input.id}»), затем\n` +
        `     повтори remove "${input.id}" — отказов больше не будет.\n` +
        `  2. Опровержение: если узел неверен — update ${input.id} → статус refuted\n` +
        `     с причиной и артефактом. Узел останется в истории, из активного\n` +
        `     замыкания выпадет, удалять не нужно.\n` +
        `  3. remove "${input.id}" force=true — удаляет узел и ставит надгробия на все\n` +
        `     ${supporters.length} рёбер. Решения ${ids} останутся без опоры и будут помечены\n` +
        `     ungrounded в отчётах. Не используй, если данные ещё нужны.`
    );
  }

  const removed = db.softDeleteNode(input.id, input.reason);
  if (!removed) {
    throw new Error(`Failed to remove concept "${input.id}".`);
  }

  // T4: soft-delete also deprecates the lifecycle status (U5: with reason).
  db.setNodeStatus(input.id, "deprecated", undefined, input.reason);

  // Plan 2 (audit B5): removing a chain member must never be silent — the
  // affected chains are marked stale and the answer says exactly why.
  for (const t of affectedTrails) {
    db.setTrailStale(t.id, true);
  }
  const trailNote =
    affectedTrails.length > 0
      ? ` Chains marked stale because "${input.id}" was removed: ${affectedTrails.map((t) => t.id).join(", ")}.`
      : "";

  // Plan 3 §4.3: with force, the report names who lost their support —
  // every affected edge is tombstoned by softDeleteNode, the decisions
  // survive without support and surface as ungrounded in reports.
  const forceNote =
    input.force && supporters.length > 0
      ? ` Опора разорвана (force): ${supporters.length} решений потеряли опору (${supporters.join(", ")}), рёбра помечены надгробиями.`
      : "";

  return {
    message: `Removed concept "${input.id}". Reason: ${input.reason}.${forceNote}${trailNote}`,
  };
}

/**
 * 2.1.13 F3: бюджетный обзор стартовой выдачи.
 *
 * Прежнее поведение при переполнении — перейти к ПОЛНОМУ ответу — убрано:
 * превышение лимита увеличивало выдачу вместо того, чтобы её сократить.
 * Теперь ответ всегда компактный; не помещается — режется с конца приоритета
 * (роли → задачи → корни), сокращение помечается в meta.
 *
 * Бюджет считается по СЕРИАЛИЗОВАННОМУ ответу (indent 2 — как у MCP) вместе
 * со всем, что добавит обработчик: extra_payload (instructions_status, stats),
 * hint, slots, board_top, meta. Оценка функции и реальный ответ MCP не
 * расходятся. Ниже минимума (конверт пустого ответа) — понятная ошибка, не
 * молчаливое превышение. usage пишется на всех ветках.
 */
export function listRoots(
  db: KnowledgeDB,
  input: ListRootsInput = {}
): ListRootsOutput & { hint?: string } {
  const maxTokens = input.max_tokens ?? 1500;
  const extra = input.extra_payload ?? {};
  const stats = db.getStats();
  const hint =
    stats.nodes === 0
      ? "Graph is empty. Run /user:bootstrap-memory to populate, or create concepts as you work."
      : undefined;
  const channel = vectorChannelState(db);
  const searchHint = channel.state === "on" ? undefined
    : channel.state === "partial"
      ? `Semantic search is partial (vectors ${channel.total - channel.missing}/${channel.total}): run \`megamemory reembed\` to finish indexing.`
      : LIST_ROOTS_SEARCH_HINT;

  // План 09 (R-06a): корни читаются страницами под бюджет ответа, а не целиком
  // с последней порезкой в памяти. Как только корневая секция перестаёт
  // помещаться в бюджет, дальше страницу читать бессмысленно — бинарный поиск
  // максимума не зайдёт за неё. meta.dropped/truncated считаются от полного
  // числа корней (COUNT), так что выдача совпадает с прежним цельным чтением
  // на любом бюджете.
  const ROOT_PAGE = 500;
  // Each fit check includes the final token field; no fixed reserve is needed.
  const target = maxTokens;
  const totalRoots = db.countRootNodes();
  const rootRows: Array<{
    id: string;
    name: string;
    kind: string;
    valid_until: string | null;
  }> = [];
  let after: { name: string; id: string } | null = null;
  while (rootRows.length < totalRoots) {
    const page = db.getRootOverviewPage(after, ROOT_PAGE);
    if (page.length === 0) break;
    rootRows.push(...page);
    after = {
      name: page[page.length - 1].name,
      id: page[page.length - 1].id,
    };
    if (
      estimateTokens(JSON.stringify(rootRows, null, 2)) > target ||
      page.length < ROOT_PAGE
    ) {
      break;
    }
  }

  // Child count — одним группированным запросом на чанк родителей, не по
  // запросу на корень (N+1: 10k корней стоили 10k prepare и +200 МБ RSS).
  const childCounts = db.getChildCounts(rootRows.map((r) => r.id));

  // Budgeted overview (plan T3): id/name/kind + child count, no summary.
  // 2.1.12 F1: valid_until на корне виден сразу — просроченный корень не
  // должен выглядеть свежим в стартовом дайджесте.
  const rootsCompact = rootRows.map((root) => ({
    id: root.id,
    name: root.name,
    kind: root.kind as NodeWithContext["kind"],
    child_count: childCounts.get(root.id) ?? 0,
    valid_until: root.valid_until ?? null,
  }));
  // Plan 2 §2/§3: role slots go FIRST in the startup digest, then the top-5
  // of the task board by rot — the burning, not the fresh.
  const slots = db.listSlots("").map((s) => ({
    role: s.role,
    node_id: s.node_id,
    node_name: s.node_name,
  }));
  const boardTop = computeBoard(db).columns.find((c) => c.name === "open")!.cards.slice(0, 5);

  const measure = measureMcpPayload;

  type RootsCompact = (typeof rootsCompact)[number];
  type Slots = (typeof slots)[number];
  type Board = (typeof boardTop)[number];

  const build = (
    roots: RootsCompact[],
    slotsCut: Slots[],
    boardCut: Board[],
    tokensEstimated: number
  ): ListRootsOutput & { hint?: string } => ({
    roots: [],
    compact: true,
    roots_compact: roots,
    slots: slotsCut,
    board_top: boardCut,
    ...(hint ? { hint } : {}),
    ...(searchHint ? { hint_search: searchHint } : {}),
    meta: {
      returned: roots.length,
      // Полное число корней (COUNT), не прочитанное: страницы могут быть
      // обрезаны бюджетом раньше конца таблицы.
      dropped: totalRoots - roots.length,
      tokens_estimated: tokensEstimated,
      truncated:
        roots.length < totalRoots ||
        slotsCut.length < slots.length ||
        boardCut.length < boardTop.length,
      dropped_slots: slots.length - slotsCut.length,
      dropped_board_top: boardTop.length - boardCut.length,
    },
  });

  /** Пустой каркас с теми же ключами, что у MCP-ответа, — минимум, ниже
   * которого ответ сжаться не может (meta, hint, extra). */
  const envelope = { ...build([], [], [], 0), ...extra };
  const minBudget = measure(envelope);
  if (maxTokens < minBudget) {
    throw new Error(
      `list_roots: max_tokens=${maxTokens} ниже минимума ${minBudget} — ` +
        `конверт ответа (meta, hint, slots, board_top, stats, instructions_status) сам этого стоит. ` +
        `Подними max_tokens (по умолчанию 1500).`
    );
  }

  const fits = (nRoots: number, nSlots: number, nBoard: number): boolean =>
    measure({
      ...build(
        rootsCompact.slice(0, nRoots),
        slots.slice(0, nSlots),
        boardTop.slice(0, nBoard),
        0
      ),
      ...extra,
    }) <= target;

  let nRoots = rootsCompact.length;
  let nSlots = slots.length;
  let nBoard = boardTop.length;

  if (!fits(nRoots, nSlots, nBoard)) {
    // Режем с конца приоритета (роли → задачи → корни): сначала корни,
    // затем задачи, роли — последними. Бинарный поиск максимума секции,
    // которая помещается.
    const searchMax = (hi: number, fitsAt: (n: number) => boolean): number => {
      let lo = 0;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi + 1) / 2);
        if (fitsAt(mid)) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    if (fits(0, nSlots, nBoard)) {
      // максимум корней при полных ролях и задачах
      nRoots = searchMax(rootsCompact.length, (n) => fits(n, nSlots, nBoard));
    } else {
      nRoots = 0;
      if (fits(0, nSlots, 0)) {
        // максимум задач при полных ролях
        nBoard = searchMax(boardTop.length, (n) => fits(0, nSlots, n));
      } else {
        nBoard = 0;
        if (fits(0, 0, 0)) {
          // максимум ролей
          nSlots = searchMax(slots.length, (n) => fits(0, n, 0));
        } else {
          // Конверт с запасом не влезает — ошибки выше быть не должно
          // (minBudget проверен), но резерва не хватило: отдаём пустой
          // каркас, честный замер ниже всё равно ≤ maxTokens.
          nSlots = 0;
        }
      }
    }
  }

  const payload = build(
    rootsCompact.slice(0, nRoots),
    slots.slice(0, nSlots),
    boardTop.slice(0, nBoard),
    0
  );
  const withExtra = { ...payload, ...extra };

  const tokens = measure(withExtra);
  if (tokens > maxTokens) {
    throw new Error(`list_roots: max_tokens=${maxTokens} cannot fit the response envelope (minimum ${tokens}); increase the budget.`);
  }
  const finalPayload: ListRootsOutput & { hint?: string } = {
    ...payload,
    meta: { ...payload.meta!, tokens_estimated: tokens },
  };

  db.insertUsage({
    tool: "list_roots",
    query: null,
    nodes: nRoots,
    returnedChars: JSON.stringify({ ...finalPayload, ...extra }, null, 2).length,
    returnedTokens: tokens,
  });

  return finalPayload;
}

// ---- Merge conflict tools ----

export function listConflicts(db: KnowledgeDB): ListConflictsOutput {
  const conflictNodes = db.getConflictNodes();

  // T4: facts with incoming `contradicts` edges — a different kind of
  // "conflict" the agent should know about even with no merge groups.
  const contradictedNodes = db.getContradictedNodes();
  const contradicted = contradictedNodes.map((n) => ({
    id: n.id,
    name: n.name,
    summary: n.summary,
    contradicted_by: db
      .getIncomingEdges(n.id)
      .filter((e) => e.relation === "contradicts")
      .map((e) => e.from_id),
  }));

  const savedConflicts = db.getMergeConflicts();
  if (conflictNodes.length === 0 && savedConflicts.length === 0) {
    return { conflicts: [], contradicted };
  }

  // Group by merge_group
  const groups = new Map<string, NodeRow[]>();
  for (const node of conflictNodes) {
    const mg = node.merge_group!;
    if (!groups.has(mg)) groups.set(mg, []);
    groups.get(mg)!.push(node);
  }

  const conflicts: ConflictGroup[] = [];

  for (const [mergeGroup, nodes] of groups) {
    const versions = nodes.map((n) => {
      const outgoingEdges = db.getOutgoingEdges(n.id);
      const fileRefs = n.file_refs ? JSON.parse(n.file_refs) : null;

      return {
        id: n.id,
        original_id: stripMergeSuffix(n.id),
        source_branch: n.source_branch ?? "unknown",
        name: n.name,
        kind: n.kind as NodeWithContext["kind"],
        summary: n.summary,
        why: n.why,
        file_refs: fileRefs,
        edges: outgoingEdges.map((e) => ({
          to: e.to_id,
          relation: e.relation as RelationType,
          description: e.description,
        })),
        removed_at: n.removed_at,
        removed_reason: n.removed_reason,
      };
    });

    conflicts.push({
      merge_group: mergeGroup,
      merge_timestamp: nodes[0].merge_timestamp,
      versions,
    });
  }

  for (const saved of savedConflicts) {
    let group = conflicts.find(conflict => conflict.merge_group === saved.merge_group);
    if (!group) {
      group = { merge_group: saved.merge_group, merge_timestamp: saved.created_at, versions: [] };
      conflicts.push(group);
    }
    (group.edge_conflicts ??= []).push(saved);
  }
  return { conflicts, contradicted };
}

export async function resolveConflict(
  db: KnowledgeDB,
  input: ResolveConflictInput
): Promise<{ message: string }> {
  const nodes = db.getNodesByMergeGroup(input.merge_group);

  if (nodes.length === 0) {
    if (db.getMergeConflicts(input.merge_group).some(conflict => conflict.object_kind === "edge")) {
      if (!input.prefer) throw new Error("Edge-only resolution requires prefer=left or right.");
      return resolveEdgeConflicts(db, { merge_group: input.merge_group, prefer: input.prefer, reason: input.reason });
    }
    throw new Error(`No nodes found with merge_group: ${input.merge_group}`);
  }

  // Prefer an active (non-removed) node as the base so the resolved concept
  // stays active for removal conflicts. Fall back to first node. CLI
  // «keep left/right» задаёт prefer — та же доменная операция, не вторая
  // реализация (F-03.1).
  const base =
    (input.prefer
      ? nodes.find(
          (n) =>
            n.removed_at === null &&
            n.id.endsWith(input.prefer === "left" ? MERGE_SUFFIX_LEFT : MERGE_SUFFIX_RIGHT)
        )
      : undefined) ??
    nodes.find((n) => n.removed_at === null) ??
    nodes[0];
  const originalId = stripMergeSuffix(base.id);

  const text = embeddingText(base.name, base.kind, input.resolved.summary);
  const newEmbedding = await embedForStorage(db, text);

  const changes: { summary?: string; why?: string; file_refs?: string[] } = {
    summary: input.resolved.summary,
  };
  if (input.resolved.why !== undefined) changes.why = input.resolved.why;
  if (input.resolved.file_refs !== undefined) changes.file_refs = input.resolved.file_refs;

  db.runInTransaction(() => {
    // Rename the base back to the original clean ID first — переименование
    // тянет за собой рёбра, parent_id детей и id в снимках опор.
    if (base.id !== originalId) {
      const renamed = db.renameNodeId(base.id, originalId);
      if (!renamed) {
        throw new Error(`Failed to rename resolved node from ${base.id} to ${originalId}`);
      }
    }

    // Apply the resolved content
    const updated = db.updateNode(originalId, changes);
    if (!updated) {
      throw new Error(`Failed to apply resolved content to ${originalId}`);
    }

    db.updateNode(originalId, { embedding: newEmbedding });
    if (newEmbedding) {
      // В17: keep the native vector copy in sync.
      db.upsertVector(originalId, newEmbedding);
    }

    // Б10: lifecycle merge rule — superseded/deprecated beats active,
    // skipped on legacy dbs without the status column.
    // valid_until is the later of the versions in the group.
    if (db.hasStatusColumn) {
      const lifecycle = KnowledgeDB.mergeLifecycleStatus(
        { status: base.status, valid_until: base.valid_until },
        nodes
          .filter((n) => n.id !== base.id)
          .reduce(
            (acc, n) => KnowledgeDB.mergeLifecycleStatus(acc, n),
            { status: "active", valid_until: null } as { status: string; valid_until: string | null }
          )
      );
      db.setNodeStatus(originalId, lifecycle.status, lifecycle.valid_until ?? undefined);
    }

    // S-06: проигравший вариант не стирается вместе со своими рёбрами.
    // Рёбра переезжают на выживший identity вербатим (живые и надгробия),
    // дети/слоты/участники цепочек/артефакты/снимки/алиасы — через
    // transferNodeIdentity; цикл, возникший от ремапа, отвергается
    // атомарно. Исчезновение истории не превращается в «complete».
    const componentsKey = (components: string[][]): string =>
      JSON.stringify(
        components.map((c) => [...c].sort()).sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")))
      );
    const cyclesBefore = db.informedByCycleComponents();

    for (const node of nodes) {
      if (node.id === base.id) continue;
      moveNodeEdges(db, node.id, originalId);
      transferNodeIdentity(db, node.id, originalId);
      db.hardDeleteNode(node.id);
    }

    const cyclesAfter = db.informedByCycleComponents();
    if (componentsKey(cyclesAfter) !== componentsKey(cyclesBefore)) {
      throw new Error(
        `Resolution rejected: remapping the losing variant onto "${originalId}" closes an informed_by cycle ` +
          `(${cyclesAfter.map((c) => c.join(" -> ")).join("; ")}) — nothing was written.`
      );
    }

    // Clear merge flags on the resolved node and any associated edges
    db.clearNodeMergeFlags(originalId);
    db.clearEdgeMergeFlagsByGroup(input.merge_group);
  });

  return {
    message: `Resolved "${originalId}". Reason: ${input.reason}`,
  };
}

// Temporary fragment: appended to src/tools.ts by a node one-liner, then deleted.
// Kept as a file because heredocs mangle escapes in shell tool calls.

// ---- Workflow tools (plan 2, schema v6) ----

import type {
  TrailSaveInput,
  TrailView,
  TrailMemberView,
  BoardOutput,
  BoardColumn,
  PassportInput,
  PassportPayload,
} from "./types.js";

/** Empirical rot constants from kaeru — do not change without a reason. */
const ROT_ISOLATION_PENALTY = 45;
const ROT_OVERDUE_PENALTY = 400;

/** "YYYY-MM-DD HH:MM:SS" (UTC sqlite) -> epoch ms. */
function parseSqliteTimestamp(ts: string): number {
  return Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}

/** Today as YYYY-MM-DD (UTC) for due_at comparisons. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Plan 2 §3: rot = age_days + (isolated ? 45 : 0) + (overdue ? 400 : 0). */
export function taskRot(task: {
  created_at: string;
  due_at: string | null;
  live_edges: number;
}): { rot: number; overdue: boolean; age_days: number } {
  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - parseSqliteTimestamp(task.created_at)) / 86_400_000)
  );
  const due = task.due_at ? task.due_at.slice(0, 10) : null;
  const overdue = due !== null && due < todayUtc();
  const rot =
    ageDays +
    (task.live_edges === 0 ? ROT_ISOLATION_PENALTY : 0) +
    (overdue ? ROT_OVERDUE_PENALTY : 0);
  return { rot, overdue, age_days: ageDays };
}

/** Full board: the `open` column sorted by rot, the terminal `done` fresh-first. */
export function computeBoard(db: KnowledgeDB, input: { done_cursor?: string; done_limit?: number } = {}): BoardOutput {
  const openTasks = db.getOpenTasks().map((t) => {
    const { rot, overdue } = taskRot(t);
    return { id: t.id, name: t.name, rot, due_at: t.due_at, overdue };
  });
  openTasks.sort((a, b) => b.rot - a.rot);

  let after: { updated_at: string; id: string } | undefined;
  if (input.done_cursor !== undefined) {
    try {
      if (typeof input.done_cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.done_cursor)) throw new Error();
      const decoded = Buffer.from(input.done_cursor, "base64url");
      if (decoded.toString("base64url") !== input.done_cursor) throw new Error();
      const parsed = JSON.parse(decoded.toString("utf8"));
      if (typeof parsed?.updated_at !== "string" || typeof parsed?.id !== "string" || parsed.id.length === 0) throw new Error();
      after = { updated_at: parsed.updated_at, id: parsed.id };
    } catch { throw new Error("board: invalid done_cursor."); }
  }
  const limit = input.done_limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("board: done_limit must be between 1 and 100.");
  const donePage = db.getDoneTaskPage(limit, after);
  const doneTasks = donePage.rows.map(t => ({ id: t.id, name: t.name }));
  const last = donePage.rows[donePage.rows.length - 1];

  const columns: BoardColumn[] = [
    {
      name: "open",
      terminal: false,
      count: openTasks.length,
      cards: openTasks,
    },
    {
      name: "done",
      terminal: true,
      count: donePage.total,
      returned: doneTasks.length,
      has_more: donePage.has_more,
      next_cursor: donePage.has_more && last ? Buffer.from(JSON.stringify({ updated_at: last.updated_at, id: last.id }), "utf8").toString("base64url") : null,
      cards: doneTasks,
    },
  ];

  return {
    columns,
    overdue: openTasks.filter((t) => t.overdue).length,
    open: openTasks.length,
  };
}

/**
 * Per-member and whole-chain state (trailMemberStates/trailState) живут в
 * passport.ts (P1): их используют и trail-домен, и квалификация паспортов —
 * один механизм доверия, не параллельный. Здесь они реэкспортируются, чтобы
 * существующие импорты (карточка узла, concept-profile, тесты) не менялись.
 */
export { trailMemberStates, trailState } from "./passport.js";
import { trailMemberStates, trailState } from "./passport.js";
import { buildPassportBody, findLatestPassportBody, qualifyReuse } from "./passport.js";

/** Uniqueness key: same name AND same summary = same chain. */
function summaryKey(summary: string): string {
  return summary.trim().slice(0, 200);
}

export function trailSave(
  db: KnowledgeDB,
  input: TrailSaveInput
): { id: string; message: string } {
  if (!input.summary || input.summary.trim().length === 0) {
    throw new Error("A trail requires a non-empty author summary — the chain exists to carry the WHY.");
  }
  const nodeIds = [...new Set(input.node_ids)];
  if (nodeIds.length === 0) {
    throw new Error("trail_save requires at least one node id.");
  }
  for (const id of nodeIds) {
    if (!db.nodeExists(id)) {
      throw new Error(`Node "${id}" does not exist (or is removed).`);
    }
  }
  const name = input.name?.trim() || `trail-${Date.now().toString(36)}`;
  const id = "trail-" + createHash("sha1").update(name + "\n" + summaryKey(input.summary)).digest("hex").slice(0, 8);
  if (db.getTrail(id)) {
    throw new Error(`Trail "${id}" already exists. Use trail_extend or a different name.`);
  }
  db.insertTrail({ id, name, summary: input.summary, node_ids: nodeIds });
  return {
    id,
    message: `Saved reasoning chain "${id}" (${name}) with ${nodeIds.length} member(s).`,
  };
}

/**
 * P1.1 (план 20+21 v3 §10): trail_save с opt-in паспортом проверенного
 * разбора. Тело валидируется и собирается (хеши области, идентичность repo)
 * ДО записи — ошибка входа не оставляет trail. Долговечное ядро — сам trail
 * (члены с отпечатками смысла + WHY); версионное тело обработчик пишет в
 * params существующего события timeline (легальная структура без DDL).
 */
export async function trailSaveWithPassport(
  db: KnowledgeDB,
  input: TrailSaveInput & { passport: PassportInput }
): Promise<{ id: string; message: string; passport: PassportPayload }> {
  const body = await buildPassportBody(db, input.passport, input.node_ids, input.repo_root);
  // Тело паспорта — ДАННЫЕ reuse, а не телеметрия: пишется в params
  // существующего типа события trail_save атомарно с самой цепочкой
  // (легальная структура без DDL; ретеншн журнала после вытеснения даёт
  // честную деградацию квалификации до unknown).
  let savedId = "";
  let savedMessage = "";
  const passport: PassportPayload = { ...body, trail_id: "" };
  db.runInTransaction(() => {
    const saved = trailSave(db, input);
    passport.trail_id = saved.id;
    db.insertTimelineEntry({
      tool: "trail_save",
      params: JSON.stringify({ name: input.name ?? null, trail_id: saved.id, passport }),
      result_summary: `passport format ${passport.passport_format} recorded for ${saved.id}`,
      is_write: true,
      is_error: false,
      affected_ids: input.node_ids,
    });
    savedId = saved.id;
    savedMessage = saved.message;
  });
  return {
    id: savedId,
    message:
      `${savedMessage} Passport format ${passport.passport_format} recorded ` +
      `(${passport.scope.files.length} scoped file(s)${passport.scope.truncated ? ", scope truncated" : ""}).`,
    passport,
  };
}

export function trailGet(
  db: KnowledgeDB,
  id: string,
  opts?: { include_passport?: boolean }
): TrailView & { passport?: PassportPayload | null } {
  const trail = db.getTrail(id);
  if (!trail) {
    throw new Error(`Trail "${id}" not found.`);
  }
  const members = trailMemberStates(db, id);
  const state = members.some((m) => m.state === "broken")
    ? "broken"
    : members.some((m) => m.state === "stale")
      ? "stale"
      : "fresh";
  // Lazy persist: the stored flag follows what the read actually found.
  if (Boolean(trail.stale) !== (state !== "fresh")) {
    db.setTrailStale(id, state !== "fresh");
  }
  // P1: тело паспорта — только по явному include_passport; отсутствие тела
  // (ретеншн журнала) честно показывается null, не молчаливым отсутствием.
  const passport = opts?.include_passport ? findLatestPassportBody(db, id) : undefined;
  return {
    id: trail.id,
    name: trail.name,
    summary: trail.summary,
    state,
    members,
    ...(opts?.include_passport ? { passport } : {}),
  };
}

export function trailRefresh(db: KnowledgeDB, id: string): { message: string; state: TrailView["state"]; reasons: Array<string | null> } {
  const trail = db.getTrail(id);
  if (!trail) {
    throw new Error(`Trail "${id}" not found.`);
  }
  db.refreshTrailFingerprints(id);
  const actual = trailGet(db, id);
  return {
    message: `Trail "${id}" refreshed: fingerprints re-snapshotted, chain is ${actual.state}.`,
    state: actual.state,
    reasons: actual.members.filter(member => member.state !== "fresh").map(member => member.reason),
  };
}

export function trailExtend(db: KnowledgeDB, id: string, nodeIds: string[]): { message: string } {
  const trail = db.getTrail(id);
  if (!trail) {
    throw new Error(`Trail "${id}" not found.`);
  }
  if (nodeIds.length === 0) {
    throw new Error("trail_extend requires at least one node id.");
  }
  for (const nodeId of nodeIds) {
    if (!db.nodeExists(nodeId)) {
      throw new Error(`Node "${nodeId}" does not exist (or is removed).`);
    }
  }
  db.appendTrailMembers(id, nodeIds);
  return { message: `Trail "${id}" extended with ${nodeIds.length} member(s).` };
}

// ---- Slots ----

export function slotSet(
  db: KnowledgeDB,
  role: string,
  nodeId: string
): { message: string } {
  const result = db.setSlot("", role, nodeId);
  if (result.noop) {
    return { message: `Node "${nodeId}" already holds role "${role}" — no-op.` };
  }
  const note =
    result.previous_node !== null
      ? ` Previous holder "${result.previous_node}" superseded (edge written, node not touched).`
      : "";
  return { message: `Role "${role}" taken by "${nodeId}".${note}` };
}

export function slotGet(db: KnowledgeDB, role: string): { message: string } {
  const slot = db.getSlot("", role);
  if (!slot) {
    return { message: `Role "${role}" is not held by anyone.` };
  }
  return {
    message: `Role "${role}" -> "${slot.node_id}" (${slot.node_name}), since ${slot.updated_at}.`,
  };
}

export function slotRelease(db: KnowledgeDB, role: string): { message: string } {
  const released = db.releaseSlot("", role);
  return {
    message: released
      ? `Role "${role}" released. The previous holder node is untouched.`
      : `Role "${role}" was not held by anyone.`,
  };
}

export function slotList(db: KnowledgeDB): {
  slots: Array<{ role: string; node_id: string; node_name: string; updated_at: string }>;
} {
  return { slots: db.listSlots("") };
}

// ---- Task board ----

export function taskAdd(
  db: KnowledgeDB,
  name: string,
  due?: string
): { id: string; message: string } {
  if (!name || name.trim().length === 0) {
    throw new Error("Task name must be a non-empty string.");
  }
  if (due && Number.isNaN(Date.parse(due))) {
    throw new Error(`due "${due}" is not a parseable date.`);
  }
  const id = makeId(name);
  if (db.nodeExists(id)) {
    throw new Error(`Concept "${id}" already exists. Use update_concept or a different name.`);
  }
  db.insertNode({
    id,
    name,
    kind: "task",
    summary: `Task: ${name}`,
    epistemic_status: null,
    created_via: "agent",
  });
  db.setTaskState(id, "open", due ?? null);
  return { id, message: `Task "${id}" added to the open column${due ? `, due ${due}` : ""}.` };
}

export function taskDone(db: KnowledgeDB, id: string): { message: string } {
  const node = db.getNode(id);
  if (!node) {
    throw new Error(`Task "${id}" not found.`);
  }
  if (node.task_state === "done") {
    return { message: `Task "${id}" is already done.` };
  }
  const wasDue = node.due_at;
  db.setTaskState(id, "done", null);
  return { message: `Task "${id}" done${wasDue ? ` (was due ${wasDue})` : ""}.` };
}

export function board(db: KnowledgeDB, input: { done_cursor?: string; done_limit?: number } = {}): BoardOutput & { summary: string } {
  const output = computeBoard(db, input);
  const openCol = output.columns.find((c) => c.name === "open")!;
  return {
    ...output,
    summary: `${output.open} open, ${output.overdue} overdue. Top: ${
      openCol.cards.slice(0, 3).map((c) => c.name).join("; ") || "nothing burning"
    }.`,
  };
}
