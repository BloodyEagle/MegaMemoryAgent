import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { understand, listRoots, getConcept, estimateTokens } from "../tools.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-usage-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("usage accounting", () => {
  it("understand/list_roots/get_concept write usage rows; aggregates count them", async () => {
    const db = freshDb();
    db.insertNode({ id: "mod", name: "Mod", kind: "module", summary: "m" });
    db.insertNode({ id: "mod/a", name: "A", kind: "feature", summary: "alpha thing", parent_id: "mod" });

    await understand(db, { query: "alpha" });
    await understand(db, { query: "alpha" });
    listRoots(db, {});
    getConcept(db, { id: "mod" });

    const stats = db.getUsageStats(7);
    expect(stats.total_queries).toBe(4);
    expect(stats.total_tokens).toBeGreaterThan(0);
    expect(stats.avg_tokens).toBeGreaterThan(0);
    expect(stats.top_queries[0]?.query).toBe("alpha");
    expect(stats.top_queries[0]?.n).toBe(2);
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0].queries).toBe(4);
  });

  it("understand recorded tokens match meta.tokens_estimated", async () => {
    const db = freshDb();
    db.insertNode({ id: "n1", name: "N", kind: "feature", summary: "summary text" });
    const result = await understand(db, { query: "summary" });
    const stats = db.getUsageStats(7);
    expect(stats.total_tokens).toBe(result.meta!.tokens_estimated);
    expect(stats.total_tokens).toBeLessThanOrEqual(1500);
  });

  it("estimateTokens is conservative (utf8 bytes, А6)", () => {
    const text = "привет".repeat(100); // 600 chars = 1200 bytes
    expect(estimateTokens(text)).toBe(400);
  });

  it("usage rows carry estimated_full_tokens and saved_tokens (В15)", async () => {
    const db = freshDb();
    db.insertNode({ id: "x1", name: "X", kind: "feature", summary: "summary text" });
    const result = await understand(db, { query: "summary" });
    const stats = db.getUsageStats(7);
    expect(stats.saved_tokens).toBeGreaterThanOrEqual(0);
    expect(stats.total_tokens).toBe(result.meta!.tokens_estimated);
  });
});
