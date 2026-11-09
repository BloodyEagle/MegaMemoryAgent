import { afterEach, describe, expect, it } from "vitest";
import { addNode, auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { seedHttpDb, startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

let fixture: AuditFixture | undefined;
afterEach(async () => { const owned = fixture; fixture = undefined; await owned?.close(); });

describe("E-01 public HTTP consolidation CAS", () => {
  it("preview followed by a same-timestamp edge change returns 409 and no apply writes", async () => {
    fixture = auditFixture();
    const file = await seedHttpDb(fixture, db => {
      addNode(db, "survivor"); addNode(db, "other"); addNode(db, "peer");
    });
    const server = await startAuditHttp(fixture, file);
    const preview = await server.request("/api/consolidate/preview?survivor=survivor&other=other");
    expect(preview.status, server.diagnostics()).toBe(200);
    const plan = JSON.parse(preview.text);
    expect(plan.base.digest).toMatch(/^[0-9a-f]{64}$/);
    const db = fixture.db("http.db");
    db.insertEdge({ from_id: "other", to_id: "peer", relation: "connects_to", description: "Changed after the preview" });
    await fixture.release(db);
    const before = await server.request("/api/graph");
    const response = await server.request("/api/consolidate", {
      method: "POST", body: JSON.stringify({ survivor: "survivor", other: "other", base: plan.base }),
    });
    expect(response.status, server.diagnostics()).toBe(409);
    expect(JSON.parse(response.text).error).toBe("version_conflict");
    const after = await server.request("/api/graph");
    expect(JSON.parse(after.text)).toEqual(JSON.parse(before.text));
    expect(server.alive()).toBe(true);
  });
});
