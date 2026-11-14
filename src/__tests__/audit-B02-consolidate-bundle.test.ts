import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { auditDom, type AuditDomReply, type AuditDomRequest } from "./helpers/audit-dom.js";
import { seedHttpDb } from "./helpers/audit-http.js";
import { startAuditHttpSrc, type AuditHttpSrc } from "./helpers/audit-http-src.js";
import { auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";
import { ensureSchema } from "../migrate-schema.js";
import { KnowledgeDB } from "../db.js";

/**
 * B-02 (аудит 2026-11-12): клиент подтверждал merge по устаревшим карточкам.
 * Карточки A/B грузились отдельно (GET /api/node/:id) ДО получения плана;
 * гонка «изменение узла после карточек, но до плана» обходила серверный CAS
 * по digest — POST уносил уже новый digest, и слияние применялось по данным,
 * которых пользователь в карточках не видел.
 *
 * Контракт после исправления: GET /api/consolidate/preview отвечает планом И
 * карточками участников (cards.survivor / cards.other) из одного снимка;
 * клиент принимает bundle атомарно, смена survivor перечитывает его целиком,
 * confirm разрешён только когда план и карточки — один ответ.
 */

const OLD_A = "OLD visible summary a";
const OLD_B = "OLD visible summary b";
const NEW_A = "NEW UNSEEN summary from concurrent agent";
const NEW_WHY = "NEW UNSEEN reason";

let fixture: AuditFixture;
let writer: KnowledgeDB | undefined;

async function startSeededServer() {
  fixture = auditFixture();
  const dbFile = await seedHttpDb(fixture, (db) => {
    ensureSchema(db);
    db.insertNode({ id: "a", name: "a", kind: "feature", summary: OLD_A });
    db.insertNode({ id: "b", name: "b", kind: "feature", summary: OLD_B });
  });
  const server = await startAuditHttpSrc(fixture, dbFile);
  writer = new KnowledgeDB(dbFile);
  return { dbFile, server };
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
    const { server } = await startSeededServer();
    try {
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
      writer?.close();
      writer = undefined;
      await fixture.close();
    }
  }, 60_000);

  it("DOM: смена survivor перечитывает карточки вместе с планом; confirm — ровно один POST", async () => {
    const { server } = await startSeededServer();
    try {
      const ui = await auditDom({ reply: proxyReply(server) });
      try {
        await ui.invoke("openConsolidatePreview", "a", "b", { older: "a", similarity: 1 });
        const text = ui.element("#consolidate-preview").textContent;
        // Карточки при открытии показывают содержимое на момент загрузки.
        expect(text).toContain(OLD_A);
        expect(text).toContain(OLD_B);

        // Гонка: другой процесс меняет узел ПОСЛЕ загрузки карточек.
        writer!.updateNode("a", { summary: NEW_A, why: NEW_WHY });

        // Выбор survivor: карточки и план обязаны прийти заново одним bundle.
        await ui.invoke("chooseConsolidateSurvivor", "A");
        const after = ui.element("#consolidate-preview").textContent;
        // Целевой assert: показано содержимое, реально применяемое планом.
        expect(after).toContain(NEW_A);
        expect(after).not.toContain(OLD_A);

        // merge готов, подтверждение даёт ровно один POST.
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

        // Одна подтверждённая операция — ровно один POST; повторный submit
        // заблокирован busy/merged.
        await ui.invoke("submitConsolidateMerge");
        const posts = ui.requests.filter((request) => request.method === "POST");
        expect(posts).toHaveLength(1);
        expect(ui.evaluate("ccState.merged")).toMatchObject({ survivor: "a", removed: "b" });

        // Слияние применило текст, который был В КАРТОЧКАХ подтверждения
        // (план объединяет summary дубля — NEW читается в итоговом тексте).
        const survivorRes = await server.request("/api/node/a");
        expect(survivorRes.status).toBe(200);
        const survivorCard = JSON.parse(survivorRes.text);
        expect(survivorCard.summary).toContain(NEW_A);
        expect(survivorCard.why).toBe(NEW_WHY);
        const otherRes = await server.request("/api/node/b");
        expect(otherRes.status).toBe(404);
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

  it("серверный CAS: запись узла после preview даёт 409 и ноль записей", async () => {
    const { dbFile, server } = await startSeededServer();
    try {
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
      writer?.close();
      writer = undefined;
      await fixture.close();
    }
  }, 60_000);
});
