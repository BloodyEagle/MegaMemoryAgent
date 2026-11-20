import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import ts from "typescript";
import type { KnowledgeDB } from "../db.js";
import { createTimelineLogger, timelineActivity, type TimelineLogger } from "../timeline.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
let db: KnowledgeDB;
let logger: TimelineLogger;

beforeEach(() => {
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  logger = createTimelineLogger(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.close();
});

function logRead(isError = false): void {
  logger.log({ tool: "get_concept", params: {}, result_summary: "read", is_write: false, is_error: isError, affected_ids: [] });
}

describe("timeline process-local activity", () => {
  it("counts three reads and returns an isolated snapshot", () => {
    logRead(); logRead(); logRead();
    expect(logger.activity()).toEqual({ reads_since_write: 3, writes: 0, last_write_at: null });
    logger.activity().reads_since_write = 99;
    expect(timelineActivity(db)?.reads_since_write).toBe(3);
  });

  it("resets reads on a write and records its ISO timestamp", () => {
    logRead(); logRead(); logRead();
    logger.log({ tool: "create_concept", params: {}, result_summary: "created", is_write: true, is_error: false, affected_ids: ["result"] });
    const activity = logger.activity();
    expect(activity.reads_since_write).toBe(0);
    expect(activity.writes).toBe(1);
    expect(activity.last_write_at).not.toBeNull();
    expect(new Date(activity.last_write_at!).toISOString()).toBe(activity.last_write_at);
  });

  it("counts tool errors and keeps counting if timeline persistence fails", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "runWithRetry").mockImplementation(() => { throw new Error("timeline unavailable"); });
    expect(() => logRead(true)).not.toThrow();
    expect(logger.activity().reads_since_write).toBe(1);
    expect(error).toHaveBeenCalledWith("Timeline logging failed:", "timeline unavailable");
  });

  it("starts every logger at zero without loading prior timeline rows", () => {
    logRead(); logRead(); logRead();
    const other = createTimelineLogger(fixture.db("other.db"));
    expect(other.activity()).toEqual({ reads_since_write: 0, writes: 0, last_write_at: null });
    expect(logger.activity().reads_since_write).toBe(3);
    const fresh = createTimelineLogger(db);
    expect(fresh.activity()).toEqual({ reads_since_write: 0, writes: 0, last_write_at: null });
    expect(timelineActivity(db)).toEqual(fresh.activity());
  });

  it("every tool registration handler contains timeline.log without starting the server", () => {
    const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
    const handlers: ts.CallExpression[] = [];
    function visit(node: ts.Node): void {
      // Регистрации идут через локальный хелпер tool(name, desc, shape, handler)
      // (план 26 §1, фильтр MEGAMEMORY_TOOLS); конструкция та же, что была
      // у прямых server.tool(...) вызовов.
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "tool") handlers.push(node);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(handlers.length).toBeGreaterThan(0);
    for (const call of handlers) {
      const handler = call.arguments[call.arguments.length - 1];
      expect(handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)), call.arguments[0].getText(ast)).toBe(true);
      const text = handler.getText(ast);
      expect(text, call.arguments[0].getText(ast)).toMatch(/\btimeline\.log\s*\(/);
    }
  });
});
