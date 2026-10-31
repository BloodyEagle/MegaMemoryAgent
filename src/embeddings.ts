import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import type { KnowledgeDB } from "./db.js";
import { CURRENT_EMBED_MODEL } from "./embed-model.js";

/**
 * Embedding model — env-configurable via MEGAMEMORY_EMBED_MODEL
 * (single source of truth lives in embed-model.ts). The fork default is
 * multilingual (trained on 100+ languages); all-MiniLM-L6-v2 stays
 * available for Latin-only projects or offline machines that already
 * downloaded it. ~120 MB is downloaded once and cached in ~/.cache/huggingface.
 */
export const MODEL_NAME = CURRENT_EMBED_MODEL;

// e5-family models were trained with "passage: "/"query: " input prefixes;
// feeding raw text degrades quality noticeably. Other models get none.
const EMBED_PREFIXES: Record<string, { passage: string; query: string }> = {
  e5: { passage: "passage: ", query: "query: " },
};

function prefixFor(model: string, kind: "passage" | "query"): string {
  const key = Object.keys(EMBED_PREFIXES).find((k) =>
    model.toLowerCase().includes(k)
  );
  return key ? EMBED_PREFIXES[key][kind] : "";
}

/** Add the model's passage prefix (used when indexing node text). */
export function passageText(text: string, model: string = MODEL_NAME): string {
  return prefixFor(model, "passage") + text;
}

/** Add the model's query prefix (used when embedding a search query). */
export function queryText(text: string, model: string = MODEL_NAME): string {
  return prefixFor(model, "query") + text;
}

let extractor: FeatureExtractionPipeline | null = null;

/**
 * Initialize the embedding model. Called lazily on first use.
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_NAME, {
      quantized: true,
    });
  }
  return extractor;
}

export async function initializeEmbeddings(): Promise<void> {
  await getExtractor();
}

/**
 * Generate an embedding vector for given text.
 * Returns a Buffer containing float32 values. Dimension depends on the
 * model (384 for MiniLM, 384 for multilingual-e5-small) — the actual value
 * is stored in meta.embed_dim, never hardcoded.
 */
export async function embed(text: string): Promise<Buffer> {
  if (!text || text.trim().length === 0) {
    throw new Error(`Cannot embed empty text`);
  }

  const ext = await getExtractor();
  const output = await ext(text, { pooling: "mean", normalize: true });
  const data = output.data as Float32Array;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Embedding dimensionality of a float32 buffer. */
export function dimOf(buffer: Buffer): number {
  return buffer.length / Float32Array.BYTES_PER_ELEMENT;
}

/**
 * Vector search is safe only when every stored vector came from the same
 * model. meta.embed_model records that; a mismatch (or an upstream database
 * with vectors but no meta at all) disables the vector path until
 * `megamemory reembed` reindexes everything.
 */
export function vectorSearchEnabled(db: KnowledgeDB): boolean {
  return db.getMetaValue("embed_model") === MODEL_NAME;
}

/**
 * Embed text for indexing/storing, or null when the vector path is disabled
 * (model mismatch — writes must not mix vector spaces). Stamps
 * meta.embed_model/embed_dim on the first successful embed.
 */
export async function embedForStorage(
  db: KnowledgeDB,
  text: string
): Promise<Buffer | null> {
  if (!vectorSearchEnabled(db)) return null;
  const buffer = await embed(passageText(text));
  if (db.getMetaValue("embed_model") === undefined) {
    db.setMetaValue("embed_model", MODEL_NAME);
    db.setMetaValue("embed_dim", String(dimOf(buffer)));
  }
  return buffer;
}

/**
 * Generate embedding text from node fields.
 * Combines name, kind, and summary for richer semantic representation.
 */
export function embeddingText(
  name: string,
  kind: string,
  summary: string
): string {
  return `${kind}: ${name} — ${summary}`;
}

/**
 * Compute cosine similarity between two embedding buffers.
 * Both buffers must contain float32 arrays of the same length.
 */
export function cosineSimilarity(a: Buffer, b: Buffer): number {
  const vecA = new Float32Array(
    a.buffer,
    a.byteOffset,
    a.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  const vecB = new Float32Array(
    b.buffer,
    b.byteOffset,
    b.byteLength / Float32Array.BYTES_PER_ELEMENT
  );

  if (vecA.length !== vecB.length) {
    throw new Error(
      `Embedding dimension mismatch: ${vecA.length} vs ${vecB.length}`
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Find the top-K most similar nodes from a list of candidates.
 */
export function findTopK(
  queryEmbedding: Buffer,
  candidates: Array<{
    id: string;
    name: string;
    kind: string;
    summary: string;
    embedding: Buffer | null;
  }>,
  topK: number
): Array<{ id: string; similarity: number }> {
  const scored = candidates
    .filter((c) => c.embedding !== null && c.embedding.length > 0)
    .map((c) => ({
      id: c.id,
      similarity: cosineSimilarity(queryEmbedding, c.embedding!),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK);
}
