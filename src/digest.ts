import { createHash } from "node:crypto";
import type { KnowledgeDB } from "./db.js";
import { isNodeExpired } from "./db.js";
import { embeddingText, embedForStorage } from "./embeddings.js";
import { makeId } from "./tools.js";
import type { NodeRow } from "./types.js";

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

export const DIGEST_MAX_SUMMARY = 800;
export const DIGEST_MAX_FILE_REFS = 10;
export const DIGEST_MIN_CHILDREN = 5;
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

function existingDigest(db: KnowledgeDB, moduleId: string): string | undefined {
  const row = db.execSqlFirst(
    `SELECT id FROM nodes
     WHERE parent_id = ? AND kind = 'digest' AND removed_at IS NULL
     LIMIT 1`,
    moduleId
  ) as { id: string } | undefined;
  return row?.id;
}

// ---- Plan 04 K-08: recorded membership of a digest ----

interface DigestSourceRecord {
  node_id: string;
  version: string | null;
}

interface DigestSourcesEnvelope {
  format: "digest-sources/2";
  module: { id: string; name: string };
  builder: { summary_cap: number; refs_cap: number; child_summary_cap: number; min_children: number };
  sources: DigestSourceRecord[];
}

const DIGEST_CHILD_SUMMARY_CAP = 120;

/** Canonical JSON for the frozen internal envelope; array order is meaningful. */
function canonicalJSON(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item)
    ? item.map(ordered)
    : item !== null && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered((item as Record<string, unknown>)[key])]))
      : item;
  return JSON.stringify(ordered(value));
}

function hasDigestSourcesTable(db: KnowledgeDB): boolean {
  return db.execSqlFirst("SELECT 1 FROM sqlite_master WHERE type='table' AND name='digest_sources'") !== undefined;
}

/** Legacy arrays/unknown formats remain raw historical records, not proof of freshness. */
function readDigestSources(db: KnowledgeDB, digestId: string): unknown {
  if (!hasDigestSourcesTable(db)) return null;
  const row = db.execSqlFirst("SELECT sources, format_version FROM digest_sources WHERE digest_id = ?", digestId) as
    { sources: string; format_version: number } | undefined;
  if (!row || row.format_version !== 2) return null;
  try {
    const parsed: unknown = JSON.parse(row.sources);
    if (!parsed || typeof parsed !== "object" || (parsed as { format?: unknown }).format !== "digest-sources/2") return null;
    return parsed;
  } catch { return null; }
}

/** Invalid legacy refs stay unavailable, never silently filtered into a fresh proof. */
function parsedSourceRefs(child: NodeRow): unknown[] | null | undefined {
  if (child.file_refs === null) return null;
  if (typeof child.file_refs !== "string") return undefined;
  try {
    const refs: unknown = JSON.parse(child.file_refs);
    return Array.isArray(refs) && refs.every((ref) => typeof ref === "string") ? refs : undefined;
  } catch { return undefined; }
}

function sourceVersion(child: NodeRow): string | null {
  const refs = parsedSourceRefs(child);
  if (refs === undefined) return null;
  return createHash("sha256").update("digest-source-v2\n" + JSON.stringify([
    child.name, child.kind, child.summary, refs, child.status ?? "active",
    child.epistemic_status ?? null, child.valid_until ?? null,
  ])).digest("hex");
}

function sourceEnvelope(module: NodeRow, children: NodeRow[]): DigestSourcesEnvelope {
  return {
    format: "digest-sources/2", module: { id: module.id, name: module.name },
    builder: { summary_cap: DIGEST_MAX_SUMMARY, refs_cap: DIGEST_MAX_FILE_REFS,
      child_summary_cap: DIGEST_CHILD_SUMMARY_CAP, min_children: DIGEST_MIN_CHILDREN },
    sources: children.map((child) => ({ node_id: child.id, version: sourceVersion(child) })),
  };
}

function writeDigestSources(db: KnowledgeDB, digestId: string, envelope: DigestSourcesEnvelope): void {
  db.ensureDigestSourcesTable();
  db.execSqlRun(
    `INSERT INTO digest_sources (digest_id, sources, format_version) VALUES (?, ?, 2)
     ON CONFLICT(digest_id) DO UPDATE SET sources = excluded.sources, format_version = 2`,
    digestId, canonicalJSON(envelope)
  );
}

/**
 * K-08: eligible digest sources — live non-digest children that can still
 * back a "current knowledge" summary: lifecycle status active (superseded /
 * deprecated do not republish), epistemic status not refuted/abandoned, and
 * not expired (expiry is computed at read time, on the fresh clock).
 */
export function digestEligibleChildren(db: KnowledgeDB, parentId: string): NodeRow[] {
  return db.getChildren(parentId).filter((c) => {
    if (c.kind === "digest") return false;
    if ((c.status ?? "active") !== "active") return false;
    if (c.epistemic_status === "refuted" || c.epistemic_status === "abandoned") return false;
    if (isNodeExpired(c)) return false;
    return true;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface DigestChild {
  id: string;
  name: string;
  kind: string;
  updated_at: string;
}

/**
 * U4, revised by plan 04 K-08: the source concepts behind a digest — its
 * SIBLINGS in the module (the digest is itself a child of the module),
 * filtered to the same eligibility the build used. stale is derived by
 * content against the RECORDED membership: any id that appeared, disappeared
 * or changed its meaning-version marks the summary out of date — deleting
 * the only source or reparenting it stales the digest even though nobody's
 * timestamp moved. Reading writes nothing.
 */
export function digestSourceChildren(
  db: KnowledgeDB,
  digestId: string
): { children: DigestChild[]; stale: boolean } {
  const digest = db.getNode(digestId);
  if (!digest || digest.kind !== "digest") {
    throw new Error(`Node "${digestId}" is not a digest.`);
  }
  return db.runInTransaction(() => {
    const module = digest.parent_id ? db.getNode(digest.parent_id) : undefined;
    const sources = module ? digestEligibleChildren(db, module.id) : [];
    const children = sources.map((c) => ({ id: c.id, name: c.name, kind: c.kind, updated_at: c.updated_at }));
    const recorded = readDigestSources(db, digestId);
    const current = module ? sourceEnvelope(module, sources) : null;
    const stale = current === null || recorded === null ||
      current.sources.some((source) => source.version === null) ||
      canonicalJSON(recorded) !== canonicalJSON(current);
    return { children, stale };
  });
}

/** Build or refresh the digest of one module. */
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

  // Summary: name — truncated summary per child, capped.
  const parts = children.map(
    (c) => `${c.name} — ${c.summary.replace(/\s+/g, " ").slice(0, DIGEST_CHILD_SUMMARY_CAP)}`
  );
  let summary = `${children.length} concepts: ${parts.join("; ")}`;
  if (summary.length > DIGEST_MAX_SUMMARY) {
    summary = summary.slice(0, DIGEST_MAX_SUMMARY - 1).trimEnd() + "…";
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

/** Modules eligible for a digest: id + active non-digest child count. */
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
}

/** Read-only plan: what rebuildDigests would build. */
export function planDigests(
  db: KnowledgeDB,
  moduleId?: string
): { build: DigestPlanEntry[]; skipped: Array<{ moduleId: string; children: number }> } {
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
  return { build, skipped };
}

/**
 * Rebuild digests for all modules with enough children, or just one module.
 */
export async function rebuildDigests(
  db: KnowledgeDB,
  moduleId?: string,
  opts: { embed?: boolean } = {}
): Promise<{
  built: DigestResult[];
  skipped: Array<{ moduleId: string; children: number }>;
}> {
  const built: DigestResult[] = [];
  const skipped: Array<{ moduleId: string; children: number }> = [];

  for (const { id, children } of scanDigestCandidates(db, moduleId)) {
    if (children < DIGEST_MIN_CHILDREN) {
      skipped.push({ moduleId: id, children });
      continue;
    }
    built.push(await buildDigest(db, id, opts));
  }
  return { built, skipped };
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
