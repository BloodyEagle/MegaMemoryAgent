import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeConsolidation, mergeNodes, VersionConflictError } from "../consolidate.js";
import { ensureSchema } from "../migrate-schema.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function database(name: string) {
  const db = fixture.db(name);
  ensureSchema(db);
  return db;
}

describe("UX-01 — один планировщик последствий для preview и apply", () => {
  it("preview обещает ровно то, что применяет mergeNodes, на одной и той же паре", () => {
    const db = database("plan.db");
    addNode(db, "A", { summary: "Первое описание", why: "why A", file_refs: ["src/a.ts"] });
    addNode(db, "B", { summary: "Второе описание", file_refs: ["src/b.ts", "src/a.ts"] });
    addNode(db, "kid", { parent_id: "B" });
    addNode(db, "P", {});
    addNode(db, "Q", {});
    db.insertEdge({ from_id: "B", to_id: "P", relation: "connects_to", description: "outgoing link" });
    db.insertEdge({ from_id: "Q", to_id: "B", relation: "depends_on", description: "incoming link" });
    db.insertEdge({ from_id: "A", to_id: "P", relation: "connects_to", description: "already there" });

    const plan = describeConsolidation(db, "A", "B");
    expect(plan.rejection).toBeUndefined();
    expect(plan.base.survivor_updated_at).toBe(db.getNode("A")!.updated_at);
    expect(plan.base.other_updated_at).toBe(db.getNode("B")!.updated_at);
    expect(plan.base.digest).toMatch(/^[0-9a-f]{64}$/);
    // B→P перемапился бы на A→P, но такое ребро у выжившего уже есть —
    // перенос не обещается и падает в edgesDropped.
    expect(plan.edgesToMove).toEqual([
      { from_id: "Q", to_id: "A", relation: "depends_on", description: "incoming link" },
    ]);
    expect(plan.edgesDropped).toBe(1);

    const result = mergeNodes(db, "A", "B");
    expect(result).toEqual({ survivor: "A", removed: "B" });

    // Контент выжившего — ровно то, что обещал план.
    const survivor = db.getNode("A")!;
    expect(survivor.summary).toBe(plan.finalSummary);
    expect(survivor.why).toBe(plan.finalWhy);
    expect(JSON.parse(survivor.file_refs ?? "[]")).toEqual(plan.fileRefs);

    // Каждое обещанное ребро стоит у выжившего с тем же описанием.
    for (const move of plan.edgesToMove) {
      const live = move.from_id === "A"
        ? db.getOutgoingEdges("A").find((e) => e.to_id === move.to_id && e.relation === move.relation)
        : db.getIncomingEdges("A").find((e) => e.from_id === move.from_id && e.relation === move.relation);
      expect(live, `${move.from_id} -${move.relation}-> ${move.to_id}`).toBeDefined();
      expect(live!.description).toBe(move.description);
    }
    // Рёбра у выжившего = его прежние живые + обещанные переносы, ничего лишнего.
    const liveAfter = db
      .getAllEdgesRaw()
      .filter((e) => e.removed_at === null && (e.from_id === "A" || e.to_id === "A"));
    expect(liveAfter).toHaveLength(2); // A→P (было; B→P — дедуп) + Q→A (перенос)
    // Дубль исчез; ребёнок переехал под выжившего.
    expect(db.getNode("B")).toBeUndefined();
    expect(db.getNode("kid")!.parent_id).toBe("A");
  });

  it("надгробия и рёбра к удалённым узлам не обещаются переносом — apply их и не переносит", () => {
    const db = database("tombstones.db");
    addNode(db, "A", { summary: "a" });
    addNode(db, "B", { summary: "b" });
    addNode(db, "P", {});
    addNode(db, "dead", { summary: "removed peer" });
    db.insertEdge({ from_id: "B", to_id: "P", relation: "connects_to", description: "live" });
    db.insertEdge({ from_id: "B", to_id: "dead", relation: "connects_to", description: "dead target" });
    db.insertEdge({ from_id: "B", to_id: "P", relation: "relates_to", description: "to tombstone" });
    db.deleteEdge("B", "P", "relates_to");
    db.softDeleteNode("dead", "history");

    const plan = describeConsolidation(db, "A", "B");
    expect(plan.rejection).toBeUndefined();
    // Старый preview считал надгробия и мёртвые концы (getAllEdgesRaw) и
    // обещал 3 переноса, а apply переносил только живые. Теперь числа сходятся.
    expect(plan.edgesToMove).toEqual([
      { from_id: "A", to_id: "P", relation: "connects_to", description: "live" },
    ]);
    expect(plan.edgesDropped).toBe(0);

    mergeNodes(db, "A", "B");
    const live = db.getAllEdgesRaw().filter((e) => e.removed_at === null);
    expect(live.map((e) => `${e.from_id}->${e.to_id}:${e.relation}`))
      .toEqual(["A->P:connects_to"]);
  });

  it("самопетля после ремапа не обещается переносом и считается dropped", () => {
    const db = database("selfloop.db");
    addNode(db, "A", { summary: "a" });
    addNode(db, "B", { summary: "b" });
    db.insertEdge({ from_id: "A", to_id: "B", relation: "connects_to", description: "A leads to B" });

    const plan = describeConsolidation(db, "A", "B");
    expect(plan.rejection).toBeUndefined();
    expect(plan.edgesToMove).toEqual([]);
    expect(plan.edgesDropped).toBe(1);
  });

  it("цикл informed_by предсказан preview и отвергнут apply тем же текстом, ноль записей", () => {
    const db = database("cycle-ib.db");
    addNode(db, "A", { summary: "a" });
    addNode(db, "B", { summary: "b" });
    addNode(db, "S", { summary: "s" });
    db.insertEdge({ from_id: "B", to_id: "S", relation: "informed_by", description: "B опирается на S" });
    db.insertEdge({ from_id: "S", to_id: "A", relation: "informed_by", description: "S опирается на A" });
    const before = sqlState(db);

    const plan = describeConsolidation(db, "A", "B");
    expect(plan.rejection).toMatch(/informed_by cycle rejected/);
    expect(() => mergeNodes(db, "A", "B")).toThrow(/informed_by cycle rejected/);
    expect(sqlState(db)).toEqual(before);
  });

  it("stale preview: изменившаяся нода даёт version_conflict до первой записи", () => {
    const db = database("stale.db");
    addNode(db, "A", { summary: "a" });
    addNode(db, "B", { summary: "b" });
    addNode(db, "P", {});
    db.insertEdge({ from_id: "B", to_id: "P", relation: "connects_to", description: "edge" });
    const plan = describeConsolidation(db, "A", "B");
    expect(plan.rejection).toBeUndefined();
    const before = sqlState(db);

    // Нода изменена между preview и confirm.
    db.updateNode("B", { summary: "другая формулировка" });
    const afterEdit = sqlState(db);
    expect(() => mergeNodes(db, "A", "B", { expect: plan.base })).toThrow(VersionConflictError);
    // Отказ не добавил ни одной записи поверх мутации.
    expect(sqlState(db)).toEqual(afterEdit);

    // Перечитанный preview подтверждается по актуальным версиям.
    const fresh = describeConsolidation(db, "A", "B");
    expect(fresh.rejection).toBeUndefined();
    expect(mergeNodes(db, "A", "B", { expect: fresh.base })).toEqual({ survivor: "A", removed: "B" });
  });

  it("stale preview: удаление ноды между preview и confirm даёт version_conflict", () => {
    const db = database("deleted.db");
    addNode(db, "A", { summary: "a" });
    addNode(db, "B", { summary: "b" });
    const plan = describeConsolidation(db, "A", "B");
    expect(plan.rejection).toBeUndefined();
    const before = sqlState(db);

    db.softDeleteNode("B", "removed elsewhere");
    const afterDelete = sqlState(db);
    expect(() => mergeNodes(db, "A", "B", { expect: plan.base })).toThrow(VersionConflictError);
    // Удаление осталось единственной мутацией: слияние не записало ничего.
    expect(sqlState(db)).toEqual(afterDelete);
  });

  it("актуальные версии проходят проверку и слияние выполняется", () => {
    const db = database("fresh.db");
    addNode(db, "A", { summary: "a" });
    addNode(db, "B", { summary: "b" });
    const plan = describeConsolidation(db, "A", "B");
    expect(mergeNodes(db, "A", "B", { expect: plan.base })).toEqual({ survivor: "A", removed: "B" });
    expect(db.getNode("B")).toBeUndefined();
  });
});
