import { describe, it, expect } from "vitest";
import { nodesAreIdentical } from "../merge.js";
import { KnowledgeDB } from "../db.js";

describe("B-01 full semantic merge equality", () => {
  it.each([
    ["task_state", "done"], ["due_at", "2030-01-01"], ["valid_until", "2020-01-01"],
    ["valid_from", "2026-11-10"], ["status_scope", '{"artifact":"new-run"}'],
    ["removed_reason", "Independent removal reason"], ["created_by_task", "Different task context"],
  ])("%s divergence is never a clean merge in either order", (field, value) => {
    const db = new KnowledgeDB(":memory:");
    try {
      db.insertNode({ id: "claim", name: "claim", kind: "feature", summary: "Concrete merge claim" });
      const left = db.getNodeIncludingRemoved("claim")!;
      const right = { ...left, [field]: value };
      expect(nodesAreIdentical(left, right)).toBe(false);
      expect(nodesAreIdentical(right, left)).toBe(false);
    } finally { db.close(); }
  });
});
