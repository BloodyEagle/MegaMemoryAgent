import { KnowledgeDB } from "./db.js";
import { createHash } from "node:crypto";
import {
  cosineSimilarity,
  embed,
  embeddingText,
  embedForStorage,
  findTopK,
  queryText,
  vectorSearchEnabled,
} from "./embeddings.js";
import { basicSearch, ftsSearch, hybridSearch, type SearchVia } from "./search.js";
import { normalizeName } from "./norm.js";
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
  CurrentDigestsView,
  NodeRow,
  RelationType,
} from "./types.js";
import { stripMergeSuffix } from "./merge.js";
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
import { artifactsDigestOf } from "./artifacts.js";
import { STUB_CHECK_KINDS, STUB_REJECTION_MESSAGE, isStubSummary } from "./stub.js";

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

/** Plan 1: status_scope is stored as a JSON string; unparseable = no scope. */
function parseStatusScope(raw: string | null | undefined): Record<string, unknown> | null {
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

/**
 * Validate an agent-driven epistemic transition. Throws with a human-readable
 * message on an illegal move; `validated` additionally requires a scope with
 * an artifact (an agent confirming a fact by itself is circular validation).
 */
export function validateEpistemicTransition(
  from: EpistemicStatus | null,
  to: EpistemicStatus,
  scope?: Record<string, unknown>
): void {
  if (from === to) return; // rewrite with a new reason/scope is a no-op
  const allowed = from === null ? ["validated", "refuted", "abandoned"] : EPISTEMIC_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid epistemic transition: ${from ?? "unknown"} -> ${to}. ` +
        `Allowed from ${from ?? "unknown"}: ${allowed.join(", ")}.`
    );
  }
  if (to === "validated") {
    const artifact = scope && typeof scope === "object" ? (scope as { artifact?: unknown }).artifact : undefined;
    if (!scope || typeof scope !== "object" || !artifact) {
      throw new Error(
        `epistemic_status "validated" requires status_scope with an "artifact" ` +
          `(id of the test/benchmark run that confirms it). Without an external ` +
          `artifact the agent would be confirming its own claim.`
      );
    }
  }
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
    epistemic_status: node.epistemic_status ?? null,
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
  // Plan 1 §5.3: refuted nodes are the conscious exception — they bypass the
  // filter and go to a separate output block, because antiknowledge ("where
  // we went wrong") must never disappear behind include_inactive.
  const includeInactive = input.include_inactive ?? false;
  const nodes: Array<{ node: NodeRow; score: number; via?: SearchVia }> = [];
  const refutedNodes: Array<{ node: NodeRow; score: number; via?: SearchVia }> = [];
  for (const match of topMatches) {
    const node = db.getNode(match.id);
    if (!node) continue;
    if ((node.epistemic_status ?? null) === "refuted") {
      refutedNodes.push({ node, score: match.similarity, via: viaById.get(match.id) });
      continue;
    }
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
    const refuted = refutedNodes.map(({ node, score, via }) => {
      const ctx = buildNodeWithContext(db, node, score);
      if (via) ctx.via = via;
      return ctx;
    });
    const payload = JSON.stringify({ matches, refuted });
    db.insertUsage({
      tool: "understand",
      query: input.query,
      nodes: matches.length,
      returnedChars: payload.length,
      returnedTokens: estimateTokens(payload),
      estimatedFullTokens: estimateTokens(payload), // full mode IS the full cost
    });
    return {
      matches,
      compact: undefined,
      refuted,
      meta: {
        returned: matches.length,
        dropped: 0,
        tokens_estimated: estimateTokens(payload),
      },
    };
  }

  // compact: keep adding nodes while the serialized result fits the budget.
  // First 3 nodes get children+edges; the rest stay bare.
  // В15: the would-be full-mode cost for the same hits, measured once.
  const fullProjection = nodes.map(({ node }) => buildNodeWithContext(db, node));
  const estimatedFullTokens = estimateTokens(JSON.stringify(fullProjection));

  // Plan 1 §5.3: separate "refuted" block, marked and with the reason —
  // these are not facts and must not blend into the match list. Built before
  // the budget loop so the early-return below still carries it.
  const refuted = refutedNodes.map(({ node, score, via }) =>
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

  const candidateIds = new Set(nodes.map((n) => n.node.id));
  const nodeRowById = new Map(nodes.map((n) => [n.node.id, n.node]));
  // Live informed_by supports of every candidate that are candidates too.
  const supportIdsOf = new Map<string, string[]>();
  for (const { node } of nodes) {
    supportIdsOf.set(
      node.id,
      db
        .getInformedByEdges(node.id, "ancestry", false)
        .map((e) => e.to_id)
        .filter((sid) => sid !== node.id && candidateIds.has(sid))
    );
  }

  const top: CompactMatch[] = [];
  let nestedByHost = new Map<string, Array<{ id: string; name: string; summary: string }>>();
  let foldedIds = new Set<string>();

  /** The answer's top level: placed candidates minus the folded ones. */
  const displayList = (): CompactMatch[] => top.filter((m) => !foldedIds.has(m.id));

  /** Display list with the folded supports attached — the serialized shape. */
  const withNested = (list: CompactMatch[]): CompactMatch[] =>
    list.map((m) =>
      nestedByHost.has(m.id) ? { ...m, supports: nestedByHost.get(m.id) } : m
    );

  /** Same projection convention the budget loop always used. */
  const projectionTokens = (): number =>
    estimateTokens(
      JSON.stringify({
        matches: [],
        compact: withNested(displayList()),
        meta: { returned: displayList().length, dropped: 0, tokens_estimated: 0 },
      })
    );

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
   */
  const foldSupports = (): number => {
    const inTop = new Set(top.map((m) => m.id));
    const foldSet = new Set<string>();
    for (const h of top) {
      for (const sid of supportIdsOf.get(h.id) ?? []) {
        if (sid !== h.id && inTop.has(sid)) foldSet.add(sid);
      }
    }
    const nextNested = new Map<string, Array<{ id: string; name: string; summary: string }>>();
    for (const sup of top) {
      if (!foldSet.has(sup.id)) continue;
      const row = nodeRowById.get(sup.id);
      if (!row) continue;
      for (const h of top) {
        if (h.id === sup.id || foldSet.has(h.id)) continue;
        if (supportIdsOf.get(h.id)?.includes(sup.id)) {
          const bucket = nextNested.get(h.id) ?? [];
          bucket.push({ id: sup.id, name: row.name, summary: trimSummary(row.summary) });
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
  let idx = 0;

  // Phase A — the plain top-level fill, unchanged: the first node always
  // fits, the rest stop at the budget. The cut index is remembered instead
  // of returning early: folding can free a slot for the tail (F2).
  for (; idx < nodes.length; idx++) {
    const candidate = compactMatch(db, nodes[idx].node, {
      score: nodes[idx].score,
      via: nodes[idx].via,
      withContext: displayList().length < 3,
    });
    top.push(candidate);
    const projected = projectionTokens();
    // Always return at least one node, budget or not.
    if (displayList().length > 1 && projected > maxTokens) {
      top.pop();
      break; // idx stays on the unplaced candidate
    }
    tokensEstimated = projected;
  }

  // Phase B — fold supports whose decision made the answer.
  if (foldSupports() > 0) tokensEstimated = projectionTokens();

  // Phase C — a folded support freed its top_k slot: refill from where the
  // budget stopped (top_k stays filled by the top level, not by the fold).
  // Every newly placed node can fold its own supports; the loop resumes at
  // the same index after each fold until the budget is full again.
  while (idx < nodes.length) {
    if (foldedIds.has(nodes[idx].node.id)) {
      idx += 1; // already in the answer, nested
      continue;
    }
    const candidate = compactMatch(db, nodes[idx].node, {
      score: nodes[idx].score,
      via: nodes[idx].via,
      withContext: displayList().length < 3,
    });
    top.push(candidate);
    const projected = projectionTokens();
    if (projected > maxTokens) {
      top.pop();
      break; // budget full again
    }
    idx += 1;
    tokensEstimated = projected;
    if (foldSupports() > 0) tokensEstimated = projectionTokens();
  }

  const compact = withNested(displayList());
  const dropped = nodes.length - top.length;
  const supportsInlined = foldedIds.size;

  const payload = JSON.stringify({
    compact,
    refuted,
    meta: { returned: compact.length, dropped: 0, tokens_estimated: tokensEstimated },
  });
  db.insertUsage({
    tool: "understand",
    query: input.query,
    nodes: compact.length,
    returnedChars: payload.length,
    returnedTokens: tokensEstimated,
    estimatedFullTokens,
  });

  // В14: relations between the returned nodes only.
  const ids = compact.map((m) => m.id);
  const edgesBetween =
    ids.length >= 2
      ? (db.execSqlAll(
          `SELECT DISTINCT from_id, to_id, relation FROM edges
           WHERE removed_at IS NULL
             AND from_id IN (${ids.map(() => "?").join(",")})
             AND to_id IN (${ids.map(() => "?").join(",")})`,
          ...ids,
          ...ids
        ) as Array<{ from_id: string; to_id: string; relation: string }>).map(
          (e) => ({ from: e.from_id, to: e.to_id, relation: e.relation })
        )
      : [];

  return {
    matches: [],
    compact,
    refuted,
    edges_between: edgesBetween,
    meta: {
      returned: compact.length,
      dropped,
      tokens_estimated: tokensEstimated,
      estimated_full_tokens: estimatedFullTokens,
      supports_inlined: supportsInlined,
    },
  };
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
 * 2.1.7 F1: the current digests of one node — computed from live exports of
 * support-baselines, never re-hashed here. A confirmed node reports its
 * snapshot claim (source: "snapshot"): the confirmation belongs to the
 * wording it was made on, and a stale value refusing confirm_supports IS the
 * divergence signal. status has no node-level snapshot — always current.
 */
function currentDigestsOf(node: NodeRow): CurrentDigestsView {
  const snapshotClaim = node.claim_digest ?? null;
  return {
    claim: snapshotClaim ?? claimDigestOf(node.summary),
    status: statusDigestOf(node.status, node.epistemic_status),
    format_version: BASELINE_FORMAT_VERSION,
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

export async function createConcept(
  db: KnowledgeDB,
  input: CreateConceptInput
): Promise<{ id: string; message: string }> {
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("Concept name must be a non-empty string.");
  }

  // 2.1.9 F2: a stub summary is refused before anything is planned — a fake
  // support is worse than a missing one because it reads as confirmation in
  // stats and weak_links. allow_stub is the conscious bypass: the node is
  // written with epistemic_status = "stub" and stays visible as a weak link.
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
      supports.push({ toId: item.node, why, fromAutoGround: false });
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
        supports.push({ toId: found.id, why, fromAutoGround: false });
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
  for (const s of supports) {
    if (!s.fromAutoGround) confirmableSupportIds.add(s.toId);
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

  db.runInTransaction(() => {
    for (const fact of factNodesToCreate) {
      db.insertNode({
        id: fact.id,
        name: fact.name,
        kind: "feature",
        summary: `File-fact node for "${fact.name}" — created as a provenance support.`,
        file_refs: [fact.name],
        embedding: fact.embedding,
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
          support_id: e.other_id,
          edge_key: String(e.id),
          claim_digest: claimDigestOf(support.summary),
          status_digest: statusDigestOf(support.status, support.epistemic_status),
          edge_digest: edgeDigestOf(e.description),
          format_version: BASELINE_FORMAT_VERSION,
          confirmed_at: now,
          confirmed_by: "agent",
          // 2.1.3 F2: the confirmed artifacts state at the moment of the call.
          artifacts_digest: artifactsDigestOf(db.getNodeArtifacts(e.other_id)),
        };
        // 2.1.3 F1: the journal is written where the snapshot is written —
        // this carve-out is a first confirmation, so it opens the chain with
        // the agent/confirmed entry, in the same transaction.
        journalSnapshotWrite(db, row, now);
        db.upsertSupportBaseline(row);
      }
    }
  });
  if (embedding) {
    // В17: keep the native vector copy in sync.
    db.upsertVector(id, embedding);
  }

  // В16: warn (never block) when a near-duplicate already exists — cheaper
  // than cleaning up afterwards with consolidate.
  const duplicateNote = findDuplicateNote(db, {
    id,
    name: input.name,
    embedding,
  });

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

  return {
    id,
    message: `Created concept "${id}"${supersededNote}${duplicateNote}${supportNote}${autoNote}${confirmNote}`,
  };
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

  // Plan 1 §5.2: epistemic transitions are validated here, at the MCP tool
  // boundary (not inside setNodeStatus/setEpistemicStatus — internal callers
  // like soft-delete and merge must never be blocked). reason is mandatory
  // together with epistemic_status; validated additionally requires a scope
  // with an artifact.
  let scope: Record<string, unknown> | undefined;
  if (input.changes.epistemic_status !== undefined) {
    if (!input.changes.epistemic_reason || input.changes.epistemic_reason.trim().length === 0) {
      throw new Error(
        `Changing epistemic_status requires a non-empty "epistemic_reason" — every transition is recorded in status_history.`
      );
    }
    scope = input.changes.status_scope;
    validateEpistemicTransition(
      (existing.epistemic_status ?? null) as EpistemicStatus | null,
      input.changes.epistemic_status,
      scope
    );
  } else if (input.changes.epistemic_reason !== undefined) {
    throw new Error(`"epistemic_reason" without "epistemic_status" is a no-op — pass both or neither.`);
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

  if (updated && embedding) {
    // В17: keep the native vector copy in sync.
    db.upsertVector(input.id, embedding);
  }

  if (!updated && input.changes.epistemic_status === undefined) {
    return { message: `No changes applied to "${input.id}"` };
  }

  // Plan 1: the epistemic write happens after the content update so a failed
  // transition validation above never leaves a half-applied epistemic change.
  let epistemicNote = "";
  if (input.changes.epistemic_status !== undefined) {
    db.setEpistemicStatus(
      input.id,
      input.changes.epistemic_status,
      input.changes.epistemic_reason!,
      scope ?? null
    );
    epistemicNote = ` Epistemic status: ${input.changes.epistemic_status}.`;
  }

  return { message: `Updated concept "${input.id}".${epistemicNote}` };
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
  // Plan 2 §2/§3: role slots go FIRST in the startup digest, then the top-5
  // of the task board by rot — the burning, not the fresh.
  const slots = db.listSlots("").map((s) => ({
    role: s.role,
    node_id: s.node_id,
    node_name: s.node_name,
  }));
  const boardTop = computeBoard(db).columns.find((c) => c.name === "open")!.cards.slice(0, 5);
  const compactProjection = JSON.stringify({
    slots,
    board_top: boardTop,
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
      slots,
      board_top: boardTop,
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
    if (newEmbedding) {
      // В17: keep the native vector copy in sync.
      db.upsertVector(originalId, newEmbedding);
    }

    // Б10: lifecycle merge rule — superseded/deprecated beats active,
    // skipped on legacy dbs without the status column.
    // valid_until is the later of the versions in the group.
    // Б10: lifecycle merge rule — superseded/deprecated beats active,
    // valid_until is the later of the versions. Skipped on legacy dbs
    // without the status column (merge flags below are cleared regardless).
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
export function computeBoard(db: KnowledgeDB): BoardOutput {
  const openTasks = db.getOpenTasks().map((t) => {
    const { rot, overdue } = taskRot(t);
    return { id: t.id, name: t.name, rot, due_at: t.due_at, overdue };
  });
  openTasks.sort((a, b) => b.rot - a.rot);

  const doneTasks = db.getDoneTasks().map((t) => ({
    id: t.id,
    name: t.name,
  }));

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
      count: doneTasks.length,
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
 * Per-member state of a saved chain, evaluated at read time (plan 2 §1): a
 * member whose fingerprint no longer matches makes the chain `stale`; a
 * member that no longer exists at all makes it `broken` — nothing to refresh.
 */
export function trailMemberStates(
  db: KnowledgeDB,
  trailId: string
): TrailMemberView[] {
  return db.getTrailMembers(trailId).map((m) => {
    const node = db.getNodeIncludingRemoved(m.node_id);
    const view: TrailMemberView = {
      position: m.position,
      node_id: m.node_id,
      node_name: node?.name ?? null,
      fingerprint_at_save: m.fingerprint,
      fingerprint_now: null,
      state: "fresh",
      reason: null,
    };
    if (!node) {
      view.state = "broken";
      view.reason = `member "${m.node_id}" was hard-deleted — the chain is broken, only a rebuild helps`;
      return view;
    }
    if (node.removed_at) {
      view.state = "stale";
      view.reason = `member "${m.node_id}" was removed (${node.removed_reason ?? "no reason recorded"})`;
      return view;
    }
    const now = db.nodeFingerprint(m.node_id);
    view.fingerprint_now = now;
    if (now !== m.fingerprint) {
      view.state = "stale";
      view.reason = `member "${m.node_id}" meaning changed since the chain was saved (summary, epistemic status or informed_by)`;
    }
    return view;
  });
}

/** Whole-chain state: broken beats stale beats fresh. */
export function trailState(db: KnowledgeDB, trailId: string): TrailView["state"] {
  const members = trailMemberStates(db, trailId);
  if (members.some((m) => m.state === "broken")) return "broken";
  if (members.some((m) => m.state === "stale")) return "stale";
  return "fresh";
}

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

export function trailGet(db: KnowledgeDB, id: string): TrailView {
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
  return {
    id: trail.id,
    name: trail.name,
    summary: trail.summary,
    state,
    members,
  };
}

export function trailRefresh(db: KnowledgeDB, id: string): { message: string } {
  const trail = db.getTrail(id);
  if (!trail) {
    throw new Error(`Trail "${id}" not found.`);
  }
  db.refreshTrailFingerprints(id);
  return { message: `Trail "${id}" refreshed: fingerprints re-snapshotted, chain is fresh.` };
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

export function board(db: KnowledgeDB): BoardOutput & { summary: string } {
  const output = computeBoard(db);
  const openCol = output.columns.find((c) => c.name === "open")!;
  return {
    ...output,
    summary: `${output.open} open, ${output.overdue} overdue. Top: ${
      openCol.cards.slice(0, 3).map((c) => c.name).join("; ") || "nothing burning"
    }.`,
  };
}
