import type { KnowledgeDB } from "./db.js";
import {
  MODEL_NAME,
  dimOf,
  embed,
  embeddingText,
  passageText,
} from "./embeddings.js";

export interface ReembedOptions {
  /** Nodes per batch (default 16 — F9.5: memory over speed). */
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
 * Recompute embeddings for every node with the current model (М6).
 *
 * On a model switch the old vectors are nulled once, then the run simply
 * fills `WHERE embedding IS NULL` — natural resumability (an interrupted
 * run continues where it stopped) and idempotency with no cursor
 * bookkeeping. meta.embed_model is stamped up front: from that moment
 * every stored vector belongs to the new model, so the vector channel can
 * serve the already-filled rows safely.
 */
export async function reembed(
  db: KnowledgeDB,
  opts: ReembedOptions = {}
): Promise<ReembedResult> {
  const batch = opts.batch ?? 16;
  const embedFn =
    opts.embedFn ?? ((text: string) => embed(passageText(text)));

  // М6: model switch — drop old-space vectors once.
  if (db.getMetaValue("embed_model") !== MODEL_NAME) {
    db.execSqlRun("UPDATE nodes SET embedding = NULL");
    db.setMetaValue("embed_model", MODEL_NAME);
  }

  const totalRow = db.execSqlFirst("SELECT count(*) AS n FROM nodes") as {
    n: number;
  };
  const total = totalRow.n;

  let processed = 0;
  let dim = Number(db.getMetaValue("embed_dim") ?? 0);

  for (;;) {
    const rows = db.execSqlAll(
      "SELECT rowid, id, name, kind, summary FROM nodes WHERE embedding IS NULL ORDER BY rowid LIMIT ?",
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
      // Named params: libsql panics on single-positional Buffer statements.
      db.execSqlRun(
        "UPDATE nodes SET embedding = @embedding WHERE id = @id",
        { embedding: buffer, id: row.id }
      );
      db.upsertVector(row.id, buffer);
      processed += 1;
    }
    opts.onProgress?.(processed, total);
  }

  db.setMetaValue("embed_dim", String(dim));
  db.setMetaValue("last_reembed", new Date().toISOString());
  // Legacy cursor from the previous scheme is no longer used.
  db.execSql("DELETE FROM meta WHERE key = 'reembed_cursor'");

  return { processed, total, dim, model: MODEL_NAME };
}
