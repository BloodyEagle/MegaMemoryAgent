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
 * read time and never hashed; a legacy digest without a recorded membership
 * falls back to the old timestamp heuristic.
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
  version: string;
}

function hasDigestSourcesTable(db: KnowledgeDB): boolean {
  return (
    db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='digest_sources'"
    ) !== undefined
  );
}

function ensureDigestSourcesTable(db: KnowledgeDB): void {
  db.execSqlRun(`CREATE TABLE IF NOT EXISTS digest_sources (
    digest_id TEXT PRIMARY KEY,
    sources TEXT NOT NULL
  )`);
}

/** null = nothing recorded (legacy digest or missing table) — timestamp fallback. */
function readDigestSources(
  db: KnowledgeDB,
  digestId: string
): DigestSourceRecord[] | null {
  if (!hasDigestSourcesTable(db)) return null;
  const row = db.execSqlFirst(
    "SELECT sources FROM digest_sources WHERE digest_id = ?",
    digestId
  ) as { sources: string } | undefined;
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.sources);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (r): r is DigestSourceRecord =>
        r !== null && typeof r === "object" &&
        typeof (r as DigestSourceRecord).node_id === "string" &&
        typeof (r as DigestSourceRecord).version === "string"
    );
  } catch {
    return null;
  }
}

/**
 * The meaning-version of one source: summary + lifecycle status + epistemic
 * status + valid_until VALUE (expiry itself is computed at read time, never
 * hashed — a clock passage must not require a rewrite). name, parent_id and
 * timestamps are excluded — a rename does not change what the digest says.
 */
function sourceVersion(child: NodeRow): string {
  return createHash("sha1")
    .update(
      [
        child.summary,
        child.status ?? "active",
        child.epistemic_status ?? "",
        child.valid_until ?? "",
      ].join("\n")
    )
    .digest("hex");
}

function writeDigestSources(
  db: KnowledgeDB,
  digestId: string,
  sources: DigestSourceRecord[]
): void {
  ensureDigestSourcesTable(db);
  db.execSqlRun(
    `INSERT INTO digest_sources (digest_id, sources) VALUES (?, ?)
     ON CONFLICT(digest_id) DO UPDATE SET sources = excluded.sources`,
    digestId,
    JSON.stringify(sources)
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
  });
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
  const children = digestEligibleChildren(db, digest.parent_id ?? "").map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    updated_at: c.updated_at,
  }));
  const recorded = readDigestSources(db, digestId);
  let stale: boolean;
  if (recorded === null) {
    // Legacy digest built before the membership table existed: the old
    // timestamp heuristic, honestly weaker than the content comparison.
    stale = children.some((c) => c.updated_at > digest.updated_at);
  } else {
    const currentIds = new Set(children.map((c) => c.id));
    const recordedIds = new Set(recorded.map((r) => r.node_id));
    const sameSet =
      currentIds.size === recordedIds.size &&
      [...currentIds].every((id) => recordedIds.has(id));
    stale =
      !sameSet ||
      children.some((c) => {
        const rec = recorded.find((r) => r.node_id === c.id)!;
        return rec.version !== sourceVersion(db.getNode(c.id)!);
      });
  }
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

  // K-08: only eligible children feed the summary — a refuted/abandoned/
  // superseded/expired source must not be republished as current knowledge
  // through a searchable digest.
  const children = digestEligibleChildren(db, moduleId);
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
  // F-06.3: text and embedding move together — a refreshed digest must not
  // keep the vector of the previous wording. undefined leaves the column
  // untouched (embed: false), null clears it (model disabled → reembed).
  let embedding: Buffer | null | undefined;
  if (!created && opts.embed !== false) {
    embedding = await embedForStorage(db, embeddingText(name, "digest", summary));
  }

  db.runInTransaction(() => {
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
        summary,
        file_refs: refs.length > 0 ? refs : [],
        ...(embedding !== undefined ? { embedding } : {}),
      });
    }
    // F-06.3: keep the native vector copy in sync with the text.
    if (embedding) db.upsertVector(targetId, embedding);

    // K-08: record what this digest was built from — the exact set of
    // sources and their meaning-versions, one atomic write with the node.
    writeDigestSources(
      db,
      targetId,
      children.map((c) => ({ node_id: c.id, version: sourceVersion(c) }))
    );
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
