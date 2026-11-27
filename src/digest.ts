import type { KnowledgeDB } from "./db.js";
import { embeddingText, embedForStorage } from "./embeddings.js";
import { makeId } from "./tools.js";
import { clipText } from "./text-clip.js";
import { computeDigestPriority } from "./digest-priority.js";
import {
  DIGEST_MAX_SUMMARY,
  DIGEST_MAX_FILE_REFS,
  DIGEST_MIN_CHILDREN,
  DIGEST_CHILD_SUMMARY_CAP,
  canonicalJSON,
  parsedSourceRefs,
  sourceEnvelope,
  writeDigestSources,
  existingDigest,
  existingDigestId,
  digestEligibleChildren,
  digestSourceChildren,
} from "./digest-sources.js";
// Plan 40 T2: the source-membership readers moved verbatim to digest-sources.ts
// (leaf: db/types/node:crypto only) to break the digest ↔ digest-priority cycle.
// Re-exports keep the public names in digest.js for web.ts / tests / external consumers.
export { DIGEST_MAX_SUMMARY, DIGEST_MAX_FILE_REFS, DIGEST_MIN_CHILDREN, existingDigestId, digestEligibleChildren, digestSourceChildren } from "./digest-sources.js";

/**
 * Digest nodes (plan T6): one derived node per module compressing its
 * children into a single payload — an agent reads one digest instead of
 * N child nodes at session start.
 *
 * Summary: "<N> concepts: name1 — summary1; name2 — summary2; …" capped at
 * 800 chars. file_refs: union of children's refs, max 10.
 *
 * Plan 04 K-08 / F-06: the digest knows the exact set of sources it was
 * built from and their meaning-versions (digest_sources, created lazily —
 * no schema bump, same pattern as status_history). staleness is derived by
 * CONTENT: membership differs, or a member's meaning-version moved — not by
 * comparing timestamps of whoever happens to remain. Expiry is computed at
 * read time and never hashed; a legacy digest without a complete format2
 * input envelope stays stale/unknown until rebuilt.
 */

// Search weight for digest nodes lives in search.ts (DIGEST_SEARCH_WEIGHT).

export interface DigestResult {
  moduleId: string;
  digestId: string;
  created: boolean;
  children: number;
}

function digestName(moduleName: string): string {
  return `${moduleName} — digest`;
}

// ---- Plan 04 K-08: recorded membership of a digest ----
// (Readers moved verbatim to src/digest-sources.ts — plan 40 T2.)

/** Build or refresh the digest of one parent. */
export async function buildDigest(
  db: KnowledgeDB,
  moduleId: string,
  opts: { embed?: boolean } = {}
): Promise<DigestResult> {
  const module = db.getNode(moduleId);
  if (!module) {
    throw new Error(`Module "${moduleId}" not found.`);
  }

  // K-08: only eligible children feed the summary — a refuted/abandoned/
  // superseded/expired source must not be republished as current knowledge
  // through a searchable digest.
  const children = digestEligibleChildren(db, moduleId);
  const envelope = sourceEnvelope(module, children);
  const name = digestName(module.name);
  const digestId = makeId(name, moduleId);

  // Summary: name — truncated summary per child, capped. The whitespace
  // normalization stays BEFORE the clip (plan 36 T1): one clipText formula
  // now owns the char cut, the ellipsis and the surrogate guard.
  const parts = children.map((c) => {
    const normalized = c.summary.replace(/\s+/g, " ");
    return `${c.name} — ${clipText(normalized, DIGEST_CHILD_SUMMARY_CAP, { wordBoundary: false })}`;
  });
  let summary = `${children.length} concepts: ${parts.join("; ")}`;
  if (summary.length > DIGEST_MAX_SUMMARY) {
    summary = clipText(summary, DIGEST_MAX_SUMMARY, { wordBoundary: false });
  }

  // Union of children's file_refs, max 10.
  const refs: string[] = [];
  for (const child of children) {
    const parsed = parsedSourceRefs(child);
    if (!parsed) continue;
    for (const ref of parsed as string[]) {
      if (!refs.includes(ref)) refs.push(ref);
      if (refs.length >= DIGEST_MAX_FILE_REFS) break;
    }
    if (refs.length >= DIGEST_MAX_FILE_REFS) break;
  }

  const existingId = existingDigest(db, moduleId);
  const created = existingId === undefined;
  const targetId = existingId ?? digestId;
  // F-06.3: text and embedding move together — a refreshed digest must not
  // keep the vector of the previous wording. undefined leaves the column
  // untouched (embed: false), null clears it (model disabled → reembed).
  let embedding: Buffer | null | undefined;
  if (!created && opts.embed !== false) {
    embedding = await embedForStorage(db, embeddingText(name, "digest", summary));
  }

  db.runInTransaction(() => {
    const currentModule = db.getNode(moduleId);
    if (!currentModule || canonicalJSON(sourceEnvelope(currentModule, digestEligibleChildren(db, moduleId))) !== canonicalJSON(envelope) ||
        existingDigest(db, moduleId) !== existingId) {
      throw new Error("version_conflict: digest inputs changed during build; nothing written.");
    }
    if (created) {
      db.insertNode({
        id: targetId,
        name,
        kind: "digest",
        summary,
        why: `Auto-generated digest of "${module.name}" children.`,
        file_refs: refs.length > 0 ? refs : null,
        parent_id: moduleId,
        embedding: opts.embed === false ? null : (embedding as Buffer | null),
        // 2.1.10 F1: a server write — not an agent node, never a stub subject.
        created_via: "auto",
      });
    } else {
      db.updateNode(targetId, {
        name,
        why: `Auto-generated digest of "${module.name}" children.`,
        summary,
        file_refs: refs.length > 0 ? refs : [],
        ...(embedding !== undefined ? { embedding } : {}),
      });
    }
    // F-06.3: keep the native vector copy in sync with the text.
    if (embedding) db.upsertVector(targetId, embedding);

    // K-08: record what this digest was built from — the exact set of
    // sources and their meaning-versions, one atomic write with the node.
    writeDigestSources(db, targetId, envelope);
  });

  return { moduleId, digestId: targetId, created, children: children.length };
}

/** Parents eligible for a digest: id + active non-digest child count. */
function scanDigestCandidates(
  db: KnowledgeDB,
  moduleId?: string
): Array<{ id: string; children: number }> {
  const ids = moduleId
    ? [moduleId]
    : (db.execSqlAll(
        `SELECT p.id AS id
         FROM nodes p
         JOIN nodes c ON c.parent_id = p.id AND c.removed_at IS NULL
         WHERE p.removed_at IS NULL
         GROUP BY p.id`
      ) as Array<{ id: string }>).map((r) => r.id);
  return ids.map((id) => ({
    id,
    // K-08: the count that would actually be built — eligible sources only.
    children: digestEligibleChildren(db, id).length,
  }));
}

export interface DigestPlanEntry {
  moduleId: string;
  digestId: string;
  created: boolean;
  children: number;
  /** P4.3: счётчики полезности и признак устаревания — только при by_use. */
  use?: DigestUseInfo;
}

export interface DigestUseInfo {
  opened: number;
  opened_error: number;
  used: number;
  issued: number | "unavailable";
  stale_existing: boolean;
}

export interface DigestPlan {
  build: DigestPlanEntry[];
  skipped: Array<{ moduleId: string; children: number }>;
  /** P4.3: остаток ограниченной очереди (после limit) — не теряются молча. */
  queued?: Array<{ moduleId: string; digestId: string; created: boolean; children: number }>;
  /** P4.3: основание порядка (явная полезность или fallback недостатка данных). */
  use_note?: string;
}

/** Опции приоритета P4.3: порядок/ограниченная очередь, eligible-область прежняя. */
export interface DigestPlanOpts {
  /** Сортировать по явной полезности (устаревание → used → opened → issued → id). */
  by_use?: boolean;
  /** Ограниченная очередь: верх приоритета в build, остаток — в queued. */
  limit?: number;
  /** Путь телеметрии J0 для счётчика issued (иначе issued unavailable). */
  telemetry_path?: string | null;
}

/** Числовой вид issued для сортировки; unavailable не смешивается с нулями. */
function issuedRank(v: number | "unavailable"): number {
  return v === "unavailable" ? -1 : v;
}

/**
 * P4.3: построить план с приоритетом по явной полезности. ПОРЯДОК меняется,
 * eligible-область (порог детей, skipped) — нет. При отсутствии достаточных
 * событий — прежний порядок скана (стабильный fallback) с явной пометкой.
 * Детерминизм: равные приоритеты упорядочены по id.
 */
export function planDigests(
  db: KnowledgeDB,
  moduleId?: string,
  planOpts: DigestPlanOpts = {}
): DigestPlan {
  const build: DigestPlanEntry[] = [];
  const skipped: Array<{ moduleId: string; children: number }> = [];
  for (const { id, children } of scanDigestCandidates(db, moduleId)) {
    if (children < DIGEST_MIN_CHILDREN) {
      skipped.push({ moduleId: id, children });
      continue;
    }
    const existing = existingDigest(db, id);
    build.push({
      moduleId: id,
      digestId: existing ?? makeId(`${db.getNode(id)?.name ?? id} — digest`, id),
      created: existing === undefined,
      children,
    });
  }
  if (!planOpts.by_use) {
    return { build, skipped };
  }

  // Один проход телеметрии на весь план: computeUseCounters читает журнал
  // раз на вызов, приоритет собирается из готовых счётчиков.
  const withUse = build.map((entry) => {
    const priority = computeDigestPriority(db, entry.moduleId, {
      telemetry_path: planOpts.telemetry_path,
    });
    return { ...entry, use: { ...priority.counters, stale_existing: priority.stale_existing } };
  });
  const anyEvents = withUse.some(
    (e) => e.use.opened > 0 || e.use.used > 0 || (typeof e.use.issued === "number" && e.use.issued > 0)
  );
  const ordered = anyEvents
    ? [...withUse].sort((a, b) => {
        // Устаревание контента сначала, затем явная полезность; равные — по id.
        const stale = (b.use.stale_existing ? 1 : 0) - (a.use.stale_existing ? 1 : 0);
        if (stale !== 0) return stale;
        if (b.use.used !== a.use.used) return b.use.used - a.use.used;
        if (b.use.opened !== a.use.opened) return b.use.opened - a.use.opened;
        const issued = issuedRank(b.use.issued) - issuedRank(a.use.issued);
        if (issued !== 0) return issued;
        return a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0;
      })
    : withUse;
  const useNote = anyEvents
    ? "порядок по событиям явной полезности: устаревшие дайджесты первее, затем области с явным использованием/открытиями; issued учитывается только там, где включена телеметрия J0"
    : "недостаточно событий использования (открытий/использований в журнале нет) — прежний порядок (fallback), приоритет не применялся";
  const limit = planOpts.limit !== undefined && planOpts.limit >= 1 ? Math.floor(planOpts.limit) : undefined;
  if (limit !== undefined && ordered.length > limit) {
    return {
      build: ordered.slice(0, limit),
      skipped,
      queued: ordered.slice(limit).map((e) => ({
        moduleId: e.moduleId,
        digestId: e.digestId,
        created: e.created,
        children: e.children,
      })),
      use_note: useNote,
    };
  }
  return { build: ordered, skipped, use_note: useNote };
}

/**
 * Rebuild digests for all parents with enough eligible children, or just one parent.
 * P4.3: with by_use — строит по приоритетной очереди planDigests (ОДИН
 * расчёт кандидатов и для preview, и для apply); остаток limit — в queued.
 */
export async function rebuildDigests(
  db: KnowledgeDB,
  moduleId?: string,
  opts: { embed?: boolean } & DigestPlanOpts = {}
): Promise<{
  built: DigestResult[];
  skipped: Array<{ moduleId: string; children: number }>;
  queued?: Array<{ moduleId: string; digestId: string; created: boolean; children: number }>;
  use_note?: string;
}> {
  const plan = planDigests(db, moduleId, {
    ...(opts.by_use ? { by_use: true } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.telemetry_path !== undefined ? { telemetry_path: opts.telemetry_path } : {}),
  });
  const built: DigestResult[] = [];
  for (const entry of plan.build) {
    built.push(await buildDigest(db, entry.moduleId, { embed: opts.embed }));
  }
  return {
    built,
    skipped: plan.skipped,
    ...(plan.queued ? { queued: plan.queued } : {}),
    ...(plan.use_note ? { use_note: plan.use_note } : {}),
  };
}

/**
 * P4.3: единое правило диагностики (doctor) и плана — родители с достаточным
 * числом ELIGIBLE детей и без живого дайджеста. Правило количества детей не
 * размножается: doctor вызывает этот расчёт вместо собственного SQL.
 */
export function digestPendingParents(
  db: KnowledgeDB
): Array<{ moduleId: string; children: number }> {
  const pending: Array<{ moduleId: string; children: number }> = [];
  for (const { id, children } of scanDigestCandidates(db)) {
    if (children >= DIGEST_MIN_CHILDREN && existingDigest(db, id) === undefined) {
      pending.push({ moduleId: id, children });
    }
  }
  return pending;
}

/**
 * Auto-digest hook for createConcept (plan T6): builds the parent's digest
 * when it reached DIGEST_MIN_CHILDREN active non-digest children and has no
 * digest yet. Controlled by MEGAMEMORY_AUTO_DIGEST (default on).
 */
export async function maybeAutoDigest(
  db: KnowledgeDB,
  parentId: string | null
): Promise<DigestResult | null> {
  if (process.env.MEGAMEMORY_AUTO_DIGEST === "0") return null;
  if (!parentId || !db.nodeExists(parentId)) return null;
  if (existingDigest(db, parentId) !== undefined) return null;
  const children = digestEligibleChildren(db, parentId);
  if (children.length < DIGEST_MIN_CHILDREN) return null;
  return buildDigest(db, parentId);
}
