import { createHash } from "node:crypto";
import type { KnowledgeDB } from "./db.js";
import { isNodeExpired } from "./db.js";
import type { NodeRow } from "./types.js";

/**
 * Plan 40 T2: reading a digest's recorded source membership and the eligible
 * source set it is derived from. Moved verbatim out of digest.ts to break the
 * digest ↔ digest-priority cycle: digest-priority only needs these helpers,
 * not the build/plan machinery in digest.ts. No reference to digest-priority
 * or tools — the module stays a leaf (db, types, node:crypto only).
 */

export const DIGEST_MAX_SUMMARY = 800;
export const DIGEST_MAX_FILE_REFS = 10;
export const DIGEST_MIN_CHILDREN = 5;

export interface DigestSourceRecord {
  node_id: string;
  version: string | null;
}

export interface DigestSourcesEnvelope {
  format: "digest-sources/2";
  module: { id: string; name: string };
  builder: { summary_cap: number; refs_cap: number; child_summary_cap: number; min_children: number };
  sources: DigestSourceRecord[];
}

export const DIGEST_CHILD_SUMMARY_CAP = 120;

/** Canonical JSON for the frozen internal envelope; array order is meaningful. */
export function canonicalJSON(value: unknown): string {
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
export function parsedSourceRefs(child: NodeRow): unknown[] | null | undefined {
  if (child.file_refs === null) return null;
  if (typeof child.file_refs !== "string") return undefined;
  try {
    const refs: unknown = JSON.parse(child.file_refs);
    return Array.isArray(refs) && refs.every((ref) => typeof ref === "string") ? refs : undefined;
  } catch { return undefined; }
}

export function sourceVersion(child: NodeRow): string | null {
  const refs = parsedSourceRefs(child);
  if (refs === undefined) return null;
  return createHash("sha256").update("digest-source-v2\n" + JSON.stringify([
    child.name, child.kind, child.summary, refs, child.status ?? "active",
    child.epistemic_status ?? null, child.valid_until ?? null,
  ])).digest("hex");
}

export function sourceEnvelope(module: NodeRow, children: NodeRow[]): DigestSourcesEnvelope {
  return {
    format: "digest-sources/2", module: { id: module.id, name: module.name },
    builder: { summary_cap: DIGEST_MAX_SUMMARY, refs_cap: DIGEST_MAX_FILE_REFS,
      child_summary_cap: DIGEST_CHILD_SUMMARY_CAP, min_children: DIGEST_MIN_CHILDREN },
    sources: children.map((child) => ({ node_id: child.id, version: sourceVersion(child) })),
  };
}

export function writeDigestSources(db: KnowledgeDB, digestId: string, envelope: DigestSourcesEnvelope): void {
  db.ensureDigestSourcesTable();
  db.execSqlRun(
    `INSERT INTO digest_sources (digest_id, sources, format_version) VALUES (?, ?, 2)
     ON CONFLICT(digest_id) DO UPDATE SET sources = excluded.sources, format_version = 2`,
    digestId, canonicalJSON(envelope)
  );
}

export function existingDigest(db: KnowledgeDB, moduleId: string): string | undefined {
  const row = db.execSqlFirst(
    `SELECT id FROM nodes
     WHERE parent_id = ? AND kind = 'digest' AND removed_at IS NULL
     LIMIT 1`,
    moduleId
  ) as { id: string } | undefined;
  return row?.id;
}

/** id of a live parent digest (for digest-priority and diagnostics). */
export function existingDigestId(db: KnowledgeDB, moduleId: string): string | undefined {
  return existingDigest(db, moduleId);
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