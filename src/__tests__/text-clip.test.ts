import { describe, it, expect } from "vitest";
import { clipText } from "../text-clip.js";

// План 36 T1: одна формула обрезки — четыре сайта-потребителя (brief.ts clip,
// tools.ts trimSummary/floorCutSummary, digest.ts child-cap/parent-cap).
// T2: инвариант суррогатной пары назван и накрыт случаем «срез в середину пары».

describe("clipText", () => {
  it("wordBoundary: true режет по слову, когда пробел лежит после середины окна", () => {
    const text = "alpha beta gamma delta";
    const out = clipText(text, 12);
    expect(out).toBe("alpha beta…");
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it("wordBoundary: false режет ровно по maxChars-1 с trimEnd и многоточием", () => {
    const text = "123456789012345";
    const out = clipText(text, 10, { wordBoundary: false });
    expect(out).toBe("123456789…");
    expect(out.length).toBe(10);
    // trimEnd общий для обоих режимов: срез, захвативший концевой пробел,
    // отдаёт «…» без пробела перед ним (старый floorCutSummary пробел оставлял).
    const spaced = "a b c d e f ";
    const outSpaced = clipText(spaced, 11, { wordBoundary: false });
    expect(outSpaced).toBe("a b c d e…");
    expect(outSpaced.length).toBe(10);
    expect(outSpaced).not.toMatch(/ $/);
  });

  it("результат не длиннее maxChars в обоих режимах", () => {
    const samples = [
      "alpha beta gamma delta",
      "123456789012345",
      "слово слово слово слово",
      "abc😀def",
      "😀😀😀😀😀😀😀😀",
    ];
    for (const text of samples) {
      for (const mode of [true, false] as const) {
        for (const maxChars of [1, 2, 3, 4, 5, 8, 12, text.length]) {
          const out = clipText(text, maxChars, { wordBoundary: mode });
          expect(out.length).toBeLessThanOrEqual(maxChars);
        }
      }
    }
  });

  it("T2: срез в середину суррогатной пары не оставляет одинокий суррогат", () => {
    const text = "abc😀def";
    // maxChars=4 → cut=3 попадает на high-суррогат (пара целиком за срезом);
    // maxChars=5 → cut=4 попадает на low-суррогат (единственная опасная позиция).
    for (const maxChars of [4, 5] as const) {
      const out = clipText(text, maxChars, { wordBoundary: false });
      // Ни одного low-суррогата без предшествующего high (одинокая половинка).
      expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      // Пара не разорвана: «средний» UTF-16 элемент — всегда целое число пар.
      expect(out.length % 1).toBe(0);
      const loneHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out);
      expect(loneHigh).toBe(false);
    }
    // И с откатом к слову — тот же инвариант на любой позиции среза.
    const text2 = "abc😀def ghi";
    for (const maxChars of [4, 5, 6, 7, 8, 9, 10] as const) {
      const out = clipText(text2, maxChars);
      expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(maxChars);
    }
  });
});
