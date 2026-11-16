import { describe, expect, it } from "vitest";
import { seedHttpDb } from "./helpers/audit-http.js";
import { startAuditHttpSrc } from "./helpers/audit-http-src.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";
import { auditDom } from "./helpers/audit-dom.js";
import { ensureSchema } from "../migrate-schema.js";
import type { KnowledgeDB } from "../db.js";

/**
 * B-03 (аудит 2026-11-12): SSE-детектор изменений узла сравнивал только
 * updated_at, который пишется с секундной точностью — второе содержательное
 * изменение узла в той же секунде не доставлялось никогда (до следующей
 * иной записи). Регрессия требует: второе изменение той же секунды приходит
 * как node_updated с новым содержимым; следующий poll без изменений молчит;
 * семантика add/remove прежняя.
 */

let fixture: AuditFixture;
let writer: KnowledgeDB | undefined;

/** Пиннуть updated_at второй записи к первой: обе записи легли «в одну
 * секунду» детерминированно (datetime('now') имеет секундную точность). */
function pinSameSecond(db: KnowledgeDB, id: string, timestamp: string) {
  db.execSqlRun("UPDATE nodes SET updated_at = ? WHERE id = ?", timestamp, id);
}

describe("B-03 — SSE доставляет второе изменение узла в той же секунде", () => {
  it("A15: внешний writer меняет только description, SSE обновляет rationale в consumer UI", async () => {
    const owned = auditFixture();
    let ui: Awaited<ReturnType<typeof auditDom>> | undefined;
    try {
      const dbFile = await seedHttpDb(owned, (db) => {
        db.insertNode({ id: "decision", name: "decision", kind: "decision", summary: "Decision wording" });
        db.insertNode({ id: "support", name: "support", kind: "feature", summary: "Support wording" });
        db.insertEdge({ from_id: "decision", to_id: "support", relation: "informed_by", description: "Исходное обоснование", via: "auto" });
      });
      const server = await startAuditHttpSrc(owned, dbFile);
      const writer = owned.track(new (await import("../db.js")).KnowledgeDB(dbFile));
      const sse = await server.events();
      expect(sse.status).toBe(200);
      const initial = await sse.next((event) => event.type === "init");
      expect(initial).toBeDefined();
      ui = await auditDom({ graph: initial!.data });
      ui.sse(initial);
      const rationale = () => ui!.evaluate<string>("edges.find(edge => !edge.isParentEdge && edge.relation === 'informed_by').description");
      expect(rationale()).toBe("Исходное обоснование");
      const coordinates = ui.graphState().nodes.map(({ id, x, y }) => ({ id, x, y }));
      const before = writer.getAllEdges()[0];
      const beforeNodes = writer.getAllActiveNodes();
      const beforeTimeline = writer.getTimelineBounds();

      // Separate connection, no node write, timeline entry or timestamp change.
      writer.execSqlRun("UPDATE edges SET description = ? WHERE id = ?", "Новое обоснование: источник уточнён", before.id);
      expect(writer.getAllEdges()[0]).toEqual({ ...before, description: "Новое обоснование: источник уточнён" });
      expect(writer.getAllActiveNodes()).toEqual(beforeNodes);
      expect(writer.getTimelineBounds()).toEqual(beforeTimeline);
      const changed = await sse.next((event) => event.type === "edge_updated" && event.data.from === "decision" && event.data.to === "support", 4000);
      expect(changed, "description-only external writes must deliver edge_updated").toBeDefined();
      expect(changed!.data).toMatchObject({
        from: "decision", to: "support", relation: "informed_by",
        description: "Новое обоснование: источник уточнён", created_via: "auto", accepted_at: null,
      });
      ui.sse(changed);
      // The shipped inline UI has no edge_updated handler. Its existing init
      // consumer must receive one fresh invalidation snapshot from this poll.
      const refreshed = await sse.next((event) => event.type === "init", 2000);
      expect(refreshed, "existing UI receives refreshed rationale without reconnect").toBeDefined();
      ui.sse(refreshed);
      expect(rationale()).toBe("Новое обоснование: источник уточнён");
      expect(ui.graphState().edges.filter((edge) => !edge.isParentEdge)).toHaveLength(1);
      expect(ui.graphState().nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(coordinates);
      expect(ui.errors).toEqual([]);
      expect(await sse.next((event) => ["edge_updated", "edge_added", "edge_removed", "init"].includes(event.type), 2000), "unchanged poll must not resend edge events or invalidation").toBeUndefined();
      expect(sse.error()).toBeNull();
    } finally { ui?.close(); await owned.close(); }
  }, 30_000);

  it("A15: provenance-only edge updates and null reset deliver full state; edge add/remove retain identity semantics", async () => {
    const owned = auditFixture();
    try {
      const dbFile = await seedHttpDb(owned, (db) => {
        db.insertNode({ id: "from", name: "from", kind: "feature", summary: "Source wording" });
        db.insertNode({ id: "to", name: "to", kind: "feature", summary: "Target wording" });
        db.insertEdge({ from_id: "from", to_id: "to", relation: "connects_to", description: "Unchanged rationale", via: "auto" });
      });
      const server = await startAuditHttpSrc(owned, dbFile);
      const writer = owned.track(new (await import("../db.js")).KnowledgeDB(dbFile));
      const sse = await server.events();
      const initial = await sse.next((event) => event.type === "init");
      const identity = { from: "from", to: "to", relation: "connects_to" };
      expect(initial!.data.edges).toEqual([{ ...identity, description: "Unchanged rationale", created_via: "auto", accepted_at: null }]);
      const beforeNodes = writer.getAllActiveNodes();
      const beforeTimeline = writer.getTimelineBounds();
      for (const state of [
        { created_via: "auto", accepted_at: "2026-11-16T00:00:00.000Z" },
        { created_via: "agent", accepted_at: "2026-11-16T00:00:00.000Z" },
        { created_via: "agent", accepted_at: null },
      ]) {
        writer.execSqlRun("UPDATE edges SET created_via = ?, accepted_at = ? WHERE from_id = ? AND to_id = ? AND relation = ?", state.created_via, state.accepted_at, "from", "to", "connects_to");
        const changed = await sse.next((event) => event.type === "edge_updated", 4000);
        expect(changed?.data).toEqual({ ...identity, description: "Unchanged rationale", ...state });
        const refreshed = await sse.next((event) => event.type === "init", 2000);
        expect(refreshed?.data.edges).toEqual([changed!.data]);
      }
      expect(writer.getAllActiveNodes()).toEqual(beforeNodes);
      expect(writer.getTimelineBounds()).toEqual(beforeTimeline);
      writer.execSqlRun("UPDATE edges SET created_at = ? WHERE from_id = ?", "2000-01-01 00:00:00", "from");
      expect(await sse.next((event) => ["edge_updated", "edge_added", "edge_removed", "init"].includes(event.type), 2000), "timestamp-only poll must not resend unchanged state").toBeUndefined();

      writer.insertEdge({ from_id: "to", to_id: "from", relation: "depends_on", description: "New edge", via: "agent" });
      const added = await sse.next((event) => event.type === "edge_added", 4000);
      expect(added?.data).toEqual({ from: "to", to: "from", relation: "depends_on", description: "New edge", created_via: "agent", accepted_at: null });
      writer.deleteEdge("to", "from", "depends_on");
      const removed = await sse.next((event) => event.type === "edge_removed", 4000);
      expect(removed?.data).toEqual({ from: "to", to: "from", relation: "depends_on" });
      expect(await sse.next((event) => event.type === "edge_updated" || event.type === "init", 2000), "add/remove must not be reported as updates").toBeUndefined();
      expect(sse.error()).toBeNull();
    } finally { await owned.close(); }
  }, 30_000);

  it("изменение только подтверждения инвалидирует карточку и preview", async () => {
    const owned = auditFixture();
    try {
      const dbFile = await seedHttpDb(owned, (db) => {
        ensureSchema(db);
        db.insertNode({ id: "evidence", name: "evidence", kind: "feature", summary: "Evidence wording" });
      });
      const server = await startAuditHttpSrc(owned, dbFile);
      const writer = owned.track(new (await import("../db.js")).KnowledgeDB(dbFile));
      const sse = await server.events();
      await sse.next((event) => event.type === "init");
      const before = writer.getNode("evidence")!;
      writer.execSqlRun("UPDATE nodes SET validation_claim_digest = ?, validation_scope_digest = ? WHERE id = ?", "claim-only", "scope-only", "evidence");
      expect(writer.getNode("evidence")!.updated_at).toBe(before.updated_at);
      const changed = await sse.next((event) => event.type === "node_updated" && event.data.id === "evidence", 3500);
      expect(changed, "confirmation-only changes must invalidate the visible card").toBeDefined();
    } finally { await owned.close(); }
  });

  it("два содержательных изменения между poll-ами: второе приходит с новым содержимым", async () => {
    fixture = auditFixture();
    try {
      const dbFile = await seedHttpDb(fixture, (db) => {
        ensureSchema(db);
        db.insertNode({ id: "clock", name: "clock", kind: "feature", summary: "clock baseline" });
      });
      const server = await startAuditHttpSrc(fixture, dbFile);
      writer = new (await import("../db.js")).KnowledgeDB(dbFile);
      const sse = await server.events();
      try {
        expect(sse.status).toBe(200);
        // init — снапшот сервера; первое изменение узла.
        await sse.next((e) => e.type === "init", 6000);
        writer.updateNode("clock", { summary: "FIRST visible update" });
        const first = await sse.next((e) => e.type === "node_updated" && e.data?.id === "clock" && e.data?.summary === "FIRST visible update", 6000);
        expect(first, "poll delivered the first update").toBeDefined();
        const token1 = writer.getNode("clock")!.updated_at;

        // Второе изменение СРАЗУ после первого (детерминированно та же секунда).
        writer.updateNode("clock", { summary: "SECOND same-second update" });
        pinSameSecond(writer, "clock", token1);
        const afterPin = writer.getNode("clock")!;
        expect(afterPin.updated_at).toBe(token1);
        expect(afterPin.summary).toBe("SECOND same-second update");

        // До двух poll-циклов: второе событие обязано прийти с новым содержимым.
        const second = await sse.next((e) => e.type === "node_updated" && e.data?.id === "clock" && e.data?.summary === "SECOND same-second update", 4000);
        expect(second, "second same-second update delivered").toBeDefined();

        // Следующий poll без изменений молчит: никаких лишних node_updated.
        const silence = await sse.next((e) => e.type === "node_updated" && e.data?.id === "clock", 3500);
        expect(silence, "no spurious node_updated after delivery").toBeUndefined();
      } finally {
        sse.close();
      }

      // Семантика add/remove прежняя: новое событие node_added/node_removed.
      const sse2 = await server.events();
      try {
        await sse2.next((e) => e.type === "init", 6000);
        writer.insertNode({ id: "added", name: "added", kind: "feature", summary: "added node" });
        const added = await sse2.next((e) => e.type === "node_added" && e.data?.id === "added", 6000);
        expect(added, "node_added still delivered").toBeDefined();
        writer.softDeleteNode("added", "B-03 add/remove check");
        const removed = await sse2.next((e) => e.type === "node_removed" && e.data?.id === "added", 6000);
        expect(removed, "node_removed still delivered").toBeDefined();
      } finally {
        sse2.close();
      }
    } finally {
      writer?.close();
      writer = undefined;
      await fixture.close();
    }
  }, 60_000);
});
