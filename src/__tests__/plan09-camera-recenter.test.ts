/**
 * План 09 (камера timeline): скраб после navigateTo к далёкому узлу раньше
 * оставлял новые узлы эпохи вне вьюпорта — данные корректны, страдает вид.
 * Теперь: если возле центра вьюпорта нет ни одного узла шага, камера
 * центрируется на медиане координат; если узлы рядом — камера не двигается.
 */
import { afterEach, describe, expect, it } from "vitest";
import { auditDom, graphNode, type AuditDom } from "./helpers/audit-dom.js";

let ui: AuditDom | undefined;
afterEach(() => { ui?.close(); ui = undefined; });

const STEPS = {
  entries: [
    { tool: "create_concept", timestamp: "2026-11-01 00:00:00", result_summary: "step one" },
    { tool: "update_concept", timestamp: "2026-11-02 00:00:00", result_summary: "step two" },
  ],
  source: "tools",
};

function atReply(url: string, epochs: Record<string, unknown>): { body: unknown } | undefined {
  const prefix = "/api/graph/at?t=";
  if (!url.startsWith(prefix)) return undefined;
  const t = decodeURIComponent(url.slice(prefix.length));
  return t in epochs ? { body: epochs[t] } : undefined;
}

/** Мир → экран при текущей камере (как worldToScreen обозревателя). */
function worldToScreen(camera: { zoom: number; panX: number; panY: number }, x: number, y: number) {
  return { x: x * camera.zoom + camera.panX, y: y * camera.zoom + camera.panY };
}

describe("камера timeline при скрабе (план 09)", () => {
  it("эпоха далеко от центра вьюпорта → камера центрируется так, что узел в кадре", async () => {
    ui = await auditDom({
      graph: { nodes: [graphNode("far-a")], edges: [] },
      reply: ({ url }) =>
        url === "/api/timeline?limit=50000" ? { body: STEPS } : atReply(url, {
          "2026-11-02 00:00:00": { nodes: [graphNode("far-a")], edges: [] },
        }),
    });
    // Узел эпохи — далеко за пределами вьюпорта; камера в нуле.
    ui.evaluate(`
      nodes[0].x = 5000;
      nodes[0].y = 6000;
      panX = 0;
      panY = 0;
      zoom = 1;
    `);
    await ui.invoke("enterTimelineMode");
    await ui.invoke("scrubToStep", 1);

    const { camera, nodes } = ui.graphState();
    expect(nodes.map((n) => n.id)).toEqual(["far-a"]);
    const screen = worldToScreen(camera, nodes[0].x, nodes[0].y);
    // Узел виден: его экранная позиция внутри вьюпорта 800×600.
    expect(screen.x).toBeGreaterThanOrEqual(0);
    expect(screen.x).toBeLessThanOrEqual(camera.width);
    expect(screen.y).toBeGreaterThanOrEqual(0);
    expect(screen.y).toBeLessThanOrEqual(camera.height);
  });

  it("узлы рядом с текущим центром → камера не смещается", async () => {
    ui = await auditDom({
      graph: { nodes: [graphNode("far-a"), graphNode("near-b")], edges: [] },
      reply: ({ url }) =>
        url === "/api/timeline?limit=50000" ? { body: STEPS } : atReply(url, {
          "2026-11-02 00:00:00": { nodes: [graphNode("far-a"), graphNode("near-b")], edges: [] },
        }),
    });
    // far-a далеко, near-b остаётся у центра (spawn вокруг ширины/2, высоты/2).
    ui.evaluate(`
      const far = nodes.find((n) => n.id === "far-a");
      if (far) {
        far.x = 5000;
        far.y = 6000;
      }
      panX = 0;
      panY = 0;
      zoom = 1;
    `);
    await ui.invoke("enterTimelineMode");
    await ui.invoke("scrubToStep", 1);

    const { camera, nodes } = ui.graphState();
    expect(nodes.map((n) => n.id).sort()).toEqual(["far-a", "near-b"]);
    // near-b — новый узел, spawn у центра (±60 px) — в радиусе 0.25*600=150
    // от центра вьюпорта, камера обязана остаться на месте.
    expect(camera.panX).toBe(0);
    expect(camera.panY).toBe(0);
  });
});
