import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBench, type BenchQuestion, type BenchReport } from "../bench.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;

beforeEach(() => {
  fixture = auditFixture();
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.close();
});

function rootedDatabase() {
  const db = fixture.db();
  db.setMetaValue("embed_model", "audit-no-vector");
  addNode(db, "rooted-ref", {
    name: "Rooted reference",
    summary: "needlebench identifies this same relative reference in different projects.",
    file_refs: ["src/x.ts"],
  });
  const a = path.dirname(path.dirname(fixture.file("repo-a/src/x.ts")));
  const b = path.dirname(path.dirname(fixture.file("repo-b/src/x.ts")));
  fs.writeFileSync(path.join(a, "src/x.ts"), "aaa", "utf8");
  fs.writeFileSync(path.join(b, "src/x.ts"), "b".repeat(300), "utf8");
  const empty = fixture.file("empty-root");
  fs.mkdirSync(empty);
  return { db, a, b, empty };
}

function baselineById(report: BenchReport) {
  // The public DTO is questions, not the obsolete repro's results field.
  return Object.fromEntries(report.questions.map((q) => [q.id, {
    tokens: q.baseline_files_tokens,
    missing: q.missing_files,
    hit: q.hit,
  }]));
}

function question(id: string, roots: string[]): BenchQuestion {
  return { id, query: "needlebench", expect_nodes: ["rooted-ref"], ref_roots: roots };
}

describe("C-05 bench resolves references in each question's root context", () => {
  it.each(["forward", "reverse"] as const)("keeps 1/100 file baselines in %s question order", async (order) => {
    const { db, a, b, empty } = rootedDatabase();
    const questions = [question("a", [a, b]), question("b", [b, a])];
    if (order === "reverse") questions.reverse();

    const report = await runBench(db, questions, {
      baseline: "files", root: empty, resolveGitRoot: () => null,
    });

    // Worked examples: 3 ASCII bytes = 1 token; 300 ASCII bytes = 100.
    expect(baselineById(report)).toEqual({
      a: { tokens: 1, missing: 0, hit: true },
      b: { tokens: 100, missing: 0, hit: true },
    });
  });

  it.each(["miss-first", "hit-first"] as const)("does not share a hit or miss across roots (%s)", async (order) => {
    const { db, b, empty } = rootedDatabase();
    const questions = [question("absent", [empty]), question("present", [b])];
    if (order === "hit-first") questions.reverse();

    const report = await runBench(db, questions, {
      baseline: "files", root: empty, resolveGitRoot: () => null,
    });

    expect(baselineById(report)).toEqual({
      absent: { tokens: 0, missing: 1, hit: true },
      present: { tokens: 100, missing: 0, hit: true },
    });
  });

  it("reuses the same root context without changing either question's baseline", async () => {
    const { db, a, empty } = rootedDatabase();

    const report = await runBench(db, [question("first", [a]), question("second", [a])], {
      baseline: "files", root: empty, resolveGitRoot: () => null,
    });

    expect(baselineById(report)).toEqual({
      first: { tokens: 1, missing: 0, hit: true },
      second: { tokens: 1, missing: 0, hit: true },
    });
  });

  it("tries the next root when the first root has no referenced file", async () => {
    const { db, b, empty } = rootedDatabase();

    const report = await runBench(db, [question("fallback", [empty, b])], {
      baseline: "files", root: empty, resolveGitRoot: () => null,
    });

    expect(baselineById(report)).toEqual({ fallback: { tokens: 100, missing: 0, hit: true } });
  });
});
