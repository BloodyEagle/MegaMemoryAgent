/**
 * 2.1.13 F5: команда megamemory expire. Сервер срок сам не ставит — это
 * ручной инструмент владельца: dry-run по умолчанию, --apply применяет,
 * неизвестный id отказывает всю команду, каждый прогон пишет timeline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { expireNodes, resolveUntil, readReportIds, runExpire } from "../expire-cli.js";
import { understand } from "../tools.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embed: vi.fn(async () => Buffer.alloc(0)),
    embedForStorage: vi.fn(async () => null),
    vectorSearchEnabled: vi.fn(() => false),
  };
});

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-expire-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) {
    await closeAndCleanup(db, tmpDir);
    db = undefined as unknown as KnowledgeDB;
  }
  delete process.env.MEGAMEMORY_DB_PATH;
});

function insert(id: string, summary: string, validUntil: string | null = null): void {
  db.insertNode({ id, name: id, kind: "feature", summary, valid_until: validUntil });
}

describe("expireNodes — ядро (тесты 27-29)", () => {
  it("dry-run не меняет базу (тест 27)", () => {
    insert("журнал-1", "журнал вызовов understand №1");
    const result = expireNodes(db, ["журнал-1"], "2026-01-01T00:00:00.000Z", false);
    expect(result.applied).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: "журнал-1",
      kind: "feature",
      was: null,
      becomes: "2026-01-01T00:00:00.000Z",
    });
    expect(db.getNode("журнал-1")!.valid_until ?? null).toBeNull();
  });

  it("--apply проставляет срок и пишет timeline (тест 28)", () => {
    insert("журнал-2", "журнал вызовов understand №2");
    insert("знание-1", "формат журнала вызовов описан в src/timeline.ts");
    const result = expireNodes(
      db,
      ["журнал-2", "знание-1"],
      "2026-01-01T00:00:00.000Z",
      true
    );
    expect(result.applied).toBe(true);
    expect(db.getNode("журнал-2")!.valid_until).toBe("2026-01-01T00:00:00.000Z");
    const timeline = db.getTimelineEntries({ tool: "expire" });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].is_write).toBe(1);
    expect(JSON.parse(timeline[0].params)).toEqual({
      until: "2026-01-01T00:00:00.000Z",
      ids: ["журнал-2", "знание-1"],
    });
  });

  it("неизвестный id → отказ, ноль записей (тест 29)", () => {
    insert("живой-1", "узел, который не должен измениться");
    expect(() =>
      expireNodes(db, ["живой-1", "нет-такого"], "2026-01-01T00:00:00.000Z", true)
    ).toThrow(/нет-такого/);
    expect(db.getNode("живой-1")!.valid_until ?? null).toBeNull();
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(0);
  });
});

describe("разбор аргументов (тесты 30-32)", () => {
  it("--until past = вчера (тест 30)", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const resolved = resolveUntil("past");
    expect(new Date(resolved).getDate()).toBe(yesterday.getDate());
    expect(new Date(resolved).getMonth()).toBe(yesterday.getMonth());
    expect(new Date(resolved).getFullYear()).toBe(yesterday.getFullYear());
    // мусор — отказ
    expect(() => resolveUntil("завтра")).toThrow(/не разбирается/);
  });

  it("--report читает JSON: применяются только кандидаты с expire: true (тест 31)", () => {
    const reportPath = path.join(tmpDir, "expire-report.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        generated_at: "2026-11-06T00:00:00Z",
        candidates: [
          { id: "журнал-а", verdict: "журнал", expire: true },
          { id: "журнал-б", verdict: "на грани", expire: true },
          { id: "знание-в", verdict: "знание", expire: false },
        ],
      })
    );
    const { ids, verdicts } = readReportIds(reportPath);
    expect(ids).toEqual(["журнал-а", "журнал-б"]);
    expect(verdicts.get("журнал-а")).toBe("журнал");
    expect(verdicts.has("знание-в")).toBe(false);
  });

  it("--ids и --report вместе → ошибка (тест 32)", async () => {
    await expect(
      runExpire(["--db", path.join(tmpDir, "knowledge.db"), "--ids", "a", "--report", "r.json", "--until", "past"])
    ).rejects.toThrow(/взаимоисключающие/);
  });
});

describe("после expire на копии — фильтр выдачи (тест 32а)", () => {
  it("stats: Expired: 9; understand журналы не возвращает, знание возвращает", async () => {
    const journalIds: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const id = `журнал-вызовов-${i}`;
      journalIds.push(id);
      insert(id, `журнал вызовов сессии №${i}: understand вернул 3 узла, изменений нет`);
    }
    insert(
      "знание-формат",
      "формат журнала вызовов определён в src/timeline.ts — одна запись на вызов инструмента"
    );

    // применяем expire с вчерашним сроком (на копии — это и есть fixture)
    const until = resolveUntil("past");
    expireNodes(db, journalIds, until, true);

    // stats: счётчик Expired === 9
    expect(db.countExpiredNodes()).toBe(9);

    // understand по теме журналов: ни один из 9 не возвращается
    const result = await understand(db, { query: "журнал вызовов" });
    const returned = (result.compact ?? result.matches).map((m: { id: string }) => m.id);
    for (const id of journalIds) {
      expect(returned, id).not.toContain(id);
    }
    expect(returned).toContain("знание-формат");
  });
});

// B-08 (аудит 2026-11-12): batch expire атомарен. Раньше UPDATE-ы шли вне
// транзакции: отказ второго UPDATE оставлял первый применённым, а журнальная
// запись не выполнялась вовсе. Ошибки инъецируются настоящими SQLite-
// триггерами (RAISE ABORT), как в доказательстве аудита.
describe("B-08: атомарный batch expire", () => {
  const UNTIL = "2026-01-01T00:00:00.000Z";

  function validUntil(id: string): string | null {
    return db.getNode(id)!.valid_until ?? null;
  }

  it("отказ второго UPDATE откатывает весь batch: первый узел не просрочен, журнала нет", () => {
    insert("alpha", "первый узел пакета");
    insert("beta", "второй узел пакета");
    db.execSql(`CREATE TRIGGER block_beta
      BEFORE UPDATE OF valid_until ON nodes
      WHEN NEW.id = 'beta'
      BEGIN SELECT RAISE(ABORT, 'second-node write failure'); END`);

    expect(() =>
      expireNodes(db, ["alpha", "beta"], UNTIL, true)
    ).toThrow(/second-node write failure/);

    expect(
      validUntil("alpha"),
      "B-08: отказ записи второго узла обязан откатить первый"
    ).toBeNull();
    expect(validUntil("beta")).toBeNull();
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(0);
  });

  it("ошибка журнального append внутри транзакции откатывает уже проставленные сроки", () => {
    insert("alpha", "узел пакета при отказе журнала");
    db.execSql(`CREATE TRIGGER block_expire_journal
      BEFORE INSERT ON timeline
      WHEN NEW.tool = 'expire'
      BEGIN SELECT RAISE(ABORT, 'journal append failure'); END`);

    expect(() =>
      expireNodes(db, ["alpha"], UNTIL, true)
    ).toThrow(/journal append failure/);

    expect(
      validUntil("alpha"),
      "B-08: ошибка журнала обязана откатить применённые сроки"
    ).toBeNull();
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(0);
  });

  it("перезапись существующего срока разрешена (совместимое «было → станет»)", () => {
    insert("уже-со-сроком", "срок выставлен ранее", "2025-06-01T00:00:00.000Z");
    insert("свежий", "узел без срока");

    const result = expireNodes(db, ["уже-со-сроком", "свежий"], UNTIL, true);

    expect(result.applied).toBe(true);
    expect(result.rows[0].was).toBe("2025-06-01T00:00:00.000Z");
    expect(validUntil("уже-со-сроком")).toBe(UNTIL);
    expect(validUntil("свежий")).toBe(UNTIL);
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(1);
  });

  it("изменение срока триггером между обновлениями отказывает весь batch", () => {
    insert("alpha", "остаётся без изменений при гонке");
    insert("beta", "срок меняется между проверкой и UPDATE");
    // Триггер внутри того же apply меняет beta после первоначального чтения.
    // Это не CAS между отдельными CLI-вызовами dry-run и --apply.
    db.execSql(`CREATE TRIGGER race_beta
      BEFORE UPDATE OF valid_until ON nodes
      WHEN NEW.id = 'alpha'
      BEGIN UPDATE nodes SET valid_until = '2030-01-01T00:00:00.000Z' WHERE id = 'beta'; END`);

    expect(() =>
      expireNodes(db, ["alpha", "beta"], UNTIL, true)
    ).toThrow(/изменился между проверкой и применением/);

    expect(validUntil("alpha"), "B-08: гонка обязана откатить batch").toBeNull();
    expect(validUntil("beta")).toBeNull();
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(0);
  });

  it("нормальный batch: оба узла просрочены и РОВНО одна запись expire с полным списком", () => {
    insert("alpha", "нормальный пакет 1");
    insert("beta", "нормальный пакет 2");

    const result = expireNodes(db, ["alpha", "beta"], UNTIL, true);

    expect(result.applied).toBe(true);
    expect(validUntil("alpha")).toBe(UNTIL);
    expect(validUntil("beta")).toBe(UNTIL);
    const timeline = db.getTimelineEntries({ tool: "expire" });
    expect(timeline).toHaveLength(1);
    expect(JSON.parse(timeline[0].params)).toEqual({ until: UNTIL, ids: ["alpha", "beta"] });
    expect(timeline[0].affected_ids && JSON.parse(timeline[0].affected_ids)).toEqual(["alpha", "beta"]);
  });

  it("удалённый (tombstone) id — контролируемая ошибка без частичного применения", () => {
    insert("alpha", "остаётся без изменений");
    insert("удалён-1", "узел удалён до пакета");
    db.softDeleteNode("удалён-1", "тест B-08");

    expect(() =>
      expireNodes(db, ["alpha", "удалён-1"], UNTIL, true)
    ).toThrow(/удалён-1/);

    expect(validUntil("alpha")).toBeNull();
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(0);
  });
});
