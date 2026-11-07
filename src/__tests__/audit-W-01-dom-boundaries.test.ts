import { describe, expect, it } from "vitest";
import { auditDom, graphNode, type AuditElement } from "./helpers/audit-dom.js";

// Inert foreign data only: no scripts, event attributes, semicolons or executable payloads.
const foreignId = `foreign'\"<audit-marker>&-узел`;
const literal = `Текст <audit-marker>не HTML</audit-marker> & ' "`;
const normalId = "normal-child";

type Surface = "parent" | "children" | "outgoing" | "incoming" | "digest sources" | "digest focus";
const surfaces: Surface[] = ["parent", "children", "outgoing", "incoming", "digest sources", "digest focus"];

function panelData(surface: Surface, id: string) {
  const base = { ...graphNode("card", { name: literal, summary: literal }), why: literal, file_refs: [literal] };
  switch (surface) {
    case "parent": return { ...base, parent: { id, name: literal } };
    case "children": return { ...base, children: [{ id, name: literal }] };
    case "outgoing": return { ...base, edges: [{ to: id, to_name: literal, relation: "connects_to", description: literal }] };
    case "incoming": return { ...base, incoming_edges: [{ from: id, from_name: literal, relation: "connects_to", description: literal }] };
    case "digest sources": return { ...base, kind: "digest", digest_children: [{ id, name: literal }] };
    case "digest focus": return { ...base, id, kind: "digest", digest_children: [{ id: "source", name: literal }] };
  }
}

function action(content: AuditElement, surface: Surface): AuditElement | undefined {
  if (surface === "digest focus") return content.querySelectorAll("button").find((el) => el.textContent === "focus");
  return content.querySelector(surface === "children" || surface === "digest sources" ? ".child-link" : ".link-row") ?? undefined;
}

describe("W-01 — foreign IDs remain data in every explorer action", () => {
  it.each(surfaces)("%s renders quoted/HTML IDs without creating markup or invalid executable handlers", async (surface) => {
    const ui = await auditDom({
      graph: { nodes: [graphNode("card"), graphNode(foreignId), graphNode("source"), graphNode("unrelated")], edges: [] },
      reply: ({ url }) => url === `/api/node/${encodeURIComponent(foreignId)}`
        ? { body: graphNode(foreignId, { name: "Foreign navigation target" }) } : undefined,
    });
    try {
      await ui.invoke("showPanel", panelData(surface, foreignId));
      const content = ui.element("#panel-content");
      expect(content.querySelectorAll("audit-marker")).toHaveLength(0);
      expect(content.textContent).toContain(literal);
      expect(action(content, surface)).toBeDefined();
      // Compile the real, HTML-decoded handler before any click; this fixture is only inert text.
      expect(ui.handlerErrors(content), `${surface}: quotes in an imported ID must stay data`).toEqual([]);
      ui.dispatch(action(content, surface)!, "click");
      await ui.settle();
      if (surface === "digest focus") {
        expect(ui.element("#visible-counter").textContent).toBe("2 / 4 visible");
      } else {
        expect(ui.requests.some((request) => request.url === `/api/node/${encodeURIComponent(foreignId)}`)).toBe(true);
        expect(ui.element("#panel-content").textContent).toContain("Foreign navigation target");
      }
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });

  it.each(surfaces)("%s retains the exact normal ID when clicked", async (surface) => {
    const graph = { nodes: [graphNode("card"), graphNode(normalId), graphNode("source"), graphNode("unrelated")], edges: [] };
    const ui = await auditDom({
      graph,
      reply: ({ url }) => url === `/api/node/${normalId}` ? { body: graphNode(normalId, { name: "Navigation target" }) } : undefined,
    });
    try {
      await ui.invoke("showPanel", panelData(surface, normalId));
      const content = ui.element("#panel-content");
      const button = action(content, surface);
      expect(button).toBeDefined();
      expect(ui.handlerErrors(content)).toEqual([]);
      ui.dispatch(button!, "click");
      await ui.settle();
      if (surface === "digest focus") {
        expect(ui.element("#visible-counter").textContent).toBe("2 / 4 visible");
        ui.dispatch(button!, "click");
        expect(ui.element("#visible-counter").textContent).toBe("4 / 4 visible");
      } else {
        expect(ui.requests.some((request) => request.url === `/api/node/${normalId}`)).toBe(true);
        expect(ui.element("#panel-content").textContent).toContain("Navigation target");
      }
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });

  it.each(["survivor", "other"] as const)("Consolidate keeps the quoted %s ID inert through rendering and handler parsing", async (position) => {
    const a = position === "survivor" ? foreignId : "safe-survivor";
    const b = position === "other" ? foreignId : "safe-other";
    const ui = await auditDom({ reply: ({ url, method }) => url === "/api/consolidate"
      ? { body: method === "GET" ? { candidates: [{ a, b, older: a, similarity: 0.9 }] } : { ok: true } } : undefined });
    try {
      ui.dispatch(ui.element("#consolidate-btn"), "click");
      await ui.settle();
      const stats = ui.element("#stats");
      expect(stats.textContent).toContain(foreignId);
      expect(stats.querySelectorAll("audit-marker")).toHaveLength(0);
      expect(stats.querySelectorAll("button").some((button) => button.textContent.startsWith("merge into "))).toBe(true);
      expect(ui.handlerErrors(stats)).toEqual([]);
      const merge = stats.querySelectorAll("button").find((button) => button.textContent.startsWith("merge into "))!;
      ui.dispatch(merge, "click");
      await ui.settle();
      const posts = ui.requests.filter((request) => request.method === "POST");
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0].body!)).toEqual({ survivor: a, other: b });
      expect(ui.location.reloads).toBe(1);
      expect(ui.alerts).toEqual([]);
    } finally { ui.close(); }
  });

  it("Consolidate sends exact normal IDs through the actual click handler", async () => {
    const ui = await auditDom({ reply: ({ url, method }) => url === "/api/consolidate"
      ? { body: method === "GET" ? { candidates: [{ a: "older", b: "newer", older: "older", similarity: 0.9 }] } : { ok: true } }
      : undefined });
    try {
      ui.dispatch(ui.element("#consolidate-btn"), "click");
      await ui.settle();
      const merge = ui.element("#stats").querySelectorAll("button").find((button) => button.textContent === "merge into older");
      expect(merge).toBeDefined();
      ui.dispatch(merge!, "click");
      await ui.settle();
      const post = ui.requests.find((request) => request.method === "POST");
      expect(post?.url).toBe("/api/consolidate");
      expect(JSON.parse(post!.body!)).toEqual({ survivor: "older", other: "newer" });
      expect(ui.location.reloads).toBe(1);
      expect(ui.alerts).toEqual([]);
    } finally { ui.close(); }
  });

  it("card text, rationale, history and Markdown link preserve quotes/HTML as literal data", async () => {
    const ui = await auditDom({ reply: ({ url }) => url.endsWith("/history")
      ? { body: { history: [{ from_status: "active", to_status: "deprecated", reason: literal, at: "2026-11-06 12:00:00" }] } }
      : undefined });
    try {
      await ui.invoke("showPanel", { ...graphNode(foreignId, { name: literal, summary: literal }), why: literal, file_refs: [literal] });
      const content = ui.element("#panel-content");
      expect(content.querySelectorAll("audit-marker")).toHaveLength(0);
      expect(content.querySelector(".panel-name")?.textContent).toBe(literal);
      expect(content.textContent).toContain("Status history");
      expect(content.textContent.split(literal).length - 1).toBe(5);
      expect(decodeURIComponent(content.querySelector("a")!.getAttribute("href")!)).toBe(`/api/node/${foreignId}.md`);
      expect(ui.handlerErrors(content)).toEqual([]);
    } finally { ui.close(); }
  });
});
