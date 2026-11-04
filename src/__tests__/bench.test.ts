import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { link, estimateTokens } from "../tools.js";
import {
  BenchError,
  BENCH_DISCLAIMER,
  type BenchOptions,
  type BenchQuestion,
  type TeRunResult,
  loadQuestions,
  runBench,
} from "../bench.js";
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
  return { baseline: "files", root, ...over };
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
    expect(q.graph_tokens).toBe(0);
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
