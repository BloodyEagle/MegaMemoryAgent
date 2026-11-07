import { afterEach, describe, expect, it } from "vitest";
import { addNode, auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { seedHttpDb, startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

let fixture: AuditFixture | undefined;
afterEach(async () => { const owned = fixture; fixture = undefined; await owned?.close(); });

async function start() {
  fixture = auditFixture();
  const file = await seedHttpDb(fixture, (db) => {
    addNode(db, "survivor", { name: "Survivor", summary: "Preserved concept" });
    addNode(db, "other", { name: "Other", summary: "Concept to consolidate" });
  });
  return startAuditHttp(fixture, file);
}

describe("W-02 — invalid JSON values never terminate the HTTP server", () => {
  it.each([
    ["null", "null"], ["array", "[]"], ["number", "7"], ["string", '"text"'], ["boolean", "false"],
    ["object missing IDs", "{}"], ["malformed JSON", "{"],
  ])("%s is one 400 response, followed by a healthy GET and unchanged graph", async (_label, body) => {
    const server = await start();
    const before = await server.request("/api/graph");
    expect(before.status, server.diagnostics()).toBe(200);
    const response = await server.request("/api/consolidate", { method: "POST", body });
    const after = await server.request("/api/graph");
    // A crashed child / socket reset is data in these assertions, not a harness exception.
    expect.soft(response.status, `invalid POST: ${JSON.stringify(response)}\n${server.diagnostics()}`).toBe(400);
    expect.soft(after.status, `next GET: ${JSON.stringify(after)}\n${server.diagnostics()}`).toBe(200);
    expect.soft(server.alive(), server.diagnostics()).toBe(true);
    if (after.status === 200) expect(JSON.parse(after.text)).toEqual(JSON.parse(before.text));
  });

  it("a valid object merges the requested IDs and keeps serving", async () => {
    const server = await start();
    const response = await server.request("/api/consolidate", {
      method: "POST", body: JSON.stringify({ survivor: "survivor", other: "other" }),
    });
    expect(response.status, `${JSON.stringify(response)}\n${server.diagnostics()}`).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ ok: true });
    const after = await server.request("/api/graph");
    expect(after.status, server.diagnostics()).toBe(200);
    expect(JSON.parse(after.text).nodes.map((node: { id: string }) => node.id)).toEqual(["survivor"]);
    expect(server.alive()).toBe(true);
  });
});
