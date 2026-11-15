import { describe, it, expect } from "vitest";
import { estimateTokens, measureMcpPayload, understand } from "../tools.js";
import { computeSizeStats } from "../stats.js";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeAndCleanup } from "./helpers/cleanup.js";

// E5 (план 20+21 v3 §8.5): ОДИН estimator размера/токенов.
//
// Контракт:
// - Везде, где выдаётся размер/токены, работает один способ оценки:
//   estimateTokens (байты/3, консервативно для любой письменности).
//   Расхождение bytes/3 (tools.ts) и chars/4 (stats.ts) устранено.
// - Любое число — ОЦЕНКА, не гарантия токенов провайдера; поля с оценками
//   носят обозначение estimated/tokens_estimated.
// - Бюджетные меры считаются по фактической MCP-форме (measureMcpPayload):
//   конверт, pretty-JSON, escaping и служебные поля входят в оценку.

describe("E5: единый estimator размера", () => {
  it("computeSizeStats (stats) считает токены тем же estimateTokens, что и выдача", () => {
    const nodes = [
      { name: "модуль-отчётов", summary: "Проверено: отчёт собирается из кэша за один проход", why: null, file_refs: "[\"docs/отчёт.md\"]" },
      { name: "auth-refresh", summary: "Silent refresh 30 s before token expiry", why: "401s on /expired broke long jobs", file_refs: null },
      { name: "模块", summary: "模块设计覆盖支付网关", why: null, file_refs: null },
    ];
    const stats = computeSizeStats(nodes);
    const expected = nodes.reduce((sum, n) => {
      const payload = JSON.stringify({
        name: n.name,
        summary: n.summary,
        why: n.why ?? "",
        file_refs: n.file_refs ?? "",
      });
      return sum + estimateTokens(payload);
    }, 0);
    expect(stats.totalTokens).toBe(expected);
    expect(stats.avgTokens).toBe(Math.ceil(expected / nodes.length));
    // расхождение chars/4 поймано кириллицей: байты кириллицы в два раза
    // больше символов, поэтому байты/3 > символы/4 на русском тексте
    const cyrPayload = JSON.stringify({
      name: nodes[0].name,
      summary: nodes[0].summary,
      why: "",
      file_refs: nodes[0].file_refs ?? "",
    });
    expect(estimateTokens(cyrPayload)).toBeGreaterThan(Math.ceil(cyrPayload.length / 4));
  });

  it("пустой набор узлов даёт нули без деления на ноль", () => {
    const stats = computeSizeStats([]);
    expect(stats.totalTokens).toBe(0);
    expect(stats.avgTokens).toBe(0);
    expect(stats.largest).toBeNull();
    expect(stats.smallest).toBeNull();
  });

  it("estimateTokens помечен как оценка: байты/3, не символы/4", () => {
    // кириллица: байты/3 консервативнее символов/4 — расхождение методов
    // должно быть наблюдаемо, а не скрыто
    const text = "кириллический текст для оценки размера ответа";
    expect(estimateTokens(text)).toBe(Math.ceil(Buffer.byteLength(text, "utf8") / 3));
    expect(estimateTokens(text)).not.toBe(Math.ceil(text.length / 4));
  });
});

describe("E5: бюджетная мера — фактическая MCP-форма", () => {
  it("measureMcpPayload включает MCP-конверт и pretty-escaping, больше голого JSON", () => {
    const payload = { meta: { tokens_estimated: 0 }, summary: 'кавычки "и" переносы\nстрок' };
    const bare = estimateTokens(JSON.stringify(payload));
    const measured = measureMcpPayload(payload);
    expect(measured).toBeGreaterThan(bare);
    expect(measured).toBeGreaterThan(0);
  });

  it("tokens_estimated understand совпадает с мерой фактического ответа", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-estimator-"));
    const db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
    ensureSchema(db);
    try {
      db.insertNode({
        id: "mod",
        name: "mod",
        kind: "module",
        summary: "Проверено: модуль кэширует отрисованную разметку до первой правки",
      });
      const result = await understand(db, { query: "модуль кэширует разметку" });
      expect(result.meta!.tokens_estimated).toBe(measureMcpPayload(result));
      // обозначение оценки: поле называется tokens_estimated, а не tokens
      expect(Object.keys(result.meta!)).toContain("tokens_estimated");
      expect(Object.keys(result.meta!)).not.toContain("tokens");
    } finally {
      await closeAndCleanup(db, tmpDir);
    }
  });
});
