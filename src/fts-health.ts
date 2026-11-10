import type { KnowledgeDB } from "./db.js";

export interface FtsHealth {
  rows: number;
  nodes: number;
  in_sync: boolean;
  status: "healthy" | "out_of_sync" | "unknown" | "absent";
  checked: number;
  misses: number;
  completeness: "complete" | "truncated" | "unknown";
  detail: string | null;
}

/** Bounded read-only verification of actual MATCH results, not external-content counts. */
export function probeFtsHealth(db: KnowledgeDB, limit = 20): FtsHealth {
  const nodes = Number((db.execSqlFirst("SELECT count(*) AS n FROM nodes") as { n: number }).n);
  const exists = db.execSqlFirst("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts'") !== undefined;
  if (!exists) return { rows: 0, nodes, in_sync: false, status: "absent", checked: 0, misses: 0, completeness: "unknown", detail: "missing" };
  try {
    const rows = Number((db.execSqlFirst("SELECT count(*) AS n FROM nodes_fts") as { n: number }).n);
    const sample = db.execSqlAll("SELECT rowid,name,summary,why FROM nodes ORDER BY rowid DESC LIMIT ?", limit) as Array<{ rowid: number; name: string; summary: string; why: string | null }>;
    let checked = 0;
    let misses = 0;
    for (const node of sample) {
      const token = `${node.name ?? ""} ${node.summary ?? ""} ${node.why ?? ""}`.match(/[\p{L}\p{N}]+/u)?.[0];
      if (!token) continue;
      const hit = db.execSqlFirst("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ? AND rowid = ? LIMIT 1", `"${token.replace(/"/g, '""')}"`, node.rowid);
      checked++;
      if (!hit) misses++;
    }
    const complete = checked === nodes;
    const drift = misses > 0 || rows !== nodes;
    // No drift within the bounded probe is healthy even when the base is
    // larger than the sample: "unknown" is reserved for unverifiable
    // indexes (errors, absent tables), not for a bounded clean verification.
    const status = drift ? "out_of_sync" : "healthy";
    return {
      rows, nodes, in_sync: status === "healthy", status, checked, misses,
      completeness: complete ? "complete" : nodes > limit ? "truncated" : "unknown",
      detail: drift ? `${misses}/${checked} sampled node(s) missing from the index` : null,
    };
  } catch (error) {
    return { rows: 0, nodes, in_sync: false, status: "unknown", checked: 0, misses: 0, completeness: "unknown", detail: `index not verifiable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
