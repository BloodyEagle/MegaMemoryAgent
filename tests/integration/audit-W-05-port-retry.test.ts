import { afterEach, describe, expect, it } from "vitest";
import { addNode, auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { reserveAuditPort, seedHttpDb, startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

let fixture: AuditFixture | undefined;
afterEach(async () => { const owned = fixture; fixture = undefined; await owned?.close(); });

describe("W-05 — Host gate follows the actual bound address after retry", () => {
  it("an owned occupied port prompts for a free port whose printed URL serves requests", async () => {
    fixture = auditFixture();
    const file = await seedHttpDb(fixture, (db) => addNode(db, "owned-retry-node"));
    const occupied = await reserveAuditPort(fixture);
    const alternative = await reserveAuditPort(fixture);
    const server = await startAuditHttp(fixture, file, { port: occupied.port, retry: alternative });
    expect(server.port).toBe(alternative.port);
    expect(server.port).not.toBe(occupied.port);
    expect(occupied.listening()).toBe(true);
    const response = await server.request("/api/graph");
    expect.soft(response.status, `the actual advertised URL must pass Host gate: ${JSON.stringify(response)}\n${server.diagnostics()}`).toBe(200);
    if (response.status === 200) expect(JSON.parse(response.text).nodes.map((node: { id: string }) => node.id)).toEqual(["owned-retry-node"]);
    const foreignHost = await server.request("/api/graph", { headers: { Host: `foreign.invalid:${server.port}` } });
    expect(foreignHost.status).toBe(403);
    const oldHost = await server.request("/api/graph", { headers: { Host: `127.0.0.1:${occupied.port}` } });
    expect(oldHost.status, "the no-longer-bound port must not remain authorized").toBe(403);
  });

  it("a normal free-port bind allows the matching origin and rejects foreign Host/Origin", async () => {
    fixture = auditFixture();
    const file = await seedHttpDb(fixture, (db) => addNode(db, "owned-normal-node"));
    const server = await startAuditHttp(fixture, file);
    expect(server.port).not.toBe(4321);
    expect((await server.request("/api/stats", { headers: { Origin: server.origin } })).status).toBe(200);
    expect((await server.request("/api/stats", { headers: { Host: `foreign.invalid:${server.port}` } })).status).toBe(403);
    expect((await server.request("/api/stats", { headers: { Origin: "http://foreign.invalid" } })).status).toBe(403);
    expect(server.alive()).toBe(true);
  });
});
