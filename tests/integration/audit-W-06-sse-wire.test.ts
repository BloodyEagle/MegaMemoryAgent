import { afterEach, describe, expect, it } from "vitest";
import { addNode, auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { seedHttpDb, startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

let fixture: AuditFixture | undefined;
afterEach(async () => { const owned = fixture; fixture = undefined; await owned?.close(); });

async function start() {
  fixture = auditFixture();
  const file = await seedHttpDb(fixture, (db) => {
    addNode(db, "old-parent");
    addNode(db, "new-parent");
    addNode(db, "moving", { parent_id: "old-parent" });
    db.execSqlRun("UPDATE nodes SET updated_at = ?", "2026-01-01 00:00:00");
  });
  return startAuditHttp(fixture, file);
}

describe("W-06 — real SSE transports complete graph state", () => {
  it.each(["new-parent", null])("node_updated includes lifecycle status and parent_id=%s", async (parent_id) => {
    const server = await start();
    const events = await server.events();
    expect(events.status, server.diagnostics()).toBe(200);
    const initial = await events.next((event) => event.type === "init");
    expect(initial, `missing SSE init: ${events.error()} ${server.diagnostics()}`).toBeDefined();
    expect(initial!.data.nodes.find((node: { id: string }) => node.id === "moving")).toMatchObject({ status: "active", parent_id: "old-parent" });
    const writer = fixture!.db("http.db");
    // Controlled fixture mutation; assertions observe the real producer's SSE wire payload.
    writer.execSqlRun("UPDATE nodes SET status = ?, parent_id = ?, name = ?, summary = ?, updated_at = ? WHERE id = ?",
      "deprecated", parent_id, "Moved node", "Updated over SSE", "2040-01-02 03:04:05", "moving");
    await fixture!.release(writer);
    const updated = await events.next((event) => event.type === "node_updated" && event.data.id === "moving");
    expect(updated, `missing update: ${events.error()} ${server.diagnostics()}`).toMatchObject({
      type: "node_updated", data: { id: "moving", name: "Moved node", summary: "Updated over SSE", status: "deprecated", parent_id },
    });
  });

  it("a new SSE connection receives the fresh snapshot, including changes made while disconnected", async () => {
    const server = await start();
    const first = await server.events();
    expect(first.status).toBe(200);
    expect(await first.next((event) => event.type === "init")).toBeDefined();
    await fixture!.release(first);
    const writer = fixture!.db("http.db");
    writer.execSqlRun("UPDATE nodes SET status = ?, parent_id = ?, updated_at = ? WHERE id = ?", "deprecated", "new-parent", "2040-01-02 03:04:05", "moving");
    writer.softDeleteNode("old-parent", "removed while disconnected");
    addNode(writer, "added-offline");
    writer.insertEdge({ from_id: "added-offline", to_id: "moving", relation: "connects_to" });
    await fixture!.release(writer);
    const second = await server.events();
    const initial = await second.next((event) => event.type === "init");
    expect(initial).toBeDefined();
    expect(initial!.data.nodes.map((node: { id: string }) => node.id).sort()).toEqual(["added-offline", "moving", "new-parent"]);
    expect(initial!.data.nodes.find((node: { id: string }) => node.id === "moving")).toMatchObject({ status: "deprecated", parent_id: "new-parent" });
    expect(initial!.data.edges).toContainEqual(expect.objectContaining({ from: "added-offline", to: "moving", relation: "connects_to" }));
    expect(second.error()).toBeNull();
  });
});
