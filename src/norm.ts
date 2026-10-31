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
