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

/**
 * B-06 (аудит 2026-11-12): fail-closed разбор eval-набора.
 *
 * Политика пробелов явная: каждая строка обрезается по краям (trim); пустая
 * после trim — пропуск, поэтому пустые строки и `//`-комментарии (в том
 * числе с ведущими пробелами) поддерживаются как раньше. Значения полей НЕ
 * обрезаются — запрос уходит в поиск дословно.
 *
 * Каждая непустая некомментарная строка обязана быть JSON-объектом с
 * непустыми строками query и expected_id; опциональный lang, если задан, —
 * непустая строка (по умолчанию "unknown"). Любое другое отклонение —
 * исключение с номером строки (нумерация с 1): молчаливый пропуск неполной
 * пары уменьшал знаменатель recall и давал ложный success quality gate.
 */
export function loadEvalPairs(jsonl: string): EvalPair[] {
  const pairs: EvalPair[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `eval: строка ${lineNo} — не разбирается как JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `eval: строка ${lineNo} — ожидается JSON-объект с полями "query" и "expected_id"`
      );
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.query !== "string" || obj.query.trim() === "") {
      throw new Error(`eval: строка ${lineNo} — поле "query" обязано быть непустой строкой`);
    }
    if (typeof obj.expected_id !== "string" || obj.expected_id.trim() === "") {
      throw new Error(`eval: строка ${lineNo} — поле "expected_id" обязано быть непустой строкой`);
    }
    if (obj.lang !== undefined && (typeof obj.lang !== "string" || obj.lang.trim() === "")) {
      throw new Error(`eval: строка ${lineNo} — поле "lang", если задано, обязано быть непустой строкой`);
    }
    pairs.push({
      query: obj.query,
      expected_id: obj.expected_id,
      lang: obj.lang === undefined ? "unknown" : obj.lang,
    });
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
