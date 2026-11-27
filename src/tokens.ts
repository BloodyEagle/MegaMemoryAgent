/** Conservative token estimate: ~3 chars per token. Cyrillic/CJK encode
 * worse than English in most tokenizers, so this stays on the safe side.
 *
 * Moved verbatim from tools.ts:387-393 (plan 40 T1) to break the task-context
 * ↔ tools cycle: estimateTokens is the only tools-name task-context consumes.
 * Module has no imports — the edge moves to a leaf.
 */
export function estimateTokens(text: string): number {
  // Bytes, not JS chars (patch А6): CJK is ~1 token per char but 3 bytes,
  // so chars/3 underestimates ~3x for Chinese. In bytes the estimate is
  // conservative for every script (latin ~4 B/token, cyrillic ~5, CJK ~3).
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}
