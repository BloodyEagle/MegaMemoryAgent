import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { KnowledgeDB } from "../db.js";
import { basicSearch, buildFtsMatch, ftsSearch, hybridSearch, rrfMerge, hasCjk } from "../search.js";
import { ensureSchema } from "../migrate-schema.js";
import { reembed } from "../reembed.js";
import { measureMcpPayload, understand } from "../tools.js";

let tmpDir: string;
let db: KnowledgeDB | undefined;
const profile = process.env.USERPROFILE ?? os.tmpdir();
const managedCleanup = path.basename(profile).startsWith("mm-new6-owned-");
const deferredCleanup = new Set<string>();

function freshDb(withTrigram = false): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(managedCleanup ? profile : os.tmpdir(), "mm-search-"));
  if (withTrigram) {
    process.env.MEGAMEMORY_FTS_TOKENIZER = "trigram";
  }
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  delete process.env.MEGAMEMORY_FTS_TOKENIZER;
  return db;
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.MEGAMEMORY_SEARCH;
  db?.close();
  db = undefined;
  if (!tmpDir) return;
  for (let i = 0; i < 40; i++) {
    (globalThis as { gc?: () => void }).gc?.();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  deferredCleanup.add(tmpDir);
});

afterAll(() => {
  for (const ownedDir of deferredCleanup) {
    (globalThis as { gc?: () => void }).gc?.();
    try { fs.rmSync(ownedDir, { recursive: true, force: true }); deferredCleanup.delete(ownedDir); }
    catch { /* The supervisor removes its isolated profile after worker exit. */ }
  }
  if (!deferredCleanup.size) return;
  if (!managedCleanup) throw new Error(`P10_OWNED_CLEANUP_FAILED ${[...deferredCleanup].join(",")}`);
  console.info(`P10_PARENT_CLEANUP_REQUIRED ${[...deferredCleanup].join(",")}`);
});

function insertNode(db: KnowledgeDB, id: string, name: string, summary: string): void {
  db.insertNode({ id, name, kind: "feature", summary });
}

const fakeEmbed = (vec: number[]) => async (): Promise<Buffer> => {
  const v = new Float32Array(vec);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
};

describe("hybridSearch (vector disabled — no meta stamp)", () => {
  it("finds russian node by exact word, with via=fts", async () => {
    const db = freshDb();
    insertNode(db, "книга", "Книга", "рецепты кулинария и тесто");
    insertNode(db, "модуль", "Модуль платежей", "платёжный шлюз");

    const hits = await hybridSearch(db, "кулинария", { topK: 5 });
    expect(hits[0]?.id).toBe("книга");
    expect(hits[0]?.via).toBe("fts");
  });

  it("finds chinese node via trigram table (>=3 chars)", async () => {
    const db = freshDb(true);
    insertNode(db, "模块", "模块设计", "支付模块");
    insertNode(db, "book", "Book", "english summary");

    const hits = await hybridSearch(db, "模块设计", { topK: 5 });
    expect(hits[0]?.id).toBe("模块");
    expect(hits[0]?.via).toBe("fts");
  });

  it("short CJK query falls back to LIKE", async () => {
    const db = freshDb(true);
    insertNode(db, "模块", "模块设计", "支付模块");

    const hits = await hybridSearch(db, "模块", { topK: 5 });
    expect(hits[0]?.id).toBe("模块");
  });

  it("empty index returns empty result without throwing", async () => {
    const db = freshDb();
    const hits = await hybridSearch(db, "что-то", { topK: 5 });
    expect(hits).toEqual([]);
  });
});

describe("hybridSearch (vector enabled)", () => {
  it("merges both channels and marks via=both for double hits", async () => {
    const db = freshDb();
    insertNode(db, "alpha", "Alpha Book", "reading");
    insertNode(db, "beta", "Beta Pen", "writing");
    // Explicit indexing establishes the fixture's active generation; model-only
    // stamps must never launder unknown historical vectors.
    await reembed(db, { embedFn: fakeEmbed([1, 0, 0, 0]) });

    const hits = await hybridSearch(db, "book", {
      topK: 5,
      embedFn: fakeEmbed([1, 0, 0, 0]),
    });
    expect(hits.length).toBeGreaterThan(0);
    const alpha = hits.find((h) => h.id === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.via).toBe("both");
  });
});

describe("C1 understand match metadata", () => {
  it.each(
    (["hybrid", "fts", "vector"] as const).flatMap((searchMode) =>
      (["compact", "full", "brief"] as const).map((mode) => ({ searchMode, mode }))
    )
  )("preserves opt-in and no_match in $searchMode/$mode", async ({ searchMode, mode }) => {
    const db = freshDb();
    insertNode(db, "alpha", "Alpha", "alpha pipeline configuration");
    insertNode(db, "beta", "Beta", "beta migration hooks");
    process.env.MEGAMEMORY_SEARCH = searchMode;
    // No generation: even vector-only mode exercises keyword fallback without inference.
    expect(db.getVectorGeneration()).toBeFalsy();
    const input = { query: "alpha beta", top_k: 5, max_tokens: 20000, mode };

    const defaultResult = await understand(db, input);
    expect(defaultResult.meta).toMatchObject({ reason: "no_match", returned: 0 });
    expect(defaultResult.meta).not.toHaveProperty("match");
    expect(defaultResult.meta!.tokens_estimated).toBe(measureMcpPayload(defaultResult));

    const all = await understand(db, { ...input, match: "all" });
    expect(all.meta).toMatchObject({ reason: "no_match", returned: 0, match: "all" });
    expect(all.meta!.tokens_estimated).toBe(measureMcpPayload(all));

    const any = await understand(db, { ...input, match: "any" });
    expect(any.meta).toMatchObject({ returned: 2, match: "any" });
    expect(any.meta).not.toHaveProperty("reason");
    expect(any.meta!.tokens_estimated).toBe(measureMcpPayload(any));

    const positiveDefault = await understand(db, { ...input, query: "alpha" });
    expect(positiveDefault.meta).toMatchObject({ returned: 1 });
    expect(positiveDefault.meta).not.toHaveProperty("match");
    expect(positiveDefault.meta).not.toHaveProperty("reason");
    expect(positiveDefault.meta!.tokens_estimated).toBe(measureMcpPayload(positiveDefault));

    for (const match of [undefined, "all", "any"] as const) {
      const miss = await understand(db, {
        ...input, query: "zzmissing zzabsent", ...(match ? { match } : {}),
      });
      expect(miss.meta).toMatchObject({ reason: "no_match", returned: 0 });
      if (match) expect(miss.meta!.match).toBe(match);
      else expect(miss.meta).not.toHaveProperty("match");
      expect(miss.meta!.tokens_estimated).toBe(measureMcpPayload(miss));
    }
  });
});

describe("C1 explicit keyword match", () => {
  it("keeps the default AND expression and quotes each OR token", () => {
    expect(buildFtsMatch("  alpha   beta  ")).toBe('"alpha"* "beta"*');
    expect(buildFtsMatch("alpha beta", { any: false })).toBe(buildFtsMatch("alpha beta"));
    expect(buildFtsMatch('alpha OR "beta"', { any: true })).toBe('"alpha"* OR "OR"* OR """beta"""*');
  });

  it("keeps default search byte-identical to explicit all", async () => {
    const db = freshDb();
    insertNode(db, "joint", "Joint", "alpha beta");
    insertNode(db, "partial", "Partial", "alpha");
    expect(ftsSearch(db, "alpha beta", 5, { any: false })).toEqual(ftsSearch(db, "alpha beta", 5));
    expect(basicSearch(db, "alpha beta", 5, { any: false })).toEqual(basicSearch(db, "alpha beta", 5));
    const defaultHits = await hybridSearch(db, "alpha beta", { topK: 5 });
    expect(defaultHits.map((hit) => hit.id)).toEqual(["joint"]);
    expect(JSON.stringify(await hybridSearch(db, "alpha beta", { topK: 5, match: "all" })))
      .toBe(JSON.stringify(defaultHits));
  });

  it("returns OR candidates only when any is explicitly requested", async () => {
    const db = freshDb();
    insertNode(db, "alpha", "Alpha", "pipeline");
    insertNode(db, "beta", "Beta", "configuration");
    insertNode(db, "other", "Other", "unrelated");
    expect(await hybridSearch(db, "alpha beta", { match: "all" })).toEqual([]);
    expect(await hybridSearch(db, "alpha beta")).toEqual([]);
    const hits = await hybridSearch(db, "alpha beta", { match: "any" });
    expect(hits.map((hit) => hit.id).sort()).toEqual(["alpha", "beta"]);
    expect(hits.every((hit) => hit.via === "fts")).toBe(true);
    expect(basicSearch(db, "alpha beta", 5, { any: true }).map((hit) => hit.id).sort())
      .toEqual(["alpha", "beta"]);
    expect(await hybridSearch(db, "zzmissing zzabsent", { match: "any" })).toEqual([]);
  });

  it.each([true, false])("ORs literal LIKE tokens without FTS (name_norm=%s)", (hasNorm) => {
    const db = freshDb();
    insertNode(db, "alpha", "Книга", "alpha");
    insertNode(db, "beta", "Beta", "beta");
    insertNode(db, "other", "Other", "unrelated");
    db.execSql("DROP TABLE nodes_fts");
    if (!hasNorm) vi.spyOn(db, "pragma").mockReturnValue([]);
    expect(ftsSearch(db, "alpha beta", 5)).toEqual([]);
    expect(ftsSearch(db, "alpha beta", 5, { any: false })).toEqual([]);
    expect(ftsSearch(db, "alpha beta", 5, { any: true }).map((hit) => hit.id))
      .toEqual(["alpha", "beta"]);
    expect(ftsSearch(db, "alpha beta", 1, { any: true }).map((hit) => hit.id)).toEqual(["alpha"]);
    expect(ftsSearch(db, "zzmissing zzabsent", 5, { any: true })).toEqual([]);
    expect(ftsSearch(db, "% _ \\", 5, { any: true })).toEqual([]);
    if (hasNorm) expect(ftsSearch(db, "КНИГА zzmissing", 5, { any: true })[0]?.id).toBe("alpha");
  });

  it.each(["hybrid", "vector"] as const)("keeps %s vector query and ranking unchanged", async (mode) => {
    const db = freshDb();
    insertNode(db, "alpha", "Alpha", "pipeline");
    insertNode(db, "beta", "Beta", "configuration");
    await reembed(db, { embedFn: async (text) =>
      fakeEmbed(text.includes("Alpha") ? [1, 0, 0, 0] : [0, 1, 0, 0])() });
    process.env.MEGAMEMORY_SEARCH = mode;
    const embedFn = vi.fn(async (_text: string): Promise<Buffer> => fakeEmbed([1, 0, 0, 0])());
    const query = mode === "vector" ? "alpha beta" : "zzmissing zzabsent";
    const options = { topK: 5, embedFn };
    const original = await hybridSearch(db, query, options);
    expect(original[0]?.id).toBe("alpha");
    expect(original.every((hit) => hit.via === "vector")).toBe(true);
    expect(await hybridSearch(db, query, { ...options, match: "all" })).toEqual(original);
    expect(await hybridSearch(db, query, { ...options, match: "any" })).toEqual(original);
    const expectedQuery = embedFn.mock.calls[0][0];
    expect(expectedQuery).toContain(query);
    expect(embedFn.mock.calls.map(([text]) => text)).toEqual([expectedQuery, expectedQuery, expectedQuery]);
  });

  it("preserves explicit any when vector-only mode falls back to keyword search", async () => {
    const db = freshDb();
    insertNode(db, "alpha", "Alpha", "pipeline");
    insertNode(db, "beta", "Beta", "configuration");
    process.env.MEGAMEMORY_SEARCH = "vector";
    expect(await hybridSearch(db, "alpha beta")).toEqual([]);
    expect((await hybridSearch(db, "alpha beta", { match: "any" })).map((hit) => hit.id).sort())
      .toEqual(["alpha", "beta"]);
  });

  it("does not forward a match query parameter from /api/search", async () => {
    const source = fs.readFileSync(new URL("../web.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("web.ts", source, ts.ScriptTarget.Latest, true);
    let route = "";
    function visit(node: ts.Node): void {
      if (ts.isIfStatement(node) && node.expression.getText(ast) === 'pathname === "/api/search" && req.method === "GET"') {
        route = node.getText(ast);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(route).not.toBe("");
    const db = freshDb();
    const search = vi.fn(async () => ({ compact: [] }));
    const respond = vi.fn();
    const url = new URL("http://127.0.0.1:8765/api/search?q=alpha%20beta&top_k=5&match=any");
    const script = ts.transpileModule(`(async () => { ${route} })()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await vm.runInNewContext(script, {
      url, pathname: url.pathname, req: { method: "GET" }, res: {}, db,
      embeddingsReady: false, isTextOnlySearchMode: () => true,
      vectorSearchEnabled: () => false, understand: search, json: respond,
    });
    expect(search).toHaveBeenCalledWith(db, { query: "alpha beta", top_k: 5 });
    expect(respond).toHaveBeenCalledWith({}, { matches: [], meta: null });
  });
});

describe("rrfMerge", () => {
  it("ranks shared hits above single-channel hits", () => {
    const merged = rrfMerge(
      [
        { hits: [{ id: "a" }, { id: "b" }, { id: "c" }], via: "fts" },
        { hits: [{ id: "b" }, { id: "d" }], via: "vector" },
      ],
      60,
      10
    );
    expect(merged[0].id).toBe("b"); // present in both pools
    expect(merged[0].via).toBe("both");
  });
});

describe("hasCjk", () => {
  it("detects CJK and ignores cyrillic/latin", () => {
    expect(hasCjk("模块设计")).toBe(true);
    expect(hasCjk("ひらがな")).toBe(true);
    expect(hasCjk("книга")).toBe(false);
    expect(hasCjk("book")).toBe(false);
  });
});

describe("patches v1.1: prefix morphology (М3), sanitization (М1), native vectors (В17)", () => {
  it("prefix query finds nodes by incomplete word: книг -> Книга", async () => {
    const db = freshDb();
    insertNode(db, "книга", "Книга", "рецепты и заметки");
    const hits = await hybridSearch(db, "книг", { topK: 5 });
    expect(hits[0]?.id).toBe("книга");
  });

  it("raw quotes in query do not throw (М1 sanitization)", async () => {
    const db = freshDb();
    insertNode(db, "quoted", 'Say "hi" now', "greeting");
    const hits = await hybridSearch(db, 'say "hi"', { topK: 5 });
    expect(hits[0]?.id).toBe("quoted");
  });

  it("native SQL vector path drives the vector channel (В17)", async () => {
    const db = freshDb();
    insertNode(db, "alpha", "Alpha Book", "reading");
    insertNode(db, "beta", "Beta Pen", "writing");
    await reembed(db, { embedFn: async (text) =>
      fakeEmbed(text.includes("Alpha Book") ? [1, 0, 0, 0] : [0, 1, 0, 0])() });

    // Explicit publication fills the current native projection atomically.
    expect(db.vectorTableCount()).toBe(2);
    expect(db.vectorTableCount()).toBeGreaterThanOrEqual(
      db.countActiveWithEmbeddings()
    );

    const hits = await hybridSearch(db, "book", {
      topK: 5,
      embedFn: fakeEmbed([1, 0, 0, 0]),
    });
    const alpha = hits.find((h) => h.id === "alpha");
    const beta = hits.find((h) => h.id === "beta");
    expect(alpha?.via).toBe("both"); // fts + vector
    expect(beta?.via).toBe("vector"); // vector only, orthogonal to the query
  });
});
