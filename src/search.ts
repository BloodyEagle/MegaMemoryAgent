import type { KnowledgeDB } from "./db.js";

/**
 * Fallback text search used when the vector path is disabled (model
 * mismatch pending reembed) or as the FTS half of hybrid search in T2.
 *
 * Tries the nodes_fts index first (external-content FTS5, unicode61 —
 * works for space-separated languages). CJK text without word boundaries
 * falls back to a LIKE scan: unicode61 cannot split hieroglyph runs, and
 * the trigram tokenizer needs >=3 characters, so short CJK queries can
 * only be matched by substring scan.
 */
export function basicSearch(
  db: KnowledgeDB,
  query: string,
  topK: number
): Array<{ id: string; similarity: number }> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const ftsAvailable =
    db.execSqlFirst(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
    ) !== undefined;

  if (ftsAvailable) {
    // Quote the whole query as an FTS phrase so special chars are literal.
    const phrase = `"${trimmed.replace(/"/g, '""')}"`;
    const rows = db.execSqlAll(`
      SELECT n.id
      FROM nodes_fts f
      JOIN nodes n ON n.rowid = f.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `, phrase, topK) as Array<{ id: string }>;
    if (rows.length > 0) {
      // Rank position stands in for similarity (1 = best).
      return rows.map((r, i) => ({ id: r.id, similarity: 1 - i / (topK + 1) }));
    }
  }

  // LIKE fallback: case-insensitive substring on name/summary/why.
  const like = `%${trimmed}%`;
  const rows = db.execSqlAll(`
    SELECT id FROM nodes
    WHERE name LIKE ? OR summary LIKE ? OR why LIKE ?
    ORDER BY id
    LIMIT ?
  `, like, like, like, topK) as Array<{ id: string }>;
  return rows.map((r, i) => ({ id: r.id, similarity: 1 - i / (topK + 1) }));
}
