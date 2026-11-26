/** Единая формула обрезки строки (план 36 T1): один модуль вместо четырёх
 * копий — brief.ts clip, tools.ts trimSummary/floorCutSummary, digest.ts
 * child-cap/parent-clip. Формула и guard дословно из brief.ts:69-78. */

export interface ClipOptions {
  /** Откат к границе слова, когда пробел лежит во второй половине окна.
   *  false — жёсткий срез по символу: пол сводки (SUMMARY_FLOOR / дайджест)
   *  добирает до пола, а не до слова. По умолчанию true. */
  wordBoundary?: boolean;
}

/** Обрезка одной строки: не длиннее maxChars, многоточие на конце, суррогатная
 *  пара никогда не режется. wordBoundary:false отключает откат к пробелу. */
export function clipText(text: string, maxChars: number, options?: ClipOptions): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars - 1;
  // Инвариант суррогатной пары (план 36 T2): проверяется ТОЛЬКО low-суррогат
  // на позиции среза. Случай «high на cut, low на cut+1» безопасен без
  // проверки — пара целиком уходит за slice(0, cut) и выпадает целиком.
  // Опасна только позиция среза на low (high остаётся в хвосте результата).
  // При смене формулы (другой cut, другой потолок) держать именно это:
  // результат не должен заканчиваться между high и low.
  const low = text.charCodeAt(cut);
  if (low >= 0xdc00 && low <= 0xdfff) cut -= 1;
  const space = text.lastIndexOf(" ", cut);
  if (options?.wordBoundary !== false && space > maxChars / 2) cut = space;
  return text.slice(0, cut).trimEnd() + "…";
}
