import { afterEach, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { auditFixture, addNode, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { seedHttpDb } from "../../src/__tests__/helpers/audit-http.js";
import { p14Http } from "./p14-http.js";

let fixture: AuditFixture | undefined;
afterEach(async () => { const owned = fixture; fixture = undefined; await owned?.close(); });

describe("P14 E03/E08/R07 public HTTP isolated offline", () => {
  it("hybrid vector-disabled FTS200, authoritative exclusions and browser headers", async () => {
    fixture = auditFixture();
    const file = await seedHttpDb(fixture, db => {
      addNode(db, "current", { summary: "p14currentneedle" });
      addNode(db, "refuted", { summary: "p14excludedneedle", epistemic_status: "refuted" });
      addNode(db, "expired", { summary: "p14excludedneedle" });
      db.updateNode("expired", { valid_until: "2000-01-01" });
      expect(db.getNode("expired")?.valid_until).toBe("2000-01-01");
      addNode(db, "superseded", { summary: "p14excludedneedle" });
      db.setNodeStatus("superseded", "superseded");
      db.setMetaValue("embed_model", "p14-disabled-benign-model-marker");
    });
    const server = await p14Http(fixture, file, '/vendor/d3.min.js?marker="p14-benign"&text=<p14-marker>');
    const match = await server.request("/api/search?q=p14currentneedle");
    expect(match.status, server.diagnostics()).toBe(200);
    expect((await match.json()).matches.map((m: { id: string }) => m.id)).toContain("current");
    const empty = await server.request("/api/search?q=p14excludedneedle");
    expect(empty.status).toBe(200);
    expect((await empty.json()).matches).toEqual([]);
    const stats = await (await server.request("/api/stats")).json();
    expect(stats.memory.model_loaded).toBe(false);
    expect(stats.embeddings.vector_search).toBe(false);
    expect(server.diagnostics()).not.toContain("Loading embedding model");
    const graph = await (await server.request("/api/graph")).json();
    expect(graph.nodes.find((n: { id: string }) => n.id === "expired")).toMatchObject({ expired: true, valid_until: "2000-01-01" });
    const page = await server.request("/");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    const html = await page.text();
    expect(html).toContain('marker=&quot;p14-benign&quot;&amp;text=&lt;p14-marker&gt;');
    expect(html).not.toContain('<p14-marker>');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/.test(match[1])) continue;
      expect(csp).toContain(`'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`);
    }
    expect((await server.request("/vendor/%ZZ.js")).status).toBe(400);
    expect((await server.request("/api/stats", { Referer: server.origin.replace("http:", "https:") + "/ui" })).status).toBe(403);
    expect((await server.request("/api/stats", { Origin: "http://benign.invalid" })).status).toBe(403);
    expect((await server.request("/api/stats", { Origin: server.origin })).status).toBe(200);
  });
});
