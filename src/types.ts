// ---- Data model types ----

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  parent_id: string | null;
  created_by_task: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  merge_group: string | null;
  needs_merge: boolean;
  source_branch: string | null;
  merge_timestamp: string | null;
}

export const NODE_KINDS = ["feature", "module", "pattern", "config", "decision", "component", "digest", "journal"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface Edge {
  id: number;
  from_id: string;
  to_id: string;
  relation: RelationType;
  description: string | null;
  created_at: string;
  merge_group: string | null;
  needs_merge: boolean;
  source_branch: string | null;
  merge_timestamp: string | null;
}

export type RelationType =
  | "connects_to"
  | "depends_on"
  | "implements"
  | "calls"
  | "configured_by"
  | "supersedes"
  | "contradicts"
  /** Plan 2 §1: provenance edge — "this conclusion is informed by that fact". */
  | "informed_by";

/** Node lifecycle (fork T4): active by default, soft-invalidated otherwise. */
export type NodeStatus = "active" | "superseded" | "deprecated";

// ---- Tool input types ----

export interface CreateConceptInput {
  name: string;
  kind: NodeKind;
  summary: string;
  why?: string;
  parent_id?: string;
  file_refs?: string[];
  edges?: Array<{
    to: string;
    relation: RelationType;
    description?: string;
  }>;
  /**
   * Plan 3 §4.1.1: provenance shortcut — pass the support together with the
   * node. `{node}` uses an existing node as evidence, `{ref}` resolves a file
   * against file_refs (creating a file-fact node when nothing matches); `why`
   * becomes the informed_by rationale. Support edges are written in the same
   * transaction as the node.
   */
  evidence?: EvidenceInput[];
  /**
   * IDs this concept replaces (T4): creates supersedes edges and marks the
   * old nodes superseded with valid_until = now.
   */
  supersedes?: string[];
  created_by_task?: string;
  /** Plan 1 §5.3: initial epistemic state; default `open`. */
  epistemic_status?: "open" | "validated" | "refuted" | "abandoned";
  /** Required when epistemic_status = validated (JSON: {env?,version?,dataset?,artifact?}). */
  status_scope?: Record<string, unknown>;
  /**
   * 2.1.9 F2: conscious bypass of the stub-summary rejection. The node is
   * written with epistemic_status = "stub" and shows up as a weak link —
   * a deliberate placeholder, never mistaken for a confirmation.
   */
  allow_stub?: boolean;
  /**
   * 2.1.10 F4: create anyway when the dedupe check finds a semantic or
   * name-level duplicate. Without it a near-duplicate request is refused
   * with duplicate_of — update that node or pass force consciously.
   */
  force?: boolean;
  /**
   * 2.1.12 F1: срок годности факта (ISO-8601, напр. "2026-12-31" или
   * "2026-12-31T23:59:59Z"). Обязателен для утверждений о состоянии
   * («смержено», «PR открыт») — без него запись о состоянии со временем
   * тихо врёт. Сервер срок не придумывает: не передал — узел бессрочный.
   * M2 B2: для kind=journal опущенное поле означает автопростановку по
   * политике expiry (env/конфиг/default 90 дней); явный null отказывается
   * от автопростановки (диагностика без срока остаётся).
   */
  valid_until?: string | null;
}

/** Plan 3 §4.1.1: one evidence item — exactly one of `ref` / `node`, plus a non-empty `why`. */
interface EvidenceExpectation {
  /** Version of a reused support's summary as the agent read it. */
  claim_digest?: string;
  /** Version of a reused support's status axes as the agent read them. */
  status_digest?: string;
  /** Combined active artifact-observation digest as the agent read it. */
  artifacts_digest?: string | null;
}

interface EvidenceBase {
  /** Mandatory and non-empty on the public wire. */
  why: string;
  /** Only versions createConcept actually validates. */
  expect?: EvidenceExpectation;
}

export type EvidenceInput =
  | (EvidenceBase & {
      /** File path (+ optional line range) to resolve or create as a file-fact node. */
      ref: string;
      node?: never;
    })
  | (EvidenceBase & {
      ref?: never;
      /** Existing node id to lean on. */
      node: string;
    });

export interface UpdateConceptInput {
  id: string;
  changes: {
    name?: string;
    kind?: NodeKind;
    summary?: string;
    why?: string;
    file_refs?: string[];
    /**
     * Plan 1 §5.3: epistemic transition. `reason` is mandatory together with
     * it; `validated` additionally requires `status_scope` with an `artifact`.
     */
    epistemic_status?: "open" | "validated" | "refuted" | "abandoned";
    epistemic_reason?: string;
    status_scope?: Record<string, unknown>;
    /**
     * 2.1.12 F1: срок годности факта (ISO-8601). null снимает срок (факт
     * снова бессрочный), отсутствие поля оставляет как есть.
     */
    valid_until?: string | null;
  };
}

export interface LinkInput {
  from: string;
  to: string;
  relation: RelationType;
  description?: string;
}

export interface RemoveConceptInput {
  id: string;
  reason: string;
  /**
   * Plan 3 §4.3: only needed when live decisions still lean on the node.
   * Without it the removal is refused (refuse-and-redirect); with it the
   * node goes and every affected informed_by edge is tombstoned with a
   * report of who lost their support.
   */
  force?: boolean;
}

// ---- Tool output types ----

export interface NodeWithContext {
  id: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  children: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    summary: string;
    status?: string;
    epistemic_status?: string | null;
    status_scope?: Record<string, unknown> | null;
    valid_until?: string | null;
    expired?: boolean;
    refuted_reason?: string | null;
  }>;
  edges: Array<{
    to: string;
    to_name: string;
    relation: RelationType;
    description: string | null;
  }>;
  incoming_edges: Array<{
    from: string;
    from_name: string;
    relation: RelationType;
    description: string | null;
  }>;
  parent: { id: string; name: string } | null;
  similarity?: number;
  /** Why this node was found: hybrid search channel (T2). */
  via?: "vector" | "fts" | "both";
  /** Lifecycle status (T4); absent only in not-yet-migrated dbs. */
  status?: string;
  valid_until?: string | null;
  /**
   * 2.1.12 F1: факт просрочен (valid_until в прошлом). В выдаче поиска
   * ставится только при include_stale: true — по умолчанию такие узлы
   * исключены; на карточке узла считается всегда.
   */
  expired?: boolean;
  /**
   * UX-01 (план 07): происхождение записи (v12), задача и роли узла —
   * сравнение перед слиянием показывает то, что переедет или потеряется
   * вместе с дублем.
   */
  created_via?: string | null;
  task_state?: string | null;
  due_at?: string | null;
  slots?: Array<{ project: string; role: string }>;
  /** Plan 1: epistemic axis + the scope of a `validated` (JSON). */
  epistemic_status?: string | null;
  status_scope?: Record<string, unknown> | null;
  /** Set for refuted nodes: why the verdict was made. */
  refuted_reason?: string | null;
  /** Plan 2 §1: chains this node participates in, with their state. */
  trails?: Array<{ id: string; name: string; state: "fresh" | "stale" | "broken" }>;
  /**
   * Plan 4 §4: what this node materially relies on — live outgoing
   * informed_by edges with their (mandatory) rationales. Present only when
   * non-empty, so cards without provenance stay unchanged.
   * Plan 3 §4.2: `weak: true` marks a weak link — the support is refuted,
   * abandoned, or ungrounded.
   */
  informed_by?: Array<{
    to: string;
    to_name: string;
    rationale: string | null;
    weak?: boolean;
  }>;
  /** Plan 4 §4: nodes that rely on this node (live incoming informed_by). */
  informed_by_incoming?: Array<{ from: string; from_name: string; rationale: string | null }>;
  /**
   * Plan 3 §4.2: this node is a decision whose every support is ungrounded —
   * it must not be quoted as proven knowledge.
   */
  weak_support?: boolean;
  /**
   * Plan 4 v8 §4: the support check next to the epistemic verdict on the node
   * card (get_concept only — search results must not pay for it). Present
   * whenever there is anything to check.
   */
  support_check?: SupportCheckView;
  /**
   * 2.1.7 F1: the digests the agent can pass straight into confirm_supports
   * — no hand-reproduction of the hash algorithm. get_concept only (compact
   * understand must not grow). null for a removed node: a tombstone exposes
   * no digests.
   */
  current_digests?: CurrentDigestsView | null;
  /**
   * E4: версия полной карточки при delta-запросе (context_epoch передан).
   * Только в profile=full ответы delta-запросов; старые вызовы не меняются.
   */
  delta_version?: { version: string; context_epoch: string };
}

/**
 * 2.1.7 F1, revised by plan 04 K-10: the digests of one node's wording with
 * the current and the confirmed versions carried SEPARATELY — the old shape
 * reported the confirmed snapshot AS the current digest, so after an edit a
 * re-read returned the stale value again and confirm → edit → reread →
 * confirm never converged.
 *
 * `claim` is ALWAYS the digest of the live summary — the exact value
 * confirm_supports compares against, confirmable right after a re-read.
 * `confirmed_claim` documents the version the confirmation was made on (what
 * the snapshot pins; a divergence against it is reported by support_check,
 * it is not a confirmable value). `status` is always the current status-axes
 * digest: the node-level snapshot tracks the claim only, there is nothing to
 * take it from.
 */
export interface CurrentDigestsView {
  validation_claim?: string | null;
  validation_scope?: string | null;
  validation_state?: "current" | "stale" | "unknown";
  claim: string;
  status: string;
  format_version: number;
  /** The confirmed snapshot's claim digest; null = never confirmed. */
  confirmed_claim: string | null;
  /** When the snapshot was written (confirm_supports); null = never. */
  confirmed_at: string | null;
  /** Whether the node carries a confirmed claim snapshot. */
  source: "computed" | "snapshot";
}

export interface UnderstandOutput {
  matches: NodeWithContext[];
}

export interface UnderstandInput {
  query: string;
  top_k?: number;
  /** Token budget for the answer (default 1500). */
  max_tokens?: number;
  /**
   * compact (default): trimmed per-node payload under the token budget;
   * full: legacy verbose output (why, children/edges for every node).
   */
  mode?: "compact" | "full" | "brief";
  /** Include superseded/deprecated nodes (T4). Default false. */
  include_inactive?: boolean;
  /**
   * 2.1.12 F1: вернуть и просроченные факты (valid_until в прошлом) — с
   * пометкой expired: true. По умолчанию они исключены из выдачи
   * (meta.stale_excluded считает исключённых).
   */
  include_stale?: boolean;
  /**
   * План 06 (K-03): всё, что обработчик MCP добавит к ответу
   * (instructions_stale, instructions_version, server_version). Бюджет
   * считается по СЕРИАЛИЗОВАННОМУ wire-ответу вместе с этими полями —
   * оценка функции и фактическая выдача не расходятся. В возвращаемый
   * объект не попадает: обработчик добавляет сам.
   */
  extra_payload?: Record<string, unknown>;
  /**
   * E3 (план 20+21 v3 §8.3): opt-in evidence-дополнение compact-выдачи.
   * По умолчанию выключено — прежний ответ байт-в-байт. С флагом каждый
   * размещённый матч несёт current_digests (текущие версии; подтверждённая
   * ранее — отдельным полем confirmed_claim) и support_evidence — полный
   * набор живых опор (включая не найденные поиском): полная формулировка
   * (не обрезается), rationale ребра и готовые дайджесты confirm_supports той
   * же механики, что evidence-профиль get_concept. Один claim digest
   * недостаточен для подтверждения — нужны версии claim/status/edge/artifacts;
   * полную формулировку агент всё равно читает до подтверждения (§4.1).
   * Поддержан только в mode=compact; с full/brief — явная ошибка.
   */
  include_evidence?: boolean;
  /**
   * D0 (план 20+21 v3 §9): opt-in режим уменьшения доли технических
   * ref-якорей на верхнем уровне compact-выдачи. Технический якорь — по
   * происхождению И текущей структуре (created_via='file_ref' + шаблонное
   * саммари + имя = file_refs[0]); отредактированная осмысленная карточка не
   * прячется. Якорь с найденным зависимым выводом показывается компактно
   * (вложение с rationale или collapsed-вид с зависимыми выводами), без
   * зависимых — компактный локатор; если найдены только якоря, результат не
   * превращается в ложный no-match. Счётчик — meta.anchor_collapsed; хранение
   * не меняется (без hidden_from_search): get_concept/provenance_trace
   * разрешают опору во всех режимах. Поддержан только в mode=compact.
   */
  collapse_ref_anchors?: boolean;
  /**
   * P1.3 (план 20+21 v3 §10): opt-in запрос переиспользования проверенного
   * разбора. Кандидат находится по ЯВНОМУ типу задачи и проверяемому scope
   * (не по embedding score); ответ — passport_reuse с covered/gaps/
   * qualification по таблице состояний P1.2. Проверка применимости — только
   * чтение: не подтверждает опоры и не заполняет next.skip.
   * Поддержан только в mode=compact; с full/brief — явная ошибка.
   */
  reuse?: {
    task_type: string;
    files?: string[];
    trail_id?: string;
    repo_root?: string;
    max_candidates?: number;
  };
  /**
   * P3 (план 20+21 v3 §12): opt-in контекст под задачу. Явная цель и тип
   * задачи → детерминированные правила отбора: обязательные категории
   * источников (решения, инварианты, отрицательные результаты, тесты),
   * удаление смысловых повторов БЕЗ удаления противоречий/refuted/неполноты,
   * оценочная полная цена и минимальный план чтения. Встраивается в ответ
   * understand (§12.10) — не отдельный обязательный вызов. Поддержан только
   * в mode=compact; с full/brief — явная ошибка.
   */
  task?: UnderstandTaskInput;
}

/**
 * План 06 (K-02): вложенная опора сохраняет квалификацию знания — статус
 * жизненного цикла, эпистемическую ось, пометку просрочки и признак
 * слабости. Отсутствие поля в проекции — дефект, а не «нет данных».
 *
 * D0: collapsed-вложение технического якоря (collapse_ref_anchors: true)
 * опускает шаблонное саммари (шум) и несёт rationale ребра: summary тогда
 * отсутствует, а collapsed_anchor: true помечает свёрнутую форму.
 */
export interface NestedSupportView {
  id: string;
  name: string;
  /** Обычное вложение — усечённое саммари; collapsed-якорь едет без него. */
  summary?: string;
  /** Lifecycle status (active/superseded/deprecated). */
  status: string;
  /** Epistemic axis (null = не оценивалось). */
  epistemic_status?: string | null;
  status_scope?: Record<string, unknown> | null;
  valid_until?: string | null;
  refuted_reason?: string | null;
  file_refs?: string[] | null;
  /** past valid_until — при include_stale: true. */
  expired?: boolean;
  /** refuted/abandoned/ungrounded — цитировать как знание нельзя. */
  weak?: boolean;
  /** D0: свёрнутый технический якорь — компактная форма без шаблонного текста. */
  collapsed_anchor?: boolean;
  /** D0: rationale informed_by-ребра решения к этому якорю. */
  rationale?: string | null;
}

/**
 * D0: collapsed-вид технического ref-якоря — компактный локатор вместо
 * карточки с шаблонным саммари. Хранение не меняется: get_concept по id и
 * provenance_trace разрешают якорь во всех режимах.
 */
export interface CollapsedAnchorView {
  id: string;
  name: string;
  kind: NodeKind;
  /** Локатор опоры: путь/диапазоны — полезны даже без карточки. */
  file_refs: string[] | null;
  collapsed_anchor: true;
  status?: string;
  epistemic_status?: string | null;
  valid_until?: string | null;
  refuted_reason?: string | null;
  /** past valid_until — при include_stale: true. */
  expired?: boolean;
  /**
   * Живые зависимые выводы (входящие informed_by) с rationale ребра — якорь
   * показывается вместе с тем, кто на него опирается и почему; weak —
   * состояние зависимого вывода.
   */
  informed_by_incoming?: Array<{
    from: string;
    from_name: string;
    rationale: string | null;
    weak?: boolean;
  }>;
}

/** One node in compact understand output — everything optional is dropped. */
export interface CompactMatch {
  id: string;
  name: string;
  kind: NodeKind;
  status: string;
  /** Plan 1: epistemic axis, shown so refuted nodes are never mistaken for facts. */
  epistemic_status?: string | null;
  status_scope?: Record<string, unknown> | null;
  valid_until?: string | null;
  /**
   * План 06 (K-04): причина опровержения едет и в compact-выдаче —
   * «антизнание с причиной» не только в full-режиме.
   */
  refuted_reason?: string | null;
  /** Truncated to <=240 chars at a word boundary. */
  summary: string;
  file_refs: string[] | null;
  score?: number;
  /** Alias of score, kept for explorer UI compatibility. */
  similarity?: number;
  via?: "vector" | "fts" | "both";
  /** Present only for the first 3 results; historical children remain qualified. */
  children?: Array<{ id: string; name: string; kind: NodeKind; status?: string; epistemic_status?: string | null; status_scope?: Record<string, unknown> | null; valid_until?: string | null; expired?: boolean; refuted_reason?: string | null }>;
  edges?: Array<{ to: string; to_name: string; relation: RelationType }>;
  /**
   * 2.1.7 F2: live informed_by supports of THIS node that the same query
   * also returned. They are folded here (depth 1 — a nested support carries
   * no supports of its own) instead of competing for a top slot: a support
   * shares the query terms with its decision and used to push the decision
   * off rank 1. Does not occupy a top_k slot; its tokens ARE counted in
   * tokens_estimated. План 06 (K-02): несёт квалификацию знания — см.
   * NestedSupportView.
   */
  supports?: NestedSupportView[];
  /**
   * 2.1.12 F1: the match is past its valid_until — present only when the
   * caller asked include_stale: true.
   */
  expired?: boolean;
  /**
   * E3 (include_evidence: true): текущие дайджесты узла — та же форма, что у
   * get_concept: claim — ВСЕГДА текущая формулировка (подтверждаемое значение
   * для expected_claim_digest), confirmed_claim/confirmed_at — документация
   * снимка, а не подтверждаемое значение; current и confirmed не смешиваются.
   */
  current_digests?: CurrentDigestsView;
  /**
   * E3 (include_evidence: true): полный набор живых опор узла (включая не
   * найденные поиском) — полная формулировка (никогда не обрезается),
   * rationale ребра, квалификация, weak/quality и готовые дайджесты
   * claim/status/edge/artifacts той же механики, что evidence-профиль
   * get_concept. Криптографические значения едут полными hex, не
   * display-префиксами.
   */
  support_evidence?: ConceptEvidenceSupport[];
}

export interface UnderstandMeta {
  returned: number;
  dropped: number;
  tokens_estimated: number;
  /** U6: what the full-mode answer would have cost — drives "saved vs full". */
  estimated_full_tokens?: number;
  /**
   * 2.1.7 F2: how many nodes were folded under their decisions instead of
   * sitting on the top level. `returned` counts the top level only; the id
   * set of the answer is preserved — folded nodes travel nested.
   */
  supports_inlined?: number;
  /**
   * 2.1.12 F1: сколько просроченных фактов (valid_until в прошлом, активных)
   * найдено запросом, но исключено из выдачи. Ноль — тоже честное число:
   * молчаливый фильтр выглядел бы как «запрос ничего не нашёл».
   */
  stale_excluded?: number;
  /**
   * План 06 (K-01): сколько неактивных (superseded/deprecated) найдено
   * запросом, но исключено без include_inactive. Отдельно от усечённых
   * (dropped) — счётчики фильтра и счётчики нарезки не смешиваются.
   */
  inactive_excluded?: number;
  /**
   * План 06 (K-03/K-04): что-то не поместилось в бюджет (узлы или refuted
   * порезаны). tokens_estimated при этом остаётся честным числом
   * фактической выдачи.
   */
  truncated?: boolean;
  /**
   * Пустой compact при непустом результате поиска: в бюджет не поместилась
   * ни одна карточка. Причина называется явно, чтобы пустой ответ не читался
   * как «ничего не нашлось» — подними max_tokens или используй brief.
   */
  reason?: "budget";
  /** E3 (include_evidence: true): сколько размещённых матчей несут дополнение. */
  evidence_matches?: number;
  /** E3 (include_evidence: true): суммарное число опор в дополнении (все живые informed_by). */
  evidence_supports?: number;
  /**
   * D0 (collapse_ref_anchors: true): сколько технических якорей свернуто в
   * collapsed-форму (секция anchors). Физическое число узлов в stats не
   * подменяется: считаются только свёрнутые в этой выдаче.
   */
  anchor_collapsed?: number;
}

export interface UnderstandOutput {
  matches: NodeWithContext[];
  /**
   * compact-mode rows (default mode). Present alongside `matches` being
   * empty/legacy for backward compatibility with older consumers.
   */
  compact?: CompactMatch[];
  /**
   * Plan 1 §5.3: refuted nodes found by the query, always returned regardless
   * of include_inactive — antiknowledge must not disappear behind a filter.
   * CompactMatch in compact mode, full NodeWithContext in full mode.
   */
  refuted?: Array<CompactMatch | NodeWithContext>;
  /**
   * В14: relations between the returned nodes — graph structure without
   * pulling every node's full context.
   */
  edges_between?: Array<{ from: string; to: string; relation: string }>;
  /**
   * D0 (collapse_ref_anchors: true): свёрнутые технические ref-якоря —
   * компактные локаторы вместо карточек с шаблонным саммари. Только opt-in;
   * без флага секции нет.
   */
  anchors?: CollapsedAnchorView[];
  /**
   * P1.3 (opt-in reuse): квалификация переиспользования проверенных разборов
   * (паспортов) для явного типа задачи и области. Без reuse-запроса секции
   * нет. Каждое состояние — явный статус; ни один случай не повышает доверие
   * молча; reusable не является покрытием кода.
   */
  passport_reuse?: PassportReuseView;
  /**
   * P3 (opt-in task): контекст под задачу — обязательные категории, скрытые
   * зависимости, план чтения и оценочная полная цена. Без task-параметра
   * секции нет; не подменяет must_read, не заполняет next.skip и не
   * утверждает whole-file coverage.
   */
  task_context?: TaskContextView;
  meta?: UnderstandMeta;
  /**
   * План 13 §2.1: машинно-исполнимый контракт действия, завершающий каждый
   * ответ understand (что читать, что пропускать, какие вызовы сделать, что
   * записать). Присутствует в compact- и full-режимах; при пустом ответе блок
   * остаётся с пустыми списками и формой записи в record. В бюджет ответа
   * входит на общих основаниях: tokens_estimated считается по той же
   * wire-форме, что уходит по проводу (K-03), поэтому по сравнению с
   * версией 2.2.0 число выросло — это единственное законно меняющееся старое
   * значение.
   */
  next?: NextHints;
}

/** План 13 §2.1: одна ссылка must_read — дословный file_ref узла из ответа. */
export interface NextHintRead {
  /** Дословно из file_refs узла (может содержать ":строки"). */
  ref: string;
  /** Почему читать: узел-источник (имя, суть). */
  why: string;
  /** Узел, чей file_ref породил ссылку. */
  node_id: string;
}

/** Legacy shape for explicit coverage proofs; current next output keeps this list empty. */
export interface NextHintSkip {
  /** Целый файл — file_ref БЕЗ диапазона строк. */
  ref: string;
  /** Какой узел покрывает файл. */
  why: string;
}

/** План 13 §2.1: follow-up вызов с готовыми аргументами — исполняется дословно. */
export interface NextHintFollowup {
  tool: "check_artifacts" | "get_concept" | "provenance_trace";
  /** Готовые аргументы вызова. */
  args: Record<string, unknown>;
  why: string;
}

/**
 * План 13 §2.1: контракт действия в конце ответа understand. must_read — до 3
 * ссылок из file_refs узлов ответа; skip — целые файлы, покрытые карточками;
 * followups — до 3 вызовов с готовыми аргументами (приоритет: check_artifacts
 * для устаревших снимков, get_concept для решений с невидимыми опорами,
 * provenance_trace для нечистого support_check); record — форма записи,
 * присутствует всегда, даже при пустом ответе.
 */
export interface NextHints {
  must_read: NextHintRead[];
  skip: NextHintSkip[];
  followups: NextHintFollowup[];
  record: string;
}

/**
 * План 13 §2.2 (режим brief, группа B): до 8 строк текста вместо карточек
 * плюс тот же блок next. compact остаётся режимом по умолчанию.
 */
export interface BriefOutput {
  brief: string;
  next: NextHints;
  meta: UnderstandMeta;
}

export interface GetConceptInput {
  id: string;
}

// ---- E1/E2 (план 20+21 v3 §8): профили get_concept, бюджет, продолжение, пакет ----
//
// Старый одиночный вызов {id} сохраняет прежний контракт байт-в-байт (до
// отдельного решения о default). Профили — ограниченный набор разделов, а не
// произвольный язык проекций; бюджет считается по фактически сериализованному
// wire-ответу существующим estimator'ом (оценка, не гарантия токенов
// провайдера).

export type GetConceptProfile = "orientation" | "evidence" | "full";

export interface ConceptProfileInput {
  id?: string;
  profile?: GetConceptProfile;
  /** Бюджет wire-ответа в оценочных токенах (estimateTokens ~ байты/3). */
  max_tokens?: number;
  /** Лимит раскрытия соседей на один список (default 20). */
  max_neighbors?: number;
  /** Opaque-токен продолжения из предыдущего бюджетного ответа. */
  continuation?: string;
  /**
   * E4 (план 20+21 v3 §8.4): идентификатор текущей эпохи контекста клиента.
   * После compaction/restart/смены проекта клиент uses a NEW epoch or omits
   * the parameter — полная выдача. Только вместе с known_versions даёт delta.
   */
  context_epoch?: string;
  /**
   * E4: подтверждённые клиентом версии проекций {id: version} из meta.version
   * предыдущего ответа (клиент подтверждает наличие текста в своём контексте).
   * Без context_epoch — явная ошибка (обе части протокола обязательны).
   */
  known_versions?: Record<string, string>;
}

/** Полные числа соседей узла — как показала бы полная карточка. */
export interface ConceptProfileNeighborCount {
  children: number;
  edges: number;
  incoming_edges: number;
  informed_by: number;
  informed_by_incoming: number;
  trails: number;
}

/** Существенная неполнота с следующим шагом — не молчаливая порезка. */
export interface ConceptProfileIncomplete {
  section: string;
  reason: "budget" | "cap";
  count: number;
  next_step: string;
  sample_ids?: string[];
}

export interface ConceptProfileMeta {
  profile: GetConceptProfile;
  /** Версия формы выдачи; изменение состава полей меняет это число. */
  form_version: 1;
  /**
   * Оценка токенов ФАКТИЧЕСКОГО wire-ответа (pretty-JSON в MCP-конверте) по
   * существующему estimator'у — оценка, не гарантия числа токенов провайдера.
   */
  tokens_estimated: number;
  max_tokens?: number;
  /** Что-то не поместилось в бюджет/лимит раскрытия (см. dropped/incomplete). */
  truncated: boolean;
  /** Полные числа соседей (у profile=full отсутствует — карточка несёт состав сама). */
  counts?: ConceptProfileNeighborCount;
  /** Сколько показано в этом ответе. */
  returned?: ConceptProfileNeighborCount;
  /** Не поместилось (только ненулевые списки). */
  dropped?: Partial<ConceptProfileNeighborCount>;
  /** Существенные формулировки/доказательства, не вошедшие в ответ. */
  incomplete?: ConceptProfileIncomplete[];
  /** Продолжения для порезанных списков: по одному токену на список. */
  continuations?: Array<{ list: string; token: string }>;
  /** Страница продолжения: какой список раскрыт и с какого места. */
  continuation_used?: { list: string; offset: number };
  /**
   * E4: версия запрошенной проекции (sha256 канонического JSON существенного
   * состояния — та же механика, что continuation-токен M3-1). Присутствует
   * только в delta-запросах (с context_epoch) — старые ответы не меняются.
   */
  version?: string;
  /** E4: эхо эпохи контекста клиента. */
  context_epoch?: string;
}

/**
 * E4: компактный ответ при совпадении версии запрошенной проекции. Текст и
 * опоры повторно не передаются; несёт квалификацию-минимум (обязательное
 * ядро §4.3) и пометку, что unchanged НЕ является покрытием кода.
 */
export interface ConceptDeltaOutput {
  unchanged: true;
  id: string;
  name: string;
  kind: NodeKind;
  profile: GetConceptProfile;
  version: string;
  context_epoch: string;
  qualification: {
    status: string;
    epistemic_status: string | null;
    valid_until: string | null;
    expired: boolean;
    refuted_reason?: string | null;
  };
  weak_support?: boolean;
  note: string;
}

export interface ConceptEvidenceSupportDigests {
  claim_digest: string;
  status_digest: string;
  edge_digest: string;
  /** Дайджест активных наблюдений артефактов опоры; null = не наблюдались. */
  artifacts_digest: string | null;
}

/**
 * Опора в evidence-профиле: полная существенная формулировка (никогда не
 * обрезается — сокращённое чтение не выдаётся за достаточное для
 * подтверждения), rationale ребра и версии, готовые для confirm_supports.
 * Клиент не вычисляет хеши сам.
 */
export interface ConceptEvidenceSupport {
  to: string;
  to_name: string;
  rationale: string | null;
  /** Полный текст формулировки опоры. */
  claim: string;
  status: string;
  epistemic_status?: string | null;
  status_scope?: Record<string, unknown> | null;
  valid_until?: string | null;
  expired?: boolean;
  refuted_reason?: string | null;
  /** refuted/abandoned/ungrounded — цитировать как знание нельзя. */
  weak?: boolean;
  /** stub = формулировка-шаблон, подтверждать её нельзя. */
  quality?: "stub" | "claim";
  digests: ConceptEvidenceSupportDigests;
}

/**
 * Проекция get_concept: обязательное ядро (идентичность, lifecycle/
 * epistemic квалификация, expiry, причины refuted) есть всегда; остальное —
 * ограниченное раскрытие соседей под бюджетом. Разделы совпадают с
 * соответствующими разделами полной карточки байт-в-байт (контрактный тест).
 */
export interface ConceptProfileOutput {
  id: string;
  name: string;
  kind: NodeKind;
  parent: { id: string; name: string } | null;
  status: string;
  epistemic_status: string | null;
  status_scope: Record<string, unknown> | null;
  valid_until: string | null;
  expired: boolean;
  refuted_reason?: string | null;
  created_via?: string | null;
  /** orientation: существующее усечение ≤240; evidence: полная формулировка. */
  summary: string;
  file_refs: string[] | null;
  /** Решение, все опоры которого слабые — предупреждение не режется бюджетом. */
  weak_support?: boolean;
  /** orientation: где брать остальное. */
  where_next?: string;
  /** Полный rationale узла (evidence). */
  why?: string | null;
  /** orientation: роле-слоты узла (как в полной карточке, без task_state). */
  slots?: Array<{ project: string; role: string }>;
  // Раскрытые соседи (ограниченно, кап + бюджет).
  children?: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    status?: string;
    epistemic_status?: string | null;
    status_scope?: Record<string, unknown> | null;
    valid_until?: string | null;
    expired?: boolean;
    refuted_reason?: string | null;
  }>;
  edges?: Array<{ to: string; to_name: string; relation: RelationType }>;
  incoming_edges?: Array<{ from: string; from_name: string; relation: RelationType }>;
  /** orientation: карта опор без формулировок (полные — в evidence). */
  informed_by?: Array<{ to: string; to_name: string; weak?: boolean }>;
  informed_by_incoming?: Array<{ from: string; from_name: string }>;
  trails?: Array<{ id: string; name: string; state: "fresh" | "stale" | "broken" }>;
  // evidence: версии для подтверждения.
  current_digests?: CurrentDigestsView;
  support_check?: SupportCheckView;
  supports?: ConceptEvidenceSupport[];
  meta: ConceptProfileMeta;
}

export interface ConceptBatchInput {
  ids?: string[];
  profile?: GetConceptProfile;
  max_tokens?: number;
  max_neighbors?: number;
  /** Opaque-токен продолжения пакета (ids/profile зашиты в токен). */
  continuation?: string;
}

export interface ConceptBatchItem {
  /** id, как передан в пакете. */
  id: string;
  /** Разрешённый id (после алиасов); отсутствует у error-элементов. */
  resolved_id?: string;
  status: "ok" | "error" | "budget_skipped";
  /** Только для error: причина по элементу, соседи не маскируются. */
  error?: string;
  /** Полная карточка (profile=full) либо проекция профиля. */
  card?: NodeWithContext | ConceptProfileOutput;
  /** Кап вычислений support-check пакета исчерпан — проверка отложена явно. */
  support_check_deferred?: boolean;
  /** Только для budget_skipped. */
  reason?: "budget";
  /** Следующий шаг для budget_skipped. */
  next_step?: string;
}

export interface ConceptBatchMeta {
  total: number;
  ok: number;
  failed: number;
  budget_skipped: number;
  profile: GetConceptProfile;
  /** Оценка токенов фактического wire-ответа — оценка, не гарантия. */
  tokens_estimated: number;
  max_tokens?: number;
  /** Бюджет порезал пакет (budget_skipped > 0). */
  truncated: boolean;
  /** Продолжение пакета: остаток списка с фиксацией версии выданного. */
  continuation?: string;
  continuation_used?: { offset: number };
}

/**
 * Пакетное чтение get_concept: один общий бюджет на весь пакет, статус/
 * ошибка/неполнота видны по каждому id; неразрешённый id не исчезает молча.
 */
export interface ConceptBatchOutput {
  batch: ConceptBatchItem[];
  meta: ConceptBatchMeta;
}

export interface ListRootsInput {
  /** Token budget for the overview (default 1500). */
  max_tokens?: number;
  /**
   * 2.1.13 F3: то, что MCP-обработчик добавит к ответу (instructions_status,
   * stats). Бюджет считается по СЕРИАЛИЗОВАННОМУ ответу вместе с этими
   * полями — оценка функции и реальная выдача не расходятся. В возвращаемый
   * объект не попадает: обработчик добавляет сам.
   */
  extra_payload?: Record<string, unknown>;
}

/** 2.1.13 F3: meta бюджетного обзора — с пометками сокращения секций. */
export interface ListRootsMeta extends UnderstandMeta {
  /** Что-то не поместилось в бюджет (roots/slots/board_top резаны). */
  truncated?: boolean;
  /** Сколько ролей не вошло (резерв приоритета: роли → задачи → корни). */
  dropped_slots?: number;
  /** Сколько задач (board_top) не вошло. */
  dropped_board_top?: number;
}

export interface ListRootsOutput {
  roots: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    summary: string;
    children: string[];
    /** 2.1.12 F1: срок годности корня, если агент его ставил. */
    valid_until?: string | null;
  }>;
  /** true when roots_compact (budgeted overview) is the payload. */
  compact?: boolean;
  roots_compact?: Array<{
    id: string;
    name: string;
    kind: NodeKind;
    child_count: number;
    /** 2.1.12 F1: срок годности корня, если агент его ставил. */
    valid_until?: string | null;
  }>;
  /** Plan 2 §2: role slots — first in the startup digest. */
  slots?: Array<{ role: string; node_id: string; node_name: string }>;
  /** Plan 2 §3: top-5 of the open column by rot. */
  board_top?: Array<{ id: string; name: string; rot?: number; due_at?: string | null }>;
  meta?: ListRootsMeta;
}

// ---- DB row types (raw from SQLite) ----

export interface NodeRow {
  validation_claim_digest?: string | null;
  validation_scope_digest?: string | null;
  embedding_generation?: number | null;
  id: string;
  name: string;
  kind: string;
  summary: string;
  why: string | null;
  file_refs: string | null; // JSON string
  parent_id: string | null;
  created_by_task: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  embedding: Buffer | ArrayBuffer | null;
  merge_group: string | null;
  needs_merge: number; // SQLite stores boolean as 0/1
  source_branch: string | null;
  merge_timestamp: string | null;
  // Fork columns (T0.5 migration) — absent only in not-yet-migrated dbs.
  status?: string;
  valid_from?: string | null;
  valid_until?: string | null;
  // Plan 1 (v5): epistemic axis (open/validated/refuted/abandoned, NULL =
  // unknown) and the JSON scope of a `validated`.
  epistemic_status?: string | null;
  status_scope?: string | null;
  // Plan 2 (v6): task board axis — 'open' | 'done', NULL for non-tasks.
  // Deliberately NOT the lifecycle `status` or the epistemic axis.
  task_state?: string | null;
  due_at?: string | null;
  // Plan 4 v8: the digest of the decision's own wording AS CONFIRMED (written
  // only by confirm_supports, never by content writes) + when. A rewrite of
  // the summary does not touch this column — the mismatch IS the signal that
  // the old confirmation does not extend to the new wording.
  claim_digest?: string | null;
  claim_digest_at?: string | null;
  // 2.1.10 (v12): which write path created the node — 'agent' | 'file_ref' |
  // 'import' | 'auto'. Anchors ('file_ref') never count as stubs; NULL means
  // the origin is unknown (rows carried over from pre-v12 sources).
  created_via?: string | null;
}

export interface EdgeRow {
  id: number;
  from_id: string;
  to_id: string;
  relation: string;
  description: string | null;
  created_at: string;
  merge_group: string | null;
  needs_merge: number; // SQLite stores boolean as 0/1
  source_branch: string | null;
  merge_timestamp: string | null;
  /** Plan 1 (v5): tombstone timestamp; NULL = active edge. */
  removed_at?: string | null;
  // Plan 4 v8: which server write path created the row — assigned by the
  // server, never accepted from the caller. 'agent' = explicit tool call
  // (link/evidence), 'auto' = server-derived (auto-ground), 'unknown' =
  // pre-v8 rows and every import/merge. Explicit acceptance does NOT rewrite it.
  created_via?: string;
  /** Plan 4 v8: when the agent explicitly accepted an auto-derived edge (confirm_supports). */
  accepted_at?: string | null;
}

// ---- Workflow tools (plan 2, v6) ----

export interface TrailSaveInput {
  node_ids: string[];
  summary: string;
  name?: string;
  /**
   * P1 (план 20+21 v3 §10): opt-in паспорт проверенного разбора. Тело пишется
   * в params существующего события timeline (без DDL), долговечное ядро — сам
   * trail. Только через trailSaveWithPassport (async): тело собирается с
   * хешированием области до записи.
   */
  passport?: PassportInput;
  /** Корень repo/worktree для паспорта (default: cwd сервера). */
  repo_root?: string;
}

export interface TrailMemberView {
  position: number;
  node_id: string;
  node_name: string | null;
  fingerprint_at_save: string;
  fingerprint_now: string | null;
  /** fresh = meaning unchanged; stale = meaning changed or node removed; broken = node gone. */
  state: "fresh" | "stale" | "broken";
  reason: string | null;
}

export interface TrailView {
  id: string;
  name: string;
  summary: string;
  /** fresh / stale / broken for the chain as a whole. */
  state: "fresh" | "stale" | "broken";
  members: TrailMemberView[];
}

// ---- P1 (план 20+21 v3 §10): паспорт проверенного разбора ----
//
// Долговечное ядро — существующий механизм trail (trails/trail_members:
// члены с отпечатками смысла + WHY-резюме). Версионное тело — JSON в params
// существующего события timeline вызова trail_save (легальная структура без
// DDL; подвержено ретеншну журнала — после вытеснения квалификация честно
// деградирует до unknown). Durable-расширение хранения — отдельный
// дизайн-документ для review-gate владельца, не реализация.

/** Версия формата тела паспорта (изменение состава полей меняет число). */
export const PASSPORT_FORMAT_VERSION = 1;

/** Файл области проверки: целевой хеш на момент обследования. */
export interface PassportScopeFile {
  /** Сырая ссылка (path или path:N-M), как записал агент. */
  ref: string;
  /** sha256 ЦЕЛОГО файла (консервативная актуальность); null — файла не было. */
  sha256: string | null;
  size_bytes: number | null;
  missing?: true;
}

/** Вывод паспорта: член цепочки и файлы, на которых он rests. */
export interface PassportConclusion {
  node_id: string;
  file_refs: string[];
}

/** Источник обследования с ролью. */
export interface PassportSource {
  ref: string;
  role: string;
}

export interface PassportCheck {
  what: string;
  /** Ссылка на результат (узел, артефакт), если результат сохранён. */
  result_ref?: string | null;
}

export interface PassportOmittedCheck {
  what: string;
  reason: string;
}

/** Версионное тело паспорта (format 1). */
export interface PassportPayload {
  passport_format: 1;
  /** Явный тип задачи — reuse ищется по нему, не по похожести запроса. */
  task_type: string;
  goal: string;
  trail_id: string;
  /** Идентичность repo/worktree: корень и базовая ревизия HEAD (null — не git). */
  repo: { root: string; head_at_check: string | null };
  scope: { files: PassportScopeFile[]; truncated: boolean };
  conclusions: PassportConclusion[];
  sources: PassportSource[];
  checks: { performed: PassportCheck[]; omitted: PassportOmittedCheck[] };
  completeness: { degree: "full" | "partial"; gaps: string[]; limitations: string[] };
  /** Версии инструментов/настроек обследования (свободная форма). */
  tools: Record<string, string>;
  checked_at: string;
  /** Срок применимости паспорта (ISO); null — срок не задан. */
  valid_until: string | null;
}

/** Вход паспорта при trail_save (opt-in). */
export interface PassportInput {
  task_type: string;
  goal: string;
  scope_files: string[];
  sources?: PassportSource[];
  checks_performed?: PassportCheck[];
  checks_omitted?: PassportOmittedCheck[];
  completeness_degree?: "full" | "partial";
  completeness_gaps?: string[];
  completeness_limitations?: string[];
  valid_until?: string | null;
  tools?: Record<string, string>;
}

/** Запрос квалификации reuse (opt-in, только явные данные). */
export interface PassportReuseRequest {
  task_type: string;
  /** Запрошенная область (refs/paths) — сверяется с областью паспорта. */
  files?: string[];
  /** Проверить конкретный паспорт. */
  trail_id?: string;
  /** Корень repo/worktree (default: cwd сервера). */
  repo_root?: string;
  max_candidates?: number;
  /** Лимит хеширования области за запрос (default PASSPORT_SCOPE_MAX_FILES). */
  max_files?: number;
}

export type PassportReuseGapKind =
  | "new_file_in_scope"
  | "file_changed"
  | "file_missing"
  | "member_stale"
  | "member_refuted"
  | "member_broken"
  | "completeness"
  | "omitted_check"
  | "limitation";

export interface PassportReuseGap {
  kind: PassportReuseGapKind;
  detail: string;
  node_ids?: string[];
}

export interface PassportCoveredConclusion {
  node_id: string;
  note: string;
}

/**
 * Состояния квалификации (§10.P1.2): candidate — только ориентация;
 * reusable — совпали задача/область + проверены входы + доказательство
 * сохранено; stale_input — изменился существенный вход (перепроверить
 * затронутое, вывод не объявляется ложным); incomplete/unknown — источник
 * недоступен или проверка неполна (пропуск анализа не разрешён); expired;
 * refuted_support — опора опровергнута (вывод требует пересмотра, история
 * сохраняется); broken; wrong_repo.
 */
export type PassportQualification =
  | "reusable"
  | "candidate"
  | "stale_input"
  | "incomplete"
  | "unknown"
  | "expired"
  | "refuted_support"
  | "broken"
  | "wrong_repo";

export interface PassportReuseCandidate {
  trail_id: string;
  trail_name: string;
  task_type: string;
  qualification: PassportQualification;
  trail_state: "fresh" | "stale" | "broken";
  covered: PassportCoveredConclusion[];
  gaps: PassportReuseGap[];
  checked_at: string | null;
  valid_until: string | null;
  /** journal — тело найдено в журнале; trail_only — тело вытеснено ретеншном. */
  body_source: "journal" | "trail_only";
  notes: string[];
}

export interface PassportReuseView {
  candidates: PassportReuseCandidate[];
  /** Сколько паспортов найдено по явному типу задачи (до лимита кандидатов). */
  found: number;
  note: string;
}

export interface SlotView {
  role: string;
  node_id: string;
  node_name: string;
  updated_at: string;
}

export interface BoardColumn {
  name: string;
  terminal: boolean;
  count: number;
  returned?: number;
  has_more?: boolean;
  next_cursor?: string | null;
  cards: Array<{ id: string; name: string; rot?: number; due_at?: string | null }>;
}

export interface BoardOutput {
  columns: BoardColumn[];
  overdue: number;
  open: number;
}

// ---- Merge types ----

export interface ConflictVersion {
  id: string;
  original_id: string;
  source_branch: string;
  name: string;
  kind: NodeKind;
  summary: string;
  why: string | null;
  file_refs: string[] | null;
  edges: Array<{ to: string; relation: RelationType; description: string | null }>;
  removed_at: string | null;
  removed_reason: string | null;
}

export interface MergeConflictRow {
  id: number;
  merge_group: string;
  object_kind: string;
  object_key: string;
  format_version: number;
  left_payload: string;
  right_payload: string;
  mapping_json: string;
  state: "unresolved" | "resolved";
  created_at: string;
  resolved_at: string | null;
  resolution_json: string | null;
}

export interface ConflictGroup {
  merge_group: string;
  merge_timestamp: string | null;
  versions: ConflictVersion[];
  edge_conflicts?: MergeConflictRow[];
}

export interface ListConflictsOutput {
  conflicts: ConflictGroup[];
  /** T4: nodes with incoming `contradicts` edges and who contradicts them. */
  contradicted?: Array<{
    id: string;
    name: string;
    summary: string;
    contradicted_by: string[];
  }>;
}

export interface ResolveConflictInput {
  merge_group: string;
  /** Required on the wire; ignored when the group contains edge conflicts only. */
  resolved: {
    summary: string;
    why?: string;
    file_refs?: string[];
  };
  reason: string;
  /**
   * F-03.1 (план 03): verified left/right source selection. CLI uses it for
   * keep left/right; MCP exposes it and requires it for edge-only groups.
   */
  prefer?: "left" | "right";
}

export interface MergeResult {
  clean: number;
  conceptConflicts: number;
  edgeConflicts: number;
  removedClean: number;
  mergeGroups: string[];
  /**
   * Plan 3 §2 (invariant 3): informed_by cycles that exist only in the union
   * of the two inputs. The merge is NOT aborted — the involved edges are
   * flagged needs_merge and listed here for the report.
   */
  informedByCycles?: string[][];
  /**
   * Plan 4 v8 §7: support-baseline rows carried over from the inputs
   * (confirmed_by rewritten to 'import'). Absent when there was nothing.
   */
  baselinesCarried?: number;
  /**
   * F-02 (план 03, S-03): workflow-строки, перенесённые из входов (слоты,
   * цепочки с участниками, артефакты, история статусов, алиасы). Absent
   * when there was nothing.
   */
  workflowCarried?: number;
  /**
   * F-02 (план 03): расхождения workflow-содержимого между входами (слот,
   * цепочка или алиас с тем же ключом, но другим значением). Не разрешаются
   * молчаливым удалением — left первым, right заполняет только отсутствующее.
   */
  workflowConflicts?: number;
}

// ---- Provenance tools (plan 3 §4.2) ----

export interface ProvenanceTraceInput {
  node_id: string;
  /** ancestry = what supports this; impact = what relies on this. */
  direction?: "ancestry" | "impact";
  /** Traversal depth cap, 0–20 (default 6); 0 returns only the root. */
  depth?: number;
  /** Node cap (default 200); the root does not occupy a slot. */
  max_nodes?: number;
  /**
   * Scan budget (default 5000, plan-3-fixes-2 contract 5): limits not only
   * the output but the WORK — the walk stops expanding once this many nodes
   * have been fetched, and the result is marked total_exact: false.
   */
  max_scan_nodes?: number;
  /** Return tombstoned edges too — "how we used to think". */
  retrospective?: boolean;
  /**
   * Plan 4 v8 §6: the support-baseline check is bounded by EDGES, not only
   * nodes — a decision can have tens of thousands of direct supports. When
   * the budget runs out the verdict is `incomplete`, never `unchanged`.
   */
  max_check_edges?: number;
  /** Plan 4 v8 §6: byte budget for one check call (default 2 MB). */
  max_check_bytes?: number;
}

/**
 * `complete`: no live links AND the node never had any informed_by record;
 * `has_hidden`: no live links, but records exist (removed or filtered by the
 * current mode) — retrospective would return their metadata;
 * `truncated`: the depth/node limit was hit, the full closure was not checked.
 */
export type ProvenanceCompleteness = "complete" | "has_hidden" | "truncated";

export interface ProvenanceWeakLink {
  type:
    | "refuted"
    | "abandoned"
    /**
     * 2.1.12 F1: узел просрочен — valid_until в прошлом, но узел всё ещё
     * активен и в графе. Выдача его уже не показывает; в цепочке он виден
     * пометкой expired.
     */
    | "expired"
    | "no_rationale"
    | "ungrounded_support"
    | "missing_support"
    | "no_support"
    | "cycle"
    /**
     * Plan 4 v8 §4: the supports diverge from the confirmed snapshot (or the
     * decision's own wording was rewritten after the confirmation).
     */
    | "support_changed"
    /**
     * 2.1.3 F2: the observed state of a support's external artifact (file /
     * git blob) diverges from the one saved in the snapshot. Not a
     * support_changed — the summary may be untouched, the source moved.
     */
    | "artifact_changed"
    /**
     * Plan 4 v8 §3: no snapshot, or live supports the snapshot does not cover
     * — `unknown`/`incomplete` are not cleanliness and must not be silent.
     */
    | "support_unreviewed"
    /**
     * plan-3-fixes-3 D2.2: the support check is bounded by max_scan_nodes —
     * this record reports how many supports of the decision were actually
     * verified (checked/total) instead of silently skipping the rest.
     */
    | "support_check_truncated"
    /**
     * 2.1.9 F2: the decision leans on support nodes whose summary is a
     * template or too short to be a claim. Already-recorded stubs are marked,
     * never deleted — but they must not read as confirmation.
     */
    | "stub_support"
    /** plan-3-fixes-3 D2.4: weak_links were cut to fit the 8 KB response cap. */
    | "weak_links_truncated";
  id?: string;
  from?: string;
  to?: string;
  /** Absent only on the truncation markers, which carry numbers instead. */
  note?: string;
  /** D2.3: numeric size of the flagged set — agents never parse the note. */
  count?: number;
  /** D2.3: first ≤5 ids of the flagged set; the full list is never returned. */
  sample?: string[];
  /** D2.2: supports actually verified vs. declared (support_check_truncated). */
  checked?: number;
  total?: number;
  /** D2.4: records kept vs. produced (weak_links_truncated). */
  shown?: number;
  /**
   * Plan 4 v8 §4: priority orders the cut, it does not suppress — when
   * weak_links are truncated, this carries the per-reason counts over ALL
   * produced records, not only the kept ones.
   */
  reason_counts?: Record<string, number>;
}

// ---- Support baselines (plan 4 v8: snapshot of the justification) ----

/** One confirmed pair "decision — support" (support_baselines row). */
export interface SupportBaselineRow {
  decision_claim_digest?: string | null;
  decision_id: string;
  support_id: string;
  /** Stable edge identity: edges.id (the rowid); recomputed on merge. */
  edge_key: string;
  /** Digest of the tracked claim fields of the support (summary, v1). */
  claim_digest: string;
  /** Digest of the support's status axes (lifecycle + epistemic, v1). */
  status_digest: string;
  /** Digest of the rationale (v1). */
  edge_digest: string;
  format_version: number;
  confirmed_at: string;
  /** 'agent' | 'import' | 'cli' — who confirmed; imports never confirm by themselves. */
  confirmed_by: string;
  /**
   * plan-4-fixes-6 F7: set ONLY by the explicit "no supports" confirmation —
   * it acknowledges the dead anchors instead of erasing them, so "confirmed
   * and later removed" stays distinguishable from "supports never existed".
   * A fresh confirmation of the same pair clears the flag again.
   */
  superseded_at?: string | null;
  /**
   * 2.1.3 F2: sha256 over the support's observed artifacts sorted by
   * (kind, ref, digest), taken at the confirmation moment. NULL = no
   * artifacts were observed when the pair was confirmed — honestly no
   * signal, never a false "changed".
   */
  artifacts_digest?: string | null;
}

// ---- 2.1.3 F2: node artifacts ----

/** One observed external artifact of a node (node_artifacts row). */
export interface NodeArtifactRow {
  node_id: string;
  /**
   * 'file' (path) | 'git_blob' (<rev>:<path>) | 'git_ref' (git:tag|commit|branch:<name>,
   * digest = resolved commit sha). URLs are out of scope.
   */
  kind: "file" | "git_blob" | "git_ref";
  ref: string;
  /** sha256 of the content / resolved sha; null = missing at the last check. */
  digest: string | null;
  /** Previous observed digest — warning text only ("was → became"). */
  prev_digest: string | null;
  size_bytes: number | null;
  /** Last check time (moves on every check, even a matching one). */
  checked_at: string;
  /** When a divergence was last noticed — warning text only. */
  changed_at: string | null;
  /** 'agent' | 'cli'. */
  checked_by: string;
  /** Repository root persisted for every artifact kind once it is resolved. */
  repo_path?: string | null;
}

/** check_artifacts input (2.1.3 F2). */
export interface CheckArtifactsInput {
  node_ids: string[];
  /** Cap on checked (node, ref) pairs; more => truncated: true. Default 50. */
  max_files?: number;
  /**
   * Internal API override for relative file/git-blob refs. Resolution order is
   * explicit cwd → persisted repo_path pin → process cwd. The public MCP tool
   * does not expose a per-call cwd.
   */
  cwd?: string;
  /**
   * Internal API/startup repository for git:tag/commit/branch. The public MCP
   * call passes startup `--repo` (default: database directory) as an explicit
   * repository on every check, so it takes precedence over a persisted pin.
   * Direct callers that omit repo fall back to the persisted pin, then the
   * database directory.
   */
  repo?: string;
}

/** One missing ref in the check_artifacts answer. */
export interface MissingArtifact {
  node_id: string;
  ref: string;
  kind: string;
  digest: null;
  missing: true;
}

export interface CheckArtifactsOutput {
  /** Number of (node, ref) pairs actually hashed. */
  checked: number;
  /** Observed divergences: old digest → new digest. */
  changed: Array<{ node_id: string; ref: string; old: string | null; new: string | null }>;
  missing: MissingArtifact[];
  /** true when more (node, ref) pairs were waiting than max_files allowed. */
  truncated: boolean;
}

/** Why a confirmed support no longer matches (plan 4 v8 §4). */
export type SupportChangeReason = "summary" | "status" | "rationale" | "removed";

// ---- 2.1.3 F1: the support revision journal (support_revisions rows) ----

/** Who wrote the journal entry: the confirming agent, the merge carry, or a
 * version transition (superseded by a re-confirmation / removed). */
export type SupportRevisionSource = "agent" | "import" | "superseded";

/**
 * Why the entry landed: the pair was confirmed for the first time, an older
 * version was replaced by a re-confirmation, the support was acknowledged as
 * gone, or the merge re-anchored the snapshot to a new edge row.
 */
export type SupportRevisionReason = "confirmed" | "reconfirmed" | "removed" | "edge_relinked";

/** One journal row: a confirmed version of a pair, past or superseded. */
export interface SupportRevisionRow {
  decision_claim_digest?: string | null;
  artifacts_digest?: string | null;
  confirmed_by?: string | null;
  superseded_at?: string | null;
  id?: number;
  decision_id: string;
  support_id: string;
  edge_key: string;
  claim_digest: string;
  status_digest: string;
  edge_digest: string;
  format_version: number;
  /** When THIS version was confirmed (not when the entry landed). */
  confirmed_at: string;
  /** When the entry landed in the journal. */
  recorded_at: string;
  source: SupportRevisionSource;
  reason: SupportRevisionReason | null;
}

/** One chain entry as provenance_history returns it: digests are 12-char
 * previews, no node bodies (the answer must stay small). */
export interface SupportRevisionEntry {
  decision_claim_digest?: string | null;
  artifacts_digest?: string | null;
  confirmed_by?: string | null;
  superseded_at?: string | null;
  edge_key: string;
  confirmed_at: string;
  source: string;
  reason: string | null;
  claim_digest: string;
  status_digest: string;
  edge_digest: string;
  format_version: number;
  recorded_at: string;
  /** true for the row taken from the live snapshot (support_baselines). */
  is_current: boolean;
}

/** The chain of one pair "decision — support". */
export interface SupportHistoryPair {
  support_id: string;
  revisions: SupportRevisionEntry[];
  /** true when the pair had more revisions than the limit allowed. */
  revisions_truncated?: boolean;
}

export interface ProvenanceHistoryOutput {
  decision_id: string;
  /** Up to 50 pairs when support_id is omitted; one pair when it is supplied. */
  pairs: SupportHistoryPair[];
  /** true when more than 50 pairs carry history and the remainder was omitted. */
  pairs_truncated?: boolean;
}

/** One diverged pair "decision — support" in the support_check block. */
export interface SupportPairChange {
  support: string;
  /** Array, not a single value: summary AND status can both move at once. */
  reasons: SupportChangeReason[];
  /** The confirmation time (baseline_at), not the edit time — the db keeps no edit log. */
  since: string;
  /**
   * 2.1.3 F2: the observed artifact state of the support diverges from the
   * one saved in the snapshot. NOT a support change: the summary may be
   * untouched, the source moved. True also when content reasons fired.
   */
  artifact_changed?: boolean;
  /** ≤3 observed artifact changes behind the flag — warning text only. */
  artifacts?: SupportArtifactChange[];
}

/** 2.1.3 F2: one observed artifact divergence, digests are 12-char previews. */
export interface SupportArtifactChange {
  ref: string;
  kind: string;
  prev_digest: string | null;
  digest: string | null;
  changed_at: string;
}

/**
 * Plan 4 v8 §3: four states, per pair and for the node as a whole.
 * `unknown` and `incomplete` are NOT cleanliness — a node without a snapshot
 * is never shown as verified.
 */
export interface SupportCheckView {
  semantic_changed_count?: number;
  semantic_reason_counts?: Partial<Record<SupportChangeReason, number>>;
  semantic_changed?: SupportPairChange[];
  artifact_changed?: SupportPairChange[];
  state: "unchanged" | "changed" | "unknown" | "incomplete";
  /** Pairs that diverged from the confirmed snapshot (state = changed). */
  changed?: SupportPairChange[];
  /** Honest total when the changed list was capped for the response. */
  changed_count?: number;
  /**
   * 2.1.3 F2: honest total of pairs whose observed artifacts diverge from
   * the snapshot — full-set, counted before the response cap. Lets the
   * weak-links layer size the support_changed record without the artifact
   * only pairs.
   */
  artifact_changed_count?: number;
  /** Live supports the snapshot does not cover (never confirmed). */
  unknown?: string[];
  /** Honest total when the unknown list was capped for the response. */
  unknown_count?: number;
  /** true when the check ran out of the edge/byte budget. */
  incomplete?: boolean;
  /** The confirmation time of the snapshot (max over its rows); null = never confirmed. */
  baseline_at: string | null;
  /**
   * The decision's own wording was rewritten after the confirmation — the old
   * confirmation does not extend to the new wording (plan 4 v8 §1.2).
   */
  claim_changed?: boolean;
  /**
   * plan-4-fixes-6 F7: the snapshot holds superseded rows — this decision HAD
   * confirmed supports that were later acknowledged as gone. Absent for a
   * decision that never had any.
   */
  had_supports?: boolean;
}

export interface ConfirmSupportsItem {
  support_id: string;
  /** The support's summary digest as the agent read it. */
  expected_claim_digest: string;
  /**
   * The support's status-axes digest as the agent read it. Mandatory: a
   * confirmation with a stale value is refused with version_conflict; an
   * agent must never confirm a status it has not seen.
   */
  expected_status_digest: string;
  /** The rationale digest as the agent read it. */
  expected_edge_digest: string;
  expected_edge_key?: string;
  /**
   * R-04 (plan 04): the combined digest of the support's ACTIVE artifact
   * observations as the agent read them (provenance_trace.supports[] carries
   * it in artifacts_digest). Optional, but enforced when present: a
   * check_artifacts by someone else between the read and this confirm
   * refuses with version_conflict — an observation the agent never read is
   * never confirmed.
   */
  expected_artifacts_digest?: string | null;
}

export interface ConfirmSupportsInput {
  decision_id: string;
  /** The decision's own wording digest as the agent saw it. */
  expected_claim_digest: string;
  /**
   * Confirms exactly the listed supports; live supports missing from the list
   * stay `unknown`, never "confirmed by default". An EMPTY list is valid: it
   * asserts "this node has no supports" — distinct from "never checked".
   */
  items: ConfirmSupportsItem[];
  note?: string;
}

export interface ConfirmSupportsOutput {
  decision_id: string;
  /** Number of baseline rows written (0 for a valid empty confirmation). */
  confirmed: number;
  claim_digest: string;
  baseline_at: string;
  /** Auto-derived edges explicitly accepted by this confirmation. */
  accepted_auto_edges: number;
  message: string;
}

export interface ProvenanceNodeView {
  id: string;
  name: string | null;
  kind: string | null;
  status: string | null;
  epistemic_status: string | null;
  depth: number;
  /**
   * Root→node paths within the SHOWN subgraph (plan-3-fixes-2 contract 4) —
   * not a confirmation count. null when every path crosses an unresolved
   * SCC: an honest unknown beats a lying number.
   */
  in_paths: number | null;
  /** true when in_paths hit PATH_COUNT_CAP — the true count is ≥ the shown value. */
  in_paths_capped?: boolean;
  /** Stub entry for a tombstoned endpoint in retrospective mode. */
  removed?: boolean;
  /**
   * 2.1.12 F1: узел просрочен (valid_until в прошлом, активен). Цепочку не
   * обрывает — предшественник остаётся в обходе и в счёте путей, но читать
   * его как факт нельзя.
   */
  expired?: boolean;
  /** audit only: epistemic_status != validated — this node is not trusted knowledge. */
  at_risk?: boolean;
  /**
   * Plan 4 v8 §4/§5: the node's own support check. On the root it is present
   * whenever there is anything to check; on inner nodes only when the state
   * is `changed` — the local divergence travels together with the dependency
   * path (§5), while clean/unknown nodes keep the response small.
   */
  support_check?: SupportCheckView;
}

export interface ProvenanceEdgeView {
  from: string;
  to: string;
  rationale: string | null;
  /** Tombstoned edge surfaced by retrospective mode. */
  removed?: boolean;
}

/**
 * 2.1.7 F1: one live informed_by support of the trace root with its FULL
 * current digests — the exact values confirm_supports compares against, not
 * the 12-char previews provenance_history keeps. Null digests mean the
 * support node is gone while the edge lives: the pair is reported `removed`
 * in support_check, there is nothing to hash.
 */
export interface ProvenanceSupportDigest {
  support_id: string;
  claim_digest: string | null;
  status_digest: string | null;
  edge_digest: string;
  /**
   * R-04 (plan 04): the combined digest of the support's ACTIVE artifact
   * observations (the last explicit check_artifacts, filtered to refs still
   * in file_refs). null = nothing observed. The value to pass into
   * confirm_supports as expected_artifacts_digest when the agent wants the
   * artifact state pinned to what it read.
   */
  artifacts_digest: string | null;
  /**
   * 2.1.9 F2: "stub" — the support's summary is a template / too short to be
   * a claim (it can never honestly confirm anything); "claim" — a real
   * assertion. A missing support node (null digests) is "stub" too.
   */
  quality: "stub" | "claim";
}

export interface ProvenanceTraceOutput {
  /**
   * One contract for the root and every other node (plan-3-fixes-2 F15): a
   * removed node's attributes are hidden (null), status is never invented as
   * "active"; a removed root is shown as a removed stub, not an error.
   */
  root: {
    id: string;
    name: string | null;
    kind: string | null;
    status: string | null;
    epistemic_status: string | null;
    removed?: boolean;
  };
  direction: "ancestry" | "impact";
  /** Weak links first (plan 3 §4.2): refuted/abandoned, cycles, missing rationales. */
  weak_links: ProvenanceWeakLink[];
  nodes: ProvenanceNodeView[];
  edges: ProvenanceEdgeView[];
  shown: number;
  /**
   * Nodes within the depth limit (plan-3-fixes-2 contract 3). A lower
   * estimate when total_exact is false (the scan budget cut the walk).
   */
  total_within_depth: number;
  /** false when the scan budget (max_scan_nodes) cut the closure walk. */
  total_exact: boolean;
  /** Always present (F21); true whenever truncated_by is not null. */
  truncated: boolean;
  truncated_by: "depth" | "nodes" | "scan" | null;
  completeness: ProvenanceCompleteness;
  /**
   * Plan 4 v8 §4: the root's support check, next to the epistemic verdict —
   * otherwise search keeps returning "verified" decisions whose supports
   * have long since drifted. Present whenever there is anything to check.
   */
  support_check?: SupportCheckView;
  /**
   * 2.1.7 F1: the root's own digests, the same block get_concept carries —
   * pass `current_digests.claim` straight into confirm_supports. null for a
   * removed root: a tombstone exposes no digests.
   */
  current_digests?: CurrentDigestsView | null;
  /**
   * Live root supports with full digests, sorted by support_id and capped at
   * 50. When capped, supports_count carries the total live-support count.
   */
  supports?: ProvenanceSupportDigest[];
  /** Total live-support count; present when `supports` was capped at 50. */
  supports_count?: number;
  /**
   * plan-4-fixes-6 F11: inner (non-root) nodes of any kind whose own support
   * check ran out of the shared budget. Present only when > 0; the verdict
   * also degrades completeness to "truncated" — an unverified inner node must
   * not hide behind a clean-looking answer.
   */
  inner_nodes_incomplete?: number;
  limits: {
    depth: number;
    max_nodes: number;
    max_scan_nodes: number;
    max_check_edges: number;
    max_check_bytes: number;
  };
  params: {
    depth: number;
    max_nodes: number;
    max_scan_nodes: number;
    retrospective: boolean;
    max_check_edges: number;
    max_check_bytes: number;
  };
}

export interface ProvenanceAuditOutput extends ProvenanceTraceOutput {
  /** Run persisted in provenance_audit_runs (plan 3 §10 decision 7). */
  audit_run_id: number;
}

// ---- P2 (план 20+21 v3 §11): инкрементальная актуальность и adapter к коду ----
//
// Границы (P2.3): проверка — ЯВНОЕ opt-in действие (инструмент check_freshness),
// обычный поиск её не запускает; проверка только читает — НЕ пишет в БД
// (наблюдения пишет только check_artifacts) и НЕ вызывает confirm_supports;
// изменение входов во время проверки → не стабильный снимок (unstable/conflict);
// вывод привязан к наблюдавшемуся состоянию — отчёт несёт expected_versions для
// повторной проверки перед правкой; обновление индекса не повышает доверие.

/** Откуда запись попала в обратный индекс «источник → использующие записи». */
export type FreshnessIndexOrigin = "node_file_ref" | "passport_scope" | "artifact";

/** Одна запись обратного индекса: кто цитирует источник. */
export interface FreshnessIndexEntry {
  /** "node" — узел (id); "passport" — паспорт (trail_id). */
  record: "node" | "passport";
  /** id узла или trail_id паспорта. */
  id: string;
  via: FreshnessIndexOrigin;
  /** Сырая ссылка, как записана в записи (может нести локатор строк). */
  ref: string;
}

/**
 * Восстановимый кэш обратного индекса (НЕ источник знания, схема БД не
 * трогается). Хранится файлом рядом с БД (<dir>/freshness-index.json);
 * валиден только при совпадении формата и отпечатка исходных данных, иначе
 * молча перестраивается из БД (rebuild — единственный источник истины).
 */
export interface FreshnessIndex {
  /** Версия формата файла кэша; несовпадение → rebuild. */
  index_format: 1;
  built_at: string;
  /** Отпечаток исходных данных БД (узлы/edges-file_refs, timeline, артефакты). */
  source_fingerprint: string;
  /** Ключ — нормализованный путь источника (slash, без локатора строк). */
  entries: Record<string, FreshnessIndexEntry[]>;
}

/** Статус проверки одного источника (P2.1). */
export type FreshnessSourceStatus =
  | "unchanged"      // дайджест совпал с записанной версией (наблюдение/паспорт)
  | "changed"        // дайджест разошёлся — связанные записи затронуты
  | "missing"        // источника больше нет (удалён/переименован)
  | "unobserved"     // проверили, но записанной версии для сравнения нет
  | "unstable"       // вход изменился ВО ВРЕМЯ проверки — снимок не объявляется
  | "skipped"        // не влез в бюджет проверки (truncated, порядок детерминирован)
  | "other_repo"     // закреплённый repo_path записи — другой worktree
  | "unknown";       // причина в note (ошибка чтения, неподдержанный вид)

/** Результат проверки одного источника в отчёте. */
export interface FreshnessSourceCheck {
  /** Сырой ref, как он записан в связанной записи. */
  source: string;
  kind: "file" | "git_blob" | "git_ref";
  status: FreshnessSourceStatus;
  /** Текущий дайджест наблюдения (для expected_versions). */
  current_digest: string | null;
  current_size: number | null;
  /** Записанная версия, с которой сравнивали (наблюдение/паспорт), если была. */
  compared_to: { origin: FreshnessIndexOrigin; digest: string | null; where: string } | null;
  /** Связанные записи этого источника (id + происхождение). */
  affected_records: Array<{ record: "node" | "passport"; id: string; via: FreshnessIndexOrigin }>;
  /** git-состояние пути в working tree (staged/unstaged/untracked/rename/delete). */
  git_state?: string | null;
  note: string | null;
}

/** Квалификация одной связанной записи после проверки. */
export interface FreshnessRecordCheck {
  record: "node" | "passport";
  id: string;
  name: string | null;
  /**
   * fresh — все процитированные этим выводом источники проверены и не изменились;
   * stale_input — проверенные источники изменились (вывод не объявляется ложным);
   * partial — у записи есть источники вне проверенного набора (проверен только
   * префикс — это НЕ весь граф);
   * unknown — проверка источника unstable/skipped/unknown.
   */
  state: "fresh" | "stale_input" | "partial" | "unknown";
  /** Источники записи, попавшие в проверку, со статусами. */
  checked_sources: Array<{ source: string; status: FreshnessSourceStatus }>;
  /** Источники записи вне проверенного набора (префикс ≠ весь граф). */
  unchecked_sources: string[];
  reasons: string[];
}

/** Статическое разрешение символа через adapter (P2.2, пилот). */
export interface FreshnessSymbolResolution {
  locator: { name: string; in?: string; file?: string };
  /** unique — одно определение; ambiguous/missing — требуется чтение, не выбор первого. */
  status: "unique" | "ambiguous" | "missing" | "adapter_error";
  candidates: Array<{
    file: string;
    kind?: string;
    owner?: string;
    /** Текущий результат разрешения; НЕ постоянная идентичность символа. */
    line?: number;
    start_line?: number;
    end_line?: number;
    body_start_line?: number;
    body_end_line?: number;
  }>;
  /** Связанные записи, чьи локаторы ссылаются на тот же файл с диапазоном строк. */
  matched_locators: Array<{ record: "node" | "passport"; id: string; ref: string; range: string }>;
  /** Диапазон разошёлся с записанным локатором (строки — не идентичность). */
  locator_moved: boolean;
  note: string | null;
}

/** Ожидаемая версия источника для повторной проверки перед правкой (P2.3). */
export interface FreshnessExpectedVersion {
  source: string;
  kind: "file" | "git_blob" | "git_ref";
  sha256: string | null;
  size_bytes: number | null;
  checked_at: string;
}

/** Отчёт адресной перепроверки (P2.1.6): затронутое / проверенное / неизвестное / причины. */
export interface FreshnessReport {
  repo: {
    root: string;
    /** HEAD на момент проверки; НЕ доказательство неизменности working tree. */
    head_at_check: string | null;
    /** git-состояние working tree; пустые массивы — состояние не наблюдалось/ошибка. */
    dirty: { staged: string[]; unstaged: string[]; untracked: string[]; renamed: string[]; truncated: boolean };
    git_error: string | null;
  };
  sources: FreshnessSourceCheck[];
  records: FreshnessRecordCheck[];
  /** Обход зависимостей источника (import-граф adapter), если доступен и запрошен. */
  dependencies: Array<{
    source: string;
    dependents: string[];
    complete: boolean;
    scope: string | null;
  }> | null;
  symbols: FreshnessSymbolResolution[];
  adapter: {
    configured: boolean;
    available: boolean;
    mode: "file" | "symbol";
    version: string | null;
    error: string | null;
    /** Объявленный scope adapter; статическая полнота — только он. */
    static_scope: string | null;
  };
  summary: {
    affected: number;
    checked: number;
    unknown: number;
    truncated: boolean;
    truncated_by: "max_files" | "max_deps" | null;
    limitations: string[];
  };
  /** Текущие наблюдения — вход для повторной проверки перед применением правки. */
  expected_versions: FreshnessExpectedVersion[];
}

export interface CheckFreshnessInput {
  /** Источники, которые изменились (или свежесть которых проверяется): пути/refs. */
  sources?: string[];
  /** Проверить связанные записи конкретных узлов (их file_refs). */
  node_ids?: string[];
  /** Проверить паспорта (области) конкретных trail. */
  trail_ids?: string[];
  /** Корень repo/worktree (default: cwd сервера). Закрепления наблюдений не переписываются. */
  repo_root?: string;
  /** Бюджет проверки: максимум источников (default 50). Превышение — truncated. */
  max_files?: number;
  /** Бюджет обхода зависимостей (default 20); превышение — truncated_by=max_deps. */
  max_deps?: number;
  /** Обходить import-граф изменённых источников через adapter (default false). */
  with_dependencies?: boolean;
  /** P2.2 (пилот): разрешить символы через adapter token-economy-ts. */
  symbols?: Array<{ name: string; in?: string; file?: string }>;
  /** P2.2: конфиг-точка adapter (путь к scripts каталогу скилла или graph-tool.js). */
  adapter?: { graph_tool?: string };
  /**
   * Детерминированная инъекция изменения между фазами проверки (§17.2: для
   * snapshot/TOCTOU-тестов, не случайный sleep). Боевые вызовы не передают.
   */
  fault_injection?: (phase: "after_first_pass") => void | Promise<void>;
}

// ---- P2.2: adapter token-economy-ts (пилот) ----

/** Конфиг adapter: путь к scripts каталогу скилла либо к самому graph-tool.js. */
export interface CodeAdapterConfig {
  /** Абсолютный путь к graph-tool.js. */
  graph_tool: string;
  /** Рабочий cwd вызова = корень анализируемого repo (изоляция cwd). */
  repo_root: string;
  /** Таймаут вызова, мс (default 10_000). */
  timeout_ms: number;
  source: "param" | "env";
}

export interface CodeAdapterCapability {
  available: boolean;
  project_type: string | null;
  version: string | null;
  /** op=info ответил, но обязательных полей нет / ответ не JSON. */
  reason: string | null;
}

// ---- P3 (план 20+21 v3 §12): контекст под задачу и минимальный план чтения ----

/** Явный тип задачи — детерминированное правило отбора обязательных категорий. */
export type TaskKind = "find_definition" | "explain_decision" | "prepare_edit" | "assess_impact";

export interface UnderstandTaskInput {
  /** Явная цель (что делает агент: найти определение, объяснить решение…). */
  goal: string;
  kind: TaskKind;
  /** Явная область (файлы/refs) — сужает mandatory-набор и план чтения. */
  files?: string[];
  /**
   * Явное состояние клиента (§12.9): эпоха контекста. Если в этой эпохе клиент
   * уже получал обзор (идентичность проекта сверена по отпечатку), повторная
   * выдача не дублирует уже отданные карточки целиком — уже выданные
   * немандаторные матчи едут компактной формой served_earlier. Без epoch —
   * поведение прежнее. Никогда не скрывает решения, refuted, противоречия и
   * обязательные категории.
   */
  context_epoch?: string;
}

/** Категории источников, обязательные для типа задачи (§12.3, детерминированные правила). */
export interface TaskContextCoverage {
  mandatory: string[];
  covered: string[];
  /** Обязательная категория не представлена в ответе (кандидатов не было/не влезли). */
  uncovered: Array<{ category: string; reason: "no_candidates" | "budget"; ids?: string[] }>;
}

/** Оценочная полная цена (§12.5): карточки + вызовы + чтение + проверка. Эвристика. */
export interface TaskContextCostEstimate {
  cards_tokens: number;
  followup_calls: number;
  reading: Array<{ ref: string; size_bytes: number | null }>;
  reading_bytes_total: number;
  /** Явно оценочная величина (bytes/3), не токены провайдера. */
  note: string;
}

/** Карточка, уже выданная в этой эпохе контекста (компактная форма повтора). */
export interface TaskContextServedEarlier {
  id: string;
  name: string;
  kind: string;
  note: string;
}

/** Секция контекста под задачу в understand-ответе (opt-in task). */
export interface TaskContextView {
  goal: string;
  kind: TaskKind;
  scope_files: string[];
  coverage: TaskContextCoverage;
  /** Живые опоры размещённых решений, включая не найденные поиском (скрытые зависимости). */
  supports_included: Array<{
    node_id: string;
    support_id: string;
    support_name: string;
    rationale: string | null;
    weak?: boolean;
  }>;
  /** Минимальный план чтения: обязательные источники (§12.7), не покрытие файла. */
  reading_plan: Array<{ ref: string; why: string; node_id: string }>;
  cost_estimate: TaskContextCostEstimate;
  /** Повторы эпохи (§12.9) — только с явным context_epoch. */
  served_earlier: TaskContextServedEarlier[];
  /** Смысловые повторы, снятые с верхнего уровня (§12.4). */
  duplicates_dropped: Array<{ id: string; name: string; kind: string; same_summary_as: string }>;
  notes: string[];
}
