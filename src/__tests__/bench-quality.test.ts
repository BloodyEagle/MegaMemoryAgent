import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBench, loadQuestions } from "../bench.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { understand, estimateTokens } from "../tools.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
beforeEach(() => { fixture = auditFixture(); fixture.isolateHome(); vi.stubEnv("MEGAMEMORY_SEARCH", "fts"); });
afterEach(async () => { vi.unstubAllEnvs(); await fixture.close(); });

function question(overrides = {}) {
  return loadQuestions(JSON.stringify({
    id: "negative", query: "absentneedle", expected_outcome: "no_match",
    quality_contract: { adapter: "ts_search" }, ...overrides,
  }))[0];
}

describe("S-05 quality-gated retrieval comparison", () => {
  it("compares a complete expected negative instead of treating empty graph matches as failure", async () => {
    const report = await runBench(fixture.db(), [question()], {
      baseline: "te", root: fixture.root, resolveGitRoot: () => null,
      teRunner: { executable: "fake", args: ["{query}"] },
      runTeProgram: async () => ({ stdout: '{"count":0,"matches":[]}', durationMs: 1, exitCode: 0 }),
    });
    expect(report.questions[0]).toMatchObject({
      graph_quality: { quality: "pass", completeness: "complete", measurement: "live" },
      te_quality: { quality: "pass", completeness: "complete", measurement: "live" },
      comparison_te: "eligible",
    });
    expect(report.questions[0].quality_ratio_te).toBeGreaterThan(0);
    expect(report.graph_metric).toBe("retrieval_wire_without_instructions");
    expect(report.quality_summary).toMatchObject({ total: 1, eligible_te: 1 });
  });

  it("reports the actual retrieval wrapper estimate without pretending to include MCP instructions", async () => {
    const db = fixture.db();
    const output = await understand(db, { query: "absentneedle", top_k: 10 });
    const wire = { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    expect(output.meta!.tokens_estimated).toBe(estimateTokens(JSON.stringify(wire)));
    const report = await runBench(db, [question()], { baseline: "files", root: fixture.root, resolveGitRoot: () => null });
    expect(report.questions[0].graph_tokens).toBe(output.meta!.tokens_estimated);
    expect(report).toMatchObject({ graph_metric: "retrieval_wire_without_instructions", instructions_scope: "excluded", economy_status: "not_measured" });
  });

  it("executes the README bench structured argv against a fresh owned DB using source CLI", async () => {
    const dbPath = fixture.file("cli-owned.db");
    await fixture.release(fixture.db("cli-owned.db"));
    // A fresh separate source CLI database is created only under this fixture.
    const questionsPath = fixture.file("questions.jsonl");
    fs.writeFileSync(questionsPath, JSON.stringify({ query: "AbsentNeedle", expected_outcome: "no_match", quality_contract: { adapter: "ts_search" } }) + "\n", "utf8");
    const readme = fs.readFileSync(path.resolve(import.meta.dirname, "../../README.md"), "utf8");
    const block = readme.match(/megamemory bench --db "<owned-copy.db>"[\s\S]*?--te-arg "ext=[^"]+"/)!;
    const argv = [...block[0].matchAll(/--te-arg "([^"]+)"/g)].flatMap((m) => ["--te-arg", m[1]]);
    const source = path.resolve(import.meta.dirname, "..");
    const cli = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve(source, "../node_modules/tsx/dist/loader.mjs")).href, path.join(source, "index.ts"),
      "bench", "--db", dbPath, "--questions", questionsPath, "--baseline", "te", "--te-exec", process.execPath, ...argv], {
      cwd: fixture.root, encoding: "utf8", timeout: 10000, maxBuffer: 65536,
    });
    console.log("README-source-bench", JSON.stringify({ status: cli.status, stdout: cli.stdout, stderr: cli.stderr }));
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toContain("eligible 1/1");
    expect(cli.stdout).toContain("retrieval_wire_without_instructions");
    expect(cli.stdout).toContain("pass/fail/unknown 1/0/0");
  });
});
