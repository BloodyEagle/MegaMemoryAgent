import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ensureSchema } from "../../src/migrate-schema.js";
import { auditFixture, type AuditFixture } from "../../src/__tests__/helpers/audit.js";
import { startAuditHttp } from "../../src/__tests__/helpers/audit-http.js";

// 2.1.13 F6, тесты (34) и (35): интеграционный тест находит базу в temp,
// а не в домашнем каталоге; MEGAMEMORY_DB_PATH из окружения не влияет —
// явный --db всегда выигрывает, база по env-пути не создаётся и не читается.

let fixture: AuditFixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

describe("db path isolation (F6 2.1.13)", () => {
  it(
    "serve uses explicit --db; poisoned MEGAMEMORY_DB_PATH is ignored and its db is not created",
    { timeout: 45000 },
    async () => {
      fixture = auditFixture();
      const tmpDir = fixture.root;
      const realDb = path.join(tmpDir, "real", "knowledge.db");
      fs.mkdirSync(path.dirname(realDb));
      const db = fixture.db(realDb);
      ensureSchema(db);
      db.insertNode({
        id: "изолированный-узел",
        name: "Изолированный",
        kind: "module",
        summary: "база в temp, а не в домашнем каталоге",
      });
      await fixture.release(db);

      // Отравленный env-путь: если serve его прочитает, здесь появится база.
      const poisonedDir = path.join(tmpDir, "home-catalog-не-создавать");
      const poisonedDb = path.join(poisonedDir, "knowledge.db");

      const server = await startAuditHttp(fixture, realDb, {
        env: { MEGAMEMORY_DB_PATH: poisonedDb },
      });
      const response = await server.request("/api/graph");
      const exitInfo = server.alive() ? null : server.diagnostics();
      const payload = response.status === 200
        ? JSON.parse(response.text) as { nodes: Array<{ id: string }> }
        : null;
      expect(exitInfo).toBeNull();
      expect(payload).not.toBeNull();
      expect(payload!.nodes.map((n) => n.id)).toContain("изолированный-узел");

      // (35): база по env-пути не создана, каталог не появился
      expect(fs.existsSync(poisonedDb)).toBe(false);
      expect(fs.existsSync(poisonedDir)).toBe(false);
    }
  );
});
