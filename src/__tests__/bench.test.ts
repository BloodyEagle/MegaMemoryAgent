import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { link, estimateTokens } from "../tools.js";
import {
  BenchError,
  BENCH_DISCLAIMER,
  type BenchOptions,
  type BenchQuestion,
  type TeRunResult,
  detectColdStart,
  loadQuestions,
  runBench,
  splitRefSuffix,
} from "../bench.js";
import { formatIdList, formatWarmupLine, questionNotes } from "../bench-cli.js";
import {
  claimDigestOf,
  confirmSupports,
  edgeDigestOf,
  statusDigestOf,
} from "../support-baselines.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// bench читает живой поиск (FTS) и провенанс; векторы на фикстуре выключены
// (узлы без embedding), поэтому мокать embeddings не нужно.

let tmpDir: string;
let db: KnowledgeDB;
let root: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-bench-"));
  root = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "loader.ts"),
    "export function loadCatalog(p: string) {\n  return read(p);\n}\n"
  );
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  // фикстурные узлы с file_refs на файлы репозитория
  db.insertNode({
    id: "catalog-import-entry",
    name: "catalog-import-entry",
    kind: "feature",
    summary: "entry point of the catalog import pipeline",
    file_refs: ["src/loader.ts"],
  });
  db.insertNode({
    id: "catalog-path-resolution",
    name: "catalog-path-resolution",
    kind: "decision",
    summary: "how catalog import resolves module paths",
    file_refs: ["src/loader.ts"],
  });
});

// Close only: libsql on Windows может держать файл до ~10 с после close.
afterEach(() => {
  db.close();
});

function opts(over: Partial<BenchOptions> = {}): BenchOptions {
  // git-root по умолчанию выключен: тесты герметичны, git не вызывается
  return { baseline: "files", root, resolveGitRoot: () => null, ...over };
}

/** Заглушка внешнего структурного инструмента: считает вызовы, печатает фиксированный текст. */
function teStub(stdout = "alpha beta gamma", delayMs = 3) {
  const calls: string[] = [];
  const run = async (cmd: string): Promise<TeRunResult> => {
    calls.push(cmd);
    return { stdout, durationMs: delayMs };
  };
  return { run, calls };
}

describe("megamemory bench (2.1.5 F3)", () => {
  it("1. files: ratio считается, graph_tokens и baseline_tokens положительные", async () => {
    const questions: BenchQuestion[] = [
      { id: "q1", query: "catalog-import-entry", expect_nodes: ["catalog-import-entry"] },
      { id: "q2", query: "catalog-path-resolution", expect_nodes: ["catalog-path-resolution"] },
    ];
    const report = await runBench(db, questions, opts());
    expect(report.questions).toHaveLength(2);
    for (const q of report.questions) {
      expect(q.graph_tokens).toBeGreaterThan(0);
      expect(q.baseline_files_tokens).toBeGreaterThan(0);
      expect(q.ratio_files).not.toBeNull();
      expect(q.ratio_files!).toBeGreaterThan(0);
      expect(q.hit).toBe(true);
      expect(q.time_to_graph_ms).toBeGreaterThanOrEqual(0);
      expect(q.time_to_baseline_ms).not.toBeNull();
    }
    expect(report.files).not.toBeNull();
    expect(report.te).toBeNull();
  });

  it("2. вопрос без совпадений: graph_tokens минимальный, hit_rate = 0, не падает", async () => {
    const questions: BenchQuestion[] = [
      { id: "q1", query: "zzzqqq nothing matches this", expect_nodes: ["catalog-import-entry"] },
    ];
    const report = await runBench(db, questions, opts());
    const q = report.questions[0];
    // План 06 (K-03): оценка честная — пустой ответ стоит конверт+meta
    // (~130 токенов), нулём он больше не притворяется.
    // План 13: в ответе всегда есть блок next (record не режется никогда) —
    // пустой ответ стоит конверт+meta+record (~205 в этой фикстуре), кап поднят до 220.
    expect(q.graph_tokens).toBeGreaterThan(0);
    expect(q.graph_tokens).toBeLessThanOrEqual(220);
    expect(q.ratio_files).toBeNull();
    expect(q.hit).toBe(false);
    expect(report.hit_rate).toBe(0);
    expect(report.files!.compared).toBe(0);
    expect(report.files!.median_ratio).toBeNull();
  });

  it("3. файл больше лимита: estimated: true, токены посчитаны по размеру", async () => {
    const bigPath = path.join(root, "src", "big.log");
    const big = "x".repeat(1500); // 1500 байт
    fs.writeFileSync(bigPath, big);
    db.insertNode({
      id: "big-log-node",
      name: "big-log-node",
      kind: "fact",
      summary: "points at the big log file",
      file_refs: ["src/big.log"],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "big-log-node", expect_nodes: ["big-log-node"] }],
      opts({ fileLimitBytes: 100 })
    );
    const q = report.questions[0];
    expect(q.estimated).toBe(true);
    expect(q.baseline_files_tokens).toBe(Math.ceil(big.length / 3));
  });

  it("4. суммарная строка совпадает с суммой по вопросам", async () => {
    const questions: BenchQuestion[] = [
      { id: "q1", query: "catalog-import-entry", expect_nodes: ["catalog-import-entry"] },
      { id: "q2", query: "catalog-path-resolution", expect_nodes: ["catalog-path-resolution"] },
    ];
    const report = await runBench(db, questions, opts());
    expect(report.files!.graph_tokens).toBe(
      report.questions.reduce((s, q) => s + q.graph_tokens, 0)
    );
    expect(report.files!.baseline_tokens).toBe(
      report.questions.reduce((s, q) => s + (q.baseline_files_tokens ?? 0), 0)
    );
  });

  it("5. пустой файл вопросов — понятная ошибка", async () => {
    expect(loadQuestions("\n  \n")).toEqual([]);
    await expect(runBench(db, [], opts())).rejects.toThrow(BenchError);
    await expect(runBench(db, [], opts())).rejects.toThrow(/empty/i);
    // битая строка — с номером строки
    expect(() => loadQuestions('{"query": "a"}\nnot json')).toThrow(/line 2/);
    expect(() => loadQuestions('{"id": "q1"}')).toThrow(/"query"/);
  });

  it("6. te с заглушкой: baseline_te_tokens равен токенам текста, время замерено", async () => {
    const stub = teStub("structured outline output");
    const report = await runBench(
      db,
      [{ id: "q1", query: "catalog-import-entry", expect_nodes: ["catalog-import-entry"] }],
      opts({ baseline: "te", teCmd: "outline {query}", runTeCommand: stub.run })
    );
    const q = report.questions[0];
    expect(q.baseline_te_tokens).toBe(estimateTokens("structured outline output"));
    expect(q.time_to_te_ms).toBeGreaterThanOrEqual(0);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toContain("catalog-import-entry");
    expect(report.te!.baseline_tokens).toBe(q.baseline_te_tokens!);
    expect(report.files).toBeNull();
  });

  it("7. te без команды-шаблона — ошибка с подсказкой про {query}", async () => {
    await expect(
      runBench(
        db,
        [{ id: "q1", query: "catalog-import-entry" }],
        opts({ baseline: "te" })
      )
    ).rejects.toThrow(BenchError);
    await expect(
      runBench(
        db,
        [{ id: "q1", query: "catalog-import-entry" }],
        opts({ baseline: "te", teCmd: "outline without placeholder" })
      )
    ).rejects.toThrow(/\{query\}/);
  });

  it("8. both: в отчёте оба отношения и оба итога", async () => {
    const stub = teStub();
    const questions: BenchQuestion[] = [
      { id: "q1", query: "catalog-import-entry", expect_nodes: ["catalog-import-entry"] },
      { id: "q2", query: "catalog-path-resolution", expect_nodes: ["catalog-path-resolution"] },
    ];
    const report = await runBench(
      db,
      questions,
      opts({ baseline: "both", teCmd: "outline {query}", runTeCommand: stub.run })
    );
    for (const q of report.questions) {
      expect(q.ratio_files).not.toBeNull();
      expect(q.ratio_te).not.toBeNull();
    }
    expect(report.files!.median_ratio).not.toBeNull();
    expect(report.te!.median_ratio).not.toBeNull();
    expect(report.files!.lost).toBeGreaterThanOrEqual(0);
    expect(report.te!.lost).toBeGreaterThanOrEqual(0);
    // оговорка едет в отчёте, а не только в CLI
    expect(report.disclaimer).toBe(BENCH_DISCLAIMER);
    expect(report.disclaimer).toContain("hit_rate");
  });

  it("9. baseline_te_tokens из файла вопросов используется без вызова команды", async () => {
    const stub = teStub();
    const report = await runBench(
      db,
      [{ id: "q1", query: "catalog-import-entry", baseline_te_tokens: 500 }],
      opts({ baseline: "te", teCmd: "outline {query}", runTeCommand: stub.run })
    );
    const q = report.questions[0];
    expect(stub.calls).toHaveLength(0);
    expect(q.baseline_te_tokens).toBe(500);
    expect(q.te_used_preset).toBe(true);
    expect(q.ratio_te).toBe(500 / q.graph_tokens);
  });

  it("10. te_cmd вопроса перебивает --te-cmd прогона; разбивка по lang в отчёте", async () => {
    const stub = teStub();
    const questions: BenchQuestion[] = [
      {
        id: "q1",
        query: "catalog-import-entry",
        lang: "python",
        te_cmd: "python-graph.py rdeps {query}",
      },
      { id: "q2", query: "catalog-path-resolution", lang: "typescript", te_cmd: undefined },
    ];
    const report = await runBench(
      db,
      questions,
      opts({ baseline: "te", teCmd: "ts-graph {query}", runTeCommand: stub.run })
    );
    expect(stub.calls[0]).toContain("python-graph.py rdeps");
    expect(stub.calls[1]).toContain("ts-graph");
    expect(report.per_lang).toHaveLength(2);
    const py = report.per_lang.find((l) => l.lang === "python")!;
    const ts = report.per_lang.find((l) => l.lang === "typescript")!;
    expect(py.questions).toBe(1);
    expect(ts.questions).toBe(1);
    expect(py.median_ratio_te).not.toBeNull();
    expect(ts.median_ratio_te).not.toBeNull();
    // lang попадает в строку вопроса
    expect(report.questions[0].lang).toBe("python");
  });

  it("11. stale_hits и unknown_supports считаются по найденным узлам", async () => {
    // решение с живой, но неподтверждённой опорой → unknown_supports
    db.insertNode({
      id: "unconfirmed-decision",
      name: "unconfirmed-decision",
      kind: "decision",
      summary: "a decision nobody confirmed",
    });
    db.insertNode({
      id: "its-support",
      name: "its-support",
      kind: "fact",
      summary: "the support of the unconfirmed decision",
    });
    link(db, {
      from: "unconfirmed-decision",
      to: "its-support",
      relation: "informed_by",
      description: "because of its-support",
    });

    // решение с подтверждённой опорой, у которой потом изменили формулировку → stale_hits
    db.insertNode({
      id: "stale-decision",
      name: "stale-decision",
      kind: "decision",
      summary: "a decision with a confirmed-then-changed support",
    });
    db.insertNode({
      id: "stale-support",
      name: "stale-support",
      kind: "fact",
      summary: "original wording of the support",
    });
    link(db, {
      from: "stale-decision",
      to: "stale-support",
      relation: "informed_by",
      description: "why stale-support",
    });
    const edge = db.getInformedByEdges("stale-decision", "ancestry", false)[0];
    confirmSupports(db, {
      decision_id: "stale-decision",
      expected_claim_digest: claimDigestOf(db.getNode("stale-decision")!.summary),
      items: [
        {
          support_id: "stale-support",
          expected_claim_digest: claimDigestOf("original wording of the support"),
          expected_status_digest: statusDigestOf(
            db.getNode("stale-support")!.status,
            db.getNode("stale-support")!.epistemic_status
          ),
          expected_edge_digest: edgeDigestOf(edge.description),
        },
      ],
    });
    // после подтверждения опора переписана — снимок разошёлся
    db.updateNode("stale-support", { summary: "rewritten wording of the support" });

    const report = await runBench(
      db,
      [
        { id: "q1", query: "unconfirmed-decision", expect_nodes: ["unconfirmed-decision"] },
        { id: "q2", query: "stale-decision", expect_nodes: ["stale-decision"] },
        { id: "q3", query: "catalog-import-entry", expect_nodes: ["catalog-import-entry"] },
      ],
      opts()
    );
    expect(report.unknown_supports).toBe(1);
    expect(report.stale_hits).toBe(1);
    // q3 — не решение, не должно считаться
    expect(report.questions[2].unknown_supports).toBe(0);
  });

  it("loadQuestions читает формат: id, query, expect_nodes, lang, te_cmd, baseline_te_tokens", () => {
    const qs = loadQuestions(
      [
        '{"id": "q1", "query": "как устроен импорт каталога", "expect_nodes": ["catalog-import-entry"]}',
        '{"id": "q7", "query": "где вызывается apply_catalog", "lang": "python", "te_cmd": "python graph.py rdeps {query}"}',
        '{"query": "preset question", "baseline_te_tokens": 420}',
      ].join("\n")
    );
    expect(qs).toHaveLength(3);
    expect(qs[0].expect_nodes).toEqual(["catalog-import-entry"]);
    expect(qs[1].lang).toBe("python");
    expect(qs[1].te_cmd).toContain("{query}");
    // id не задан — генерируется по порядку
    expect(qs[2].id).toBe("q3");
    expect(qs[2].baseline_te_tokens).toBe(420);
  });
});

describe("megamemory bench 2.1.6 — честные цифры", () => {
  // ---- F1: ранг и id найденного ----

  it("F1-1. узел на первом месте: expected_rank = 1, hit_rate@1 = 1", async () => {
    const report = await runBench(
      db,
      [{ id: "q1", query: "catalog-import-entry", expect_nodes: ["catalog-import-entry"] }],
      opts()
    );
    const q = report.questions[0];
    expect(q.expected_rank).toBe(1);
    expect(q.top_ids[0]).toBe("catalog-import-entry");
    expect(report.hit_rate).toBe(1);
    expect(report.hit_rate_at_1).toBe(1);
    expect(report.hits_at_1).toBe(1);
  });

  it("F1-2. узел на третьем месте: expected_rank = 3, hit@1 не растёт, hit@10 растёт", async () => {
    // три узла с общими токенами — выдача вернёт все три в некотором порядке
    const names = ["ranked-one", "ranked-two", "ranked-three"];
    for (const [i, name] of names.entries()) {
      db.insertNode({
        id: name,
        name,
        kind: "fact",
        summary: `alpha beta marker-${i + 1}`,
      });
    }
    // прогон 1: без expect — узнаём фактический порядок выдачи
    const run1 = await runBench(db, [{ id: "q1", query: "alpha beta" }], opts());
    const topIds = run1.questions[0].top_ids;
    expect(topIds).toHaveLength(3);
    // прогон 2: ожидаем узел, который встал третьим
    const third = topIds[2];
    const run2 = await runBench(
      db,
      [{ id: "q1", query: "alpha beta", expect_nodes: [third] }],
      opts()
    );
    const q = run2.questions[0];
    expect(q.expected_rank).toBe(3);
    expect(q.hit).toBe(true);
    expect(run2.hit_rate).toBe(1);
    expect(run2.hit_rate_at_1).toBe(0);
    expect(run2.hits_at_1).toBe(0);
  });

  it("F1-3. expect_nodes не задан: expected_rank = null, вопрос не входит ни в один hit_rate", async () => {
    const report = await runBench(
      db,
      [{ id: "q1", query: "catalog-import-entry" }],
      opts()
    );
    const q = report.questions[0];
    expect(q.expected_rank).toBeNull();
    expect(q.hit).toBeNull();
    expect(report.hit_rate).toBeNull();
    expect(report.hit_rate_at_1).toBeNull();
    expect(report.expected_total).toBe(0);
  });

  // ---- F2: суффикс строки в file_refs ----

  it("F2-4. src/loader.ts:9 и src/loader.ts:605-643 считаются тем же файлом, что src/loader.ts", async () => {
    db.insertNode({
      id: "suffixed-refs",
      name: "suffixed-refs",
      kind: "fact",
      summary: "refs carrying line suffixes",
      file_refs: ["src/loader.ts:9", "src/loader.ts:605-643", "src/loader.ts"],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "suffixed-refs", expect_nodes: ["suffixed-refs"] }],
      opts()
    );
    const q = report.questions[0];
    const once = estimateTokens(
      fs.readFileSync(path.join(root, "src", "loader.ts"), "utf8")
    );
    // токены не утроены: все три рефа — один файл
    expect(q.baseline_files_tokens).toBe(once);
    expect(q.missing_files).toBe(0);
    // суффикс строки только у двух из трёх рефов
    expect(q.line_refs).toBe(2);
    expect(splitRefSuffix("src/db.ts:9")).toEqual({ path: "src/db.ts", suffix: "9" });
    expect(splitRefSuffix("src/db.ts:605-643")).toEqual({
      path: "src/db.ts",
      suffix: "605-643",
    });
  });

  it("F2-5. Windows-путь с двоеточием диска не режется", () => {
    expect(splitRefSuffix("C:\\p\\proj\\src\\db.ts")).toEqual({
      path: "C:\\p\\proj\\src\\db.ts",
      suffix: "",
    });
    expect(splitRefSuffix("C:\\p\\proj\\src\\db.ts:9")).toEqual({
      path: "C:\\p\\proj\\src\\db.ts",
      suffix: "9",
    });
  });

  it("F2-6. двоеточие внутри имени файла не режется", () => {
    expect(splitRefSuffix("a:b.ts")).toEqual({ path: "a:b.ts", suffix: "" });
    expect(splitRefSuffix("a:b.ts:9")).toEqual({ path: "a:b.ts", suffix: "9" });
    // не-числовой хвост — не суффикс
    expect(splitRefSuffix("src/db.ts:abc")).toEqual({ path: "src/db.ts:abc", suffix: "" });
  });

  it("F2-7. пустой суффикс (src/db.ts:) — missing, не падение", async () => {
    expect(splitRefSuffix("src/db.ts:")).toEqual({ path: "src/db.ts:", suffix: "" });
    db.insertNode({
      id: "empty-suffix",
      name: "empty-suffix",
      kind: "fact",
      summary: "ref with a bare trailing colon",
      file_refs: ["src/loader.ts:"],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "empty-suffix", expect_nodes: ["empty-suffix"] }],
      opts()
    );
    const q = report.questions[0];
    expect(q.missing_files).toBe(1);
    expect(q.baseline_files_tokens).toBe(0);
    expect(q.line_refs).toBe(0);
  });

  // ---- F3: несколько корней для рефов ----

  it("F3-8. реф находится от git-корня при cwd в подкаталоге", async () => {
    fs.writeFileSync(path.join(root, "src", "x.ts"), "export const x = 1;\n");
    fs.mkdirSync(path.join(root, "sub", "deep"), { recursive: true });
    db.insertNode({
      id: "rooted-ref",
      name: "rooted-ref",
      kind: "fact",
      summary: "a ref rooted at the repository root",
      file_refs: ["src/x.ts"],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "rooted-ref", expect_nodes: ["rooted-ref"] }],
      opts({ root: path.join(root, "sub", "deep"), resolveGitRoot: () => root })
    );
    const q = report.questions[0];
    expect(q.missing_files).toBe(0);
    expect(q.baseline_files_tokens).toBeGreaterThan(0);
    expect(report.refs!.roots["git-root"]).toBe(1);
    expect(report.refs!.resolved).toBe(1);
  });

  it("F3-9. --ref-root перебивает cwd", async () => {
    const repoB = path.join(tmpDir, "repoB");
    fs.mkdirSync(path.join(repoB, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoB, "src", "dup.ts"), "from repo b, longer content\n".repeat(4));
    fs.writeFileSync(path.join(root, "src", "dup.ts"), "cwd version\n");
    db.insertNode({
      id: "dup-ref",
      name: "dup-ref",
      kind: "fact",
      summary: "the same relative ref in two roots",
      file_refs: ["src/dup.ts"],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "dup-ref", expect_nodes: ["dup-ref"] }],
      opts({ refRoots: [repoB] })
    );
    const q = report.questions[0];
    expect(q.missing_files).toBe(0);
    // взят из --ref-root, не из cwd
    expect(q.baseline_files_tokens).toBe(
      estimateTokens("from repo b, longer content\n".repeat(4))
    );
    expect(report.refs!.roots["--ref-root"]).toBe(1);
    expect(report.refs!.roots.cwd).toBeUndefined();
  });

  it("F3-10. ref_roots вопроса перебивает --ref-root", async () => {
    const repoQ = path.join(tmpDir, "repoQ");
    const repoB = path.join(tmpDir, "repoB");
    for (const repo of [repoQ, repoB]) {
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      fs.writeFileSync(path.join(repo, "src", "tri.ts"), `content of ${repo}\n`);
    }
    fs.writeFileSync(path.join(root, "src", "tri.ts"), "content of cwd\n");
    db.insertNode({
      id: "tri-ref",
      name: "tri-ref",
      kind: "fact",
      summary: "one relative ref, three candidate roots",
      file_refs: ["src/tri.ts"],
    });
    const qs = loadQuestions(
      JSON.stringify({ id: "q1", query: "tri-ref", ref_roots: [repoQ] })
    );
    const report = await runBench(db, qs, opts({ refRoots: [repoB] }));
    const q = report.questions[0];
    expect(q.missing_files).toBe(0);
    expect(q.baseline_files_tokens).toBe(estimateTokens(`content of ${repoQ}\n`));
    expect(report.refs!.roots.question).toBe(1);
    expect(report.refs!.roots["--ref-root"]).toBeUndefined();
  });

  it("F3-11. один реф, найденный в двух корнях, даёт один файл — токены не удваиваются", async () => {
    const repoB = path.join(tmpDir, "repoB");
    fs.mkdirSync(path.join(repoB, "src"), { recursive: true });
    const contentB = "the one true content\n".repeat(3);
    fs.writeFileSync(path.join(repoB, "src", "once.ts"), contentB);
    fs.writeFileSync(path.join(root, "src", "once.ts"), "cwd copy\n");
    db.insertNode({
      id: "once-ref",
      name: "once-ref",
      kind: "fact",
      summary: "exists in two roots, counted once",
      file_refs: ["src/once.ts", "src/once.ts"],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "once-ref", expect_nodes: ["once-ref"] }],
      opts({ refRoots: [repoB] })
    );
    const q = report.questions[0];
    expect(q.baseline_files_tokens).toBe(estimateTokens(contentB));
    expect(report.files!.baseline_tokens).toBe(estimateTokens(contentB));
    expect(report.refs!.roots["--ref-root"]).toBe(1);
    expect(report.refs!.resolved).toBe(1);
  });

  // ---- F4: --files-top N ----

  it("F4-12. files-top 1 даёт меньше токенов, чем все рефы, и r меньше", async () => {
    const contentA = "a".repeat(300);
    const contentB = "b".repeat(600);
    fs.writeFileSync(path.join(root, "src", "a-top.ts"), contentA);
    fs.writeFileSync(path.join(root, "src", "b-rest.ts"), contentB);
    db.insertNode({
      id: "top-files",
      name: "top-files",
      kind: "fact",
      summary: "two files for the top baseline",
      file_refs: ["src/a-top.ts", "src/b-rest.ts"],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "top-files", expect_nodes: ["top-files"] }],
      opts({ filesTopN: 1 })
    );
    const q = report.questions[0];
    expect(q.baseline_files_top_tokens).toBe(estimateTokens(contentA));
    expect(q.baseline_files_top_tokens!).toBeLessThan(q.baseline_files_tokens!);
    expect(q.ratio_files_top!).toBeLessThan(q.ratio_files!);
    expect(report.files!.baseline_top_tokens).toBe(estimateTokens(contentA));
    expect(report.files!.median_ratio_top).not.toBeNull();
    // контракт: r(files-top) ≤ r(files)
    expect(q.ratio_files_top!).toBeLessThanOrEqual(q.ratio_files!);
  });

  it("F4-13. N больше числа файлов: r(files-top) равен r(files)", async () => {
    const contentA = "a".repeat(300);
    fs.writeFileSync(path.join(root, "src", "a-top.ts"), contentA);
    db.insertNode({
      id: "single-file",
      name: "single-file",
      kind: "fact",
      summary: "one file only",
      file_refs: ["src/a-top.ts"],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "single-file", expect_nodes: ["single-file"] }],
      opts({ filesTopN: 10 })
    );
    const q = report.questions[0];
    expect(q.baseline_files_top_tokens).toBe(q.baseline_files_tokens);
    expect(q.ratio_files_top).toBe(q.ratio_files);
  });

  it("F4-14. files-top идёт по порядку узлов выдачи, а не по алфавиту", async () => {
    db.insertNode({ id: "order-one", name: "order-one", kind: "fact", summary: "shared order probe one" });
    db.insertNode({ id: "order-two", name: "order-two", kind: "fact", summary: "shared order probe two" });
    const run1 = await runBench(db, [{ id: "q1", query: "shared order probe" }], opts());
    const topIds = run1.questions[0].top_ids;
    expect(topIds).toHaveLength(2);
    // первый узел выдачи получает лексически ПОСЛЕДНИЙ файл — алфавитный выбор дал бы другой
    const zzz = "z".repeat(900);
    const aaa = "a".repeat(30);
    fs.writeFileSync(path.join(root, "zzz-first.txt"), zzz);
    fs.writeFileSync(path.join(root, "aaa-second.txt"), aaa);
    db.updateNode(topIds[0], { file_refs: ["zzz-first.txt"] });
    db.updateNode(topIds[1], { file_refs: ["aaa-second.txt"] });
    const run2 = await runBench(
      db,
      [{ id: "q1", query: "shared order probe" }],
      opts({ filesTopN: 1 })
    );
    const q = run2.questions[0];
    expect(q.baseline_files_top_tokens).toBe(estimateTokens(zzz));
    expect(q.baseline_files_top_tokens).not.toBe(estimateTokens(aaa));
    expect(q.baseline_files_tokens).toBe(estimateTokens(zzz) + estimateTokens(aaa));
  });

  // ---- F5: unknown_supports / stale по вопросам ----

  it("F5-15. неподтверждённое решение: unk:1 и id в списке вопроса", async () => {
    db.insertNode({
      id: "unconfirmed-one",
      name: "unconfirmed-one",
      kind: "decision",
      summary: "a decision nobody confirmed",
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "unconfirmed-one", expect_nodes: ["unconfirmed-one"] }],
      opts()
    );
    const q = report.questions[0];
    expect(q.unknown_supports).toBe(1);
    expect(q.unknown_support_ids).toEqual(["unconfirmed-one"]);
    expect(report.unknown_supports).toBe(1);
    expect(report.unknown_support_ids).toEqual(["unconfirmed-one"]);
  });

  it("F5-16. подтверждённое решение: unk:0", async () => {
    db.insertNode({
      id: "confirmed-decision",
      name: "confirmed-decision",
      kind: "decision",
      summary: "a decision with a live confirmed support",
    });
    db.insertNode({
      id: "live-support",
      name: "live-support",
      kind: "fact",
      summary: "the untouched support of the confirmed decision",
    });
    link(db, {
      from: "confirmed-decision",
      to: "live-support",
      relation: "informed_by",
      description: "because of live-support",
    });
    const edge = db.getInformedByEdges("confirmed-decision", "ancestry", false)[0];
    confirmSupports(db, {
      decision_id: "confirmed-decision",
      expected_claim_digest: claimDigestOf(db.getNode("confirmed-decision")!.summary),
      items: [
        {
          support_id: "live-support",
          expected_claim_digest: claimDigestOf("the untouched support of the confirmed decision"),
          expected_status_digest: statusDigestOf(
            db.getNode("live-support")!.status,
            db.getNode("live-support")!.epistemic_status
          ),
          expected_edge_digest: edgeDigestOf(edge.description),
        },
      ],
    });
    const report = await runBench(
      db,
      [{ id: "q1", query: "confirmed-decision", expect_nodes: ["confirmed-decision"] }],
      opts()
    );
    const q = report.questions[0];
    expect(q.unknown_supports).toBe(0);
    expect(q.unknown_support_ids).toEqual([]);
    expect(report.unknown_supports).toBe(0);
  });

  it("F5-17. сумма по вопросам равна итогу — и для unknown, и для stale", async () => {
    // два неподтверждённых решения и одно подтверждённое-затем-изменённое
    for (const [i, id] of ["unconf-a", "unconf-c"].entries()) {
      db.insertNode({
        id,
        name: id,
        kind: "decision",
        summary: `unconfirmed decision ${i + 1} of two`,
      });
    }
    db.insertNode({
      id: "stale-b",
      name: "stale-b",
      kind: "decision",
      summary: "a decision with a confirmed-then-changed support",
    });
    db.insertNode({
      id: "stale-b-support",
      name: "stale-b-support",
      kind: "fact",
      summary: "original wording of the stale support",
    });
    link(db, {
      from: "stale-b",
      to: "stale-b-support",
      relation: "informed_by",
      description: "why stale-b-support",
    });
    const edge = db.getInformedByEdges("stale-b", "ancestry", false)[0];
    confirmSupports(db, {
      decision_id: "stale-b",
      expected_claim_digest: claimDigestOf(db.getNode("stale-b")!.summary),
      items: [
        {
          support_id: "stale-b-support",
          expected_claim_digest: claimDigestOf("original wording of the stale support"),
          expected_status_digest: statusDigestOf(
            db.getNode("stale-b-support")!.status,
            db.getNode("stale-b-support")!.epistemic_status
          ),
          expected_edge_digest: edgeDigestOf(edge.description),
        },
      ],
    });
    db.updateNode("stale-b-support", { summary: "rewritten wording of the stale support" });

    const report = await runBench(
      db,
      [
        { id: "qa", query: "unconf-a", expect_nodes: ["unconf-a"] },
        { id: "qb", query: "stale-b", expect_nodes: ["stale-b"] },
        { id: "qc", query: "unconf-c", expect_nodes: ["unconf-c"] },
      ],
      opts()
    );
    const sumUnknown = report.questions.reduce((s, q) => s + q.unknown_supports, 0);
    const sumStale = report.questions.reduce((s, q) => s + q.stale_hits, 0);
    expect(report.unknown_supports).toBe(sumUnknown);
    expect(report.stale_hits).toBe(sumStale);
    expect(sumUnknown).toBe(2);
    expect(sumStale).toBe(1);
    expect(report.unknown_support_ids.sort()).toEqual(["unconf-a", "unconf-c"]);
    expect(report.stale_ids).toEqual(["stale-b"]);
    // строки вопроса: qb — stale, не unknown
    expect(report.questions[1].stale_ids).toEqual(["stale-b"]);
    expect(report.questions[1].unknown_support_ids).toEqual([]);
  });

  // ---- F6: холодный старт ----

  it("F6-18. холодный старт: cold-start в notes, в итоге обе цифры — warmup и медиана без него", async () => {
    // заглушка времён: первый вызов с задержкой загрузки модели
    const cold = detectColdStart([17732, 19, 14, 24]);
    expect(cold.cold).toBe(true);
    expect(cold.warmupMs).toBe(17732);
    // медиана остальных [19, 14, 24] = 19
    expect(cold.medianWithoutWarmupMs).toBe(19);
    // тёплый прогон не помечается
    const warm = detectColdStart([30, 20, 25]);
    expect(warm.cold).toBe(false);
    expect(warm.warmupMs).toBeNull();
    expect(detectColdStart([5]).cold).toBe(false);

    // строка итога несёт обе цифры
    const line = formatWarmupLine(17732, 19);
    expect(line).toContain("17.7s");
    expect(line).toContain("19ms");
    expect(line).toContain("excluded from median time");
    expect(formatWarmupLine(null, null)).toBeNull();

    // notes первой строки получают cold-start, остальные — нет
    const report = await runBench(
      db,
      [
        { id: "q1", query: "catalog-import-entry" },
        { id: "q2", query: "catalog-path-resolution" },
      ],
      opts()
    );
    // notes: cold-start получает только первая строка — решение внутри questionNotes
    const coldReport = { ...report, cold_start: true };
    expect(questionNotes(coldReport.questions[0], coldReport)).toContain("cold-start");
    expect(questionNotes(coldReport.questions[1], coldReport)).not.toContain("cold-start");
    // Явно тёплый отчёт: флаг cold_start в сыром report зависит от машины
    // (на холодном FS CI первый запрос пересекает порог 5× median — это
    // честный вердикт detectColdStart, а не поведение questionNotes).
    const warmReport = { ...report, cold_start: false };
    expect(questionNotes(warmReport.questions[0], warmReport)).not.toContain(
      "cold-start"
    );
    // формат списка id: до 10 целиком, дальше +N
    expect(formatIdList(["a", "b"])).toBe(" (ids: a, b)");
    expect(formatIdList(Array.from({ length: 12 }, (_, i) => `n${i}`))).toContain("+2");
  });
});

describe("megamemory bench 2.1.7 — вложенные опоры в ранге", () => {
  function insertInlinedPair(): void {
    // FTS: остальная часть файла живёт на LIKE-fallback, здесь нужен настоящий FTS-AND
    ensureSchema(db);
    db.insertNode({
      id: "inl-decision",
      name: "inl-decision",
      kind: "decision",
      summary: "the decision about the ebusy retry loop bmark",
    });
    db.insertNode({
      id: "inl-support",
      name: "inl-support",
      kind: "fact",
      summary: "the ebusy retry loop reproduced with two parallel writers bmark",
    });
    link(db, {
      from: "inl-decision",
      to: "inl-support",
      relation: "informed_by",
      description: "the reproduction is what the retry loop fixes",
    });
  }

  it("F6-14. ожидаемый узел вложен в решение: hit true, ранг равен рангу решения", async () => {
    insertInlinedPair();
    const report = await runBench(
      db,
      [{ id: "q1", query: "ebusy retry loop bmark", expect_nodes: ["inl-support"] }],
      opts()
    );
    const q = report.questions[0];
    expect(q.hit).toBe(true);
    expect(q.nested_ids).toContain("inl-support");
    // ранг вложенной опоры = ранг её решения
    const decisionRank = q.top_ids.indexOf("inl-decision") + 1;
    expect(decisionRank).toBeGreaterThan(0);
    expect(q.expected_rank).toBe(decisionRank);
    expect(report.hit_rate).toBe(1);
  });

  it("F6-15. top_ids содержит вложенный id, nested_ids помечает его", async () => {
    insertInlinedPair();
    const report = await runBench(
      db,
      [{ id: "q1", query: "ebusy retry loop bmark" }],
      opts()
    );
    const q = report.questions[0];
    expect(q.top_ids).toContain("inl-support");
    expect(q.top_ids.filter((id) => id === "inl-support")).toHaveLength(1);
    expect(q.nested_ids).toEqual(["inl-support"]);
    // опора не занимает слот верхнего уровня: top-level — только решение
    expect(q.top_ids.filter((id) => id === "inl-decision")).toHaveLength(1);
  });
});
