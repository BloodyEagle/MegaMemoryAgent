import { describe, expect, it } from "vitest";
import { auditDom, graphNode } from "./helpers/audit-dom.js";

describe("W-04 — explorer export action", () => {
  it("clicking the rendered export button navigates to the bundle with valid JavaScript", async () => {
    const ui = await auditDom({ graph: { nodes: [graphNode("normal-id")], edges: [] } });
    try {
      const stats = ui.element("#stats");
      const button = [...stats.querySelectorAll("button"), ...stats.querySelectorAll("a")].find((el) => el.textContent === "export bundle");
      expect(button, "renderStats must expose the bundle action").toBeDefined();
      expect(() => ui.dispatch(button!, "click"), "the actual HTML-decoded click handler must compile and run").not.toThrow();
      expect(new URL(ui.location.href, "http://audit.invalid").pathname).toBe("/api/export.json");
    } finally { ui.close(); }
  });

  it("the neighboring consolidate action can be clicked without executing animation frames", async () => {
    const ui = await auditDom({ reply: ({ url }) => url === "/api/consolidate" ? { body: { candidates: [] } } : undefined });
    try {
      ui.dispatch(ui.element("#consolidate-btn"), "click");
      await ui.settle();
      expect(ui.requests.some((request) => request.url === "/api/consolidate" && request.method === "GET")).toBe(true);
      expect(ui.element("#stats").textContent).toContain("no duplicates found");
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });
});
