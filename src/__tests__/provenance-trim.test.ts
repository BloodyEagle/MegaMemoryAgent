import { describe, it, expect } from "vitest";
import { clipText } from "../text-clip.js";
import { clampNote, trimRationale } from "../provenance.js";

// План 37 T1/T2: оставшиеся сайты обрезки сводятся к одной формуле clipText
// (T1 trimRationale, T2 clampNote; поведение байт-в-байт кроме guard
// суррогатной пары). T3 — shortEssence (next-hints.ts) отдельным файлом
// не вынесен: его случай живёт в text-clip.test.ts? Нет — его случай здесь же,
// см. plan37-t3.test.ts. Здесь только T1/T2.

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

describe("plan 37 T2 clampNote", () => {
  it("T2: note длиннее 300 режется до ≤300 с «…» на конце", () => {
    const note = "n".repeat(350);
    const out = clampNote(note);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
    expect(clampNote("short note")).toBe("short note");
  });

  it("T2: эмодзи на срезе clampNote не рвёт суррогатную пару", () => {
    // cut=299: guard clipText (low на cut) опускает cut при попадании на пару.
    const note = "x".repeat(298) + "😀" + "z".repeat(60);
    expect(note.length).toBeGreaterThan(300);
    const out = clampNote(note);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
