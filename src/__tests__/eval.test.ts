import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { loadEvalPairs, runEval } from "../eval.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-eval-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("eval harness (В13)", () => {
  it("computes recall@k overall and per language", async () => {
    const db = freshDb();
    db.insertNode({ id: "книга", name: "Книга", kind: "module", summary: "заметки о книгах" });
    db.insertNode({ id: "book", name: "Book", kind: "module", summary: "english book node" });

    const pairs = [
      { query: "Книга", expected_id: "книга", lang: "ru" },
      { query: "Book", expected_id: "book", lang: "en" },
    ];
    const result = await runEval(db, pairs, { k: 5 });
    expect(result.recall).toBe(1);
    expect(result.perLang["ru"].recall).toBe(1);
    expect(result.perLang["en"].recall).toBe(1);
    expect(result.misses).toHaveLength(0);
  });

  it("misses lower recall and are reported", async () => {
    const db = freshDb();
    db.insertNode({ id: "a", name: "Alpha", kind: "feature", summary: "alpha" });
    const pairs = [
      { query: "Alpha", expected_id: "a", lang: "en" },
      { query: "несуществующий запрос", expected_id: "ghost", lang: "ru" },
    ];
    const result = await runEval(db, pairs, { k: 5 });
    expect(result.recall).toBe(0.5);
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0].expected_id).toBe("ghost");
    expect(result.perLang["ru"].recall).toBe(0);
  });

  it("loads jsonl pairs and skips blanks", () => {
    const pairs = loadEvalPairs(
      '{"query":"q1","expected_id":"e1","lang":"ru"}\n\n  \n{"query":"q2","expected_id":"e2"}\n'
    );
    expect(pairs).toHaveLength(2);
    expect(pairs[1].lang).toBe("unknown");
  });
});
