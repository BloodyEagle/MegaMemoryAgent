/**
 * The embedding model this fork currently indexes with.
 *
 * Kept in a leaf module so migration/CLI code can reference it without
 * importing the (lazy, heavy) transformers pipeline in embeddings.ts.
 * T1 turns this into an env-configurable multilingual model.
 */
export const CURRENT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
