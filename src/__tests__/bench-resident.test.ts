import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { understand } from "../tools.js";
vi.mock("../tools.js", () => ({
  estimateTokens: (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3),
  understand: vi.fn(async () => ({ compact: [], matches: [], meta: { returned: 0, dropped: 0, tokens_estimated: 600, truncated: false } })),
}));
import { loadQuestions, runBench } from "../bench.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });

function question(id: string) {
  return loadQuestions(JSON.stringify({ id, query: "Needle" }))[0];
}

describe("bench resident_ratio (план 26 §4)", () => {
  it("answer 600 against a 3000-token files-top baseline gives 0.2", async () => {
    fs.writeFileSync(path.join(fixture.root, "big.txt"), "x".repeat(9000), "utf8");
    vi.mocked(understand).mockResolvedValueOnce({
      compact: [{ id: "needle", file_refs: ["big.txt"] }],
      matches: [],
      meta: { returned: 1, dropped: 0, tokens_estimated: 600, truncated: false },
    } as never);
    const report = await runBench({ getNode: () => null } as never, [question("r1")], {
      baseline: "files", root: fixture.root, resolveGitRoot: () => null, filesTopN: 1,
    });
    expect(report.questions[0].answer_tokens).toBe(600);
    expect(report.questions[0].baseline_files_top_tokens).toBe(3000);
    expect(report.resident_ratio).toBeCloseTo(0.2, 10);
  });

  it("a zero denominator gives null, not Infinity", async () => {
    // Файл, на который ссылается узел, отсутствует: baseline_files_top = null.
    vi.mocked(understand).mockResolvedValueOnce({
      compact: [{ id: "needle", file_refs: ["absent.txt"] }],
      matches: [],
      meta: { returned: 1, dropped: 0, tokens_estimated: 600, truncated: false },
    } as never);
    const report = await runBench({ getNode: () => null } as never, [question("r2")], {
      baseline: "files", root: fixture.root, resolveGitRoot: () => null, filesTopN: 1,
    });
    // files-top считается и при пустом списке файлов: baseline 0, а не null —
    // и это ровно нулевой знаменатель из плана: доля = null, не Infinity.
    expect(report.questions[0].baseline_files_top_tokens).toBe(0);
    expect(report.resident_ratio).toBeNull();
  });

  it("questions without baseline_files_top (te mode) give resident_ratio null", async () => {
    const report = await runBench({ getNode: () => null } as never, [question("r3")], {
      baseline: "te", resolveGitRoot: () => null,
      teRunner: { executable: "fake", args: ["{query}"] },
      runTeProgram: async () => ({ stdout: '{"count":0,"matches":[]}', durationMs: 1, exitCode: 0 }),
    });
    expect(report.questions[0].answer_tokens).toBe(600);
    expect(report.questions[0].baseline_files_top_tokens).toBeNull();
    expect(report.resident_ratio).toBeNull();
  });
});
