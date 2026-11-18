import { describe, expect, it } from "vitest";
import fs from "node:fs";
import ts from "typescript";

type Registration = { description: string; parameters: Map<string, ts.Expression> };

function understandRegistration(): Registration {
  const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let registration: Registration | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "tool"
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "understand") {
      const description = node.arguments[1];
      const parameters = node.arguments[2];
      if (!description || !ts.isStringLiteral(description) || !parameters || !ts.isObjectLiteralExpression(parameters)) {
        throw new Error("understand must expose a literal description and its actual parameter schema");
      }
      registration = {
        description: description.text,
        parameters: new Map(parameters.properties.flatMap(property => {
          if (!ts.isPropertyAssignment(property)) return [];
          const name = property.name;
          if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return [];
          return [[name.text, property.initializer] as const];
        })),
      };
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!registration) throw new Error("understand registration was not found in src/index.ts");
  return registration;
}

function parameterDescription(registration: Registration, name: string): string {
  const expression = registration.parameters.get(name);
  if (!expression) throw new Error(`understand parameter ${name} is missing`);
  const descriptions: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "describe"
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) descriptions.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(expression);
  if (descriptions.length !== 1) throw new Error(`Expected one description for understand.${name}, found ${descriptions.length}`);
  return descriptions[0];
}

describe("D: understand MCP source description matches retrieval contracts", () => {
  it("documents default 4000, candidate discovery and separately budgeted qualified cards", () => {
    const { description } = understandRegistration();
    expect(description).toMatch(/default\s+max_tokens\s+(?:is\s+)?4000/i);
    expect(description).toMatch(/candidates/i);
    expect(description).toMatch(/cards/i);
    expect(description).toMatch(/(?:default\s+20|pool[^.]*20)/i);
    expect(description).toMatch(/(?:up to|at most)\s+3/i);
    expect(description).toMatch(/(?:only when they fit|only if they fit|subject to[^.]*budget)/i);
    expect(description).toMatch(/first[^.]*card[^.]*candidates[^.]*(?:second|third)/i);
    expect(description).toMatch(/meta\.returned[^.]*candidates/i);
    expect(description).toMatch(/meta\.cards[^.]*cards/i);
    expect(description).toMatch(/meta\.dropped[^.]*wholly hidden/i);
    expect(description).toMatch(/candidate-only/i);
    expect(description).toMatch(/25%/);
    expect(description).not.toMatch(/(?:default\s+(?:max_tokens\s+)?(?:is\s+)?1500|max_tokens[^.]*default\s*:?\s*1500)/i);
  });

  it("documents loss text, exact expandable ids and no unconditional card guarantee", () => {
    const { description } = understandRegistration();
    expect(description).toContain("Показано N совпадений из M (K скрыто бюджетом) — уточни запрос или подними max_tokens.");
    expect(description).toMatch(/dropped\s*>\s*0/);
    expect(description).toMatch(/exact[^.]*id/i);
    expect(description).toContain("get_concept");
    expect(description).toMatch(/(?:never shorten id|untrimmed id)/i);
    expect(description).toMatch(/summary_short[^.]*80/i);
    expect(description).toMatch(/name[^.]*60/i);
    expect(description).toMatch(/90[^.]*tokens per entry/i);
    expect(description).toMatch(/summary_short before[^.]*name/i);
    expect(description).toMatch(/(?:no minimal qualified card fits|no[^.]*card fits),\s*meta\.reason is budget, not no_match/i);
    expect(description).not.toMatch(/(?:always returns|always includes|guarantees)\s+(?:at least\s+)?(?:one|three|1|3)\s+(?:compact\s+)?cards?/i);
    expect(description).toMatch(/mode:'full'[^.]*legacy[^.]*no candidates/i);
  });

  it("the actual max_tokens parameter no longer advertises 1500 as its default", () => {
    const registration = understandRegistration();
    const description = parameterDescription(registration, "max_tokens");
    expect(description).toMatch(/default\s*:?\s*4000/i);
    expect(description).not.toMatch(/default\s*:?\s*1500/i);
    expect(description).toMatch(/(?:MCP[^.]*envelope|wire)/i);
    expect(description).toMatch(/next/i);
    expect(description).toMatch(/(?:only if they fit|only when they fit)/i);
    expect(description).toMatch(/budget[^.]*no_match/i);
  });

  it("the collapse parameter is default-on in compact, explicit false remains supported", () => {
    const registration = understandRegistration();
    const description = parameterDescription(registration, "collapse_ref_anchors");
    expect(description).toMatch(/compact/);
    expect(description).toMatch(/(?:default[^.]*true|по умолчанию true)/i);
    expect(description).toMatch(/false/i);
    expect(description).not.toMatch(/opt-in|default(?:\s*:?\s*|\s*\([^)]*\)\s*)off|по умолчанию (?:выключен|false)/i);
    expect(registration.description).toMatch(/collapse_ref_anchors defaults to true in compact/i);
    expect(registration.description).toMatch(/path[^.]*exact full path/i);
  });
});
