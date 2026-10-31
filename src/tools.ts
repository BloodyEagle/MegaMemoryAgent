import { KnowledgeDB } from "./db.js";
import { createHash } from "node:crypto";
import {
  embed,
  embeddingText,
  embedForStorage,
  findTopK,
  queryText,
  vectorSearchEnabled,
} from "./embeddings.js";
import { basicSearch, hybridSearch, type SearchVia } from "./search.js";
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
  UnderstandMeta,
  NodeRow,
  RelationType,
} from "./types.js";
import { stripMergeSuffix } from "./merge.js";

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
 * Parse file_refs from JSON string to array.
 */
function parseFileRefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build a NodeWithContext from a node row and DB lookups.
 */
export function buildNodeWithContext(
  db: KnowledgeDB,
  node: NodeRow,
  similarity?: number
): NodeWithContext {
  const children = db.getChildren(node.id).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind as NodeWithContext["kind"],
    summary: c.summary,
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
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

// ---- Tool handlers ----

/**
 * Conservative token estimate: ~3 chars per token. Cyrillic/CJK encode
 * worse than English in most tokenizers, so this stays on the safe side.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
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

/** Compact per-node payload (plan T3): no why, trimmed summary. */
function compactMatch(
  db: KnowledgeDB,
  node: NodeRow,
  opts: { score?: number; via?: SearchVia; withContext: boolean }
): CompactMatch {
  const fileRefs = parseFileRefs(node.file_refs);
  const match: CompactMatch = {
    id: node.id,
    name: node.name,
    kind: node.kind as CompactMatch["kind"],
    status: node.status ?? "active",
    summary: trimSummary(node.summary),
    file_refs: fileRefs,
    ...(opts.score !== undefined
      ? { score: opts.score, similarity: opts.score }
      : {}),
    ...(opts.via ? { via: opts.via } : {}),
  };
  if (opts.withContext) {
    match.children = db
      .getChildren(node.id)
      .map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind as CompactMatch["kind"],
      }));
    match.edges = db
      .getOutgoingEdges(node.id)
      .map((e) => ({
        to: e.to_id,
        to_name: e.to_name,
        relation: e.relation as RelationType,
      }));
  }
  return match;
}

export async function understand(
  db: KnowledgeDB,
  input: UnderstandInput
): Promise<UnderstandOutput> {
  const topK = input.top_k ?? 10;
  const maxTokens = input.max_tokens ?? 1500;
  const outputMode = input.mode ?? "compact";

  // Search mode (plan T2): hybrid by default — RRF over FTS + vector.
  // Vector-only runs when MEGAMEMORY_SEARCH=vector; text-only for fts, or
  // when vectors are disabled (model mismatch pending reembed).
  const mode = process.env.MEGAMEMORY_SEARCH ?? "hybrid";
  let topMatches: Array<{ id: string; similarity: number }>;
  const viaById = new Map<string, SearchVia>();

  if (mode === "hybrid") {
    const hits = await hybridSearch(db, input.query, { topK });
    topMatches = hits.map((h) => ({ id: h.id, similarity: h.score }));
    for (const h of hits) viaById.set(h.id, h.via);
  } else if (mode === "vector" && vectorSearchEnabled(db)) {
    const candidates = db.getAllActiveNodesWithEmbeddings();
    if (candidates.length === 0) {
      return { matches: [], compact: [], meta: { returned: 0, dropped: 0, tokens_estimated: 0 } };
    }
    const queryEmbedding = await embed(queryText(input.query));
    topMatches = findTopK(queryEmbedding, candidates, topK);
  } else {
    topMatches = basicSearch(db, input.query, topK);
  }

  // T4 will filter superseded/deprecated here unless include_inactive.

  // Resolve nodes once, in rank order. T4: superseded/deprecated nodes are
  // hidden by default (include_inactive: true shows them with their status).
  const includeInactive = input.include_inactive ?? false;
  const nodes: Array<{ node: NodeRow; score: number; via?: SearchVia }> = [];
  for (const match of topMatches) {
    const node = db.getNode(match.id);
    if (!node) continue;
    const status = node.status ?? "active";
    if (!includeInactive && status !== "active") continue;
    nodes.push({ node, score: match.similarity, via: viaById.get(match.id) });
  }

  if (outputMode === "full") {
    const matches: NodeWithContext[] = [];
    for (const { node, score, via } of nodes) {
      const ctx = buildNodeWithContext(db, node, score);
      if (via) ctx.via = via;
      matches.push(ctx);
    }
    const payload = JSON.stringify(matches);
    db.insertUsage({
      tool: "understand",
      query: input.query,
      nodes: matches.length,
      returnedChars: payload.length,
      returnedTokens: estimateTokens(payload),
    });
    return {
      matches,
      compact: undefined,
      meta: {
        returned: matches.length,
        dropped: 0,
        tokens_estimated: estimateTokens(payload),
      },
    };
  }

  // compact: keep adding nodes while the serialized result fits the budget.
  // First 3 nodes get children+edges; the rest stay bare.
  const compact: CompactMatch[] = [];
  let tokensEstimated = 0;
  for (let i = 0; i < nodes.length; i++) {
    const candidate = compactMatch(db, nodes[i].node, {
      score: nodes[i].score,
      via: nodes[i].via,
      withContext: compact.length < 3,
    });
    const projection = {
      matches: [],
      compact: [...compact, candidate],
      meta: { returned: compact.length + 1, dropped: 0, tokens_estimated: 0 },
    };
    const projected = estimateTokens(JSON.stringify(projection));
    // Always return at least one node, budget or not.
    if (compact.length > 0 && projected > maxTokens) {
      const dropped = nodes.length - compact.length;
      return {
        matches: [],
        compact,
        meta: {
          returned: compact.length,
          dropped,
          tokens_estimated: tokensEstimated,
        },
      };
    }
    compact.push(candidate);
    tokensEstimated = projected;
  }

  const payload = JSON.stringify({ compact, meta: { returned: compact.length, dropped: 0, tokens_estimated: tokensEstimated } });
  db.insertUsage({
    tool: "understand",
    query: input.query,
    nodes: compact.length,
    returnedChars: payload.length,
    returnedTokens: tokensEstimated,
  });

  return {
    matches: [],
    compact,
    meta: {
      returned: compact.length,
      dropped: 0,
      tokens_estimated: tokensEstimated,
    },
  };
}

export function getConcept(
  db: KnowledgeDB,
  input: GetConceptInput
): NodeWithContext {
  const node = db.getNode(input.id);
  if (!node) {
    throw new Error(`Concept "${input.id}" not found.`);
  }
  const ctx = buildNodeWithContext(db, node);
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

export async function createConcept(
  db: KnowledgeDB,
  input: CreateConceptInput
): Promise<{ id: string; message: string }> {
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("Concept name must be a non-empty string.");
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

  // Generate embedding (null when the vector path is disabled pending reembed)
  const text = embeddingText(input.name, input.kind, input.summary);
  const embedding = await embedForStorage(db, text);

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
    },
    (input.edges ?? []).map((edge) => ({
      to_id: edge.to,
      relation: edge.relation,
      description: edge.description ?? null,
    }))
  );

  // T4: mark replaced concepts — edges new--supersedes-->old, old nodes
  // become superseded with valid_until = now.
  let supersededNote = "";
  if (input.supersedes && input.supersedes.length > 0) {
    const { superseded, missing } = db.supersedeNodes(id, input.supersedes);
    if (missing.length > 0) {
      throw new Error(
        `Created "${id}", but supersedes targets not found: ${missing.join(", ")}. ` +
          `Superseded: ${superseded.join(", ") || "none"}.`
      );
    }
    supersededNote = ` Superseded: ${superseded.join(", ")}.`;
  }

  return { id, message: `Created concept "${id}"${supersededNote}` };
}

export async function updateConcept(
  db: KnowledgeDB,
  input: UpdateConceptInput
): Promise<{ message: string }> {
  // Verify node exists
  const existing = db.getNode(input.id);
  if (!existing) {
    throw new Error(`Concept "${input.id}" not found.`);
  }

  // If summary or name changed, regenerate embedding (skip when the vector
  // path is disabled pending reembed — reembed will fill it in)
  let embedding: Buffer | undefined;
  if (input.changes.summary !== undefined || input.changes.name !== undefined) {
    const name = input.changes.name ?? existing.name;
    const kind = input.changes.kind ?? existing.kind;
    const summary = input.changes.summary ?? existing.summary;
    const text = embeddingText(name, kind, summary);
    embedding = (await embedForStorage(db, text)) ?? undefined;
  }

  const updated = db.updateNode(input.id, {
    ...input.changes,
    embedding,
  });

  if (!updated) {
    return { message: `No changes applied to "${input.id}"` };
  }

  return { message: `Updated concept "${input.id}"` };
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

  const removed = db.softDeleteNode(input.id, input.reason);
  if (!removed) {
    throw new Error(`Failed to remove concept "${input.id}".`);
  }

  // T4: soft-delete also deprecates the lifecycle status.
  db.setNodeStatus(input.id, "deprecated");

  return {
    message: `Removed concept "${input.id}". Reason: ${input.reason}`,
  };
}

export function listRoots(
  db: KnowledgeDB,
  input: ListRootsInput = {}
): ListRootsOutput & { hint?: string } {
  const maxTokens = input.max_tokens ?? 1500;
  const rootRows = db.getRootNodes();

  const stats = db.getStats();
  const hint =
    stats.nodes === 0
      ? "Graph is empty. Run /user:bootstrap-memory to populate, or create concepts as you work."
      : undefined;

  // Budgeted overview (plan T3): id/name/kind + child count, no summary.
  const rootsCompact = rootRows.map((root) => ({
    id: root.id,
    name: root.name,
    kind: root.kind as NodeWithContext["kind"],
    child_count: db.getChildren(root.id).length,
  }));
  const compactProjection = JSON.stringify({
    roots_compact: rootsCompact,
    ...(hint ? { hint } : {}),
  });
  if (estimateTokens(compactProjection) <= maxTokens) {
    db.insertUsage({
      tool: "list_roots",
      query: null,
      nodes: rootsCompact.length,
      returnedChars: compactProjection.length,
      returnedTokens: estimateTokens(compactProjection),
    });
    return {
      roots: [],
      compact: true,
      roots_compact: rootsCompact,
      ...(hint ? { hint } : {}),
      meta: {
        returned: rootsCompact.length,
        dropped: 0,
        tokens_estimated: estimateTokens(compactProjection),
      },
    };
  }

  // Legacy verbose shape when the compact overview alone busts the budget —
  // trim the list, never return nothing.
  const roots = rootRows.map((root) => {
    const children = db.getChildren(root.id).map((c) => c.name);
    return {
      id: root.id,
      name: root.name,
      kind: root.kind as NodeWithContext["kind"],
      summary: root.summary,
      children,
    };
  });

  return { roots, ...(hint ? { hint } : {}) };
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

  if (conflictNodes.length === 0) {
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

  return { conflicts, contradicted };
}

export async function resolveConflict(
  db: KnowledgeDB,
  input: ResolveConflictInput
): Promise<{ message: string }> {
  const nodes = db.getNodesByMergeGroup(input.merge_group);

  if (nodes.length === 0) {
    throw new Error(`No nodes found with merge_group: ${input.merge_group}`);
  }

  // Prefer an active (non-removed) node as the base so the resolved concept
  // stays active for removal conflicts. Fall back to first node.
  const base = nodes.find((n) => n.removed_at === null) ?? nodes[0];
  const originalId = stripMergeSuffix(base.id);

  const text = embeddingText(base.name, base.kind, input.resolved.summary);
  const newEmbedding = await embedForStorage(db, text);

  const changes: { summary?: string; why?: string; file_refs?: string[] } = {
    summary: input.resolved.summary,
  };
  if (input.resolved.why !== undefined) changes.why = input.resolved.why;
  if (input.resolved.file_refs !== undefined) changes.file_refs = input.resolved.file_refs;

  db.runInTransaction(() => {
    // Delete all conflict copies except the base
    for (const node of nodes) {
      if (node.id !== base.id) {
        db.hardDeleteNode(node.id);
      }
    }

    // Rename the base back to the original clean ID
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

    // Clear merge flags on the resolved node and any associated edges
    db.clearNodeMergeFlags(originalId);
    db.clearEdgeMergeFlagsByGroup(input.merge_group);
  });

  return {
    message: `Resolved "${originalId}". Reason: ${input.reason}`,
  };
}
