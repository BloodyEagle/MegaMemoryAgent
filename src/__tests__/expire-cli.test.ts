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
