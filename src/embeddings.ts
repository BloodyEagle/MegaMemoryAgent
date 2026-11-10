import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { KnowledgeDB, VectorGeneration } from "./db.js";
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
// R-03a (plan 08): shared in-flight load slot — see getExtractor below.
let extractorInFlight: Promise<FeatureExtractionPipeline> | null = null;
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
    // R-03b (plan 08): null the slot synchronously — an async dispose must
    // never be handed to a new caller mid-disposal. The next getExtractor
    // load repopulates the slot; this dispose does not touch it again.
    extractor = null;
    void Promise.resolve(disposing.dispose?.());
  }, IDLE_MS);
  idleTimer.unref?.(); // the timer must not keep the process alive
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    // R-03a (plan 08): share the in-flight load — concurrent first embeds
    // must not each start their own pipeline (double download, double
    // memory, last write wins). A rejected load is not cached: the finally
    // clears the slot so the next embed retries.
    if (!extractorInFlight) {
      extractorInFlight = pipeline("feature-extraction", MODEL_NAME, PIPELINE_OPTIONS)
        .then((loaded) => {
          extractor = loaded;
          return loaded;
        })
        .finally(() => {
          extractorInFlight = null;
          scheduleIdleUnload();
        });
    }
    const loaded = await extractorInFlight;
    scheduleIdleUnload();
    return loaded;
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
  extractorInFlight = null;
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

/** Actual preprocessing identity; unknown concrete weight revision stays null. */
export function embeddingProfile(model: string = MODEL_NAME, dim = 0): string {
  return JSON.stringify({
    dim,
    dtype: "q8",
    input_text_format: "kind: name — summary",
    max_length: 256,
    model,
    normalize: true,
    passage_prefix: prefixFor(model, "passage"),
    pooling: "mean",
    query_prefix: prefixFor(model, "query"),
    revision: null,
  });
}

/** Compare preprocessing independently of the dimension learned on first publish. */
export function sameEmbeddingProfile(a: string, b: string): boolean {
  try {
    const normalize = (value: string) => {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return JSON.stringify(Object.keys(parsed).filter((key) => key !== "dim").sort()
        .map((key) => [key, parsed[key]]));
    };
    const left = normalize(a);
    return left !== null && left === normalize(b);
  } catch {
    return false;
  }
}

/** Read float32 bytes safely even when a pooled Buffer is not aligned. */
export function embeddingValues(buffer: Buffer): Float32Array {
  if (buffer.length === 0 || buffer.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Invalid embedding buffer length");
  }
  const values = new Float32Array(dimOf(buffer));
  for (let i = 0; i < values.length; i++) values[i] = buffer.readFloatLE(i * 4);
  return values;
}

/** Invalid, nonfinite, zero and wrong-space dimensions cannot be vector hits. */
export function validEmbedding(buffer: Buffer, dim = dimOf(buffer)): boolean {
  if (!Number.isSafeInteger(dim) || dim <= 0 || buffer.length !== dim * 4) return false;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const value = buffer.readFloatLE(i * 4);
    if (!Number.isFinite(value)) return false;
    norm += value * value;
  }
  return norm > 0 && Number.isFinite(norm);
}

/** F9.6: text-only mode — the model must never be loaded at all. */
export function isTextOnlySearchMode(): boolean {
  return (process.env.MEGAMEMORY_SEARCH ?? "hybrid").toLowerCase() === "fts";
}

/** Active generation and actual preprocessing jointly authorize vector reads. */
export function vectorSearchEnabled(db: KnowledgeDB, model: string = MODEL_NAME): boolean {
  const active = db.getVectorGeneration();
  if (!active || !Number.isSafeInteger(active.generation) || active.generation <= 0 ||
      active.model !== model || !Number.isSafeInteger(active.dim) || active.dim <= 0 ||
      !sameEmbeddingProfile(active.profile, embeddingProfile(model, active.dim))) return false;
  try { return JSON.parse(active.profile).dim === active.dim; }
  catch { return false; }
}

export function vectorGenerationMatches(db: KnowledgeDB, expected: VectorGeneration): boolean {
  const active = db.getVectorGeneration();
  return active !== null && active.generation === expected.generation &&
    active.model === expected.model && active.dim === expected.dim &&
    active.profile === expected.profile;
}

export interface StorageEmbeddingOptions {
  /** Alternate models are only allowed with an injected embedder, never a download. */
  model?: string;
  embedFn?: (text: string) => Promise<Buffer>;
}

/**
 * Keep the Buffer|null API; the DB publisher must additionally CAS the node
 * input and generation inside its transaction. A model switch during inference
 * returns null without stamping metadata or laundering historical vectors.
 */
export async function embedForStorage(
  db: KnowledgeDB,
  text: string,
  opts: StorageEmbeddingOptions = {}
): Promise<Buffer | null> {
  const model = opts.model ?? MODEL_NAME;
  if (model !== MODEL_NAME && !opts.embedFn) throw new Error("Alternate model requires embedFn");
  if (!vectorSearchEnabled(db, model)) return null;
  const expected = db.getVectorGeneration()!;
  const buffer = await (opts.embedFn ?? embed)(passageText(text, model));
  if (!vectorGenerationMatches(db, expected)) return null;
  if (!validEmbedding(buffer, expected.dim)) throw new Error("Invalid storage embedding dimension or values");
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
  const vecA = embeddingValues(a);
  const vecB = embeddingValues(b);

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
    .filter((c) => c.embedding !== null && validEmbedding(c.embedding, dimOf(queryEmbedding)))
    .map((c) => ({
      id: c.id,
      similarity: cosineSimilarity(queryEmbedding, c.embedding!),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK);
}
