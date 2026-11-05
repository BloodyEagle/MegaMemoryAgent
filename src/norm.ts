/**
 * Normalize a name for comparisons and the name_norm column (patches А5).
 * NFKD, strip combining marks ONLY after Latin/Cyrillic/Greek/Hebrew bases
 * (katakana dakuten ジ = シ + U+3099 and Hangul jamo are NOT diacritics —
 * stripping them silently changes the syllable), lowercase, NFC.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(
      /(?<=[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hebrew}])\p{M}+/gu,
      ""
    )
    .toLowerCase()
    .normalize("NFC");
}

/**
 * 2.1.10 F4: name comparison for the create-time dedupe — регистр, пробелы,
 * пунктуация, ё/е. normalizeName already folds case and diacritics; this adds
 * the ё→е fold and dissolves punctuation/digit-adjacent separators into
 * single spaces, so «Кэш-результатов», "cache results"-style variants and
 * «Кэш результатов» collapse to one key.
 */
export function normalizeNameForDedupe(name: string): string {
  return normalizeName(name)
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
