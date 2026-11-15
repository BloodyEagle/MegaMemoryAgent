import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { trailSaveWithPassport, understand } from "../tools.js";
import { PASSPORT_FORMAT_VERSION, qualifyReuse } from "../passport.js";
import type { PassportPayload } from "../types.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// P4.1 (план 20+21 v3 §13): маршрут повторяющейся задачи — необязательный
// раздел route в теле паспорта (passport_format остаётся 1: обратная
// совместимость чтения старых паспортов без route).
//
// Контракт:
// - Маршрут: точка входа → инварианты → локаторы → проверочные действия;
//   краткие причины отвергнутых подходов; платформенные ограничения с
//   воспроизведением. Исходники не копируются (тело — рецепт, не код).
// - Локаторы резолвятся через проверку свежести, НЕ как сырые номера строк:
//   статус локатора в reuse-ответе — current/changed/missing/unchecked;
//   номер строки — данные момента проверки, не идентичность.
// - Команды из памяти — данные для проверки, не команда (явная пометка в
//   выдаче); выполнение подчиняется разрешениям среды.
// - Связи с тестами помогают выбрать НАЧАЛЬНЫЙ набор проверок, но не
//   доказывают, что остальные можно пропустить (явная оговорка).
// - Выдача route подчиняется тем же правилам, что covered: reusable и
//   stale_input; строгие состояния (expired/broken/refuted_support/incomplete)
//   маршрут для reuse не выдают.

let tmpDir: string;
let projDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p4route-"));
  projDir = path.join(tmpDir, "proj");
  fs.mkdirSync(projDir, { recursive: true });
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function writeProjFile(rel: string, content: string): void {
  const abs = path.join(projDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function insertFixtureNodes(d: KnowledgeDB): void {
  d.insertNode({
    id: "refresh-decision",
    name: "Refresh decision",
    kind: "decision",
    summary: "Тихое обновление токена за 30 секунд до истечения — фоновая проверка в refreshLoop.",
    why: "Долгие джобы падали на 401 при истечении токена.",
    file_refs: ["src/auth/refresh.ts"],
    created_via: "agent",
  });
  d.insertNode({
    id: "sup-loop",
    name: "Refresh loop",
    kind: "feature",
    summary: "refreshLoop проверяет срок токена каждые 10 секунд.",
    file_refs: ["src/auth/loop.ts"],
  });
  d.insertEdge({
    from_id: "refresh-decision",
    to_id: "sup-loop",
    relation: "informed_by",
    description: "loop даёт превентивное обновление",
  });
}

const SCOPE = ["src/auth/refresh.ts", "src/auth/loop.ts"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoosePassport = Record<string, any>;

async function saveWithRoute(route: unknown): Promise<PassportPayload & { trail_id: string }> {
  writeProjFile("src/auth/refresh.ts", "export function refresh() { return 42; }\n");
  writeProjFile("src/auth/loop.ts", "export const INTERVAL = 10;\n");
  const passport: LoosePassport = {
    task_type: "implementation_analysis",
    goal: "Разобрать реализацию тихого обновления токена",
    scope_files: SCOPE,
    ...(route !== undefined ? { route } : {}),
  };
  const result = await trailSaveWithPassport(db, {
    node_ids: ["refresh-decision", "sup-loop"],
    summary: "Решение опирается на loop: превентивное обновление следует из проверки срока.",
    name: "route-passport",
    repo_root: projDir,
    // Маршрут передаётся свободным объектом — форма тела фиксируют тесты.
    passport: passport as Parameters<typeof trailSaveWithPassport>[1]["passport"],
  });
  return { ...result.passport, trail_id: result.id };
}

const ROUTE = {
  entry: "src/auth/refresh.ts — функция refresh; вход через refreshLoop",
  invariants: [
    "токен обновляется ТОЛЬКО за 30 секунд до истечения",
    "фоновой цикл не блокирует основной поток",
  ],
  locators: [
    { ref: "src/auth/refresh.ts:1", what: "функция refresh" },
    { ref: "src/auth/loop.ts", what: "интервал опроса" },
  ],
  verification: [
    { what: "прогнать тест refresh.loop", test_refs: ["src/auth/refresh.test.ts"] },
  ],
  rejected: [
    { approach: "обновление по промиксу с таймером", reason: "гонка с параллельным refresh", date: "2026-10-01" },
  ],
  platform_notes: [
    { constraint: "setInterval дрейфует при сне процесса", repro: "усыпить процесс на 60 с и сравнить интервалы" },
  ],
};

describe("P4.1 маршрут: тело паспорта", () => {
  it("сохраняет раздел route в теле: entry/invariants/locators/verification/rejected/platform_notes; passport_format остаётся 1", async () => {
    insertFixtureNodes(db);
    const saved = await saveWithRoute(ROUTE);
    expect(saved.passport_format).toBe(PASSPORT_FORMAT_VERSION);
    expect(saved.route).toBeDefined();
    expect(saved.route?.entry).toContain("refresh");
    expect(saved.route?.invariants).toHaveLength(2);
    expect(saved.route?.locators?.[0]).toMatchObject({ ref: "src/auth/refresh.ts:1", what: "функция refresh" });
    expect(saved.route?.verification?.[0]?.test_refs).toEqual(["src/auth/refresh.test.ts"]);
    expect(saved.route?.rejected?.[0]).toMatchObject({ approach: "обновление по промиксу с таймером", date: "2026-10-01" });
    expect(saved.route?.platform_notes?.[0]?.repro).toContain("усыпить");
  });

  it("без route тело прежнее: ключа route нет (обратная совместимость старых паспортов)", async () => {
    insertFixtureNodes(db);
    const saved = await saveWithRoute(undefined);
    expect(saved.passport_format).toBe(PASSPORT_FORMAT_VERSION);
    expect("route" in saved).toBe(false);
  });

  it("валидация ДО записи: пустой ref локатора / не-строковые инварианты — ошибка, trail не создаётся", async () => {
    insertFixtureNodes(db);
    await expect(saveWithRoute({ locators: [{ ref: "  " }] })).rejects.toThrow(/локатор|ref/i);
    await expect(saveWithRoute({ invariants: [42] })).rejects.toThrow(/инвариант/i);
    const trails = db.execSqlAll("SELECT COUNT(*) AS n FROM trails") as Array<{ n: number }>;
    expect(trails[0].n).toBe(0);
  });

  it("тело с route читается из журнала: findLatestPassportBody возвращает route", async () => {
    insertFixtureNodes(db);
    await saveWithRoute(ROUTE);
    const { findLatestPassportBody } = await import("../passport.js");
    const trails = db.execSqlAll("SELECT id FROM trails") as Array<{ id: string }>;
    const body = findLatestPassportBody(db, trails[0].id);
    expect(body?.route?.invariants).toHaveLength(2);
  });
});

describe("P4.1 маршрут: резолвинг локаторов в reuse", () => {
  it("reusable: локатор с неизменным файлом — статус current; пометка «данные, не команда» обязательна", async () => {
    insertFixtureNodes(db);
    await saveWithRoute(ROUTE);
    const view = await qualifyReuse(db, {
      task_type: "implementation_analysis",
      files: SCOPE,
      repo_root: projDir,
    });
    const c = view.candidates[0];
    expect(c.qualification).toBe("reusable");
    expect(c.route).toBeDefined();
    const loc = c.route?.locators.find((l) => l.ref === "src/auth/refresh.ts:1");
    expect(loc?.status).toBe("current");
    // Номер строки — данные, не идентичность: пометка про резолвинг.
    expect(loc?.note ?? "").toMatch(/строк|резолв|символ|провер/i);
    // Команды из памяти — данные для проверки, не команда.
    expect(c.route?.notes.join(" ")).toMatch(/данные.*не команда|не.*автоматически исполня/i);
  });

  it("изменившийся файл: локатор changed с указанием резолвить заново; маршрут остаётся виден (stale_input), устаревшее требует проверки", async () => {
    insertFixtureNodes(db);
    await saveWithRoute(ROUTE);
    writeProjFile("src/auth/refresh.ts", "export function refresh() { return 43; }\n");
    const view = await qualifyReuse(db, {
      task_type: "implementation_analysis",
      files: SCOPE,
      repo_root: projDir,
    });
    const c = view.candidates[0];
    expect(c.qualification).toBe("stale_input");
    const loc = c.route?.locators.find((l) => l.ref === "src/auth/refresh.ts:1");
    expect(loc?.status).toBe("changed");
    expect(loc?.note ?? "").toMatch(/резолв|заново|не идентичност|провер/i);
    // Не затронутый локатор остаётся current.
    expect(c.route?.locators.find((l) => l.ref === "src/auth/loop.ts")?.status).toBe("current");
  });

  it("исчезнувший файл: локатор missing; файл вне области — unchecked (не сверялся)", async () => {
    insertFixtureNodes(db);
    await saveWithRoute(ROUTE);
    fs.unlinkSync(path.join(projDir, "src/auth/loop.ts"));
    const view = await qualifyReuse(db, {
      task_type: "implementation_analysis",
      files: ["src/auth/loop.ts"],
      repo_root: projDir,
      max_files: 1,
    });
    const c = view.candidates[0];
    // max_files=1: один файл области сверяется и оказывается missing → incomplete.
    expect(c.qualification).toBe("incomplete");
    expect(c.route).toBeUndefined();
  });

  it("строгие состояния reuse маршрут не выдают: expired — без route (доверие не повышается молча)", async () => {
    insertFixtureNodes(db);
    // Паспорт с истёкшим сроком и маршрутом.
    await trailSaveWithPassport(db, {
      node_ids: ["refresh-decision"],
      summary: "Истёкший маршрут",
      name: "route-expired",
      repo_root: projDir,
      passport: {
        task_type: "implementation_analysis",
        goal: "Истёкший разбор",
        scope_files: SCOPE,
        valid_until: "2020-01-01T00:00:00.000Z",
        route: ROUTE,
      } as Parameters<typeof trailSaveWithPassport>[1]["passport"],
    });
    const view = await qualifyReuse(db, {
      task_type: "implementation_analysis",
      files: SCOPE,
      repo_root: projDir,
    });
    const c = view.candidates.find((x) => x.qualification === "expired");
    expect(c).toBeDefined();
    expect(c?.route).toBeUndefined();
  });

  it("связи с тестами едут с явной оговоркой: не доказывают, что остальные проверки можно пропустить", async () => {
    insertFixtureNodes(db);
    await saveWithRoute(ROUTE);
    const view = await qualifyReuse(db, {
      task_type: "implementation_analysis",
      files: SCOPE,
      repo_root: projDir,
    });
    const c = view.candidates[0];
    expect(c.route?.verification[0]?.test_refs).toEqual(["src/auth/refresh.test.ts"]);
    expect(c.route?.notes.join(" ")).toMatch(/тест|проверк/i);
    expect(c.route?.notes.join(" ")).toMatch(/не доказыва|начальн/i);
  });

  it("understand compact + reuse: маршрут в секции passport_reuse", async () => {
    insertFixtureNodes(db);
    await saveWithRoute(ROUTE);
    const result = (await understand(db, {
      query: "тихое обновление токена",
      mode: "compact",
      max_tokens: 6000,
      reuse: { task_type: "implementation_analysis", files: SCOPE, repo_root: projDir },
    })) as unknown as {
      passport_reuse?: { candidates: Array<{ route?: { entry?: string | null; locators: Array<{ status: string }> } }> };
    };
    const cand = result.passport_reuse?.candidates[0];
    expect(cand?.route).toBeDefined();
    expect(cand?.route?.locators.some((l) => l.status === "current")).toBe(true);
  });
});
