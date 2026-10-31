import type { KnowledgeDB } from "./db.js";
import { embed, findTopK, queryText, vectorSearchEnabled } from "./embeddings.js";

/**
 * Hybrid search (plan T2): FTS + optional vector channel merged with
 * Reciprocal Rank Fusion. Works for any language:
 * - unicode61 FTS handles space-separated scripts (ru/en/ar/he...);
 * - a trigram FTS table (when created via MEGAMEMORY_FTS_TOKENIZER=trigram)
 *   handles CJK runs of >=3 chars;
 * - short CJK queries and empty indexes fall back to a LIKE scan.
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
 * FTS channel: phrase query against nodes_fts; for CJK queries also the
 * trigram table (>=3 chars — trigram cannot index shorter strings). Falls
 * back to LIKE when the index has no rows (e.g. short CJK words).
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
    // Quote as an FTS phrase so special characters stay literal.
    const phrase = `"${trimmed.replace(/"/g, '""')}"`;
    const rows = db.execSqlAll(
      `SELECT n.id FROM nodes_fts f
       JOIN nodes n ON n.rowid = f.rowid
       WHERE nodes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      phrase,
      limit
    ) as Array<{ id: string }>;

    const triRows: Array<{ id: string }> = [];
    if (hasCjk(trimmed) && trimmed.length >= 3 && trigramTableAvailable(db)) {
      triRows.push(
        ...((db.execSqlAll(
          `SELECT n.id FROM nodes_fts_tri f
           JOIN nodes n ON n.rowid = f.rowid
           WHERE nodes_fts_tri MATCH ?
           LIMIT ?`,
          phrase,
          limit
        ) as Array<{ id: string }>))
      );
    }

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

  // LIKE fallback: case-insensitive substring on name/summary/why.
  const like = `%${trimmed}%`;
  const rows = db.execSqlAll(
    `SELECT id FROM nodes
     WHERE name LIKE ? OR summary LIKE ? OR why LIKE ?
     ORDER BY id
     LIMIT ?`,
    like,
    like,
    like,
    limit
  ) as Array<{ id: string }>;
  return rows.map((r) => ({ id: r.id, via: "fts" }));
}

/**
 * Merge two ranked pools with Reciprocal Rank Fusion:
 * score = Σ 1 / (k + rank), rank starting at 1.
 */
export function rrfMerge(
  pools: Array<{ hits: Array<{ id: string }>; via: SearchVia }>,
  k: number,
  topK: number
): SearchHit[] {
  const scores = new Map<string, { score: number; vias: Set<SearchVia> }>();
  for (const pool of pools) {
    pool.hits.forEach((hit, index) => {
      const entry = scores.get(hit.id) ?? { score: 0, vias: new Set<SearchVia>() };
      entry.score += 1 / (k + index + 1);
      entry.vias.add(pool.via);
      scores.set(hit.id, entry);
    });
  }

  return [...scores.entries()]
    .map(([id, { score, vias }]) => ({
      id,
      score,
      via: (vias.has("both") ? "both" : vias.size > 1 ? "both" : [...vias][0]) as SearchVia,
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
    const vectorHits = findTopK(
      queryEmbedding,
      db.getAllActiveNodesWithEmbeddings(),
      poolSize
    );
    pools.push({ hits: vectorHits, via: "vector" });
  }

  if (pools.length === 0) return [];

  return rrfMerge(pools, k, topK);
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
