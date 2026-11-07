import { describe, expect, it } from "vitest";
import { auditDom, graphNode } from "./helpers/audit-dom.js";

// R-08 (plan 08): transport failures in the explorer must be visible.
// Previously init(), navigateTo and the timeline paths died with unhandled
// rejections and no cue; now every failure surfaces in #transport-error.

/** Reject a specific request from the harness — the page must catch it. */
function rejectUrl(prefix: string) {
  return (request: { url: string }) => {
    if (request.url.startsWith(prefix)) throw new Error(`injected failure for ${prefix}`);
    return undefined; // остальные URL — дефолты харнеса
  };
}

describe("R-08 — explorer surfaces transport failures", () => {
  it("a failed startup load shows the banner instead of dying silently", async () => {
    const ui = await auditDom({ reply: rejectUrl("/api/graph") });
    try {
      const banner = ui.element("#transport-error");
      expect(banner.style.display).toBe("block");
      expect(banner.querySelector(".te-msg")!.textContent).toContain("startup");
      expect(ui.graphState().nodes).toEqual([]); // страница не упала — граф пуст, баннер виден
    } finally {
      ui.close();
    }
  });

  it("the banner Reload button re-runs the page via location.reload", async () => {
    const ui = await auditDom({ reply: rejectUrl("/api/graph") });
    try {
      expect(ui.location.reloads).toBe(0);
      const retry = ui.element("#transport-error").querySelector("button.te-retry")!;
      ui.dispatch(retry, "click");
      expect(ui.location.reloads).toBe(1);
    } finally {
      ui.close();
    }
  });

  it("a node-panel fetch failure surfaces without killing the page", async () => {
    const ui = await auditDom({
      graph: { nodes: [graphNode("solo")], edges: [] },
      reply: rejectUrl("/api/node/"),
    });
    try {
      await ui.invoke("navigateTo", "solo");
      const banner = ui.element("#transport-error");
      expect(banner.style.display).toBe("block");
      expect(banner.querySelector(".te-msg")!.textContent).toContain("node panel");
    } finally {
      ui.close();
    }
  });
});
