import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBench } from "../bench.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;

beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
  vi.stubEnv("MEGAMEMORY_SEARCH", "fts");
  vi.stubEnv("MEGAMEMORY_AUDIT_LITERAL", "expanded_value_is_not_literal");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.close();
});

const examples = [
  ["plain text", "needleargv simple words"],
  ["percent variable", "needleargv %MEGAMEMORY_AUDIT_LITERAL%"],
  ["Unicode", "needleargv кириллица 模块"],
  ["double quotes", 'needleargv "two words"'],
  ["ampersand", "needleargv left&right"],
  ["backslashes", "needleargv C:\\folder\\file.txt"],
] as const;

describe("C-06 bench runner preserves literal query argv", () => {
  it.each(examples)("passes %s as exactly one unchanged argument", async (_name, query) => {
    const db = fixture.db();
    db.setMetaValue("embed_model", "audit-no-vector");
    const helper = fixture.file("argv-print.cjs");
    const output = fixture.file("argv.json");
    vi.stubEnv("MEGAMEMORY_AUDIT_ARGV_OUTPUT", output);
    // Only this harmless local Node program may run. It prints argv and
    // mirrors that same JSON into its owned temp log; no shell redirections,
    // commands, network, or executable payloads are in any query example.
    // Quotes and ampersands deliberately occur in separate cases.
    fs.writeFileSync(helper, `
const text = JSON.stringify(process.argv.slice(2));
process.stdout.write(text);
require("node:fs").writeFileSync(process.env.MEGAMEMORY_AUDIT_ARGV_OUTPUT, text, "utf8");
`, "utf8");

    // C-06 (plan 05): the structured executable+argv runner is the default
    // query->runner boundary — no shell, no quoting, no expansion. The
    // shell-template mode (--te-cmd) is the separate explicitly trusted one.
    const report = await runBench(db, [{ id: "literal", query }], {
      baseline: "te", root: fixture.root, resolveGitRoot: () => null,
      teRunner: { executable: process.execPath, args: [helper, "{query}"] },
    });

    const actual = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
    console.log("argv-print", JSON.stringify({ expected: [query], actual }));
    expect(actual, "C-06: user query data must not be expanded or reinterpreted by a shell").toEqual([query]);
    expect(report.questions[0]).toMatchObject({ te_used_preset: false });
    expect(report.questions[0].baseline_te_tokens).toBeGreaterThan(0);
  });
});
