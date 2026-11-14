import { describe, expect, it } from "vitest";
import { seedHttpDb } from "./helpers/audit-http.js";
import { startAuditHttpSrc } from "./helpers/audit-http-src.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";
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
