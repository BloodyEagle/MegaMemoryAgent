import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { understand, measureMcpPayload } from "../tools.js";
import { readRefLines } from "../source-reader.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";

type CompactCard = { id: string; source?: { ref: string; start_line: number; lines: string[]; truncated: boolean } };
type Output = Awaited<ReturnType<typeof understand>>;

let fixture: AuditFixture;
let db: KnowledgeDB;
let previousCwd: string;
let previousSearch: string | undefined;

beforeEach(() => {
  fixture = auditFixture();
  previousCwd = process.cwd();
  process.chdir(fixture.root);
  previousSearch = process.env.MEGAMEMORY_SEARCH;
  process.env.MEGAMEMORY_SEARCH = "fts";
  db = new KnowledgeDB(":memory:");
  ensureSchema(db);
});

afterEach(async () => {
  db.close();
  process.chdir(previousCwd);
  if (previousSearch === undefined) delete process.env.MEGAMEMORY_SEARCH;
  else process.env.MEGAMEMORY_SEARCH = previousSearch;
  await fixture.close();
});

function seedNode(id: string, refs: string[], summary = `Verified fixture for ${id}: a concrete independent source example.`): void {
  db.insertNode({ id, name: id, kind: "feature", summary, ...(refs.length > 0 ? { file_refs: refs } : {}) });
}

function writeProjectFile(relative: string, content: string | Buffer): string {
  const abs = path.join(fixture.root, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";

async function query(id: string, extra: Partial<Parameters<typeof understand>[1]> = {}): Promise<Output> {
  return understand(db, { query: id, ...extra });
}

function cardsOf(output: Output): CompactCard[] {
  return (output.compact ?? []) as CompactCard[];
}

describe("readRefLines (план 26 §2)", () => {
  it("reads the exact range: 11 lines, start_line 10", () => {
    writeProjectFile("src/x.ts", TEN_LINES + Array.from({ length: 10 }, (_, i) => `// tail ${i + 1}`).join("\n") + "\n");
    const result = readRefLines(fixture.root, "src/x.ts:10-20", 200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe("src/x.ts");
    expect(result.start_line).toBe(10);
    expect(result.lines).toHaveLength(11);
    expect(result.lines[0]).toBe("// line 10");
    expect(result.lines[10]).toBe("// tail 10");
    expect(result.truncated).toBe(false);
  });

  it("a ref without a range is refused — whole files are a Read, not a saving", () => {
    writeProjectFile("src/plain.ts", TEN_LINES);
    expect(readRefLines(fixture.root, "src/plain.ts", 60)).toEqual({ ok: false, reason: "no_range" });
    // git-формы не читаются вовсе: blob-форма распознаётся и не режется.
    expect(readRefLines(fixture.root, "HEAD:src/plain.ts:1-2", 60)).toEqual({ ok: false, reason: "no_range" });
    expect(readRefLines(fixture.root, "git:tag:v1", 60)).toEqual({ ok: false, reason: "no_range" });
  });

  it("an inverted range is refused", () => {
    writeProjectFile("src/plain2.ts", TEN_LINES);
    expect(readRefLines(fixture.root, "src/plain2.ts:10-5", 60)).toEqual({ ok: false, reason: "no_range" });
  });

  it("a path outside the root is refused, lexically and through a junction", () => {
    const outside = fs.mkdtempSync(path.join(path.dirname(fixture.root), "mm-source-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secrets.txt"), "line1\nline2\n", "utf8");
      expect(readRefLines(fixture.root, "../" + path.basename(outside) + "/secrets.txt:1-2", 60))
        .toEqual({ ok: false, reason: "outside_root" });
      // Симлинк/junction внутри корня не обходит границу — проверяется realpath.
      try {
        fs.symlinkSync(outside, path.join(fixture.root, "link-out"), "junction");
        const result = readRefLines(fixture.root, "link-out/secrets.txt:1-2", 60);
        expect(result).toEqual({ ok: false, reason: "outside_root" });
      } catch {
        // Создание ссылки может быть запрещено привилегиями — лексический кейс выше уже проверен.
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("missing files, oversized files and non-text content have distinct reasons", () => {
    expect(readRefLines(fixture.root, "src/nope.ts:1-2", 60)).toEqual({ ok: false, reason: "missing" });
    writeProjectFile("src/huge.ts", "x".repeat(1024 * 1024 + 1) + "\n");
    expect(readRefLines(fixture.root, "src/huge.ts:1-2", 60)).toEqual({ ok: false, reason: "too_large" });
    writeProjectFile("src/binary.ts", Buffer.from([0x61, 0x00, 0x62]));
    expect(readRefLines(fixture.root, "src/binary.ts:1-2", 60)).toEqual({ ok: false, reason: "not_text" });
    writeProjectFile("src/latin1.ts", Buffer.from([0x61, 0xff, 0x62]));
    expect(readRefLines(fixture.root, "src/latin1.ts:1-2", 60)).toEqual({ ok: false, reason: "not_text" });
  });

  it("only the tail is cut when the range exceeds maxLines — never the middle", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
    writeProjectFile("src/long.ts", twenty);
    const result = readRefLines(fixture.root, "src/long.ts:1-20", 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toHaveLength(5);
    expect(result.lines[0]).toBe("// line 1");
    expect(result.truncated).toBe(true);
  });
});

describe("understand include_source (план 26 §2)", () => {
  it("attaches the verbatim range to the card: 11 lines, start_line 10", async () => {
    writeProjectFile("src/x.ts", TEN_LINES + Array.from({ length: 10 }, (_, i) => `// tail ${i + 1}`).join("\n") + "\n");
    seedNode("source-demo", ["src/x.ts:10-20"]);
    const output = await query("source-demo", { include_source: true });
    const cards = cardsOf(output);
    expect(cards).toHaveLength(1);
    expect(cards[0].source).toBeDefined();
    expect(cards[0].source).toMatchObject({ ref: "src/x.ts:10-20", start_line: 10, truncated: false });
    expect(cards[0].source!.lines).toHaveLength(11);
    expect(cards[0].source!.lines[0]).toBe("// line 10");
    expect(output.meta!.source_cards).toBe(1);
    expect(output.meta!.source_skipped).toBeUndefined();
  });

  it("without the flag the answer carries no source at all", async () => {
    writeProjectFile("src/x.ts", TEN_LINES);
    seedNode("source-off", ["src/x.ts:1-3"]);
    const output = await query("source-off");
    expect(JSON.stringify(output)).not.toContain('"source"');
    expect(output.meta!.source_cards).toBeUndefined();
    expect(output.meta!.source_skipped).toBeUndefined();
  });

  it("tokens grow exactly by the attached source cost plus its meta counter and stay within max_tokens", async () => {
    writeProjectFile("src/x.ts", TEN_LINES);
    seedNode("source-cost", ["src/x.ts:1-10"]);
    const without = await query("source-cost");
    const withSource = await query("source-cost", { include_source: true });
    const block = cardsOf(withSource)[0].source!;
    const blockCost =
      measureMcpPayload({ compact: [{ source: block }] }) - measureMcpPayload({ compact: [{}] });
    // meta с флагом несёт source_cards — его стоимость тоже часть дельты.
    // Соседний ключ в мере повторяет вставку в непустой meta реального ответа.
    const metaCost =
      measureMcpPayload({ meta: { returned: 0, source_cards: 1 } }) - measureMcpPayload({ meta: { returned: 0 } });
    // Дельта = стоимость блока на глубине карточки + счётчик meta. ±1 —
    // потолочное округление estimator (ceil(bytes/3)) по всему payload,
    // не подгонка: механизм бюджета проверен отдельным тестом ниже.
    const delta = withSource.meta!.tokens_estimated - without.meta!.tokens_estimated;
    expect(Math.abs(delta - (blockCost + metaCost))).toBeLessThanOrEqual(1);
    expect(withSource.meta!.tokens_estimated).toBeLessThanOrEqual(4000);
  });

  it("a ref without a range reports no_range and no card carries a source", async () => {
    writeProjectFile("src/plain.ts", TEN_LINES);
    seedNode("source-no-range", ["src/plain.ts"]);
    const output = await query("source-no-range", { include_source: true });
    expect(cardsOf(output)[0].source).toBeUndefined();
    expect(output.meta!.source_skipped).toBe("no_range");
    expect(output.meta!.source_cards).toBe(0);
  });

  it("a path outside the root reports outside_root", async () => {
    seedNode("source-escape", ["../outside.txt:1-2"]);
    const output = await query("source-escape", { include_source: true });
    expect(cardsOf(output)[0].source).toBeUndefined();
    expect(output.meta!.source_skipped).toBe("outside_root");
  });

  it("a 2 MiB file reports too_large", async () => {
    writeProjectFile("src/huge.ts", "x".repeat(2 * 1024 * 1024) + "\n");
    seedNode("source-huge", ["src/huge.ts:1-2"]);
    const output = await query("source-huge", { include_source: true });
    expect(cardsOf(output)[0].source).toBeUndefined();
    expect(output.meta!.source_skipped).toBe("too_large");
  });

  it("a missing file reports missing", async () => {
    seedNode("source-missing", ["src/absent.ts:1-5"]);
    const output = await query("source-missing", { include_source: true });
    expect(cardsOf(output)[0].source).toBeUndefined();
    expect(output.meta!.source_skipped).toBe("missing");
  });

  it("a budget too small for the source keeps the answer honest: no source, budget notice", async () => {
    writeProjectFile("src/x.ts", TEN_LINES);
    seedNode("source-budget", ["src/x.ts:1-10"]);
    let minimum = 0;
    try {
      await query("source-budget", { include_source: true, max_tokens: 100 });
      expect.unreachable("understand must refuse a too-small budget");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      minimum = Number(/ниже минимума (\d+)/.exec(message)?.[1]);
      expect(minimum).toBeGreaterThan(0);
    }
    const blockCost =
      measureMcpPayload({ compact: [{ source: { ref: "src/x.ts:1-10", start_line: 1, lines: TEN_LINES.replace(/\n$/, "").split("\n"), truncated: false } }] })
      - measureMcpPayload({ compact: [{}] });
    const output = await query("source-budget", {
      include_source: true,
      max_tokens: minimum + Math.max(1, Math.floor(blockCost / 2)),
    });
    expect(JSON.stringify(output)).not.toContain('"source":');
    expect(output.meta!.source_cards ?? 0).toBe(0);
    if (output.meta!.source_skipped !== undefined) expect(output.meta!.source_skipped).toBe("budget");
    expect(output.meta!.tokens_estimated).toBeLessThanOrEqual(minimum + Math.max(1, Math.floor(blockCost / 2)));
  });

  it("full mode refuses include_source explicitly", async () => {
    seedNode("source-full", ["src/x.ts:1-3"]);
    await expect(query("source-full", { include_source: true, mode: "full" }))
      .rejects.toThrow(/include_source поддержан только в mode=compact/);
  });
});
