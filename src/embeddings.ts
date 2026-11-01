import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
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

// ---- F9.1/F9.2: memory-conscious model lifecycle ----
//
// The ONNX session keeps 400-500 MB RSS alive long after the last query.
// The model is unloaded after an idle timeout, and the session is created
// without the growth-only memory arena so the peak does not stick around.

const IDLE_MS = Number(process.env.MEGAMEMORY_EMBED_IDLE_MS ?? 5 * 60_000);

const PIPELINE_OPTIONS = {
  dtype: "q8" as const,
  session_options: {
    // The arena grows to the peak and never returns memory — disable it
    // (costs ~10-20% speed, saves hundreds of MB after a reembed batch).
    enableCpuMemArena: false,
    enableMemPattern: false,
    intraOpNumThreads: Number(process.env.MEGAMEMORY_EMBED_THREADS ?? 1),
    interOpNumThreads: 1,
  },
};

let extractor: FeatureExtractionPipeline | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let activeEmbeds = 0;

function scheduleIdleUnload(): void {
  if (IDLE_MS === 0) return; // MEGAMEMORY_EMBED_IDLE_MS=0 disables unloading
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Do not unload while inference is running.
    if (!extractor || activeEmbeds > 0) return;
    const disposing = extractor as unknown as { dispose?: () => unknown };
    const result = disposing.dispose?.();
    void Promise.resolve(result).finally(() => {
      extractor = null;
    });
  }, IDLE_MS);
  idleTimer.unref?.(); // the timer must not keep the process alive
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_NAME, PIPELINE_OPTIONS);
  }
  scheduleIdleUnload();
  return extractor;
}

/** Whether the model session is currently in memory. */
export function isModelLoaded(): boolean {
  return extractor !== null;
}

/**
 * Run inference with the idle-unload bookkeeping: the model cannot be
 * disposed mid-call even if the idle timer fires in parallel.
 */
export async function withExtractor<T>(
  fn: (extractor: FeatureExtractionPipeline) => Promise<T>
): Promise<T> {
  const ext = await getExtractor();
  activeEmbeds += 1;
  try {
    return await fn(ext);
  } finally {
    activeEmbeds -= 1;
    scheduleIdleUnload();
  }
}

/** Test hook: drop the singleton so each test starts clean. */
export function resetEmbeddingsForTests(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  extractor = null;
  activeEmbeds = 0;
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

  return withExtractor(async (ext) => {
    // F9.4: node texts are trimmed long before this (240-char summaries);
    // cap the tokenization so stray long inputs cannot blow up activations.
    // max_length/truncation are tokenizer options — the pipeline type is
    // narrower than the runtime contract, hence the assertion.
    const callOptions = {
      pooling: "mean" as const,
      normalize: true,
      truncation: true,
      max_length: 256,
    };
    const output = await ext(
      text,
      callOptions as Parameters<FeatureExtractionPipeline>[1]
    );
    const data = output.data as Float32Array;
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  });
}

/** Embedding dimensionality of a float32 buffer. */
export function dimOf(buffer: Buffer): number {
  return buffer.length / Float32Array.BYTES_PER_ELEMENT;
}

/** F9.6: text-only mode — the model must never be loaded at all. */
export function isTextOnlySearchMode(): boolean {
  return (process.env.MEGAMEMORY_SEARCH ?? "hybrid").toLowerCase() === "fts";
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
