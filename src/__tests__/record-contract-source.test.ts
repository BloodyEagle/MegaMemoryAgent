import { describe, it, expect } from "vitest";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

function createTool(): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "server.tool" &&
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "create_concept") {
      found = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!found) throw new Error("create_concept registration not found");
  return found;
}

describe("Plan 25 source record contract", () => {
  it("create_concept documents evidence for any code-backed claim, not only decisions", () => {
    const description = createTool().arguments[1];
    expect(ts.isStringLiteral(description)).toBe(true);
    const text = (description as ts.StringLiteral).text;
    expect(text).toContain("any claim");
    expect(text).toContain("file_refs alone creates no link");
    expect(text).not.toContain("For a decision/pattern");
  });

  it("the evidence parameter names feature/module and the informed_by edge", () => {
    const schema = createTool().arguments[2];
    if (!ts.isObjectLiteralExpression(schema)) throw new Error("create_concept schema not found");
    const evidence = schema.properties.find((property) =>
      ts.isPropertyAssignment(property) && property.name.getText(ast) === "evidence"
    );
    if (!evidence || !ts.isPropertyAssignment(evidence) ||
        !ts.isCallExpression(evidence.initializer)) throw new Error("evidence description not found");
    const description = evidence.initializer.arguments[0];
    expect(ts.isStringLiteral(description)).toBe(true);
    const text = (description as ts.StringLiteral).text;
    expect(text).toContain("для любого kind");
    expect(text).toContain("feature/module");
    expect(text).toContain("informed_by");
    expect(text).toContain("file_refs связей не создаёт");
    expect(text).toContain("ровно одно из ref/node и непустой why");
    expect(text).not.toContain("Опоры для decision/pattern");
  });
});
