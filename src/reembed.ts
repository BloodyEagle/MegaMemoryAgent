import type { KnowledgeDB } from "./db.js";
import {
  MODEL_NAME,
  embed,
  embeddingProfile,
  embeddingText,
  passageText,
  sameEmbeddingProfile,
  validEmbedding,
} from "./embeddings.js";

export interface ReembedOptions {
  /** Nodes per batch (default 16 — F9.5: memory over speed). */
  batch?: number;
  /** Injectable embedder for tests; defaults to the real model. */
  embedFn?: (text: string) => Promise<Buffer>;
  /** Alternate model identity requires an injected embedder. */
  model?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface ReembedResult {
  processed: number;
  total: number;
  dim: number;
  model: string;
}

/**
 * Switch both vector projections atomically, then publish one captured node at
 * a time with an afterawait input/live/generation CAS. Interrupted runs keep
 * only their actual current-generation rows and resume missing eligible rows.
 */
export async function reembed(
  db: KnowledgeDB,
  opts: ReembedOptions = {}
): Promise<ReembedResult> {
  const batch = opts.batch ?? 16;
  if (!Number.isSafeInteger(batch) || batch < 1) throw new Error("Invalid reembed batch");
  const model = opts.model ?? MODEL_NAME;
  if (model !== MODEL_NAME && !opts.embedFn) throw new Error("Alternate model requires embedFn");
  const embedFn = opts.embedFn ?? embed;
  let generation = db.beginVectorGeneration({ model, profile: embeddingProfile(model), dim: 0 });
  const assertCurrent = () => {
    const active = db.getVectorGeneration();
    if (!active || active.generation !== generation.generation || active.model !== model ||
        !sameEmbeddingProfile(active.profile, generation.profile)) {
      throw new Error("Vector generation changed during reembed");
    }
    generation = active;
  };
  const total = db.getReembedEligibleCount(generation);
  let processed = 0;

  for (;;) {
    assertCurrent();
    const rows = db.getNodesNeedingReembed(generation, batch);
    if (rows.length === 0) break;
    for (const row of rows) {
      const expected = { ...generation, id: row.id, name: row.name, kind: row.kind, summary: row.summary };
      const buffer = await embedFn(passageText(embeddingText(row.name, row.kind, row.summary), model));
      assertCurrent();
      if (!validEmbedding(buffer, generation.dim || buffer.length / 4)) {
        throw new Error("Invalid reembed dimension or values");
      }
      if (!db.publishNodeEmbedding(expected, buffer)) {
        throw new Error("Node input or vector generation changed during reembed");
      }
      assertCurrent();
      processed += 1;
    }
    opts.onProgress?.(processed, total);
  }

  assertCurrent();
  if (!db.finishVectorGeneration(generation)) throw new Error("Reembed completion changed concurrently");
  return { processed, total, dim: generation.dim, model };
}
