import { describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { planIdRepair, applyIdRepair } from "../migrate.js";

function makeDb(): KnowledgeDB {
  const db = new KnowledgeDB(":memory:");
  ensureSchema(db);
  return db;
}

describe("B-09 nested broken-id repair keeps the parent prefix", () => {
  it("an empty parent id still provides the repaired prefix to its descendants", () => {
    const db = makeDb();
    try {
      db.insertNode({ id: "", name: "Parent", kind: "module", summary: "Empty legacy root" });
      db.insertNode({ id: "/", name: "Child", kind: "component", summary: "Child of empty id", parent_id: "" });
      const plan = planIdRepair(db);
      expect(plan.entries).toEqual([
        { oldId: "", newId: "parent", name: "Parent" },
        { oldId: "/", newId: "parent/child", name: "Child" },
      ]);
      expect(applyIdRepair(db, plan)).toEqual({ renamed: 2, skipped: 0 });
      expect(db.getNode("parent/child")?.parent_id).toBe("parent");
      expect(db.getAliasTarget("")).toBe("parent");
      expect(db.getAliasTarget("/")).toBe("parent/child");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });

  it("plans parent/child and applies the full nested rename", () => {
    const db = makeDb();
    try {
      db.insertNode({ id: "legacy/", name: "Parent", kind: "module", summary: "Broken parent" });
      db.insertNode({ id: "legacy//", name: "Child", kind: "component", summary: "Broken child", parent_id: "legacy/" });
      db.insertNode({ id: "other", name: "Other", kind: "fact", summary: "Independent node" });
      db.insertEdge({ from_id: "legacy//", to_id: "other", relation: "informed_by", description: "Evidence" });

      const plan = planIdRepair(db);
      const parentEntry = plan.entries.find((e) => e.oldId === "legacy/");
      const childEntry = plan.entries.find((e) => e.oldId === "legacy//");
      // Ребёнок строит id от уже разрешённого БУДУЩЕГО id родителя, а не от
      // корня: родитель есть в итоговом пространстве плана, хоть его ещё нет
      // в базе (план ничего не пишет).
      expect(parentEntry).toMatchObject({ oldId: "legacy/", newId: "parent", name: "Parent" });
      expect(childEntry).toMatchObject({ oldId: "legacy//", newId: "parent/child", name: "Child" });
      expect(plan.unresolvedDescendants).toBe(0);

      expect(applyIdRepair(db, plan)).toEqual({ renamed: 2, skipped: 0 });
      expect(db.getNode("parent")).toBeDefined();
      const child = db.getNode("parent/child");
      expect(child).toBeDefined();
      expect(child?.parent_id).toBe("parent");
      expect(child?.name).toBe("Child");
      // Б12.3: старые id остаются разрешимыми через aliases.
      expect(db.getAliasTarget("legacy/")).toBe("parent");
      expect(db.getAliasTarget("legacy//")).toBe("parent/child");
      // Рёбра следуют за переименованием.
      expect(db.getOutgoingEdges("parent/child").map((e) => e.to_id)).toEqual(["other"]);
      expect(db.nodeExists("legacy//")).toBe(false);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("chains three broken levels under resolved parents", () => {
    const db = makeDb();
    try {
      db.insertNode({ id: "a/", name: "Alpha", kind: "module", summary: "Level 1" });
      db.insertNode({ id: "a//", name: "Beta", kind: "component", summary: "Level 2", parent_id: "a/" });
      db.insertNode({ id: "a///", name: "Gamma", kind: "component", summary: "Level 3", parent_id: "a//" });

      const plan = planIdRepair(db);
      expect(plan.entries.map((e) => [e.oldId, e.newId])).toEqual([
        ["a/", "alpha"],
        ["a//", "alpha/beta"],
        ["a///", "alpha/beta/gamma"],
      ]);
      expect(applyIdRepair(db, plan)).toEqual({ renamed: 3, skipped: 0 });
      expect(db.getNode("alpha/beta/gamma")?.parent_id).toBe("alpha/beta");
      expect(db.getNode("alpha/beta")?.parent_id).toBe("alpha");
      expect(db.getAliasTarget("a///")).toBe("alpha/beta/gamma");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("a removed target is occupied and apply stays atomic if a stale plan collides", () => {
    const db = makeDb();
    try {
      db.insertNode({ id: "legacy/", name: "First", kind: "module", summary: "First rename" });
      db.insertNode({ id: "other/", name: "Taken", kind: "module", summary: "Would collide" });
      db.insertNode({ id: "taken", name: "Removed target", kind: "module", summary: "Tombstone still owns id" });
      db.softDeleteNode("taken", "reserved tombstone id");
      const plan = planIdRepair(db);
      expect(plan.entries.map((entry) => entry.oldId)).toEqual(["legacy/"]);
      expect(plan.conflicts.map((entry) => entry.oldId)).toEqual(["other/"]);

      const stale = {
        ...plan,
        entries: [...plan.entries, { oldId: "other/", newId: "taken", name: "Taken" }],
        conflicts: [],
      };
      expect(() => applyIdRepair(db, stale)).toThrow(/already exists/);
      expect(db.getNode("legacy/")).toBeDefined();
      expect(db.getNode("first")).toBeUndefined();
      expect(db.getAliasTarget("legacy/")).toBeUndefined();
    } finally { db.close(); }
  });

  it("a target taken in the database becomes a plan conflict, not an overwrite", () => {
    const db = makeDb();
    try {
      db.insertNode({ id: "legacy/", name: "Parent", kind: "module", summary: "Broken parent" });
      db.insertNode({ id: "legacy//", name: "Child", kind: "component", summary: "Broken child", parent_id: "legacy/" });
      db.insertNode({ id: "parent/child", name: "Squatter", kind: "fact", summary: "Occupies the target" });

      const plan = planIdRepair(db);
      expect(plan.entries).toEqual([{ oldId: "legacy/", newId: "parent", name: "Parent" }]);
      expect(plan.conflicts).toEqual([{ oldId: "legacy//", newId: "parent/child", name: "Child" }]);

      expect(applyIdRepair(db, plan)).toEqual({ renamed: 1, skipped: 1 });
      // Цель занята другим узлом — он не перезаписан, сломанный ребёнок
      // остался как был (до следующего repair).
      expect(db.getNode("parent/child")?.name).toBe("Squatter");
      expect(db.getNode("legacy//")).toBeDefined();
      expect(db.getNode("parent")).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("two broken rows planning the same target collide at plan level", () => {
    const db = makeDb();
    try {
      db.insertNode({ id: "dup1/", name: "Same", kind: "fact", summary: "First broken row" });
      db.insertNode({ id: "dup2/", name: "Same", kind: "fact", summary: "Second broken row" });

      const plan = planIdRepair(db);
      expect(plan.entries).toEqual([{ oldId: "dup1/", newId: "same", name: "Same" }]);
      expect(plan.conflicts).toEqual([{ oldId: "dup2/", newId: "same", name: "Same" }]);
      expect(applyIdRepair(db, plan)).toEqual({ renamed: 1, skipped: 1 });
      expect(db.getNode("same")?.id).toBe("same");
      expect(db.getNode("dup2/")).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("descendants of an unresolved broken parent stay unplanned, not rooted", () => {
    const db = makeDb();
    try {
      // Занимает целевой id родителя — родитель уйдёт в conflicts.
      db.insertNode({ id: "parent", name: "Occupier", kind: "fact", summary: "Occupies the target" });
      db.insertNode({ id: "legacy/", name: "Parent", kind: "module", summary: "Broken parent" });
      db.insertNode({ id: "legacy//", name: "Child", kind: "component", summary: "Broken child", parent_id: "legacy/" });

      const plan = planIdRepair(db);
      expect(plan.conflicts.map((e) => e.oldId)).toEqual(["legacy/"]);
      // Ребёнок нерешённого родителя не получает корневой id и не теряет
      // префикс молча — политика видна в плане.
      expect(plan.entries.map((e) => e.newId)).not.toContain("child");
      expect(plan.entries.find((e) => e.oldId === "legacy//")).toBeUndefined();
      expect(plan.conflicts.find((e) => e.oldId === "legacy//")).toBeUndefined();
      expect(plan.unresolvedDescendants).toBe(1);
    } finally {
      db.close();
    }
  });

  it("a broken child with a dangling parent stays broken, not rooted", () => {
    const db = makeDb();
    try {
      // Висящий parent_id без строки в базе возможен только в импортированных
      // данных (FK): вставляем напрямую, как внешний SQLite.
      db.pragma("foreign_keys = OFF");
      try {
        db.execSqlRun(
          "INSERT INTO nodes (id, name, kind, summary, parent_id) VALUES ('ghost//', 'Orphan', 'feature', 'Broken child of a missing parent', 'ghost')"
        );
      } finally {
        db.pragma("foreign_keys = ON");
      }

      const plan = planIdRepair(db);
      // Молча превращать в корневой 'orphan' нельзя — родитель нерешаем,
      // потомок остаётся без плана до починки родителя.
      expect(plan.entries).toEqual([]);
      expect(plan.conflicts).toEqual([]);
      expect(plan.unresolvedDescendants).toBe(1);
      expect(db.getNode("ghost//")).toBeDefined();
      expect(db.getNode("orphan")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("a second repair after apply is idempotent", () => {
    const db = makeDb();
    try {
      db.insertNode({ id: "legacy/", name: "Parent", kind: "module", summary: "Broken parent" });
      db.insertNode({ id: "legacy//", name: "Child", kind: "component", summary: "Broken child", parent_id: "legacy/" });
      applyIdRepair(db, planIdRepair(db));

      const second = planIdRepair(db);
      expect(second.entries).toEqual([]);
      expect(second.conflicts).toEqual([]);
      expect(second.unresolvedDescendants).toBe(0);
      expect(applyIdRepair(db, second)).toEqual({ renamed: 0, skipped: 0 });
      expect(db.getNode("parent/child")).toBeDefined();
      expect(db.getAllNodesRaw()).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
