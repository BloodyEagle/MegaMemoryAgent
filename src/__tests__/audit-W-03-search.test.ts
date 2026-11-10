import { describe, expect, it } from "vitest";
import { auditDom, graphNode } from "./helpers/audit-dom.js";

const match = { id: "search-target", name: "Найденная нода", kind: "feature", summary: "Проверенный результат поиска", score: 0.75, via: "fts" };

async function search(ui: Awaited<ReturnType<typeof auditDom>>, query: string) {
  const input = ui.element("#search");
  input.value = query;
  ui.dispatch(input, "keydown", { key: "Enter" });
  await ui.settle();
}

describe("W-03 — live explorer search rendering", () => {
  it.each([
    { label: "response with a budget", meta: { returned: 1, tokens_estimated: 42, dropped: 2 } },
    { label: "response without a budget", meta: null },
  ])("$label renders its matches using only the supplied metadata", async ({ meta }) => {
    const ui = await auditDom({
      graph: { nodes: [graphNode(match.id, match)], edges: [] },
      reply: ({ url }) => url.startsWith("/api/search?") ? { body: { matches: [match], meta } }
        : url === "/api/node/search-target" ? { body: match } : undefined,
    });
    try {
      await search(ui, "найденная");
      const results = ui.element("#search-results");
      expect.soft(ui.errors, "a valid response must not trigger ReferenceError: data is not defined").toEqual([]);
      expect.soft(results.querySelector(".search-error")).toBeNull();
      expect(results.querySelectorAll(".search-result")).toHaveLength(1);
      expect(results.textContent).toContain(match.name);
      expect(results.textContent).toContain(match.summary);
      if (meta) expect(results.querySelector(".search-budget")?.textContent).toBe("1 nodes, ~42 tokens, dropped 2");
      else expect(results.querySelector(".search-budget")).toBeNull();
      expect(results.textContent).not.toContain("undefined");
      ui.dispatch(results.querySelector(".search-result")!, "click");
      await ui.settle();
      expect(ui.element("#panel-content").textContent).toContain(match.name);
      expect(results.classList.contains("open")).toBe(false);
    } finally { ui.close(); }
  });

  it("unavailable semantic search renders a local keyword match without a global data variable", async () => {
    const ui = await auditDom({
      // The server always serializes epistemic_status (null when unset);
      // an absent field is an unqualified old snapshot and the keyword
      // fallback skips it by design.
      graph: { nodes: [graphNode("local", { name: "Local needle", summary: "Local fallback result", epistemic_status: null, valid_until: null })], edges: [] },
      reply: ({ url }) => url.startsWith("/api/search?") ? { status: 503, body: { error: "offline" } } : undefined,
    });
    try {
      await search(ui, "needle");
      expect.soft(ui.errors).toEqual([]);
      expect(ui.element("#search-results").querySelectorAll(".search-result")).toHaveLength(1);
      expect(ui.element("#search-results").textContent).toContain("keyword fallback");
      expect(ui.element("#search-loading").classList.contains("visible")).toBe(false);
    } finally { ui.close(); }
  });

  it("empty results and clearing the query do not leave stale matches or errors", async () => {
    const ui = await auditDom({ reply: ({ url }) => url.startsWith("/api/search?") ? { body: { matches: [], meta: null } } : undefined });
    try {
      await search(ui, "absent");
      expect(ui.element("#search-results").textContent).toBe("No semantic matches found.");
      expect(ui.element("#search-loading").classList.contains("visible")).toBe(false);
      await ui.invoke("renderSearchResults", "", []);
      expect(ui.element("#search-results").textContent).toBe("");
      expect(ui.element("#search-results").classList.contains("open")).toBe(false);
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });
});
