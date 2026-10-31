import type { KnowledgeDB } from "./db.js";
import { hybridSearch } from "./search.js";

/**
 * Eval harness (patch В13, task T2.5): proves "search got better" with a
 * number — recall@k over fixtures/eval.jsonl, overall and per language.
 * Thresholds are by rank, never by absolute score.
 */

export interface EvalPair {
  query: string;
  expected_id: string;
  lang: string;
}

export interface EvalResult {
  recall: number;
  total: number;
  hits: number;
  perLang: Record<string, { recall: number; total: number; hits: number }>;
  misses: Array<{ query: string; expected_id: string; lang: string }>;
}

export function loadEvalPairs(jsonl: string): EvalPair[] {
  const pairs: EvalPair[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const parsed = JSON.parse(trimmed) as Partial<EvalPair>;
    if (parsed.query && parsed.expected_id) {
      pairs.push({
        query: parsed.query,
        expected_id: parsed.expected_id,
        lang: parsed.lang ?? "unknown",
      });
    }
  }
  return pairs;
}

/** recall@k over the given pairs using the live search stack. */
export async function runEval(
  db: KnowledgeDB,
  pairs: EvalPair[],
  opts: { k?: number } = {}
): Promise<EvalResult> {
  const k = opts.k ?? 10;
  const perLang: EvalResult["perLang"] = {};
  const misses: EvalResult["misses"] = [];
  let hits = 0;

  for (const pair of pairs) {
    const results = await hybridSearch(db, pair.query, { topK: k });
    const found = results.some((h) => h.id === pair.expected_id);
    if (found) hits += 1;
    else misses.push(pair);

    const bucket = (perLang[pair.lang] ??= { recall: 0, total: 0, hits: 0 });
    bucket.total += 1;
    if (found) bucket.hits += 1;
  }

  for (const bucket of Object.values(perLang)) {
    bucket.recall = bucket.total > 0 ? bucket.hits / bucket.total : 0;
  }

  return {
    recall: pairs.length > 0 ? hits / pairs.length : 0,
    total: pairs.length,
    hits,
    perLang,
    misses,
  };
}
