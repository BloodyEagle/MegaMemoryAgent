import { describe, it, expect } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { auditDom, graphNode } from "./helpers/audit-dom.js";
import { auditFixture, addNode, sqlState } from "./helpers/audit.js";
import { ensureSchema } from "../migrate-schema.js";
import { mergeNodes, describeConsolidation, VersionConflictError } from "../consolidate.js";

function post(body: unknown, realDb?: Parameters<typeof mergeNodes>[0]) {
  const source = fs.readFileSync(new URL("../web.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("web.ts", source, ts.ScriptTarget.Latest, true);
  let callback = "";
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "req.on" && node.arguments[0]?.getText(ast) === '"end"') callback = node.arguments[1].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!callback) throw new Error("Missing consolidate HTTP body boundary");
  let response: { status: number; payload: unknown } | undefined;
  let expectation: unknown;
  const context = vm.createContext({
    parsed: body, chunks: [Buffer.from(JSON.stringify(body))], Buffer,
    tooLarge: false, MAX_BODY: 65536, db: realDb ?? {},
    respondOnce: (status: number, payload: unknown) => { response = { status, payload }; },
    mergeNodes: (_db: unknown, survivor: string, other: string, options: unknown) => {
      expectation = options;
      return realDb ? mergeNodes(realDb, survivor, other, options as Parameters<typeof mergeNodes>[3]) : {};
    },
    VersionConflictError,
  });
  vm.runInContext(ts.transpileModule(`(${callback})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { response, expectation };
}

describe("E-01 HTTP preview version expectation", () => {
  it("passes the authoritative digest unchanged to the core apply", () => {
    const digest = "a".repeat(64);
    const result = post({ survivor: "a", other: "b", base: { digest, survivor_updated_at: null, other_updated_at: null } });
    expect(result.response?.status).toBe(200);
    expect(result.expectation).toEqual({ expect: { digest, survivor_updated_at: null, other_updated_at: null } });
  });

  it("same-second edge mutation after preview returns 409 without changing the SQL snapshot", async () => {
    const fixture = auditFixture();
    try {
      const db = fixture.db();
      ensureSchema(db);
      for (const id of ["a", "b", "peer"]) addNode(db, id);
      const preview = describeConsolidation(db, "a", "b");
      db.insertEdge({ from_id: "b", to_id: "peer", relation: "connects_to", description: "Changed after preview" });
      const before = sqlState(db);
      const result = post({ survivor: "a", other: "b", base: preview.base }, db);
      expect(result.response?.status).toBe(409);
      expect(sqlState(db)).toEqual(before);
    } finally { await fixture.close(); }
  });

  it.each([null, 12, "", "not-a-digest"])("invalid digest %j rejects before apply", digest => {
    const result = post({ survivor: "a", other: "b", base: { digest, survivor_updated_at: null, other_updated_at: null } });
    expect(result.response?.status).toBe(400);
    expect(result.expectation).toBeUndefined();
  });
});

const marker = '<audit-marker data-safe="true">metadata</audit-marker>';
describe("E-02 imported metadata is text", () => {
  it.each(["kind", "status", "created_at", "updated_at"])("detail %s never creates markup", async field => {
    const node = graphNode("node");
    const ui = await auditDom();
    try {
      await ui.evaluate(`showPanel(${JSON.stringify({ ...node, created_at: "baseline", [field]: marker })});`);
      await ui.settle();
      expect(ui.element("#panel-content").querySelectorAll("audit-marker")).toHaveLength(0);
      expect(ui.element("#panel-content").textContent).toContain(marker);
    } finally { ui.close(); }
  });

  it("stats kind keys never create imported markup", async () => {
    const ui = await auditDom();
    try {
      await ui.evaluate(`renderStats(${JSON.stringify({ nodes: 1, edges: 0, kinds: { [marker]: 1 } })});`);
      expect(ui.element("#stats").querySelectorAll("audit-marker")).toHaveLength(0);
      expect(ui.element("#stats").textContent).toContain(marker);
    } finally { ui.close(); }
  });
});
