import { describe, expect, it } from "vitest";
import { auditDom, graphNode, type AuditDomReply, type AuditDomRequest } from "./helpers/audit-dom.js";
import { seedHttpDb } from "./helpers/audit-http.js";
import { startAuditHttpSrc, type AuditHttpSrc } from "./helpers/audit-http-src.js";
import { auditFixture, deferred, type AuditFixture } from "./helpers/audit.js";
import { ensureSchema } from "../migrate-schema.js";
import { KnowledgeDB } from "../db.js";

/**
 * B-04 (аудит 2026-11-12): исторический /api/graph/at показывал узел,
 * а клик по нему всегда бил в текущий /api/node/:id — tombstone давал 404,
 * панель не открывалась, и ЛЮБАЯ ошибка карточки показывалась как
 * «Server unreachable (node panel)».
 *
 * Контракт после исправления:
 *  - GET /api/node/:id?at=<ts> — историческое чтение, согласованное с
 *    /api/graph/at (узел существовал на момент t); ответ маркирован
 *    historical:true, at, а для удалённого сейчас узла — removed_now:true
 *    с датой и причиной. Только чтение.
 *  - Клиент в режиме Timeline передаёт at; 404 показывает «узел не найден»
 *    в панели, не транспортный баннер; транспортный баннер — только
 *    реальный сетевой сбой.
 */

const REMOVED_REASON = "synthetic historical repro";
const REMOVED_SUMMARY = "OLD visible summary removed";

let fixture: AuditFixture;
let writer: KnowledgeDB | undefined;

async function startSeededServer() {
  fixture = auditFixture();
  const dbFile = await seedHttpDb(fixture, (db) => {
    ensureSchema(db);
    for (const id of ["a", "b", "removed"]) {
      db.insertNode({ id, name: id, kind: "feature", summary: id === "removed" ? REMOVED_SUMMARY : `Verified fixture for ${id}` });
    }
    // Фиксированная эпоха: создание задолго до удаления — исторический граф
    // на любую дату между содержит все узлы, после удаления — только живые.
    db.execSqlRun("UPDATE nodes SET created_at='2020-01-01 00:00:00', updated_at='2020-01-01 00:00:00'");
    db.softDeleteNode("removed", REMOVED_REASON);
  });
  const server = await startAuditHttpSrc(fixture, dbFile);
  writer = new KnowledgeDB(dbFile);
  return { dbFile, server };
}

function proxyReply(server: AuditHttpSrc) {
  return async ({ url, method, body }: AuditDomRequest): Promise<AuditDomReply> => {
    const res = await server.request(url, { method, body });
    let parsed: unknown = null;
    try { parsed = JSON.parse(res.text); } catch { parsed = res.text; }
    return { body: parsed, status: res.status ?? 500 };
  };
}

function bannerVisible(ui: Awaited<ReturnType<typeof auditDom>>): boolean {
  // Статичный текст "Server unreachable" всегда в разметке баннера —
  // показатель именно показа (display), а не наличие текста.
  return ui.element("#transport-error").style.display === "block";
}

describe("B-04 — историческая карточка узла и честные ошибки панели", () => {
  it("ошибка scrub откатывает подпись шага и не оставляет UI заблокированным", async () => {
    const first = "2020-01-02 00:00:00";
    const second = "2020-01-03 00:00:00";
    const graph = { nodes: [graphNode("a")], edges: [] };
    const ui = await auditDom({ graph, reply: ({ url }) => {
      if (url.startsWith("/api/timeline?")) return { body: { entries: [first, second].map((timestamp) => ({ timestamp, tool: "create_concept", result_summary: timestamp })) } };
      if (url === `/api/graph/at?t=${encodeURIComponent(first)}`) return { body: graph };
      if (url === `/api/graph/at?t=${encodeURIComponent(second)}`) throw new Error("second snapshot unavailable");
      if (url === `/api/node/a?at=${encodeURIComponent(first)}`) return { body: graphNode("a", { historical: true, at: first } as never) };
      return undefined;
    } });
    try {
      await ui.invoke("enterTimelineMode");
      await ui.invoke("scrubToStep", 0);
      const beforeDisplay = ui.element("#timeline-display").textContent;
      await ui.invoke("scrubToStep", 1);
      expect(ui.element("#timeline-display").textContent).toBe(beforeDisplay);
      await ui.invoke("navigateTo", "a");
      expect(ui.requests.some((request) => request.url === `/api/node/a?at=${encodeURIComponent(first)}`)).toBe(true);
    } finally { ui.close(); }
  });

  it("переключение даты блокирует карточку до готовности соответствующего графа", async () => {
    const first = "2020-01-02 00:00:00";
    const second = "2020-01-03 00:00:00";
    const loaded = deferred<AuditDomReply>();
    const started = deferred();
    const graph = { nodes: [graphNode("a")], edges: [] };
    const ui = await auditDom({ graph, reply: ({ url }) => {
      if (url.startsWith("/api/timeline?")) return { body: { entries: [first, second].map((timestamp) => ({ timestamp, tool: "create_concept" })) } };
      if (url === `/api/graph/at?t=${encodeURIComponent(first)}`) return { body: graph };
      if (url === `/api/graph/at?t=${encodeURIComponent(second)}`) { started.resolve(); return loaded.promise; }
      if (url.startsWith("/api/node/a")) return { body: graphNode("a", { summary: "card from pending date" }) };
      return undefined;
    } });
    let navigating: Promise<unknown> | undefined;
    try {
      await ui.invoke("enterTimelineMode");
      await ui.invoke("scrubToStep", 0);
      const pending = ui.evaluate<Promise<void>>("scrubToStep(1)");
      await started.promise;
      const before = ui.requests.filter((request) => request.url.startsWith("/api/node/")).length;
      navigating = ui.invoke("navigateTo", "a");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ui.requests.filter((request) => request.url.startsWith("/api/node/"))).toHaveLength(before);
      loaded.resolve({ body: graph });
      await pending;
      await navigating;
      await ui.invoke("navigateTo", "a");
      expect(ui.requests.filter((request) => request.url.startsWith("/api/node/a?")).at(-1)?.url).toContain(`at=${encodeURIComponent(second)}`);
    } finally {
      loaded.resolve({ body: graph });
      await navigating;
      await ui.settle();
      ui.close();
    }
  });

  it("SSE snapshot после ошибки возврата в Live снова разрешает открывать карточки", async () => {
    let failLive = false;
    const graph = { nodes: [graphNode("a")], edges: [] };
    const ui = await auditDom({ graph, reply: ({ url }) => {
      if (url === "/api/graph" && failLive) throw new Error("live reload disconnected");
      if (url.startsWith("/api/timeline?")) return { body: { entries: [{ timestamp: "2020-01-02 00:00:00", tool: "create_concept" }] } };
      if (url === "/api/node/a") return { body: graphNode("a") };
      return undefined;
    } });
    try {
      await ui.invoke("enterTimelineMode");
      failLive = true;
      await ui.invoke("exitTimelineMode");
      ui.sse({ type: "init", data: graph }, true);
      await ui.invoke("navigateTo", "a");
      expect(ui.requests.some((request) => request.url === "/api/node/a")).toBe(true);
      expect(ui.element("#panel").classList.contains("open")).toBe(true);
    } finally { ui.close(); }
  });

  it("исторический режим не позволяет открыть мутирующий consolidate preview", async () => {
    const ui = await auditDom({ reply: ({ url }) => url.startsWith("/api/timeline?")
      ? { body: { entries: [{ timestamp: "2020-01-02 00:00:00", tool: "create_concept" }] } }
      : undefined });
    try {
      await ui.invoke("enterTimelineMode");
      await ui.invoke("openConsolidatePreview", "a", "b", { older: "a", similarity: 1 });
      expect(ui.evaluate("ccState")).toBeNull();
      expect(ui.requests.some((request) => request.url.startsWith("/api/consolidate"))).toBe(false);
    } finally { ui.close(); }
  });

  it("несуществующий в графе ID всё равно показывает понятную ошибку карточки", async () => {
    const ui = await auditDom({ reply: ({ url }) => url.startsWith("/api/node/unknown")
      ? { body: { error: 'Concept "unknown" not found' }, status: 404 } : undefined });
    try {
      await ui.invoke("navigateTo", "unknown");
      expect(ui.element("#panel-content").textContent).toContain("not found");
      expect(bannerVisible(ui)).toBe(false);
    } finally { ui.close(); }
  });

  it("HTTP: границы жизни узла сравниваются по времени, включая ISO и часовые пояса", async () => {
    const owned = auditFixture();
    try {
      const dbFile = await seedHttpDb(owned, (db) => {
        db.insertNode({ id: "timed", name: "timed", kind: "feature", summary: "Fixed lifetime" });
        db.execSqlRun("UPDATE nodes SET created_at = '2020-02-02 10:00:00', removed_at = '2020-02-02 12:00:00' WHERE id = 'timed'");
      });
      const server = await startAuditHttpSrc(owned, dbFile);
      for (const [at, expected] of [
        ["2020-02-02T09:59:59Z", 404],
        ["2020-02-02T10:00:00Z", 200],
        ["2020-02-02T13:00:00+03:00", 200],
        ["2020-02-02T12:00:00Z", 404],
      ] as const) {
        const card = await server.request(`/api/node/timed?at=${encodeURIComponent(at)}`);
        expect(card.status, at).toBe(expected);
        const graph = await server.request(`/api/graph/at?t=${encodeURIComponent(at)}`);
        expect(JSON.parse(graph.text).nodes.some((node: { id: string }) => node.id === "timed")).toBe(expected === 200);
      }
      for (const route of [
        "/api/node/timed?at=not-a-date",
        "/api/node/timed?at=",
        "/api/node/timed?at=0",
        "/api/node/timed?at=2020-01",
        "/api/graph/at?t=not-a-date",
        "/api/graph/at?t=0",
        "/api/graph/at?t=2020-01",
      ]) {
        expect((await server.request(route)).status).toBe(400);
      }
    } finally { await owned.close(); }
  });

  it("HTTP: GET /api/node/:id?at возвращает карточку узла, существовавшего на момент t", async () => {
    const { server } = await startSeededServer();
    try {
      const at = "2020-01-02 00:00:00";
      // Вход red-состояния: исторический граф видит узел, текущий — нет.
      const graphAt = await server.request(`/api/graph/at?t=${encodeURIComponent(at)}`);
      expect(JSON.parse(graphAt.text).nodes.map((n: { id: string }) => n.id)).toContain("removed");
      const current = await server.request("/api/node/removed");
      expect(current.status).toBe(404);

      // Целевой assert: историческое чтение согласовано с /api/graph/at.
      const res = await server.request(`/api/node/removed?at=${encodeURIComponent(at)}`);
      expect(res.status, "historical card exists at t").toBe(200);
      const card = JSON.parse(res.text);
      expect(card).toMatchObject({ id: "removed", summary: REMOVED_SUMMARY });
      expect(card.historical).toBe(true);
      expect(card.at).toBe(new Date(`${at.replace(" ", "T")}Z`).toISOString());
      expect(card.removed_now).toBe(true);
      expect(card.removed_reason).toBe(REMOVED_REASON);
      expect(card.removed_at).toEqual(expect.any(String));

      // Узел не существовал на дату до создания — честный 404.
      const early = await server.request(`/api/node/removed?at=${encodeURIComponent("2019-01-01 00:00:00")}`);
      expect(early.status).toBe(404);
      expect(JSON.parse(early.text).error).toContain("did not exist at");

      // Историческое чтение ничего не пишет: в таблице timeline ноль записей
      // (synthetic-записи bounds деривятся из узлов и сюда не попадают).
      expect(writer!.execSqlAll("SELECT * FROM timeline")).toHaveLength(0);
    } finally {
      writer?.close();
      writer = undefined;
      await fixture.close();
    }
  }, 60_000);

  it("DOM: в Timeline клик по видимому удалённому узлу открывает историческую карточку без транспортного баннера", async () => {
    const { server } = await startSeededServer();
    try {
      const ui = await auditDom({ reply: proxyReply(server) });
      try {
        await ui.invoke("enterTimelineMode");
        await ui.invoke("scrubToStep", 0);
        expect(ui.graphState().nodes.map((node) => node.id)).toContain("removed");

        await ui.invoke("navigateTo", "removed");
        // Целевые asserts: панель открыта с содержимым, баннера нет.
        expect(bannerVisible(ui), "no transport banner for a historical node").toBe(false);
        expect(ui.element("#panel").classList.contains("open")).toBe(true);
        const panelText = ui.element("#panel-content").textContent;
        expect(panelText).toContain(REMOVED_SUMMARY);
        // Честная маркировка: сохранённая карточка, не историческая ревизия.
        expect(panelText).toContain("not an exact historical revision");
        expect(panelText).toContain("removed now");
        expect(panelText).toContain(REMOVED_REASON);
        expect(panelText).not.toContain("History unavailable");
        expect(ui.requests.some((request) => request.url.startsWith("/api/node/removed/history?at="))).toBe(true);
        // Никаких мутаций из исторической панели.
        expect(ui.requests.filter((request) => request.method === "POST")).toHaveLength(0);
        expect(ui.errors).toEqual([]);
      } finally {
        ui.close();
      }
    } finally {
      writer?.close();
      writer = undefined;
      await fixture.close();
    }
  }, 60_000);

  it("DOM: 404 карточки показывает «узел не найден» в панели, не Server unreachable", async () => {
    const reply = ({ url }: AuditDomRequest): AuditDomReply | undefined => {
      if (url.startsWith("/api/node/ghost")) {
        return { body: { error: 'Concept "ghost" not found' }, status: 404 };
      }
      return undefined;
    };
    const ui = await auditDom({
      graph: { nodes: [graphNode("ghost")], edges: [] },
      reply,
    });
    try {
      await ui.invoke("navigateTo", "ghost");
      expect(bannerVisible(ui), "404 must not be shown as a transport outage").toBe(false);
      expect(ui.element("#panel").classList.contains("open")).toBe(true);
      const text = ui.element("#panel-content").textContent;
      expect(text).toContain("not found");
    } finally {
      ui.close();
    }
  });
});
