import { describe, expect, it } from "vitest";
import { auditDom, graphNode, type AuditElement } from "./helpers/audit-dom.js";

// Inert foreign data only: no scripts, event attributes, semicolons or executable payloads.
const foreignId = `foreign'\"<audit-marker>&-узел`;
const literal = `Текст <audit-marker>не HTML</audit-marker> & ' "`;
const normalId = "normal-child";

/** Консервативный план последствий (planConsolidation) для preview-reply. */
function consolidatePlanFixture(survivor: string, other: string) {
  return {
    survivor,
    other,
    base: { digest: "a".repeat(64), survivor_updated_at: "2026-11-07 10:00:00", other_updated_at: "2026-11-07 10:00:00" },
    summaryCombines: true,
    finalSummary: "combined summary",
    whySource: "survivor",
    finalWhy: "kept why",
    fileRefs: [],
    refsAdded: [],
    edgesToMove: [],
    edgesDropped: 0,
    children: [],
    slots: [],
    trailMembers: 0,
    artifacts: 0,
    baselines: 0,
    taskCarries: false,
    taskState: null,
    dueAt: null,
    statusDiverges: false,
    confirmationsAffected: false,
  };
}

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

  // UX-01 (план 07): действие у пары — «Сравнить»; POST делает только
  // финальное подтверждение. Инвариант W-01 прежний: кавычки/HTML в id
  // остаются данными на каждом шаге — рендер, разбор обработчиков, POST.
  it.each(["survivor", "other"] as const)("Consolidate keeps the quoted %s ID inert through rendering and handler parsing", async (position) => {
    const a = position === "survivor" ? foreignId : "safe-survivor";
    const b = position === "other" ? foreignId : "safe-other";
    const previewUrl = (survivor: string, other: string) =>
      `/api/consolidate/preview?survivor=${encodeURIComponent(survivor)}&other=${encodeURIComponent(other)}`;
    const ui = await auditDom({
      reply: ({ url, method }) => {
        if (url === "/api/consolidate") {
          return { body: method === "GET" ? { candidates: [{ a, b, older: a, similarity: 0.9 }] } : { ok: true, survivor: "done", removed: "gone" } };
        }
        if (url === previewUrl(a, b)) return { body: consolidatePlanFixture(a, b) };
        if (url === previewUrl(b, a)) return { body: consolidatePlanFixture(b, a) };
        if (url === `/api/node/${encodeURIComponent(a)}`) return { body: graphNode(a, { name: "Card A" }) };
        if (url === `/api/node/${encodeURIComponent(b)}`) return { body: graphNode(b, { name: "Card B" }) };
        return undefined;
      },
    });
    try {
      ui.dispatch(ui.element("#consolidate-btn"), "click");
      await ui.settle();
      const stats = ui.element("#stats");
      expect(stats.textContent).toContain(foreignId);
      expect(stats.querySelectorAll("audit-marker")).toHaveLength(0);
      expect(ui.handlerErrors(stats)).toEqual([]);
      const compare = stats.querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-compare");
      expect(compare).toBeDefined();
      ui.dispatch(compare!, "click");
      await ui.settle();
      // До финального подтверждения — только GET.
      expect(ui.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      const panel = ui.element("#consolidate-preview");
      expect(panel.textContent).toContain(foreignId);
      expect(panel.querySelectorAll("audit-marker")).toHaveLength(0);
      expect(ui.handlerErrors(panel)).toEqual([]);
      const choose = panel.querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-survivor"
          && (button.textContent ?? "").includes(foreignId));
      expect(choose).toBeDefined();
      ui.dispatch(choose!, "click");
      await ui.settle();
      // После выбора survivor серверный планировщик отрисовал последствия.
      const withEffects = ui.element("#consolidate-preview");
      expect(withEffects.textContent).toContain("Consequences");
      expect(withEffects.querySelectorAll("audit-marker")).toHaveLength(0);
      const merge = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      expect(merge).toBeDefined();
      expect(merge!.hasAttribute("disabled")).toBe(false);
      ui.dispatch(merge!, "click");
      await ui.settle();
      const confirm = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-confirm");
      expect(confirm).toBeDefined();
      ui.dispatch(confirm!, "click");
      await ui.settle();
      const posts = ui.requests.filter((request) => request.method === "POST");
      expect(posts).toHaveLength(1);
      const body = JSON.parse(posts[0].body!);
      expect(body.survivor).toBe(position === "survivor" ? a : b);
      expect(body.other).toBe(position === "survivor" ? b : a);
      expect(body.base.digest).toEqual(expect.any(String));
      // Успех обновляет граф перечитыванием (GET), без location.reload.
      expect(ui.location.reloads).toBe(0);
      expect(ui.alerts).toEqual([]);
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });

  it("Consolidate sends exact normal IDs through the actual click handler", async () => {
    const previewUrl = (survivor: string, other: string) =>
      `/api/consolidate/preview?survivor=${encodeURIComponent(survivor)}&other=${encodeURIComponent(other)}`;
    const ui = await auditDom({
      reply: ({ url, method }) => {
        if (url === "/api/consolidate") {
          return {
            body: method === "GET"
              ? { candidates: [{ a: "older", b: "newer", older: "older", similarity: 0.9 }] }
              : { ok: true, survivor: "older", removed: "newer" },
          };
        }
        if (url === previewUrl("older", "newer")) return { body: consolidatePlanFixture("older", "newer") };
        if (url === previewUrl("newer", "older")) return { body: consolidatePlanFixture("newer", "older") };
        if (url === "/api/node/older") return { body: graphNode("older", { name: "Older" }) };
        if (url === "/api/node/newer") return { body: graphNode("newer", { name: "Newer" }) };
        return undefined;
      },
    });
    try {
      ui.dispatch(ui.element("#consolidate-btn"), "click");
      await ui.settle();
      const compare = ui.element("#stats").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-compare");
      expect(compare).toBeDefined();
      ui.dispatch(compare!, "click");
      await ui.settle();
      // Явный выбор survivor: рекомендация (older) видна, но выбора нет,
      // пока пользователь не кликнул.
      const chooseOlder = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-survivor"
          && (button.textContent ?? "").includes("older"));
      expect(chooseOlder).toBeDefined();
      const mergeBefore = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      expect(mergeBefore!.hasAttribute("disabled")).toBe(true);
      ui.dispatch(chooseOlder!, "click");
      await ui.settle();
      const merge = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      expect(merge!.hasAttribute("disabled")).toBe(false);
      ui.dispatch(merge!, "click");
      await ui.settle();
      const confirm = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-confirm");
      ui.dispatch(confirm!, "click");
      await ui.settle();
      const post = ui.requests.find((request) => request.method === "POST");
      expect(post?.url).toBe("/api/consolidate");
      expect(JSON.parse(post!.body!)).toMatchObject({ survivor: "older", other: "newer" });
      expect(ui.location.reloads).toBe(0);
      expect(ui.alerts).toEqual([]);
      expect(ui.errors).toEqual([]);
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
