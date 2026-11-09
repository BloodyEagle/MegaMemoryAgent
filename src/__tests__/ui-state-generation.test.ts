import { describe, it, expect } from "vitest";
import { p14Dom, graphNode, tick, deferred } from "./p14-dom.js";

describe("P14 checked HTTP data", () => {
  it.each([{ status: 500, body: { error: "offline" } }, { body: null }, { body: {} }])("duplicate scan error is not a clean graph (%j)", async reply => {
    const ui = await p14Dom({ reply: r => r.url === "/api/consolidate" ? reply : undefined });
    try {
      await ui.invoke("openConsolidate");
      expect(ui.element("#stats").textContent).toContain("failed");
      expect(ui.element("#stats").textContent).not.toContain("graph is clean");
    } finally { ui.close(); }
  });
});

describe("E08 authoritative search", () => {
  it.each([200, 503])("excluded-only local nodes stay excluded at HTTP %s", async status => {
    const excluded = [
      graphNode("refuted", { summary: "needle" }),
      graphNode("expired", { summary: "needle" }),
      graphNode("superseded", { summary: "needle", status: "superseded" }),
    ].map((node, i) => ({ ...node, epistemic_status: i === 0 ? "refuted" : "open", valid_until: i === 1 ? "2000-01-01" : null }));
    const ui = await p14Dom({ graph: { nodes: excluded, edges: [] }, reply: r => r.url.startsWith("/api/search?") ?
      { status, body: status === 200 ? { matches: [] } : { error: "unavailable" } } : undefined });
    try {
      ui.element("#search").value = "needle";
      ui.dispatch(ui.element("#search"), "keydown", { key: "Enter" });
      await ui.settle();
      expect(ui.element("#search-results").querySelectorAll(".search-result")).toHaveLength(0);
    } finally { ui.close(); }
  });
  it("HTTP200 empty never resurrects an eligible keyword match", async () => {
    const ui = await p14Dom({ graph: { nodes: [graphNode("needle")], edges: [] }, reply: r => r.url.startsWith("/api/search?") ? { body: { matches: [] } } : undefined });
    try {
      ui.element("#search").value = "needle";
      ui.dispatch(ui.element("#search"), "keydown", { key: "Enter" });
      await ui.settle();
      expect(ui.element("#search-results").querySelectorAll(".search-result")).toHaveLength(0);
      expect(ui.element("#search-results").textContent).toContain("No semantic matches");
    } finally { ui.close(); }
  });
  it("HTTP503 fallback keeps current qualification visible and excludes abandoned/expired", async () => {
    const graph = { nodes: [
      { ...graphNode("eligible", { summary: "needle" }), epistemic_status: "stub", valid_until: null },
      { ...graphNode("abandoned", { summary: "needle" }), epistemic_status: "abandoned", valid_until: null },
      { ...graphNode("expired", { summary: "needle" }), epistemic_status: "open", valid_until: "2000-01-01" },
    ], edges: [] };
    const ui = await p14Dom({ graph, reply: r => r.url.startsWith("/api/search?") ? { status: 503, body: { error: "offline" } } : undefined });
    try {
      ui.element("#search").value = "needle";
      ui.dispatch(ui.element("#search"), "keydown", { key: "Enter" });
      await ui.settle();
      expect(ui.element("#search-results").querySelectorAll(".search-result")).toHaveLength(1);
      expect(ui.element("#search-results").textContent).toContain("eligible");
      expect(ui.element("#search-results").textContent).toContain("stub");
    } finally { ui.close(); }
  });

  it("active expired detail visibly shows expiry", async () => {
    const ui = await p14Dom();
    try {
      await ui.evaluate(`showPanel(${JSON.stringify({ ...graphNode("ttl"), expired: true, valid_until: "2000-01-01" })});`);
      await ui.settle();
      expect(ui.element("#panel-content").textContent).toContain("expired");
      expect(ui.element("#panel-content").textContent).toContain("2000-01-01");
    } finally { ui.close(); }
  });
});

const plan = (survivor: string, other: string, digest = "a".repeat(64)) => ({ survivor, other, base: { digest }, refsAdded: [], edgesToMove: [], children: [], slots: [] });
describe("E04/E06 preview generations", () => {
  it("A→B→A accepts only the latest orientation response", async () => {
    const plans: ReturnType<typeof deferred<{ body: unknown }>>[] = [];
    const ui = await p14Dom({ reply: r => {
      if (r.url.startsWith("/api/consolidate/preview?")) { const p = deferred<{ body: unknown }>(); plans.push(p); return p.promise; }
      if (/^\/api\/node\/[ab]$/.test(r.url)) return { body: graphNode(r.url.endsWith("a") ? "a" : "b") };
    } });
    try {
      ui.evaluate('openConsolidatePreview("a", "b");');
      await tick();
      ui.evaluate('chooseConsolidateSurvivor("A"); chooseConsolidateSurvivor("B"); chooseConsolidateSurvivor("A");');
      await tick();
      expect(plans).toHaveLength(3);
      plans[2].resolve({ body: plan("a", "b", "c".repeat(64)) });
      await tick();
      plans[1].resolve({ body: plan("b", "a", "b".repeat(64)) });
      plans[0].resolve({ body: plan("a", "b") });
      await ui.settle();
      ui.dispatch(ui.element('[data-action="consolidate-merge"]'), "click");
      expect(ui.element("#consolidate-preview").textContent).toContain("Final confirmation");
      expect(ui.evaluate<string>("ccState.plan.data.base.digest")).toBe("c".repeat(64));
    } finally { plans.forEach(p => p.resolve({ body: plan("a", "b") })); ui.close(); }
  });
  it("closed preview cannot launch a plan against a different newly opened pair", async () => {
    const old = deferred<{ body: unknown }>();
    const ui = await p14Dom({ reply: r => {
      if (r.url === "/api/node/a") return old.promise;
      if (/^\/api\/node\/[bcd]$/.test(r.url)) return { body: graphNode(r.url.split("/").pop()!) };
      if (r.url.startsWith("/api/consolidate/preview?")) return { body: plan("c", "d") };
    } });
    try {
      ui.evaluate('openConsolidatePreview("a", "b"); closeConsolidatePreview(); openConsolidatePreview("c", "d"); chooseConsolidateSurvivor("A");');
      await tick();
      old.resolve({ body: graphNode("a") });
      await ui.settle();
      expect(ui.element("#consolidate-preview").textContent).toContain("Fixture c");
      expect(ui.requests.filter(r => r.url.includes("/consolidate/preview?")).map(r => r.url)).toEqual(["/api/consolidate/preview?survivor=c&other=d"]);
    } finally { old.resolve({ body: graphNode("a") }); ui.close(); }
  });
  it("invalid merge response is an error, never successful apply", async () => {
    const ui = await p14Dom({ reply: r => {
      if (r.method === "POST") return { body: {} };
      if (/^\/api\/node\/[ab]$/.test(r.url)) return { body: graphNode(r.url.endsWith("a") ? "a" : "b") };
      if (r.url.startsWith("/api/consolidate/preview?")) return { body: plan("a", "b") };
    } });
    try {
      ui.evaluate('openConsolidatePreview("a", "b");'); await ui.settle();
      ui.evaluate('chooseConsolidateSurvivor("A");'); await ui.settle();
      ui.dispatch(ui.element('[data-action="consolidate-merge"]'), "click");
      ui.dispatch(ui.element('[data-action="consolidate-confirm"]'), "click"); await ui.settle();
      expect(ui.element("#consolidate-preview").textContent).toContain("merge failed");
      expect(ui.element("#consolidate-preview").textContent).not.toContain("merged: survivor");
    } finally { ui.close(); }
  });
  it("invalidation during refresh keeps stale until a subsequent coherent refresh", async () => {
    let delayed = false;
    const card = deferred<{ body: unknown }>();
    const ui = await p14Dom({ reply: r => {
      if (r.url === "/api/node/a" && delayed) return card.promise;
      if (/^\/api\/node\/[ab]$/.test(r.url)) return { body: graphNode(r.url.endsWith("a") ? "a" : "b") };
      if (r.url.startsWith("/api/consolidate/preview?")) return { body: plan("a", "b") };
    } });
    try {
      ui.evaluate('openConsolidatePreview("a", "b");');
      await ui.settle();
      ui.evaluate('chooseConsolidateSurvivor("A");');
      await ui.settle();
      ui.sse({ type: "edge_added", data: { from: "a", to: "b", relation: "connects_to" } });
      expect(ui.element('[data-action="consolidate-retry"]').textContent).toContain("refresh");
      delayed = true;
      ui.dispatch(ui.element('[data-action="consolidate-retry"]'), "click");
      await tick();
      ui.sse({ type: "node_updated", data: { id: "a", summary: "changed" } });
      card.resolve({ body: graphNode("a") });
      await ui.settle();
      expect(ui.element("#consolidate-preview").textContent).toContain("preview stale");
      delayed = false;
      ui.dispatch(ui.element('[data-action="consolidate-retry"]'), "click");
      await ui.settle();
      expect(ui.element("#consolidate-preview").textContent).not.toContain("preview stale");
    } finally { card.resolve({ body: graphNode("a") }); ui.close(); }
  });
});

describe("E05/E06 timeline/live generations", () => {
  it("live reload HTTP500 preserves graph, reconnects, and never rejects", async () => {
    const ui = await p14Dom({ graph: { nodes: [graphNode("before")], edges: [] } });
    try {
      // Replace only the transport, not the UI logic.
      ui.evaluate(`fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'offline' }) }); timelineMode = true;`);
      await expect(ui.evaluate<Promise<void>>("exitTimelineMode()" )).resolves.toBeUndefined();
      expect(ui.graphState().nodes.map(n => n.id)).toEqual(["before"]);
      expect(ui.element("#transport-error").style.display).toBe("block");
      expect(ui.evaluate("evtSource !== null")).toBe(true);
    } finally { ui.close(); }
  });
  it("late live reload cannot overwrite a newer timeline entry", async () => {
    const graph = deferred<{ body: unknown }>();
    let delayed = false;
    const ui = await p14Dom({ reply: r => {
      if (delayed && r.url === "/api/graph") return graph.promise;
      if (r.url.startsWith("/api/timeline?")) return { body: { entries: [{ timestamp: "2020-01-01", tool: "fixture" }] } };
    } });
    try {
      delayed = true;
      ui.evaluate("timelineMode = true;");
      const exit = ui.evaluate<Promise<void>>("exitTimelineMode()");
      const enter = ui.evaluate<Promise<void>>("enterTimelineMode()");
      await enter;
      graph.resolve({ body: { nodes: [graphNode("obsolete-live")], edges: [] } });
      await exit;
      expect(ui.element("#timeline-toggle").textContent).toContain("Timeline");
      expect(ui.graphState().nodes.map(n => n.id)).not.toContain("obsolete-live");
    } finally { graph.resolve({ body: { nodes: [], edges: [] } }); ui.close(); }
  });
  it("late timeline entry payload after exit cannot switch the mode back", async () => {
    const entries = deferred<{ body: unknown }>();
    const ui = await p14Dom({ reply: r => r.url.startsWith("/api/timeline?") ? entries.promise : undefined });
    try {
      const enter = ui.evaluate<Promise<void>>("enterTimelineMode()");
      await ui.evaluate<Promise<void>>("exitTimelineMode()");
      entries.resolve({ body: { entries: [{ timestamp: "2020-01-01", tool: "fixture" }], source: "fixture" } });
      await enter;
      expect(ui.element("#timeline-controls").style.display).toBe("none");
      expect(ui.element("#timeline-toggle").textContent).toContain("Live");
    } finally { entries.resolve({ body: { entries: [] } }); ui.close(); }
  });
});

describe("E06 node panel generations", () => {
  it("late A detail does not replace B or reopen a closed panel", async () => {
    const a = deferred<{ body: unknown }>();
    const ui = await p14Dom({ graph: { nodes: [graphNode("a"), graphNode("b")], edges: [] }, reply: r => {
      if (r.url === "/api/node/a") return a.promise;
      if (r.url === "/api/node/b") return { body: graphNode("b") };
    } });
    try {
      ui.evaluate('navigateTo("a"); navigateTo("b");');
      await tick();
      expect(ui.element("#panel-content").textContent).toContain("Fixture b");
      ui.evaluate("closePanel();");
      a.resolve({ body: graphNode("a") });
      await ui.settle();
      expect(ui.element("#panel").classList.contains("open")).toBe(false);
      expect(ui.element("#panel-content").textContent).not.toContain("Fixture a");
    } finally { a.resolve({ body: graphNode("a") }); ui.close(); }
  });

  it("late A history never appends to B history", async () => {
    const a = deferred<{ body: unknown }>();
    const ui = await p14Dom({ reply: r => r.url === "/api/node/a/history" ? a.promise : undefined });
    try {
      ui.evaluate(`showPanel(${JSON.stringify(graphNode("a"))}); showPanel(${JSON.stringify(graphNode("b"))});`);
      a.resolve({ body: { history: [{ to_status: "refuted", at: "old", reason: "A-only-history" }] } });
      await ui.settle();
      expect(ui.element("#panel-content").textContent).not.toContain("A-only-history");
    } finally { a.resolve({ body: { history: [] } }); ui.close(); }
  });
});
