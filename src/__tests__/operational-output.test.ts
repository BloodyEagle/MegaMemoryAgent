import { describe, it, expect } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { addNode } from "./helpers/audit.js";
import { board, trailRefresh, trailGet } from "../tools.js";

describe("P-13 operational output", () => {
  it("D-03 exposes the total done count and a stable keyset continuation", () => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      for (let i = 0; i < 25; i++) { addNode(db, `task-${i}`); db.setTaskState(`task-${i}`, "done", null); }
      const first = board(db).columns.find(c => c.name === "done")!;
      expect(first.count).toBe(25);
      expect(first.returned).toBe(20);
      expect(first.has_more).toBe(true);
      expect(first.next_cursor).toEqual(expect.any(String));
      const second = board(db, { done_cursor: first.next_cursor! }).columns.find(c => c.name === "done")!;
      expect(second.count).toBe(25);
      expect(second.returned).toBe(5);
      expect(second.has_more).toBe(false);
      expect(new Set([...first.cards, ...second.cards].map(c => c.id)).size).toBe(25);
    } finally { db.close(); }
  });

  it("D-04 refresh returns the actual post-state and stale reasons", () => {
    const db = new KnowledgeDB(":memory:"); ensureSchema(db);
    try {
      addNode(db, "expired", { valid_until: "2020-01-01" });
      db.insertTrail({ id: "trail", name: "trail", summary: "Verified reasoning", node_ids: ["expired"] });
      const result = trailRefresh(db, "trail");
      const actual = trailGet(db, "trail");
      expect(result.state).toBe(actual.state);
      expect(result.state).toBe("stale");
      expect(result.reasons).toEqual(actual.members.filter(m => m.state !== "fresh").map(m => m.reason));
      expect(result.message).not.toContain("chain is fresh");
    } finally { db.close(); }
  });
});
