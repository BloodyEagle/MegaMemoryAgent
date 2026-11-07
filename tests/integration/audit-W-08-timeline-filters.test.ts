import { afterEach, describe, expect, it } from "vitest";
import { auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { seedHttpDb, startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

let fixture: AuditFixture | undefined;
afterEach(async () => { const owned = fixture; fixture = undefined; await owned?.close(); });

const examples: Array<{ label: string; params: Record<string, string>; expected: string[] }> = [
  { label: "writes_only", params: { writes_only: "true" }, expected: ["created target", "updated target"] },
  { label: "tool", params: { tool: "get_concept" }, expected: ["read one target"] },
  { label: "since", params: { since: "2026-11-03 00:00:00" }, expected: ["created target", "read one target", "updated target"] },
  { label: "until", params: { until: "2026-11-04 23:59:59" }, expected: ["read initial graph", "created target", "read one target"] },
  { label: "combined filters", params: { writes_only: "1", tool: "create_concept", since: "2026-11-03 00:00:00", until: "2026-11-04 23:59:59" }, expected: ["created target"] },
];

async function start() {
  fixture = auditFixture();
  const file = await seedHttpDb(fixture, (db) => {
    for (const [tool, is_write, result_summary, timestamp] of [
      ["understand", false, "read initial graph", "2026-11-01 01:00:00"],
      ["create_concept", true, "created target", "2026-11-03 12:00:00"],
      ["get_concept", false, "read one target", "2026-11-04 12:00:00"],
      ["update_concept", true, "updated target", "2026-11-06 12:00:00"],
    ] as const) {
      const seq = db.insertTimelineEntry({ tool, params: "{}", result_summary, is_write, is_error: false, affected_ids: ["target"] });
      db.execSqlRun("UPDATE timeline SET timestamp = ? WHERE seq = ?", timestamp, seq);
    }
  });
  return startAuditHttp(fixture, file);
}

describe("W-08 — timeline filters apply before the default kind branch", () => {
  it.each(examples)("$label works when kind is omitted", async ({ params, expected }) => {
    const server = await start();
    const query = new URLSearchParams(params).toString();
    expect(new URLSearchParams(query).has("kind")).toBe(false);
    const response = await server.request(`/api/timeline?${query}`);
    expect(response.status, server.diagnostics()).toBe(200);
    expect(JSON.parse(response.text).entries.map((entry: { result_summary: string }) => entry.result_summary)).toEqual(expected);
  });

  it.each(examples)("$label still works for explicit kind=tools", async ({ params, expected }) => {
    const server = await start();
    const response = await server.request(`/api/timeline?${new URLSearchParams({ ...params, kind: "tools" })}`);
    expect(response.status, server.diagnostics()).toBe(200);
    expect(JSON.parse(response.text).entries.map((entry: { result_summary: string }) => entry.result_summary)).toEqual(expected);
  });

  it("explicit all uses the same writes-only contract as the default kind", async () => {
    const server = await start();
    const response = await server.request("/api/timeline?kind=all&writes_only=true");
    expect(response.status, server.diagnostics()).toBe(200);
    expect(JSON.parse(response.text).entries.map((entry: { result_summary: string }) => entry.result_summary)).toEqual(["created target", "updated target"]);
  });

  it("an unfiltered timeline is chronological and limit still bounds the response", async () => {
    const server = await start();
    const full = await server.request("/api/timeline");
    expect(full.status).toBe(200);
    expect(JSON.parse(full.text).entries.map((entry: { result_summary: string }) => entry.result_summary)).toEqual(["read initial graph", "created target", "read one target", "updated target"]);
    const limited = await server.request("/api/timeline?limit=1");
    expect(limited.status).toBe(200);
    expect(JSON.parse(limited.text).entries.map((entry: { result_summary: string }) => entry.result_summary)).toEqual(["read initial graph"]);
  });
});
