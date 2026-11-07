import { afterEach, describe, expect, it } from "vitest";
import { addNode, auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { auditDom } from "../../src/__tests__/helpers/audit-dom.js";
import { seedHttpDb, startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

let fixture: AuditFixture | undefined;
afterEach(async () => { const owned = fixture; fixture = undefined; await owned?.close(); });

async function explorer() {
  fixture = auditFixture();
  const file = await seedHttpDb(fixture, (db) => {
    addNode(db, "dated-concept", { name: "Dated concept" });
    db.execSqlRun("UPDATE nodes SET created_at = ?, updated_at = ? WHERE id = ?", "2026-11-01 00:00:00", "2026-11-01 00:00:00", "dated-concept");
    db.setNodeStatus("dated-concept", "deprecated", undefined, "Replaced after review");
    db.execSqlRun("UPDATE status_history SET at = ? WHERE node_id = ?", "2026-11-06 12:34:56", "dated-concept");
    const seq = db.insertTimelineEntry({ tool: "understand", params: "{}", result_summary: "Read dated concept", is_write: false, is_error: false, affected_ids: ["dated-concept"] });
    db.execSqlRun("UPDATE timeline SET timestamp = ? WHERE seq = ?", "2026-11-05 08:09:10", seq);
  });
  const server = await startAuditHttp(fixture, file);
  const ui = await auditDom({ reply: async ({ url, method, body }) => {
    const response = await server.request(url, { method, body });
    // Route real HTTP bytes to the real UI without normalizing the broken DTO.
    expect(response.status, `${method} ${url}: ${response.text}\n${server.diagnostics()}`).toBe(200);
    return { status: response.status!, body: JSON.parse(response.text) };
  } });
  return { ui, server };
}

describe("W-07 — timeline renders dates from real HTTP status history", () => {
  it("status selection and slider render the transition, reason and date, never undefined", async () => {
    const { ui } = await explorer();
    try {
      ui.element("#timeline-kind").value = "status";
      ui.dispatch(ui.element("#timeline-toggle"), "click");
      await ui.settle();
      expect(ui.element("#timeline-toggle").textContent).toContain("Status");
      const slider = ui.element("#timeline-slider");
      slider.value = "0";
      ui.dispatch(slider, "input");
      await ui.settle();
      const rendered = `${ui.element("#timeline-display").textContent} ${ui.element("#timeline-summary").textContent}`;
      expect.soft(rendered).not.toContain("undefined");
      expect.soft(rendered).not.toContain("Invalid Date");
      expect.soft(rendered).toContain("2026-11-06");
      expect.soft(rendered).toContain("deprecated");
      expect.soft(rendered).toContain("Replaced after review");
      const snapshot = ui.requests.find((request) => request.url.startsWith("/api/graph/at?"));
      expect(snapshot).toBeDefined();
      expect.soft(new URL(snapshot!.url, "http://audit.invalid").searchParams.get("t")).not.toBe("undefined");
      expect(ui.alerts).toEqual([]);
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });

  it("the same controls still render an ordinary tool event with its real timestamp", async () => {
    const { ui } = await explorer();
    try {
      ui.element("#timeline-kind").value = "tools";
      ui.dispatch(ui.element("#timeline-toggle"), "click");
      await ui.settle();
      const slider = ui.element("#timeline-slider");
      // The earlier synthetic create is step 0; the recorded tool call is step 1.
      slider.value = "1";
      ui.dispatch(slider, "input");
      await ui.settle();
      expect(ui.element("#timeline-display").textContent).toContain("understand");
      expect(ui.element("#timeline-display").textContent).toContain("2026-11-05 08:09:10");
      expect(ui.element("#timeline-summary").textContent).toBe("Read dated concept");
      expect(ui.element("#timeline-display").textContent).not.toContain("undefined");
      expect(ui.errors).toEqual([]);
    } finally { ui.close(); }
  });
});
