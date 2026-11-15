/**
 * M2 B2+B3 (план 20+21 v3 §7): политика expiry для kind=journal и запрет
 * автоматического бэкфилла.
 *
 * Порядок значения: явный valid_until → env MEGAMEMORY_EXPIRY_JOURNAL_DAYS →
 * конфиг expiry.journal_days рядом с БД → default 90 дней (стартовый
 * настраиваемый fallback исходника плана, не результат измерения).
 *
 * Время управляемое: фиксированная точка старта (fake timers поверх Date) —
 * никаких «примерно через 90 дней»; дата вычисляется и проверяется точно.
 * B3: существующие узлы не переклассифицируются и не просрочиваются —
 * автопростановка это политика СОЗДАНИЯ новой записи.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { createConcept, updateConcept } from "../tools.js";
import { readExpiryConfig, journalDefaultExpiry } from "../expiry.js";
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

const NOW = "2026-11-15T00:00:00.000Z";
/** NOW + 90 дней (default) — точная дата, не «примерно». */
const NOW_PLUS_90 = "2027-02-13T00:00:00.000Z";
/** NOW + 7 дней. */
const NOW_PLUS_7 = "2026-11-22T00:00:00.000Z";
/** NOW + 14 дней. */
const NOW_PLUS_14 = "2026-11-29T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE_EXPLICIT = "2026-12-01T12:00:00.000Z";

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-journal-expiry-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
  delete process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS;
  delete process.env.MEGAMEMORY_SEARCH;
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS;
  if (db) await closeAndCleanup(db, tmpDir);
});

function writeConfig(value: unknown, raw?: string): void {
  const file = path.join(tmpDir, "megamemory.config.json");
  fs.writeFileSync(file, raw ?? JSON.stringify(value), "utf-8");
}

function expiryOf(id: string): string | null {
  return (db.getNode(id)!.valid_until ?? null) as string | null;
}

describe("B2: порядок значения — явный valid_until → env → конфиг → default", () => {
  it("новый journal без поля: now UTC + journal_days (default 90)", async () => {
    const res = await createConcept(db, {
      name: "jr-default",
      kind: "journal",
      summary: "PR #1 открыт, ждёт ревью",
    });
    expect(res.id).toBe("jr-default");
    expect(expiryOf("jr-default")).toBe(NOW_PLUS_90);
    // автопростановка снимает предупреждение: срок есть
    expect(res.warnings).toBeUndefined();
  });

  it("явная дата сохраняется после существующей валидации — автопростановка не перебивает", async () => {
    const res = await createConcept(db, {
      name: "jr-explicit",
      kind: "journal",
      summary: "PR #2 открыт",
      valid_until: FUTURE_EXPLICIT,
    });
    expect(expiryOf("jr-explicit")).toBe(FUTURE_EXPLICIT);
  });

  it("env MEGAMEMORY_EXPIRY_JOURNAL_DAYS перебивает default", async () => {
    process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS = "7";
    await createConcept(db, { name: "jr-env", kind: "journal", summary: "PR #3 открыт" });
    expect(expiryOf("jr-env")).toBe(NOW_PLUS_7);
  });

  it("конфиг expiry.journal_days рядом с БД; env перебивает конфиг; конфиг перебивает default", async () => {
    writeConfig({ expiry: { journal_days: 14 } });
    await createConcept(db, { name: "jr-config", kind: "journal", summary: "PR #4 открыт" });
    expect(expiryOf("jr-config")).toBe(NOW_PLUS_14);

    process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS = "7";
    await createConcept(db, { name: "jr-env-over", kind: "journal", summary: "PR #5 открыт" });
    expect(expiryOf("jr-env-over")).toBe(NOW_PLUS_7);
  });

  it("конфиг читается свежим на каждый вызов: смена между create меняет следующий срок", async () => {
    writeConfig({ expiry: { journal_days: 14 } });
    await createConcept(db, { name: "jr-fresh-1", kind: "journal", summary: "PR #6 открыт" });
    expect(expiryOf("jr-fresh-1")).toBe(NOW_PLUS_14);

    writeConfig({ expiry: { journal_days: 7 } });
    await createConcept(db, { name: "jr-fresh-2", kind: "journal", summary: "PR #7 открыт" });
    expect(expiryOf("jr-fresh-2")).toBe(NOW_PLUS_7);
  });

  it("90 дней — default, не измерение: без env и конфига ровно now+90d", () => {
    const config = readExpiryConfig(path.join(tmpDir, "knowledge.db"));
    expect(config).toMatchObject({ journalDays: 90, source: "default" });
    expect(journalDefaultExpiry(config, new Date(NOW))).toBe(NOW_PLUS_90);
  });
});

describe("B2: явный null, пустая строка, journal_days = 0", () => {
  it("явный null: автопростановки нет; изменчивое утверждение диагностируется предупреждением, запись не блокируется", async () => {
    const res = await createConcept(db, {
      name: "jr-null",
      kind: "journal",
      summary: "PR #8 открыт",
      valid_until: null,
    });
    expect(res.id).toBe("jr-null");
    expect(expiryOf("jr-null")).toBeNull();
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings![0].code).toBe("state_claim_without_expiry");
  });

  it("пустая строка: совместимая семантика снятия срока — НЕ отсутствие поля, автопростановки нет", async () => {
    const res = await createConcept(db, {
      name: "jr-empty",
      kind: "journal",
      summary: "PR #9 открыт",
      valid_until: "",
    });
    expect(expiryOf("jr-empty")).toBeNull();
    expect(res.warnings).toHaveLength(1);
  });

  it("journal_days = 0: автопростановка выключена, запись не объявляется безопасной (предупреждение остаётся)", async () => {
    process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS = "0";
    const res = await createConcept(db, { name: "jr-zero", kind: "journal", summary: "PR #10 открыт" });
    expect(expiryOf("jr-zero")).toBeNull();
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings![0].code).toBe("state_claim_without_expiry");
  });
});

describe("B2: обычные kinds не трогаются", () => {
  it("обычный kind (feature) не получает TTL от journal-политики; существующие предупреждения остаются", async () => {
    const res = await createConcept(db, {
      name: "feat-plain",
      kind: "feature",
      summary: "Релиз 2.5.1 опубликован в npm 2026-11-05: пакет содержит d3-фолбэк, тег стоит на main",
    });
    expect(expiryOf("feat-plain")).toBeNull();
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings![0].code).toBe("state_claim_without_expiry");
  });

  it("digest не проверяется на утверждение о состоянии (существующий контракт)", async () => {
    const res = await createConcept(db, {
      name: "digest-node",
      kind: "digest",
      summary: "Сводка модуля от 2026-11-15: релиз 2.5.1",
    });
    expect(expiryOf("digest-node")).toBeNull();
    expect(res.warnings).toBeUndefined();
  });
});

describe("B2: update — срок сохраняется, включая истёкший; скользящего TTL нет", () => {
  it("update journal без поля срока сохраняет срок, включая истёкший", async () => {
    await createConcept(db, {
      name: "jr-keep",
      kind: "journal",
      summary: "PR #11 открыт",
      valid_until: PAST,
    });
    await updateConcept(db, { id: "jr-keep", changes: { summary: "PR #11 открыт, ревью назначено" } });
    expect(expiryOf("jr-keep")).toBe(PAST); // не омолаживается и не продлевается
  });

  it("update journal c явным сроком меняет его; null и пустая строка снимают", async () => {
    await createConcept(db, { name: "jr-upd", kind: "journal", summary: "PR #12 открыт" });
    expect(expiryOf("jr-upd")).toBe(NOW_PLUS_90);

    await updateConcept(db, { id: "jr-upd", changes: { valid_until: FUTURE_EXPLICIT } });
    expect(expiryOf("jr-upd")).toBe(FUTURE_EXPLICIT);

    await updateConcept(db, { id: "jr-upd", changes: { valid_until: null } });
    expect(expiryOf("jr-upd")).toBeNull();

    // повторное обновление без поля не возвращает автопростановку
    await updateConcept(db, { id: "jr-upd", changes: { summary: "PR #12 открыт, изменён" } });
    expect(expiryOf("jr-upd")).toBeNull();
  });

  it("явная смена обычного kind → journal: заданный ранее срок сохраняется", async () => {
    await createConcept(db, {
      name: "jr-conv-keep",
      kind: "feature",
      summary: "Импорт читает манифест",
      valid_until: FUTURE_EXPLICIT,
    });
    await updateConcept(db, { id: "jr-conv-keep", changes: { kind: "journal" } });
    expect(expiryOf("jr-conv-keep")).toBe(FUTURE_EXPLICIT);
  });

  it("явная смена обычного kind → journal без срока и без поля: default применяется как часть смены kind", async () => {
    await createConcept(db, { name: "jr-conv-new", kind: "feature", summary: "Импорт читает манифест" });
    expect(expiryOf("jr-conv-new")).toBeNull();
    await updateConcept(db, { id: "jr-conv-new", changes: { kind: "journal" } });
    expect(expiryOf("jr-conv-new")).toBe(NOW_PLUS_90);
  });

  it("смена journal → другой kind: ранее заданный срок не снимается автоматически", async () => {
    // саммари с глаголом-утверждением: смена kind на feature не превращает
    // запись в заглушку (проверка итогового саммари действует для feature)
    await createConcept(db, {
      name: "jr-conv-out",
      kind: "journal",
      summary: "PR #13 открыт: правка содержит рефакторинг скана, ревью назначено на неделю",
    });
    expect(expiryOf("jr-conv-out")).toBe(NOW_PLUS_90);
    await updateConcept(db, { id: "jr-conv-out", changes: { kind: "feature" } });
    expect(expiryOf("jr-conv-out")).toBe(NOW_PLUS_90);
  });

  it("предупреждение при update: journal-саммари без итогового срока диагностируется", async () => {
    await createConcept(db, { name: "jr-warn", kind: "journal", summary: "PR #14 открыт" });
    const res = await updateConcept(db, {
      id: "jr-warn",
      changes: { valid_until: null, summary: "PR #14 открыт, перенесён" },
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings![0].code).toBe("state_claim_without_expiry");
  });
});

describe("B2: невалидный конфиг/env — явная ошибка ДО записи", () => {
  const cases: Array<[string, string]> = [
    ["мусор", "abc"],
    ["отрицательное", "-1"],
    ["дробное", "1.5"],
    ["пустая строка", ""],
    ["не число-литерал", "1e3"],
  ];
  for (const [name, raw] of cases) {
    it(`env "${raw}" (${name}) отклоняет запись journal — узла нет`, async () => {
      process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS = raw;
      await expect(
        createConcept(db, { name: "jr-bad-env", kind: "journal", summary: "PR #15 открыт" })
      ).rejects.toThrow(/MEGAMEMORY_EXPIRY_JOURNAL_DAYS/);
      expect(db.getNode("jr-bad-env")).toBeUndefined();
    });
  }

  it("конфиг с невалидным expiry.journal_days отклоняет запись; непарсируемый JSON — тоже", async () => {
    writeConfig(null, "{ not json at all");
    await expect(
      createConcept(db, { name: "jr-bad-cfg", kind: "journal", summary: "PR #16 открыт" })
    ).rejects.toThrow(/конфиг|config/i);
    expect(db.getNode("jr-bad-cfg")).toBeUndefined();

    writeConfig({ expiry: { journal_days: "много" } });
    await expect(
      createConcept(db, { name: "jr-bad-cfg2", kind: "journal", summary: "PR #17 открыт" })
    ).rejects.toThrow(/journal_days/);
    expect(db.getNode("jr-bad-cfg2")).toBeUndefined();
  });

  it("переполнение вычисляемой даты — ошибка до записи", () => {
    const config = { journalDays: 10 ** 15, source: "env" as const };
    expect(() => journalDefaultExpiry(config, new Date(NOW))).toThrow(/переполн|overflow/i);
  });

  it("невалидный env не мешает записи обычного (не journal) kind", async () => {
    process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS = "мусор";
    const res = await createConcept(db, {
      name: "feat-ok",
      kind: "feature",
      summary: "Импорт читает манифест и резолвит пути",
    });
    expect(res.id).toBe("feat-ok");
  });
});

describe("B2: UTC и граница дня; duplicate; B3 — без бэкфилла", () => {
  it("граница дня в UTC: 2026-12-31T23:59:59.999Z + 1 день → 2027-01-01T23:59:59.999Z", () => {
    const config = { journalDays: 1, source: "default" as const };
    const ts = journalDefaultExpiry(config, new Date("2026-12-31T23:59:59.999Z"));
    expect(ts).toBe("2027-01-01T23:59:59.999Z");
  });

  it("duplicate create не обновляет срок существующего узла", async () => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
    await createConcept(db, { name: "jr-dup", kind: "journal", summary: "PR #18 открыт" });
    const before = expiryOf("jr-dup");
    expect(before).toBe(NOW_PLUS_90);

    // вторая запись тем же именем — отказ-дубликат; время «прошло»; срок не тронут
    vi.useFakeTimers({ now: new Date("2026-11-20T00:00:00.000Z"), toFake: ["Date"] });
    await expect(
      createConcept(db, { name: "jr-dup", kind: "journal", summary: "PR #18 открыт" })
    ).rejects.toThrow(/already exists|duplicate/i);
    expect(expiryOf("jr-dup")).toBe(before);
  });

  it("B3: существующие узлы не бэкфиллится — открытие/чтение не проставляет срок старым journal-подобным узлам", async () => {
    // Узел, записанный ДО введения kind (feature с утверждением о состоянии,
    // без срока): ни чтение, ни повторное чтение не переклассифицируют и
    // не просрочивают его.
    db.insertNode({
      id: "old-state-claim",
      name: "old-state-claim",
      kind: "feature",
      summary: "Релиз 2.4.0 влит в main 2026-10-01, тег стоит",
    });
    expect(expiryOf("old-state-claim")).toBeNull();
    const { getConcept } = await import("../tools.js");
    getConcept(db, { id: "old-state-claim" });
    expect(db.getNode("old-state-claim")!.kind).toBe("feature"); // не переклассифицирован
    expect(expiryOf("old-state-claim")).toBeNull(); // не просрочен и не получил TTL
  });
});
