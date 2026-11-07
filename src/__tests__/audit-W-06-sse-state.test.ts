import { describe, expect, it } from "vitest";
import { auditDom, graphNode, type AuditGraph } from "./helpers/audit-dom.js";

function wireState(ui: Awaited<ReturnType<typeof auditDom>>) {
  const state = ui.graphState();
  const id = (endpoint: string | { id: string }) => typeof endpoint === "string" ? endpoint : endpoint.id;
  return {
    nodes: state.nodes.map(({ id, name, summary, status, parent_id }) => ({ id, name, summary, status, parent_id })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: state.edges.filter((edge) => !edge.isParentEdge).map((edge) => ({ from: id(edge.source), to: id(edge.target), relation: edge.relation })),
  };
}

describe("W-06 — explorer consumes SSE snapshots and complete updates", () => {
  it("a reconnect replaces stale contents, membership and edges while retaining only surviving node coordinates", async () => {
    const oldGraph: AuditGraph = {
      nodes: [graphNode("keep", { name: "Old name", summary: "Old summary", parent_id: "old-parent" }), graphNode("old-parent"), graphNode("gone")],
      edges: [{ from: "keep", to: "gone", relation: "connects_to" }],
    };
    const ui = await auditDom({ graph: oldGraph });
    try {
      const before = ui.graphState().nodes.find((node) => node.id === "keep")!;
      ui.sse({ type: "init", data: {
        nodes: [graphNode("keep", { name: "Fresh name", summary: "Fresh summary", parent_id: "new-parent", status: "deprecated" }), graphNode("new-parent")],
        edges: [{ from: "new-parent", to: "keep", relation: "depends_on" }],
        stats: { nodes: 2, edges: 1 },
      } }, true);
      expect(wireState(ui)).toEqual({
        nodes: [
          { id: "keep", name: "Fresh name", summary: "Fresh summary", parent_id: "new-parent", status: "deprecated" },
          { id: "new-parent", name: "new-parent", summary: "Fixture new-parent", parent_id: null, status: "active" },
        ],
        edges: [{ from: "new-parent", to: "keep", relation: "depends_on" }],
      });
      const after = ui.graphState().nodes.find((node) => node.id === "keep")!;
      expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
      const toggle = ui.element("#toggle-outdated");
      toggle.checked = false;
      ui.dispatch(toggle, "change");
      await ui.invoke("updateVisibleCounter");
      expect(ui.element("#visible-counter").textContent).toBe("1 / 2 visible");
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });

  it.each(["new-parent", null])("node_updated applies lifecycle and parent_id=%s rather than retaining stale state", async (parent_id) => {
    const ui = await auditDom({ graph: {
      nodes: [graphNode("moving", { parent_id: "old-parent" }), graphNode("old-parent"), graphNode("new-parent")], edges: [],
    } });
    try {
      ui.sse({ type: "node_updated", data: graphNode("moving", { name: "Updated", summary: "Fresh content", parent_id, status: "deprecated" }) });
      expect.soft(ui.graphState().nodes.find((node) => node.id === "moving")).toMatchObject({ name: "Updated", summary: "Fresh content", status: "deprecated", parent_id });
      const toggle = ui.element("#toggle-outdated");
      toggle.checked = false;
      ui.dispatch(toggle, "change");
      await ui.invoke("updateVisibleCounter");
      expect(ui.element("#visible-counter").textContent).toBe("2 / 3 visible");
    } finally { ui.close(); }
  });

  it("an initial snapshot and ordinary add/update/remove events remain usable", async () => {
    const ui = await auditDom();
    try {
      ui.sse({ type: "init", data: { nodes: [graphNode("root")], edges: [], stats: { nodes: 1, edges: 0 } } });
      ui.sse({ type: "node_added", data: graphNode("child", { parent_id: "root" }) });
      ui.sse({ type: "node_updated", data: graphNode("child", { name: "Changed name", summary: "Changed summary", parent_id: "root" }) });
      expect(ui.graphState().nodes.map((node) => node.id).sort()).toEqual(["child", "root"]);
      expect(ui.graphState().nodes.find((node) => node.id === "child")).toMatchObject({ name: "Changed name", summary: "Changed summary", parent_id: "root" });
      ui.sse({ type: "node_removed", data: { id: "child" } });
      expect(ui.graphState().nodes.map((node) => node.id)).toEqual(["root"]);
      expect(ui.graphState().edges).toEqual([]);
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });
});
