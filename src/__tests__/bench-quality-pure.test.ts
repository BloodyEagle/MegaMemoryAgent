import { describe, expect, it, vi } from "vitest";
import { understand } from "../tools.js";
vi.mock("../tools.js", () => ({
  estimateTokens: (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3),
  understand: vi.fn(async () => ({ compact: [], matches: [], meta: { returned: 0, dropped: 0, tokens_estimated: 100, truncated: false } })),
}));
import { loadQuestions, runBench } from "../bench.js";

const db = { getNode: () => null } as never;
describe("S-05 runBench quality boundary without native DB", () => {
  it("compares complete expected negatives at positive live costs", async () => {
    const questions = loadQuestions('{"id":"negative","query":"Absent","expected_outcome":"no_match","quality_contract":{"adapter":"ts_search"}}');
    const report = await runBench(db, questions, {
      baseline: "te", resolveGitRoot: () => null,
      teRunner: { executable: "fake", args: ["{query}"] },
      runTeProgram: async () => ({ stdout: '{"count":0,"matches":[]}', durationMs: 1, exitCode: 0 }),
    });
    expect(report.questions[0]).toMatchObject({ graph_quality: { quality: "pass" }, te_quality: { quality: "pass" }, comparison_te: "eligible" });
    expect(report.questions[0].quality_ratio_te).toBe(8 / 100);
    expect(report.graph_metric).toBe("retrieval_wire_without_instructions");
  });

  it.each([
    ["absent", "", "fail", "unknown"],
    ["malformed", "{", "fail", "unknown"],
    ["error JSON", '{"error":"bad"}', "fail", "unknown"],
    ["unexpected positive", '{"count":1,"matches":[{"file":"x.ts","line":1,"text":"x"}]}', "fail", "complete"],
    ["adapter truncation", '{"count":2,"matches":[{"file":"x.ts","line":1,"text":"x"}]}', "unknown", "truncated"],
  ])("does not compare %s exit0 payload", async (_label, stdout, quality, completeness) => {
    const report = await runBench(db, loadQuestions('{"query":"Absent","expected_outcome":"no_match","quality_contract":{"adapter":"ts_search"}}'), {
      baseline: "te", resolveGitRoot: () => null, teRunner: { executable: "fake", args: ["{query}"] },
      runTeProgram: async () => ({ stdout, durationMs: 1, exitCode: 0 }),
    });
    expect(report.questions[0]).toMatchObject({ te_quality: { quality, completeness }, comparison_te: "not_comparable", quality_ratio_te: null });
    expect(report.quality_summary.total).toBe(1);
  });

  it("passes expected positive refs, symbols and edges with an explicit generic adapter", async () => {
    vi.mocked(understand).mockResolvedValueOnce({ compact: [{ id: "needle" }], matches: [], meta: { returned: 1, dropped: 0, tokens_estimated: 100, truncated: false } } as never);
    const questions = loadQuestions(JSON.stringify({ query: "Needle", expected_outcome: "match", expect_nodes: ["needle"],
      quality_contract: { adapter: "generic_json" }, expected_te_refs: ["a.ts:2"], expected_te_symbols: ["Needle"], expected_te_edges: ["a->b:uses"] }));
    const report = await runBench(db, questions, { baseline: "te", resolveGitRoot: () => null,
      teRunner: { executable: "fake", args: ["{query}"] }, runTeProgram: async () => ({ stdout: '{"results":[{"refs":["a.ts:2"],"symbols":["Needle"],"edges":["a->b:uses"]}],"complete":true}', durationMs: 1 }) });
    expect(report.questions[0]).toMatchObject({ graph_quality: { quality: "pass" }, te_quality: { quality: "pass" }, comparison_te: "eligible" });
  });

  it("counts every excluded case and keeps preset/raw cost apart from live quality", async () => {
    const questions = loadQuestions([
      { query: "Absent", expected_outcome: "no_match", quality_contract: { adapter: "ts_search" } },
      { query: "Absent", expected_outcome: "no_match", quality_contract: { adapter: "ts_search" }, baseline_te_tokens: 500 },
      { query: "Absent" },
    ].map((q) => JSON.stringify(q)).join("\n"));
    let calls = 0;
    const report = await runBench(db, questions, { baseline: "te", resolveGitRoot: () => null,
      teRunner: { executable: "fake", args: ["{query}"] }, runTeProgram: async () => { calls++; return { stdout: '{"count":0,"matches":[]}', durationMs: 1 }; } });
    expect(calls).toBe(2);
    expect(report.questions[1]).toMatchObject({ baseline_te_tokens: 500, te_used_preset: true, te_quality: { measurement: "preset", quality: "unknown" }, comparison_te: "not_comparable" });
    expect(report.quality_summary).toMatchObject({ total: 3, te: { pass: 1, fail: 0, unknown: 2 }, eligible_te: 1, preset_te: 1 });
  });

  it("never gives an exact cost or ratio to a measured stdout prefix", async () => {
    vi.mocked(understand).mockResolvedValueOnce({ compact: [{ id: "needle" }], matches: [], meta: { returned: 1, dropped: 0, tokens_estimated: 100 } } as never);
    const report = await runBench(db, [{ query: "Needle", id: "prefix" }], { baseline: "te", resolveGitRoot: () => null,
      teRunner: { executable: "fake", args: ["{query}"] }, runTeProgram: async () => ({ stdout: "Ж", durationMs: 1, stdoutTruncated: true, stdoutBytes: 7, stdoutCapturedBytes: 2 }) });
    expect(report.questions[0]).toMatchObject({ baseline_te_tokens: null, ratio_te: null, quality_ratio_te: null, te_captured_prefix_tokens: 1, te_stdout_bytes: 7, te_stdout_captured_bytes: 2 });
  });

  it.each([
    ["HAR negative exit1", "har_search", '{"command":"search","total":0,"shown":0,"omitted":0,"items":[],"truncated":false}', 1, "pass", "complete"],
    ["HAR error exit1", "har_search", '{"error":"bad"}', 1, "fail", "unknown"],
    ["HAR negative stderr", "har_search", '{"command":"search","total":0,"shown":0,"omitted":0,"items":[],"truncated":false}', 1, "fail", "complete"],
    ["PY negative text", "py_search", '«Absent»: совпадений нет (3 файлов просмотрено)', 0, "pass", "complete"],
    ["PY false JSON", "py_search", '{"count":0,"matches":[]}', 0, "fail", "unknown"],
    ["PY wrong query", "py_search", '«Other»: совпадений нет (3 файлов просмотрено)', 0, "fail", "unknown"],
    ["PY shown limit", "py_search", 'a.py\n  3: def Needle():\n-- совпадений: 4, файлов: 3, показано 1', 0, "unknown", "truncated"],
  ])("honors the actual adapter contract: %s", async (label, adapter, stdout, exitCode, quality, completeness) => {
    const report = await runBench(db, loadQuestions(JSON.stringify({ query: "Absent", expected_outcome: "no_match", quality_contract: { adapter } })), {
      baseline: "te", resolveGitRoot: () => null, teRunner: { executable: "fake", args: ["{query}"] },
      runTeProgram: async () => ({ stdout, durationMs: 1, exitCode, stderr: label === "HAR negative stderr" ? "error" : "" }),
    });
    expect(report.questions[0]).toMatchObject({ te_quality: { quality, completeness }, comparison_te: quality === "pass" ? "eligible" : "not_comparable" });
  });

  it.each(["py_search", "ts_search", "har_search"])("checks positive refs for %s instead of equating count with quality", async (adapter) => {
    vi.mocked(understand).mockResolvedValueOnce({ compact: [{ id: "needle" }], matches: [], meta: { returned: 1, dropped: 0, tokens_estimated: 100 } } as never);
    const stdout = adapter === "py_search" ? 'a.py\n  3: def Needle():\n-- совпадений: 1, файлов: 1'
      : adapter === "ts_search" ? '{"count":1,"matches":[{"file":"a.ts","line":3,"text":"Needle"}]}'
      : '{"command":"search","total":1,"shown":1,"omitted":0,"items":[{"url":"https://example.invalid/Needle","index":0}],"truncated":false}';
    const ref = adapter === "py_search" ? "a.py:3" : adapter === "ts_search" ? "a.ts:3" : "https://example.invalid/Needle";
    const report = await runBench(db, loadQuestions(JSON.stringify({ query: "Needle", expected_outcome: "match", expect_nodes: ["needle"], expected_te_refs: [ref], quality_contract: { adapter } })), {
      baseline: "te", resolveGitRoot: () => null, teRunner: { executable: "fake", args: ["{query}"] }, runTeProgram: async () => ({ stdout, durationMs: 1 }),
    });
    expect(report.questions[0]).toMatchObject({ te_quality: { quality: "pass", completeness: "complete" }, comparison_te: "eligible" });
  });

  it("does not compare a graph miss, partial graph, error or positive without its TE oracle", async () => {
    for (const kind of ["miss", "truncated", "error", "no_te_oracle"]) {
      if (kind === "error") vi.mocked(understand).mockRejectedValueOnce(new Error("retrieval failed"));
      else if (kind !== "miss") vi.mocked(understand).mockResolvedValueOnce({ compact: [{ id: "needle" }], matches: [], meta: { returned: 1, dropped: 0, tokens_estimated: 100, truncated: kind === "truncated" } } as never);
      const report = await runBench(db, loadQuestions(JSON.stringify({ query: "Needle", expected_outcome: "match", expect_nodes: ["needle"], expected_te_refs: kind === "no_te_oracle" ? [] : ["a.ts:1"], quality_contract: { adapter: "ts_search" } })), {
        baseline: "te", resolveGitRoot: () => null, teRunner: { executable: "fake", args: ["{query}"] }, runTeProgram: async () => ({ stdout: '{"count":1,"matches":[{"file":"a.ts","line":1,"text":"Needle"}]}', durationMs: 1 }),
      });
      expect(report.questions[0].comparison_te, kind).toBe("not_comparable");
      expect(report.questions[0].quality_ratio_te, kind).toBeNull();
    }
  });

  it("keeps a valid negative quality pass when its denominator is zero", async () => {
    vi.mocked(understand).mockResolvedValueOnce({ compact: [], matches: [], meta: { returned: 0, dropped: 0, tokens_estimated: 0 } } as never);
    const report = await runBench(db, loadQuestions('{"query":"Absent","expected_outcome":"no_match","quality_contract":{"adapter":"ts_search"}}'), {
      baseline: "te", resolveGitRoot: () => null, teRunner: { executable: "fake", args: ["{query}"] }, runTeProgram: async () => ({ stdout: '{"count":0,"matches":[]}', durationMs: 1 }),
    });
    expect(report.questions[0]).toMatchObject({ graph_quality: { quality: "pass" }, te_quality: { quality: "pass" }, comparison_te: "not_comparable", quality_ratio_te: null });
  });

  it("reports runner failures over the whole dataset while preserving literal query argv", async () => {
    const query = 'строка "с кавычками" %HOME% & C:\\repo\\x';
    const calls: string[][] = [];
    const report = await runBench(db, loadQuestions(JSON.stringify({ query, expected_outcome: "no_match", quality_contract: { adapter: "ts_search" } })), {
      baseline: "te", resolveGitRoot: () => null, teRunner: { executable: "fake", args: ["query={query}", "root=."] },
      runTeProgram: async (_executable, args) => { calls.push(args); throw new Error("owned runner failed"); },
    });
    expect(calls).toEqual([[`query=${query}`, "root=."]]);
    expect(report.questions[0]).toMatchObject({ te_quality: { quality: "fail", completeness: "unknown" }, baseline_te_tokens: null, comparison_te: "not_comparable", te_error: "owned runner failed" });
    expect(report.quality_summary).toMatchObject({ total: 1, errors_te: 1, te: { fail: 1 } });
  });

  it("rejects malformed additive dataset contracts instead of silently ignoring them", () => {
    for (const extra of [{ expected_outcome: "other" }, { quality_contract: { adapter: "auto" } }, { expected_te_refs: [1] }]) {
      expect(() => loadQuestions(JSON.stringify({ query: "Needle", ...extra }))).toThrow();
    }
  });
});
