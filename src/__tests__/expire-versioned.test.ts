/**
 * M2 B5 (план 20+21 v3 §7): защита preview → apply.
 *
 * Версионный отчёт (format_version 2) содержит идентичность источника,
 * время снимка, предложенную конкретную дату и версии существенных полей
 * каждого кандидата (id, claim, kind, lifecycle/удаление, прежний expiry).
 * Перед применением весь выбранный набор проверяется внутри одной
 * транзакции: изменение summary/kind/status/expiry либо исчезновение любого
 * участника отменяет весь batch с version_conflict. `past` разрешается в
 * конкретный timestamp при построении отчёта и не подменяется новой датой
 * при apply того же отчёта. Старый формат отчёта (без версий) остаётся
 * документированным путём совместимости с ЯВНЫМ предупреждением.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { scanExpiryCandidates } from "../scan-expiry.js";
import { expireNodes, expirePinsFromReport, readReport, runExpire } from "../expire-cli.js";
import { ensureSchema } from "../migrate-schema.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-expire-versioned-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
  delete process.env.MEGAMEMORY_DB_PATH;
});

function insert(id: string, kind: string, summary: string, validUntil?: string | null): void {
  db.insertNode({ id, name: id, kind, summary, valid_until: validUntil ?? undefined });
}

function validUntilOf(id: string): string | null {
  return (db.getNode(id)!.valid_until ?? null) as string | null;
}

/** Просмотренный версионный отчёт: одна строка разрешена, версии — от скана. */
function reviewedReport(idsToExpire: string[]) {
  const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
  return {
    ...report,
    candidates: report.candidates.map((c) =>
      idsToExpire.includes(c.id) ? { ...c, expire: true } : c
    ),
  };
}

describe("B5: применённый версионный отчёт", () => {
  it("JSON скана читается тем же interface: просмотренная строка с expire:true применяется", () => {
    insert("jr-json", "journal", "PR #26 открыт");
    const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    // человек просмотрел отчёт и разрешил одну строку — единственная правка
    // в JSON; всё остальное (версии полей) исходит от скана
    const reviewed = {
      ...report,
      candidates: report.candidates.map((c) =>
        c.id === "jr-json" ? { ...c, expire: true } : c
      ),
    };
    const result = expireNodes(
      db,
      ["jr-json"],
      reviewed.proposed_until,
      true,
      expirePinsFromReport(reviewed)
    );
    expect(result.applied).toBe(true);
    expect(validUntilOf("jr-json")).toBe(reviewed.proposed_until);
  });

  it("применяет предложенную конкретную дату отчёта — не новую при apply", () => {
    insert("jr-a", "journal", "PR #30 открыт");
    const reviewed = reviewedReport(["jr-a"]);
    // «время прошло» между просмотром и применением
    const pins = expirePinsFromReport(reviewed);
    const result = expireNodes(db, ["jr-a"], reviewed.proposed_until, true, pins);
    expect(result.applied).toBe(true);
    // proposed_until = вчера относительно СКАНА (2026-11-14), а не относительно apply
    expect(validUntilOf("jr-a")).toBe("2026-11-14T00:00:00.000Z");
  });

  it("успешный apply пишет ровно одну строгую запись timeline с полным списком", () => {
    insert("jr-b", "journal", "PR #31 открыт");
    insert("jr-c", "journal", "Релиз 2.1.17 влит в main 2026-11-03");
    const reviewed = reviewedReport(["jr-b", "jr-c"]);
    expireNodes(db, ["jr-b", "jr-c"], reviewed.proposed_until, true, expirePinsFromReport(reviewed));
    const timeline = db.getTimelineEntries({ tool: "expire" });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].is_write).toBe(1);
    expect(JSON.parse(timeline[0].params)).toEqual({
      until: reviewed.proposed_until,
      ids: ["jr-b", "jr-c"],
    });
  });
});

describe("B5: устаревший preview полностью откатывается (version_conflict)", () => {
  const PAST_U = "2026-01-05T00:00:00.000Z";

  it("изменение summary любого участника отменяет весь batch: ни один срок не проставлен", () => {
    insert("jr-1", "journal", "PR #32 открыт");
    insert("jr-2", "journal", "PR #33 открыт");
    const reviewed = reviewedReport(["jr-1", "jr-2"]);
    const pins = expirePinsFromReport(reviewed);

    // после preview участник изменён
    db.updateNode("jr-2", { summary: "PR #33 открыт, ревью назначено" });

    expect(() =>
      expireNodes(db, ["jr-1", "jr-2"], reviewed.proposed_until, true, pins)
    ).toThrow(/version_conflict/);
    expect(validUntilOf("jr-1")).toBeNull();
    expect(validUntilOf("jr-2")).toBeNull();
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(0);
  });

  it("изменение kind, статуса или прежнего expiry отменяет batch", () => {
    insert("jr-4", "journal", "PR #35 открыт");
    const reviewed = reviewedReport(["jr-4"]);
    const pins = expirePinsFromReport(reviewed);

    db.updateNode("jr-4", { kind: "feature" });
    expect(() => expireNodes(db, ["jr-4"], reviewed.proposed_until, true, pins)).toThrow(/version_conflict/);
    expect(validUntilOf("jr-4")).toBeNull();

    // статус (lifecycle): supersede ставит собственную метку valid_until —
    // важен факт конфликта и то, что дата отчёта не записана
    db.updateNode("jr-4", { kind: "journal" });
    const marker = new Date().toISOString();
    db.setNodeStatus("jr-4", "superseded", marker, "superseded");
    expect(() => expireNodes(db, ["jr-4"], reviewed.proposed_until, true, pins)).toThrow(/version_conflict/);
    expect(validUntilOf("jr-4")).toBe(marker);

    // прежний expiry изменился (статус возвращён в active, срок остаётся PAST_U)
    db.setNodeStatus("jr-4", "active", undefined, "revert");
    db.updateNode("jr-4", { valid_until: PAST_U });
    expect(() => expireNodes(db, ["jr-4"], reviewed.proposed_until, true, pins)).toThrow(/version_conflict/);
    expect(validUntilOf("jr-4")).toBe(PAST_U);
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(0);
  });

  it("исчезновение (soft-delete) любого участника отменяет весь batch", () => {
    insert("jr-5", "journal", "PR #36 открыт");
    insert("jr-6", "journal", "PR #37 открыт");
    const reviewed = reviewedReport(["jr-5", "jr-6"]);
    const pins = expirePinsFromReport(reviewed);
    db.softDeleteNode("jr-6", "удалён после preview");

    expect(() =>
      expireNodes(db, ["jr-5", "jr-6"], reviewed.proposed_until, true, pins)
    ).toThrow(/неизвестные id|version_conflict|исчез|удалён/);
    expect(validUntilOf("jr-5")).toBeNull();
    expect(db.getTimelineEntries({ tool: "expire" })).toHaveLength(0);
  });

  it("ошибка строгой записи timeline внутри транзакции откатывает применённые сроки", () => {
    insert("jr-7", "journal", "PR #38 открыт");
    const reviewed = reviewedReport(["jr-7"]);
    const pins = expirePinsFromReport(reviewed);
    db.execSql(`CREATE TRIGGER block_expire_journal
      BEFORE INSERT ON timeline
      WHEN NEW.tool = 'expire'
      BEGIN SELECT RAISE(ABORT, 'journal append failure'); END`);

    expect(() =>
      expireNodes(db, ["jr-7"], reviewed.proposed_until, true, pins)
    ).toThrow(/journal append failure/);
    expect(validUntilOf("jr-7")).toBeNull();
  });
});

describe("B5: формат отчёта и флаги CLI", () => {
  it("версионный отчёт читается readReport; expire:true задаёт выбор, версии переносятся", () => {
    insert("jr-8", "journal", "PR #39 открыт");
    const reviewed = reviewedReport(["jr-8"]);
    const reportPath = path.join(tmpDir, "scan.json");
    fs.writeFileSync(reportPath, JSON.stringify(reviewed), "utf-8");

    const read = readReport(reportPath);
    expect(read.ids).toEqual(["jr-8"]);
    expect(read.versioned).toBeDefined();
    expect(read.versioned!.proposed_until).toBe(reviewed.proposed_until);
    expect(read.versioned!.pins.get("jr-8")).toMatchObject({
      kind: "journal",
      status: "active",
      valid_until: null,
    });
  });

  it("старый формат (без версий) читается как legacy — путь совместимости", () => {
    const reportPath = path.join(tmpDir, "legacy.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        generated_at: "2026-11-06T00:00:00Z",
        candidates: [{ id: "legacy-a", verdict: "журнал", expire: true }],
      }),
      "utf-8"
    );
    const read = readReport(reportPath);
    expect(read.ids).toEqual(["legacy-a"]);
    expect(read.versioned).toBeUndefined();
  });

  it("--scan --apply запрещён: применение только по --ids или просмотренному отчёту", async () => {
    const dbPath = path.join(tmpDir, "knowledge.db");
    await expect(
      runExpire(["--db", dbPath, "--scan", "--apply", "--until", "past"])
    ).rejects.toThrow(/--scan/);
  });

  it("--until с датой, расходящейся с версионным отчётом, — явный отказ (past не подменяется)", async () => {
    insert("jr-9", "journal", "PR #40 открыт");
    const reviewed = reviewedReport(["jr-9"]);
    const reportPath = path.join(tmpDir, "scan.json");
    fs.writeFileSync(reportPath, JSON.stringify(reviewed), "utf-8");
    process.env.MEGAMEMORY_DB_PATH = path.join(tmpDir, "knowledge.db");

    await expect(
      runExpire(["--report", reportPath, "--until", "2027-06-01", "--apply"])
    ).rejects.toThrow(/--until|proposed_until|расходится/);
    expect(validUntilOf("jr-9")).toBeNull();
  });
});

describe("B5: старый формат — явное предупреждение в выводе", () => {
  it("apply старого отчёта печатает предупреждение о действии без защиты от устаревания", async () => {
    insert("legacy-node", "feature", "Релиз 2.1.18 влит в main 2026-11-04");
    const reportPath = path.join(tmpDir, "legacy.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ candidates: [{ id: "legacy-node", verdict: "журнал", expire: true }] }),
      "utf-8"
    );
    process.env.MEGAMEMORY_DB_PATH = path.join(tmpDir, "knowledge.db");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await runExpire(["--report", reportPath, "--until", "past", "--apply"]);
    } finally {
      spy.mockRestore();
    }
    expect(validUntilOf("legacy-node")).not.toBeNull();
    expect(logs.join("\n")).toMatch(/предупрежд|legacy|без версий|устареван/i);
  });
});
