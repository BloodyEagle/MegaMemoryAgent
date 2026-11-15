/**
 * M2 B4 (план 20+21 v3 §7): `expire --scan` — единый проверяемый module
 * обнаружения кандидатов на expiry.
 *
 * Исправления исходника (R10/R11): опоры кандидата — ИСХОДЯЩИЕ живые
 * informed_by с живыми целями (старый скрипт считал входящие); открытие базы
 * — безопасный readonly-путь KnowledgeDB (query_only), а не «обещаем только
 * SELECT» поверх сырого RW libsql. JSON совместим с обработчиком отчёта
 * expire (--report). Дата/номер версии/тег в claim — признак кандидата;
 * существующий git tag НЕ доказывает влитость конкретного PR и не является
 * основанием авто-опровержения (candidate-sign only). --scan никогда не
 * пишет; пустой scan — успешный пустой результат; ошибка git — явная ошибка,
 * а не «кандидатов нет».
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import { scanExpiryCandidates, renderScanText } from "../scan-expiry.js";
import { link } from "../tools.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-scan-expiry-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function insert(id: string, kind: string, summary: string, validUntil?: string | null): void {
  db.insertNode({ id, name: id, kind, summary, valid_until: validUntil ?? undefined });
}

/** Логический слепок всех данных — то, что скан не имеет права менять. */
function dump(dbPath: string): string {
  const raw = new Database(dbPath);
  try {
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'nodes_fts%'").all() as Array<{ name: string }>
    ).map((t) => t.name).sort();
    const out: Record<string, unknown[]> = {};
    for (const t of tables) out[t] = raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    return JSON.stringify(out);
  } finally {
    raw.close();
  }
}

describe("scanExpiryCandidates — обнаружение кандидатов", () => {
  it("находит журнальные узлы по маркерам; не-журналы без маркеров не попадают", () => {
    insert("pr-19-state", "decision", "PR #19 не открыт, патч ждёт ревью после рефакторинга");
    insert("release-2111", "feature", "Релиз 2.1.11 влит в main 2026-11-01, тег стоит на merge-коммите");
    insert("migration-status", "module", "Миграция базы не начата, план согласован 2026-10-30");
    insert("behavior", "pattern", "Импорт резолвит пути через tsconfig paths и кэширует результат по mtime");
    insert("convention", "feature", "Имена тестов повторяют имя модуля, чтобы поиск находил пару");

    const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    const ids = report.candidates.map((c) => c.id);
    expect(ids).toContain("pr-19-state");
    expect(ids).toContain("release-2111");
    expect(ids).toContain("migration-status");
    expect(ids).not.toContain("behavior");
    expect(ids).not.toContain("convention");
  });

  it("R11: опоры кандидата — ИСХОДЯЩИЕ живые informed_by с живыми целями", () => {
    insert("release-2111", "feature", "Релиз 2.1.11 влит в main 2026-11-01");
    insert("follower", "decision", "Решение о выпуске 2.1.11 опирается на состояние публикации");
    link(db, { from: "follower", to: "release-2111", relation: "informed_by", description: "релиз подтверждает решение" });

    const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    const release = report.candidates.find((c) => c.id === "release-2111")!;
    const follower = report.candidates.find((c) => c.id === "follower")!;
    // релиз — цель опоры: У НЕГО исходящих опор нет (старый скрипт насчитал 1)
    expect(release.outgoing_live_supports).toBe(0);
    // follower опирается на релиз — у НЕГО исходящая живая опора
    expect(follower.outgoing_live_supports).toBe(1);
  });

  it("удалённая цель не считается живой опорой; tombstone-ребро тоже", () => {
    insert("jr-a", "journal", "PR #20 открыт");
    insert("gone", "feature", "Релиз 2.1.12 влит в main");
    link(db, { from: "jr-a", to: "gone", relation: "informed_by", description: "релиз" });
    db.softDeleteNode("gone", "удалён");
    // живая цель → счёт 1
    insert("alive", "feature", "Релиз 2.1.13 влит в main");
    insert("jr-b", "journal", "PR #21 открыт");
    link(db, { from: "jr-b", to: "alive", relation: "informed_by", description: "релиз" });
    // tombstone-ребро не считается
    insert("jr-c", "journal", "PR #22b открыт");
    link(db, { from: "jr-c", to: "alive", relation: "informed_by", description: "связь снята" });
    db.deleteEdge("jr-c", "alive", "informed_by");

    const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    expect(report.candidates.find((c) => c.id === "jr-a")!.outgoing_live_supports).toBe(0);
    expect(report.candidates.find((c) => c.id === "jr-b")!.outgoing_live_supports).toBe(1);
    expect(report.candidates.find((c) => c.id === "jr-c")!.outgoing_live_supports).toBe(0);
  });

  it("kind=journal попадает в скан; task и digest исключены (серверные/досочные виды)", () => {
    insert("jr-kind", "journal", "PR #22 открыт");
    insert("digest-node", "digest", "Сводка модуля от 2026-11-01: релиз 2.1.14 влит");
    db.insertNode({ id: "task-node", name: "task-node", kind: "task", summary: "Task: релиз 2.1.15 выкатить 2026-12-01" });

    const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    const ids = report.candidates.map((c) => c.id);
    expect(ids).toContain("jr-kind");
    expect(ids).not.toContain("digest-node");
    expect(ids).not.toContain("task-node");
  });

  it("ложноположительный state-claim остаётся кандидатом: скан ничего не решает сам", () => {
    // устойчивое знание, совпавшее с маркером даты/версии, — всё равно
    // кандидат с expire: false; решение за человеком, автоматом ничего не
    // просрочивается и не опровергается
    insert("stable-knowledge", "feature", "Формат журнала вызовов описан 2026-11-01 в src/timeline.ts, версия контракта 2.1.12");
    const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    const row = report.candidates.find((c) => c.id === "stable-knowledge");
    expect(row).toBeDefined();
    expect(row!.expire).toBe(false);
  });

  it("git tag при «не влито» — диагностический признак, не авто-опровержение: кандидат остаётся", () => {
    insert("not-merged", "feature", "Релиз 2.9.9 не влит в main, ждём ревью");
    // «репозиторий» с уже существующим тегом v2.9.9
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
    git(["init"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "x");
    git(["add", "f.txt"]);
    git(["commit", "-m", "init"]);
    git(["tag", "v2.9.9"]);

    const report = scanExpiryCandidates(db, { repoPath: repo, now: new Date("2026-11-15T00:00:00.000Z") });
    const row = report.candidates.find((c) => c.id === "not-merged");
    expect(row).toBeDefined(); // кандидат не снят тегом
    expect(row!.contradictions.join(" ")).toContain("v2.9.9");
    expect(row!.expire).toBe(false);
  });

  it("ошибка git — явная ошибка, а не пустой отчёт «кандидатов нет»", () => {
    insert("jr-x", "journal", "PR #23 открыт");
    const notARepo = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    expect(() =>
      scanExpiryCandidates(db, { repoPath: notARepo, now: new Date("2026-11-15T00:00:00.000Z") })
    ).toThrow(/git/i);
  });

  it("пустой скан — успешный пустой результат; текстовый рендер не падает", () => {
    insert("clean", "feature", "Импорт резолвит пути через tsconfig paths");
    const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    expect(report.candidates).toHaveLength(0);
    expect(report.complete).toBe(true);
    expect(renderScanText(report)).toContain("не найдено");
  });

  it("скан не пишет: логический слепок базы до и после идентичен", () => {
    insert("jr-y", "journal", "PR #24 открыт");
    insert("release-2", "feature", "Релиз 2.1.16 влит в main 2026-11-02");
    const dbPath = path.join(tmpDir, "knowledge.db");
    const before = dump(dbPath);
    scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    expect(dump(dbPath)).toBe(before);
  });

  it("скан работает на readonly-соединении (query_only), а не на обещании SELECT", async () => {
    insert("jr-z", "journal", "PR #25 открыт");
    db.close();
    const ro = new KnowledgeDB(path.join(tmpDir, "knowledge.db"), { readonly: true });
    try {
      const report = scanExpiryCandidates(ro, { now: new Date("2026-11-15T00:00:00.000Z") });
      expect(report.candidates.map((c) => c.id)).toContain("jr-z");
      // запись через readonly-соединение отклоняется самой базой
      expect(() => ro.insertNode({ id: "nope", name: "nope", kind: "feature", summary: "попытка записи" }))
        .toThrow(/readonly/i);
    } finally {
      db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
      ro.close();
    }
  });
});

describe("версионный отчёт — содержимое", () => {
  it("каждый кандидат несёт версии существенных полей: id, claim, kind, lifecycle, прежний expiry", () => {
    insert("jr-pin", "journal", "PR #27 открыт", "2026-11-10T00:00:00.000Z");
    const report = scanExpiryCandidates(db, { now: new Date("2026-11-15T00:00:00.000Z") });
    const row = report.candidates.find((c) => c.id === "jr-pin")!;
    expect(row.kind).toBe("journal");
    expect(row.claim_digest).toBeTypeOf("string");
    expect(row.claim_digest.length).toBeGreaterThan(0);
    expect(row.status).toBe("active");
    expect(row.removed_at ?? null).toBeNull();
    expect(row.valid_until).toBe("2026-11-10T00:00:00.000Z");
    // предложенная конкретная дата зафиксирована в отчёте (вчера относительно now)
    expect(report.proposed_until).toBe("2026-11-14T00:00:00.000Z");
    expect(report.format_version).toBe(2);
    expect(report.generated_at).toBeTypeOf("string");
  });
});
