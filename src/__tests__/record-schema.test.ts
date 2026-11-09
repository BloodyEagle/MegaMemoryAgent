import { describe, it, expect } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { KnowledgeDB } from "../db.js";
import { buildNextHints, emptyNextHints } from "../next-hints.js";
import { understand } from "../tools.js";
import { ensureSchema } from "../migrate-schema.js";
import { MODEL_NAME } from "../embeddings.js";
import * as types from "../types.js";

function publicCreateSchema() {
  const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let kindExpression = "", createExpression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "NodeKindEnum") kindExpression = node.initializer!.getText(ast);
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "server.tool" && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "create_concept") createExpression = node.arguments[2].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const NodeKindEnum = vm.runInNewContext(kindExpression, { z, ...types });
  return z.object(vm.runInNewContext(`(${createExpression})`, { z, NodeKindEnum, RelationEnum: z.enum(["connects_to", "informed_by"]) }));
}

describe("I-01 generated record schema roundtrip", () => {
  it("empty, early empty, non-decision, refuted and decision records use the public create schema", async () => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      db.insertNode({ id: "module", name: "module", kind: "module", summary: "Measured implementation module" });
      db.insertNode({ id: "decision", name: "decision", kind: "decision", summary: "Measured design decision" });
      const records = [
        emptyNextHints().record,
        buildNextHints({ db, cards: [] }).record,
        buildNextHints({ db, cards: [{ id: "module" }] }).record,
        buildNextHints({ db, cards: [], refuted: [{ name: "wrong", reason: "Measured failure" }] }).record,
        buildNextHints({ db, cards: [{ id: "decision" }] }).record,
      ];
      const previousSearch = process.env.MEGAMEMORY_SEARCH;
      const previousModel = db.getMetaValue("embed_model");
      process.env.MEGAMEMORY_SEARCH = "vector";
      db.setMetaValue("embed_model", MODEL_NAME);
      try {
        records.push((await understand(db, { query: "early empty", max_tokens: 1500 })).next!.record);
      } finally {
        if (previousSearch === undefined) delete process.env.MEGAMEMORY_SEARCH;
        else process.env.MEGAMEMORY_SEARCH = previousSearch;
        if (previousModel) db.setMetaValue("embed_model", previousModel);
      }
      const schema = publicCreateSchema();
      const expectedKinds = ["feature", "feature", "feature", "feature", "decision", "feature"];
      for (const [index, record] of records.entries()) {
        const kind = /create_concept kind=(\w+)/.exec(record)?.[1];
        expect(kind).toBe(expectedKinds[index]);
        expect(record).toContain("evidence");
        expect(schema.safeParse({ name: "Verified result", kind, summary: "Independent measured result", evidence: [{ ref: "src/result.ts:10-20", why: "The current source establishes the result" }] }).success, record).toBe(true);
      }
      expect(schema.safeParse({ name: "Bad kind", kind: "fact", summary: "Legacy unsupported kind" }).success).toBe(false);
    } finally { db.close(); }
  });
});
