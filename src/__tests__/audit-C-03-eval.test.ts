import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addNode, AuditHarnessError, auditFixture, type AuditFixture } from "./helpers/audit.js";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
let fixture: AuditFixture;

beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function evalCli(db: string, expectedId: string, flags: string[]) {
  if (!fs.existsSync(cli)) throw new AuditHarnessError("Build dist before running C-03 subprocess tests");
  const pairs = fixture.file("eval.jsonl");
  fs.writeFileSync(pairs, `${JSON.stringify({ query: "alpha", expected_id: expectedId, lang: "en" })}\n`, "utf8");
  const { env } = fixture.profile();
  const result = spawnSync(process.execPath, [cli, "eval", "--db", db, "--file", pairs, ...flags], {
    cwd: fixture.root,
    // No vectors, no model path, no network or inherited user database.
    env: { ...env, NODE_OPTIONS: "", MEGAMEMORY_DB_PATH: "", MEGAMEMORY_SEARCH: "fts", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", NO_COLOR: "1" },
    shell: false, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.error || result.signal || result.status === null) {
    throw new AuditHarnessError(`Eval subprocess did not complete: ${result.error?.message ?? result.signal}`, { cause: result.error });
  }
  return { ...result, output: result.stdout + result.stderr };
}

const invalid: [string, string | undefined][] = [
  ["--min", "nope"], ["--min", "NaN"], ["--min", "Infinity"],
  ["--min", "-0.1"], ["--min", "1.1"], ["--min", "0.5junk"], ["--min", undefined],
  ["--k", "nope"], ["--k", "Infinity"], ["--k", "0"], ["--k", "-1"],
  ["--k", "1.5"], ["--k", "2junk"], ["--k", undefined],
];

describe("C-03 eval validates numeric flags before opening a database", () => {
  it.each(invalid)("rejects %s=%s without initializing the selected DB", (flag, value) => {
    // An existing empty SQLite file is legal input to SQLite, but opening it
    // through KnowledgeDB would create the schema. Invalid argv must not do so.
    const db = fixture.file("must-remain-unopened.db");
    fs.writeFileSync(db, Buffer.alloc(0));

    const result = evalCli(db, "alpha", value === undefined ? [flag] : [flag, value]);

    expect(fs.statSync(db).size, "C-03: numeric validation must precede DB initialization").toBe(0);
    expect(result.status).not.toBe(0);
    expect(result.output, "The diagnostic must identify the invalid flag").toContain(flag);
    expect(result.output).not.toContain("overall:");
  });

  it.each(["0", "0.5", "1"])("accepts finite min=%s with a positive integer k and a known hit", async (min) => {
    const db = fixture.db("valid.db");
    db.setMetaValue("embed_model", "audit-no-vector");
    addNode(db, "alpha", { name: "Alpha", summary: "Alpha is the known evaluation answer." });
    await fixture.release(db);

    const result = evalCli(fixture.file("valid.db"), "alpha", ["--min", min, "--k", "1"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("(1/1)");
    expect(result.output).toContain("recall@1");
  });

  it("still fails a valid quality gate when the expected node is missing", async () => {
    const db = fixture.db("miss.db");
    db.setMetaValue("embed_model", "audit-no-vector");
    addNode(db, "alpha", { name: "Alpha", summary: "Alpha is unrelated to the absent expected id." });
    await fixture.release(db);

    const result = evalCli(fixture.file("miss.db"), "absent-node", ["--min", "1", "--k", "10"]);

    expect(result.status).toBe(1);
    expect(result.output).toContain("(0/1)");
    expect(result.output).toContain("recall 0.000 < min 1");
  });
});
