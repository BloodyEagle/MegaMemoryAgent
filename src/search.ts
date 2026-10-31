import type { KnowledgeDB } from "./db.js";
import { embed, findTopK, queryText, vectorSearchEnabled } from "./embeddings.js";
import { normalizeName } from "./norm.js";

/** Digest nodes weigh less in search so they never displace concrete nodes. */
export const DIGEST_SEARCH_WEIGHT = 0.8;

/**
 * Hybrid search (plan T2 + patches А4/А5/М1/М3/М7/В17): FTS + optional
 * vector channel merged with Reciprocal Rank Fusion. Works for any language:
 * - unicode61 FTS handles space-separated scripts; every token is quoted and
 *   prefix-enabled ('"ток"*') — safe against raw input and compensates the
 *   missing russian stemmer;
 * - a trigram FTS table (MEGAMEMORY_FTS_TOKENIZER=trigram) handles CJK runs
 *   of >=3 chars; SHORT CJK queries (<3 chars) match through the unicode61
 *   prefix query and the name_norm LIKE path (trigram cannot index them);
 * - name_norm (JS-normalized) makes the LIKE fallback case-insensitive for
 *   cyrillic — SQL lower() is ASCII-only;
 * - vector channel uses libsql's native F32_BLOB + vector_distance_cos when
 *   the shadow table is fully populated, JS cosine otherwise.
 *
 * `via` in every hit records WHY the node was found — surfaced in the
 * explorer as a badge and in MCP output as `via`.
 */

export type SearchVia = "vector" | "fts" | "both";

export interface SearchHit {
  id: string;
  score: number;
  via: SearchVia;
}

export interface HybridSearchOptions {
  topK?: number;
  poolSize?: number;
  /** RRF smoothing constant. */
  k?: number;
  /** Injectable query embedder for tests. */
  embedFn?: (text: string) => Promise<Buffer>;
}

// CJK Unicode ranges (hiragana/katakana, CJK ext A, CJK unified, compat).
// Built from code points — no escape sequences (they do not survive tooling).
const CJK_RANGES: Array<[number, number]> = [
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
];

export function hasCjk(text: string): boolean {
  return [...text].some((ch) => {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return false;
    return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
  });
}

function trigramTableAvailable(db: KnowledgeDB): boolean {
  return (
    db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts_tri'"
    ) !== undefined
  );
}

/**
 * Sanitized FTS MATCH expression (М1): every token individually quoted with
 * inner quotes doubled, prefix-enabled (М3: '"ток"*' compensates the missing
 * russian stemmer and lets short CJK match longer runs, А4).
 */
export function buildFtsMatch(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" ");
}

/**
 * FTS channel. Trigram is consulted only for CJK tokens of >=3 chars
 * (trigram cannot index shorter strings — patch А4); short CJK queries are
 * covered by the unicode61 prefix query and the LIKE fallback.
 */
export function ftsSearch(
  db: KnowledgeDB,
  query: string,
  limit: number
): Array<{ id: string; via: SearchVia }> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const ftsAvailable =
    db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
    ) !== undefined;

  if (ftsAvailable) {
    const match = buildFtsMatch(trimmed);
    const rows = db.execSqlAll(
      `SELECT n.id FROM nodes_fts f
       JOIN nodes n ON n.rowid = f.rowid
       WHERE nodes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      match,
      limit
    ) as Array<{ id: string }>;

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const useTri =
      tokens.some((t) => hasCjk(t) && [...t].length >= 3) &&
      trigramTableAvailable(db);
    const triRows: Array<{ id: string }> = useTri
      ? (db.execSqlAll(
          `SELECT n.id FROM nodes_fts_tri f
           JOIN nodes n ON n.rowid = f.rowid
           WHERE nodes_fts_tri MATCH ?
           LIMIT ?`,
          match,
          limit
        ) as Array<{ id: string }>)
      : [];

    if (rows.length > 0 || triRows.length > 0) {
      const seen = new Set<string>();
      const merged: Array<{ id: string; via: SearchVia }> = [];
      for (const row of [...rows, ...triRows]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push({ id: row.id, via: "fts" });
      }
      return merged.slice(0, limit);
    }
  }

  // А5: LIKE fallback. name_norm is JS-normalized (case-insensitive for
  // cyrillic); summary/why keep the raw case-sensitive scan as a bonus.
  const likeNorm = `%${normalizeName(trimmed)}%`;
  const likeRaw = `%${trimmed}%`;
  const rows = db.execSqlAll(
    `SELECT id FROM nodes
     WHERE name_norm LIKE ? OR summary LIKE ? OR why LIKE ?
     ORDER BY id
     LIMIT ?`,
    likeNorm,
    likeRaw,
    likeRaw,
    limit
  ) as Array<{ id: string }>;
  return rows.map((r) => ({ id: r.id, via: "fts" }));
}

/**
 * Merge ranked pools with weighted Reciprocal Rank Fusion:
 * score = Σ weight / (k + rank), rank starting at 1 (М7: weights per hit,
 * not post-hoc score multiplication).
 */
export function rrfMerge(
  pools: Array<{ hits: Array<{ id: string }>; via: SearchVia }>,
  k: number,
  topK: number,
  weightFor?: (id: string) => number
): SearchHit[] {
  const scores = new Map<string, { score: number; vias: Set<SearchVia> }>();
  for (const pool of pools) {
    pool.hits.forEach((hit, index) => {
      const weight = weightFor ? weightFor(hit.id) : 1;
      const entry =
        scores.get(hit.id) ?? { score: 0, vias: new Set<SearchVia>() };
      entry.score += weight / (k + index + 1);
      entry.vias.add(pool.via);
      scores.set(hit.id, entry);
    });
  }

  return [...scores.entries()]
    .map(([id, { score, vias }]) => ({
      id,
      score,
      via: (vias.size > 1 ? "both" : [...vias][0]) as SearchVia,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Hybrid search entry point. Honors MEGAMEMORY_SEARCH:
 * - "hybrid" (default): RRF over FTS + vector (vector skipped when disabled);
 * - "fts": text only;
 * - "vector": vector only, falling back to FTS when vectors are disabled.
 */
export async function hybridSearch(
  db: KnowledgeDB,
  query: string,
  opts: HybridSearchOptions = {}
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 10;
  const poolSize = opts.poolSize ?? 50;
  const k = opts.k ?? 60;
  const mode = process.env.MEGAMEMORY_SEARCH ?? "hybrid";

  const pools: Array<{ hits: Array<{ id: string }>; via: SearchVia }> = [];

  if (mode !== "vector") {
    pools.push({ hits: ftsSearch(db, query, poolSize), via: "fts" });
  }

  if (mode !== "fts" && vectorSearchEnabled(db)) {
    const embedFn = opts.embedFn ?? ((text: string) => embed(queryText(text)));
    const queryEmbedding = await embedFn(query);

    // В17: native SQL top-k when the shadow table is fully populated.
    let vectorHits: Array<{ id: string }> | null = null;
    try {
      const sqlHits = db.vectorTopK(
        JSON.stringify([
          ...new Float32Array(
            queryEmbedding.buffer,
            queryEmbedding.byteOffset,
            queryEmbedding.byteLength / Float32Array.BYTES_PER_ELEMENT
          ),
        ]),
        poolSize
      );
      if (sqlHits) {
        vectorHits = sqlHits;
      }
    } catch {
      vectorHits = null;
    }
    if (vectorHits === null) {
      vectorHits = findTopK(
        queryEmbedding,
        db.getAllActiveNodesWithEmbeddings(),
        poolSize
      );
    }
    pools.push({ hits: vectorHits, via: "vector" });
  }

  if (pools.length === 0) return [];

  // М7: weighted RRF — digest nodes contribute 0.8 per rank.
  const digestIds = new Set(
    (
      db.execSqlAll("SELECT id FROM nodes WHERE kind = 'digest'") as Array<{
        id: string;
      }>
    ).map((r) => r.id)
  );
  const weightFor = (id: string): number =>
    digestIds.has(id) ? DIGEST_SEARCH_WEIGHT : 1;

  const merged = rrfMerge(pools, k, Infinity, weightFor);

  // М7: when a digest made the cut, drop its children — the digest already
  // compresses them (direct token savings).
  const childIds = new Set<string>();
  for (const hit of merged) {
    if (digestIds.has(hit.id)) {
      for (const child of db.getChildren(hit.id)) childIds.add(child.id);
    }
  }
  const filtered = merged.filter((h) => !childIds.has(h.id));

  return filtered.slice(0, topK);
}

/**
 * Text-only search kept for the vector-disabled path (T1).
 */
export function basicSearch(
  db: KnowledgeDB,
  query: string,
  topK: number
): Array<{ id: string; similarity: number }> {
  const hits = ftsSearch(db, query, topK);
  return hits.map((h, i) => ({ id: h.id, similarity: 1 - i / (topK + 1) }));
}
