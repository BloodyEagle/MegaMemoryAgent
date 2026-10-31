/**
 * The embedding model this fork indexes with — the single source of truth.
 *
 * Kept in a leaf module so migration/CLI code can reference it without
 * importing the (lazy, heavy) transformers pipeline in embeddings.ts.
 * The fork default is multilingual (100+ languages); override with
 * MEGAMEMORY_EMBED_MODEL (e.g. Xenova/all-MiniLM-L6-v2 for Latin-only
 * projects or offline machines that already downloaded it).
 */
export const CURRENT_EMBED_MODEL =
  process.env.MEGAMEMORY_EMBED_MODEL ?? "Xenova/multilingual-e5-small";
