import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { auditDom, type AuditDomReply, type AuditDomRequest } from "./helpers/audit-dom.js";
import { seedHttpDb } from "./helpers/audit-http.js";
import { startAuditHttpSrc, type AuditHttpSrc } from "./helpers/audit-http-src.js";
import { auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";
import { ensureSchema } from "../migrate-schema.js";

/**
 * B-02 (аудит 2026-11-12): клиент подтверждал merge по устаревшим карточкам.
 * Карточки A/B грузились отдельно (GET /api/node/:id) ДО получения плана;
 * гонка «изменение узла после карточек, но до плана» обходила серверный CAS
 * по digest — POST уносил уже новый digest, и слияние применялось по данным,
 * которых пользователь в карточках не видел.
 *
 * Контракт после исправления: GET /api/consolidate/preview отвечает планом И
 * карточками участников (cards.survivor / cards.other) из одного снимка;
 * клиент принимает bundle атомарно и переиспользует его, если явный выбор
 * survivor совпадает с уже показанной ориентацией. Поздняя запись не делает
 * этот снимок опасным: digest-CAS даёт 409, клиент перечитывает весь bundle и
 * требует повторного подтверждения. Confirm разрешён только когда план и
 * карточки — один ответ.
 */

const OLD_A = "OLD visible summary a";
const OLD_B = "OLD visible summary b";
const NEW_A = "NEW UNSEEN summary from concurrent agent";
const NEW_WHY = "NEW UNSEEN reason";

async function startSeededServer(fixture: AuditFixture) {
  const dbFile = await seedHttpDb(fixture, (db) => {
    ensureSchema(db);
    db.insertNode({ id: "a", name: "a", kind: "feature", summary: OLD_A });
    db.insertNode({ id: "b", name: "b", kind: "feature", summary: OLD_B });
  });
  const server = await startAuditHttpSrc(fixture, dbFile);
  const writer = fixture.db(dbFile);
  return { dbFile, server, writer };
}

/** Прокси всех запросов DOM-обозревателя на реальный loopback-сервер. */
function proxyReply(server: AuditHttpSrc) {
  return async ({ url, method, body }: AuditDomRequest): Promise<AuditDomReply> => {
    const res = await server.request(url, { method, body });
    let parsed: unknown = null;
    try { parsed = JSON.parse(res.text); } catch { parsed = res.text; }
    return { body: parsed, status: res.status ?? 500 };
  };
}

describe("B-02 — preview возвращает карточки вместе с планом (один снимок)", () => {
  it("карточки и digest остаются одним снимком при записи сразу после транзакции плана", async () => {
    const owned = auditFixture();
    try {
      const dbFile = await seedHttpDb(owned, (db) => {
        ensureSchema(db);
        db.insertNode({ id: "a", name: "a", kind: "feature", summary: OLD_A });
        db.insertNode({ id: "b", name: "b", kind: "feature", summary: OLD_B });
      });
      const setupFile = owned.file("preview-writer.mts");
      // Второй connection меняет данные на границе COMMIT, пока HTTP-запрос
      // ещё собирает ответ. Не полагаемся на случайную фазу часов/планировщика.
      fs.writeFileSync(setupFile, `
import { KnowledgeDB } from ${JSON.stringify(new URL("../db.ts", import.meta.url).href)};
const run = KnowledgeDB.prototype.runInTransaction;
let depth = 0;
let changed = false;
KnowledgeDB.prototype.runInTransaction = function (fn) {
  depth++;
  let result;
  try { result = run.call(this, fn); }
  finally { depth--; }
  if (!changed && depth === 0 && result?.survivor === "a" && result?.other === "b" && result?.base?.digest) {
    changed = true;
    const writer = new KnowledgeDB(${JSON.stringify(dbFile)});
    try { writer.updateNode("a", { summary: ${JSON.stringify(NEW_A)}, why: ${JSON.stringify(NEW_WHY)} }); }
    finally { writer.close(); }
  }
  return result;
};
`, "utf8");
      const server = await startAuditHttpSrc(owned, dbFile, { setupFile });
      const preview = await server.request("/api/consolidate/preview?survivor=a&other=b");
      expect(preview.status).toBe(200);
      const bundle = JSON.parse(preview.text);
      expect(bundle.finalSummary).toContain(OLD_A);
      expect(bundle.cards.survivor.summary, "card must describe the same snapshot as the plan").toBe(OLD_A);
      const current = await server.request("/api/node/a");
      expect(JSON.parse(current.text).summary).toBe(NEW_A);
      const applied = await server.request("/api/consolidate", {
        method: "POST", body: JSON.stringify({ survivor: "a", other: "b", base: bundle.base }),
      });
      expect(applied.status).toBe(409);
    } finally { await owned.close(); }
  });

  it("GET /api/consolidate/preview содержит cards с текущим содержимым обоих узлов", async () => {
    const fixture = auditFixture();
    try {
      const { server, writer } = await startSeededServer(fixture);
      // Изменение ДО preview: cards обязаны показать уже новое содержимое.
      writer!.updateNode("a", { summary: NEW_A, why: NEW_WHY });
      const res = await server.request("/api/consolidate/preview?survivor=a&other=b");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.text);
      // Существующие поля плана сохранены (совместимость).
      expect(body.survivor).toBe("a");
      expect(body.other).toBe("b");
      expect(body.base?.digest).toMatch(/^[0-9a-f]{64}$/);
      // Целевой assert: карточки участников в том же ответе.
      expect(body.cards, "preview response carries member cards").toEqual(expect.any(Object));
      expect(body.cards.survivor).toMatchObject({ id: "a", summary: NEW_A, why: NEW_WHY });
      expect(body.cards.other).toMatchObject({ id: "b", summary: OLD_B });
    } finally {
      await fixture.close();
    }
  });

  it("DOM: совпавший выбор переиспользует bundle; поздняя запись даёт 409 и требует повторного confirm", async () => {
    const fixture = auditFixture();
    try {
      const { server, writer } = await startSeededServer(fixture);
      const ui = await auditDom({ reply: proxyReply(server) });
      try {
        await ui.invoke("openConsolidatePreview", "a", "b", { older: "a", similarity: 1 });
        const text = ui.element("#consolidate-preview").textContent;
        expect(text).toContain(OLD_A);
        expect(text).toContain(OLD_B);
        const previewRequestsBefore = ui.requests.filter((request) =>
          request.url.includes("/api/consolidate/preview?")
        ).length;

        // Гонка: другой процесс меняет узел ПОСЛЕ согласованного bundle.
        writer!.updateNode("a", { summary: NEW_A, why: NEW_WHY });

        // Явный выбор той же ориентации не тратит второй GET и продолжает
        // показывать единый старый снимок — он будет защищён digest-CAS.
        await ui.invoke("chooseConsolidateSurvivor", "A");
        const afterChoice = ui.element("#consolidate-preview").textContent;
        expect(afterChoice).toContain(OLD_A);
        expect(afterChoice).not.toContain(NEW_A);
        expect(ui.requests.filter((request) =>
          request.url.includes("/api/consolidate/preview?")
        )).toHaveLength(previewRequestsBefore);

        const merge = ui.element("#consolidate-preview").querySelectorAll("button")
          .find((button) => button.getAttribute("data-action") === "consolidate-merge");
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
        expect(ui.evaluate("ccState.merged")).toBeNull();
        expect(ui.element("#consolidate-preview").textContent).toContain("preview was stale");
        expect(ui.element("#consolidate-preview").textContent).toContain(NEW_A);
        const refreshedMerge = ui.element("#consolidate-preview").querySelectorAll("button")
          .find((button) => button.getAttribute("data-action") === "consolidate-merge");
        expect(refreshedMerge!.hasAttribute("disabled")).toBe(false);
        expect(ui.element("#consolidate-preview").querySelectorAll("button")
          .some((button) => button.getAttribute("data-action") === "consolidate-confirm")).toBe(false);

        // Сервер не применил unseen bundle: оба узла живы, текст A — только
        // concurrent write, не результат merge.
        const survivorRes = await server.request("/api/node/a");
        expect(survivorRes.status).toBe(200);
        expect(JSON.parse(survivorRes.text)).toMatchObject({ summary: NEW_A, why: NEW_WHY });
        expect((await server.request("/api/node/b")).status).toBe(200);
        expect(ui.errors).toEqual([]);
      } finally {
        ui.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it("серверный CAS: запись узла после preview даёт 409 и ноль записей", async () => {
    const fixture = auditFixture();
    try {
      const { server, writer } = await startSeededServer(fixture);
      const preview = await server.request("/api/consolidate/preview?survivor=a&other=b");
      const body = JSON.parse(preview.text);
      expect(body.base.digest).toMatch(/^[0-9a-f]{64}$/);
      const before = sqlState(writer!);
      // Поздняя запись после bundle.
      writer!.updateNode("a", { summary: "changed after bundle" });
      const afterEdit = sqlState(writer!);
      const post = await server.request("/api/consolidate", {
        method: "POST",
        body: JSON.stringify({ survivor: "a", other: "b", base: body.base }),
      });
      expect(post.status).toBe(409);
      // Отказ атомарен: ни одной записи поверх мутации.
      expect(sqlState(writer!)).toEqual(afterEdit);
      expect(sqlState(writer!)).not.toEqual(before);
    } finally {
      await fixture.close();
    }
  });
});
