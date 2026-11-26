import { describe, it, expect } from "vitest";
import { clipText } from "../text-clip.js";
import { trimRationale } from "../provenance.js";

// План 37 T1: trimRationale (provenance.ts:219-223) — оставшийся сайт обрезки
// сводки с собственной арифметикой без guard суррогатной пары — сводится к
// clipText(text, RATIONALE_TRIM, { wordBoundary: false }). Поведение
// байт-в-байт кроме guard: cut = RATIONALE_TRIM-1, trimEnd, «…».

describe("plan 37 T1 trimRationale", () => {
  it("T1: строка длиннее 80 режется до 80 с «…» (формула clipText)", () => {
    const long = "r".repeat(100);
    const out = trimRationale(long);
    expect(out).toBe("r".repeat(79) + "…");
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
    expect(trimRationale("short")).toBe("short");
    expect(trimRationale("")).toBeNull();
    expect(trimRationale(null)).toBeNull();
  });

  it("T1: эмодзи на позиции среза не оставляет одинокий суррогат", () => {
    // cut=79 попадает на low-суррогат (единственная опасная позиция формулы);
    // guard опускает cut до 78 — пара целиком за срезом.
    const text = "x".repeat(78) + "😀" + "z".repeat(30);
    expect(text.length).toBeGreaterThan(80);
    const out = trimRationale(text);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(80);
  });
});
