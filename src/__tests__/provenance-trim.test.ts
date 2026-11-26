import { describe, it, expect } from "vitest";
import { clipText } from "../text-clip.js";
import { clampNote, trimRationale } from "../provenance.js";
import { shortEssence } from "../next-hints.js";

// План 37: T1 trimRationale и T2 clampNote делегируют clipText (поведение
// прежнее, добавлен guard суррогатной пары); T3 shortEssence — отдельное правило.

describe("plan 37 T1 trimRationale", () => {
  it("T1: строка длиннее 80 режется до 80 с «…» (формула clipText)", () => {
    const long = "r".repeat(100);
    const out = trimRationale(long) as string;
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
    const out = trimRationale(text) as string;
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(80);
  });
});

describe("plan 37 T2 clampNote", () => {
  it("T2: note длиннее 300 режется до ≤300 с «…» на конце", () => {
    const note = "n".repeat(350);
    const out = clampNote(note) as string;
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
    expect(clampNote("short note")).toBe("short note");
  });

  it("T2: эмодзи на срезе clampNote не рвёт суррогатную пару", () => {
    // cut=299: guard clipText (low на cut) опускает cut при попадании на пару.
    const note = "x".repeat(298) + "😀" + "z".repeat(60);
    expect(note.length).toBeGreaterThan(300);
    const out = clampNote(note) as string;
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(300);
  });
});

describe("plan 37 T3 shortEssence — отдельное правило (не clipText)", () => {
  it("T3: откат к любому пробелу, guard high на cut-1, длина ≤ 80", () => {
    // 86 символов «alpha » + 80 «b»: clipText откатывается только при пробеле
    // во второй половине окна (space > 80/2=40) — пробел на индексе 5 не
    // попадает, clipText режет посреди слова (80 символов). shortEssence
    // откатывается к ЛЮБОМУ пробелу (space > 0) — целое слово «alpha…».
    const text = "alpha " + "b".repeat(80);
    expect(text.length).toBe(86);
    expect(clipText(text, 80)).not.toBe("alpha…");
    expect(clipText(text, 80).length).toBe(80);
    const out = shortEssence(text);
    expect(out).toBe("alpha…");
    expect(out.length).toBe(6);
    // Без пробела — жёсткий срез по символу (та же формула, что до T3).
    const denseOut = shortEssence("x".repeat(100));
    expect(denseOut).toBe("x".repeat(79) + "…");
    expect(denseOut.length).toBe(80);
  });

  it("T3: эмодзи в позиции среза не оставляет одинокий суррогат", () => {
    // cut=79: cut-1=78 — high суррогата → guard опускает cut до 78.
    const text = "x".repeat(78) + "😀" + "z".repeat(30);
    const out = shortEssence(text);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(80);
  });
});
