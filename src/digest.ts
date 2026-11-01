import type { KnowledgeDB } from "./db.js";
import { embeddingText, embedForStorage } from "./embeddings.js";
import { makeId } from "./tools.js";

/**
 * Digest nodes (plan T6): one derived node per module compressing its
 * children into a single payload — an agent reads one digest instead of
 * N child nodes at session start.
 *
 * Summary: "<N> concepts: name1 — summary1; name2 — summary2; …" capped at
 * 800 chars. file_refs: union of children's refs, max 10.
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

export interface DigestChild {
  id: string;
  name: string;
  kind: string;
  updated_at: string;
}

/**
 * U4: the source concepts behind a digest — its SIBLINGS in the module
 * (the digest is itself a child of the module). stale = any source concept
 * was updated after the digest, i.e. the summary may be out of date.
 */
export function digestSourceChildren(
  db: KnowledgeDB,
  digestId: string
): { children: DigestChild[]; stale: boolean } {
  const digest = db.getNode(digestId);
  if (!digest || digest.kind !== "digest") {
    throw new Error(`Node "${digestId}" is not a digest.`);
  }
  const children = db
    .getChildren(digest.parent_id ?? "")
    .filter((c) => c.kind !== "digest" && c.id !== digestId)
    .map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      updated_at: c.updated_at,
    }));
  const stale = children.some((c) => c.updated_at > digest.updated_at);
  return { children, stale };
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

  // Exclude any existing digest — it is a derived node, not a concept.
  const children = db
    .getChildren(moduleId)
    .filter((c) => c.kind !== "digest");
  const name = digestName(module.name);
  const digestId = makeId(name, moduleId);

  // Summary: name — truncated summary per child, capped.
  const parts = children.map(
    (c) => `${c.name} — ${c.summary.replace(/\s+/g, " ").slice(0, 120)}`
  );
  let summary = `${children.length} concepts: ${parts.join("; ")}`;
  if (summary.length > DIGEST_MAX_SUMMARY) {
    summary = summary.slice(0, DIGEST_MAX_SUMMARY - 1).trimEnd() + "…";
  }

  // Union of children's file_refs, max 10.
  const refs: string[] = [];
  for (const child of children) {
    if (!child.file_refs) continue;
    try {
      const parsed = JSON.parse(child.file_refs);
      if (!Array.isArray(parsed)) continue;
      for (const ref of parsed.map(String)) {
        if (!refs.includes(ref)) refs.push(ref);
        if (refs.length >= DIGEST_MAX_FILE_REFS) break;
      }
    } catch {
      // unparsable refs are skipped, not fatal
    }
    if (refs.length >= DIGEST_MAX_FILE_REFS) break;
  }

  const existingId = existingDigest(db, moduleId);
  const created = existingId === undefined;
  const targetId = existingId ?? digestId;

  if (created) {
    const embedding =
      opts.embed === false
        ? null
        : await embedForStorage(db, embeddingText(name, "digest", summary));
    db.insertNode({
      id: targetId,
      name,
      kind: "digest",
      summary,
      why: `Auto-generated digest of "${module.name}" children.`,
      file_refs: refs.length > 0 ? refs : null,
      parent_id: moduleId,
      embedding,
    });
  } else {
    db.updateNode(targetId, {
      summary,
      file_refs: refs.length > 0 ? refs : [],
    });
  }

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
    children: db.getChildren(id).filter((c) => c.kind !== "digest").length,
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
  const children = db.getChildren(parentId).filter((c) => c.kind !== "digest");
  if (children.length < DIGEST_MIN_CHILDREN) return null;
  return buildDigest(db, parentId);
}
