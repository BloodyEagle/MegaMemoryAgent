import type { KnowledgeDB } from "./db.js";
import {
  MODEL_NAME,
  dimOf,
  embed,
  embeddingText,
  passageText,
} from "./embeddings.js";

export interface ReembedOptions {
  /** Nodes per batch (default 64). Each batch commits its cursor. */
  batch?: number;
  /** Injectable embedder for tests; defaults to the real model. */
  embedFn?: (text: string) => Promise<Buffer>;
  onProgress?: (done: number, total: number) => void;
}

export interface ReembedResult {
  processed: number;
  total: number;
  dim: number;
  model: string;
}

/**
 * Recompute embeddings for every node with the current model.
 *
 * Resumable: progress lives in meta.reembed_cursor (last processed rowid),
 * so an interrupted run continues where it stopped. meta.embed_model is
 * stamped only after the final batch — until then vector search stays
 * disabled and old/new vectors never mix.
 */
export async function reembed(
  db: KnowledgeDB,
  opts: ReembedOptions = {}
): Promise<ReembedResult> {
  const batch = opts.batch ?? 64;
  const embedFn =
    opts.embedFn ?? ((text: string) => embed(passageText(text)));
  const totalRow = db.execSqlFirst("SELECT count(*) AS n FROM nodes") as {
    n: number;
  };
  const total = totalRow.n;

  let cursor = Number(db.getMetaValue("reembed_cursor") ?? 0);
  let processed = 0;
  let dim = Number(db.getMetaValue("embed_dim") ?? 0);

  for (;;) {
    const rows = db.execSqlAll(
      "SELECT rowid, id, name, kind, summary FROM nodes WHERE rowid > ? ORDER BY rowid LIMIT ?",
      cursor,
      batch
    ) as Array<{
      rowid: number;
      id: string;
      name: string;
      kind: string;
      summary: string;
    }>;
    if (rows.length === 0) break;

    for (const row of rows) {
      const text = passageText(
        embeddingText(row.name, row.kind, row.summary)
      );
      const buffer = await embedFn(text);
      dim = dimOf(buffer);
      // Named params: libsql panics on single-POSITIONAL-param statements
      // with a Buffer argument (statement.rs unwrap), named binding is safe.
      db.execSqlRun(
        "UPDATE nodes SET embedding = @embedding WHERE id = @id",
        { embedding: buffer, id: row.id }
      );
      cursor = row.rowid;
      processed += 1;
    }
    db.setMetaValue("reembed_cursor", String(cursor));
    opts.onProgress?.(processed, total);
  }

  db.setMetaValue("embed_model", MODEL_NAME);
  db.setMetaValue("embed_dim", String(dim));
  db.setMetaValue("last_reembed", new Date().toISOString());
  db.execSql("DELETE FROM meta WHERE key = 'reembed_cursor'");

  return { processed, total, dim, model: MODEL_NAME };
}
