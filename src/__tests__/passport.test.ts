import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import {
  trailSave,
  trailGet,
  trailSaveWithPassport,
  understand,
} from "../tools.js";
import {
  PASSPORT_FORMAT_VERSION,
  PASSPORT_SCOPE_MAX_FILES,
  qualifyReuse,
} from "../passport.js";
import type { PassportPayload } from "../types.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// P1 (план 20+21 v3 §10): паспорт проверенного разбора.
//
// Контракт:
// - Паспорт — версионное расширение trail: долговечное ядро (члены цепочки с
//   отпечатками смысла и WHY-резюме) живёт в таблицах trails/trail_members;
//   версионное тело (тип задачи, область, проверки, полнота, срок) — JSON в
//   существующем событии timeline (params вызова trail_save), легальная
//   структура без DDL. Тело подвержено ретеншну журнала: после вытеснения
//   квалификация честно деградирует до unknown, reuse запрещён.
// - Квалификация переиспользования — таблица состояний §10.P1.2: каждое
//   состояние — явный статус в ответе, НИ ОДИН случай не повышает доверие
//   молча. Семантическая похожесть не доказывает одинаковую область: кандидат
//   находится по ЯВНОМУ типу задачи и проверяемому scope.
// - Проверка применимости — только чтение: не пишет снимки (confirm_supports
//   не вызывается), не меняет граф, не вызывает check_artifacts.
// - unchanged/reusable НЕ означает покрытие кода: ответ несёт обязательную
//   оговорку, что перед правкой агент читает текущий участок.
// - Legacy next.skip остаётся пустым; reuse-ответ — отдельная секция
//   passport_reuse opt-in вызова understand.

let tmpDir: string;
let projDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-passport-"));
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

function sha256Of(rel: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(projDir, rel))).digest("hex");
}

const TASK = "implementation_analysis";

/** Фикстура: решение с опорой и файловая область проекта. */
function insertFixtureNodes(db: KnowledgeDB): void {
  db.insertNode({
    id: "refresh-decision",
    name: "Refresh decision",
    kind: "decision",
    summary: "Тихое обновление токена за 30 секунд до истечения — фоновая проверка в refreshLoop.",
    why: "Долгие джобы падали на 401 при истечении токена.",
    file_refs: ["src/auth/refresh.ts"],
    created_via: "agent",
  });
  db.insertNode({
    id: "sup-loop",
    name: "Refresh loop",
    kind: "feature",
    summary: "refreshLoop проверяет срок токена каждые 10 секунд.",
    file_refs: ["src/auth/loop.ts"],
  });
  db.insertEdge({
    from_id: "refresh-decision",
    to_id: "sup-loop",
    relation: "informed_by",
    description: "loop даёт превентивное обновление",
  });
}

interface SaveOpts {
  files?: Array<{ rel: string; content: string }>;
  nodeIds?: string[];
  summary?: string;
  validUntil?: string | null;
  completenessDegree?: "full" | "partial";
  gaps?: string[];
  limitations?: string[];
  omitted?: Array<{ what: string; reason: string }>;
  performed?: Array<{ what: string; result_ref?: string }>;
  repoRoot?: string;
}

async function savePassport(opts: SaveOpts = {}): Promise<PassportPayload & { trail_id: string }> {
  for (const f of opts.files ?? [
    { rel: "src/auth/refresh.ts", content: "export function refresh() { return 42; }\n" },
    { rel: "src/auth/loop.ts", content: "export const INTERVAL = 10;\n" },
  ]) {
    writeProjFile(f.rel, f.content);
  }
  const nodeIds = opts.nodeIds ?? ["refresh-decision", "sup-loop"];
  const result = await trailSaveWithPassport(db, {
    node_ids: nodeIds,
    summary: opts.summary ?? "Решение опирается на loop: превентивное обновление следует из проверки срока.",
    name: "passport-refresh",
    repo_root: opts.repoRoot ?? projDir,
    passport: {
      task_type: TASK,
      goal: "Разобрать реализацию тихого обновления токена",
      scope_files: (opts.files ?? [
        { rel: "src/auth/refresh.ts", content: "" },
        { rel: "src/auth/loop.ts", content: "" },
      ]).map((f) => f.rel),
      checks_performed: opts.performed ?? [{ what: "чтение src/auth/refresh.ts целиком", result_ref: "refresh-decision" }],
      checks_omitted: opts.omitted ?? [],
      completeness_degree: opts.completenessDegree ?? "full",
      completeness_gaps: opts.gaps ?? [],
      completeness_limitations: opts.limitations ?? [],
      valid_until: opts.validUntil ?? undefined,
    },
  });
  return { ...result.passport, trail_id: result.id };
}

// ---- P1.1: состав и запись версионной записи ----

describe("P1.1 паспорт: сохранение и хранение", () => {
  it("сохраняет версионное тело: формат 1, тип задачи, область с хешами файлов, идентичность repo, выводы, проверки, время", async () => {
    insertFixtureNodes(db);
    const body = await savePassport();
    expect(body.passport_format).toBe(PASSPORT_FORMAT_VERSION);
    expect(PASSPORT_FORMAT_VERSION).toBe(1);
    expect(body.task_type).toBe(TASK);
    expect(body.goal).toContain("тихого обновления");
    // Область — целые файлы с хешами на момент проверки (консервативная актуальность).
    const refresh = body.scope.files.find((f) => f.ref === "src/auth/refresh.ts");
    expect(refresh?.sha256).toBe(sha256Of("src/auth/refresh.ts"));
    expect(refresh?.size_bytes).toBe(fs.statSync(path.join(projDir, "src/auth/refresh.ts")).size);
    expect(refresh?.missing).toBeUndefined();
    // Идентичность repo/worktree: корень записан.
    expect(body.repo.root).toBe(projDir);
    // Выводы — члены цепочки с их файлами.
    expect(body.conclusions.map((c) => c.node_id).sort()).toEqual(["refresh-decision", "sup-loop"]);
    const decision = body.conclusions.find((c) => c.node_id === "refresh-decision");
    expect(decision?.file_refs).toEqual(["src/auth/refresh.ts"]);
    // Проверки: выполненные с ссылками на результат.
    expect(body.checks.performed).toEqual([{ what: "чтение src/auth/refresh.ts целиком", result_ref: "refresh-decision" }]);
    expect(body.checks.omitted).toEqual([]);
    expect(body.completeness.degree).toBe("full");
    expect(body.checked_at).toBeTruthy();
  });

  it("долговечное ядро — trail: члены с отпечатками смысла и WHY-резюме переживают вызов (существующий механизм)", async () => {
    insertFixtureNodes(db);
    const body = await savePassport();
    const view = trailGet(db, body.trail_id);
    expect(view.state).toBe("fresh");
    expect(view.summary).toContain("превентивное обновление");
    expect(view.members.map((m) => m.node_id).sort()).toEqual(["refresh-decision", "sup-loop"]);
    expect(view.members.every((m) => m.fingerprint_at_save)).toBe(true);
  });

  it("тело паспорта пишется в существующее событие timeline (params trail_save) — легальная структура без DDL", async () => {
    insertFixtureNodes(db);
    const body = await savePassport();
    const rows = db.execSqlAll(
      `SELECT params FROM timeline WHERE tool = 'trail_save' AND params LIKE '%"passport_format"%'`
    ) as Array<{ params: string }>;
    expect(rows.length).toBe(1);
    const logged = JSON.parse(rows[0].params) as { trail_id: string; passport: PassportPayload };
    expect(logged.trail_id).toBe(body.trail_id);
    expect(logged.passport.task_type).toBe(TASK);
  });

  it("валидирует вход ДО записи: без task_type / цели / области паспорт не сохраняется и trail не создаётся", async () => {
    insertFixtureNodes(db);
    writeProjFile("src/auth/refresh.ts", "x\n");
    await expect(
      trailSaveWithPassport(db, {
        node_ids: ["refresh-decision"],
        summary: "s",
        passport: { task_type: "", goal: "g", scope_files: ["src/auth/refresh.ts"] },
      })
    ).rejects.toThrow(/task_type/);
    await expect(
      trailSaveWithPassport(db, {
        node_ids: ["refresh-decision"],
        summary: "s",
        passport: { task_type: TASK, goal: "", scope_files: ["src/auth/refresh.ts"] },
      })
    ).rejects.toThrow(/goal/);
    await expect(
      trailSaveWithPassport(db, {
        node_ids: ["refresh-decision"],
        summary: "s",
        passport: { task_type: TASK, goal: "g", scope_files: [] },
      })
    ).rejects.toThrow(/scope_files/);
    // Ничего не записано — ни trail, ни события журнала.
    const trails = db.execSqlAll("SELECT COUNT(*) AS n FROM trails") as Array<{ n: number }>;
    expect(trails[0].n).toBe(0);
  });

  it("trail_get без include_passport сохраняет прежнюю форму; с флагом возвращает тело", async () => {
    insertFixtureNodes(db);
    const body = await savePassport();
    const plain = trailGet(db, body.trail_id);
    expect(plain).not.toHaveProperty("passport");
    const withBody = trailGet(db, body.trail_id, { include_passport: true });
    expect(withBody.passport?.task_type).toBe(TASK);
  });

  it("trail_save без паспорта — прежний контракт: в ответе нет паспорта", () => {
    insertFixtureNodes(db);
    const saved = trailSave(db, { node_ids: ["refresh-decision"], summary: "обычная цепочка" });
    expect(saved).not.toHaveProperty("passport");
  });

  it("предел области: больше PASSPORT_SCOPE_MAX_FILES файлов — честный truncated, лишние не теряются молча", async () => {
    insertFixtureNodes(db);
    const many = Array.from({ length: PASSPORT_SCOPE_MAX_FILES + 5 }, (_, i) => `f${i}.ts`);
    for (const rel of many) writeProjFile(rel, "x\n");
    const body = await savePassport({ files: many.map((rel) => ({ rel, content: "x\n" })) });
    expect(body.scope.files.length).toBe(PASSPORT_SCOPE_MAX_FILES);
    expect(body.scope.truncated).toBe(true);
  });
});

// ---- P1.2/P1.4: квалификация переиспользования — таблица состояний ----

describe("P1.2 квалификация reuse: состояния таблицы", () => {
  it("повтор той же задачи: совпали тип/область/входы + сохранённое доказательство → reusable с covered и оговоркой о чтении кода", async () => {
    insertFixtureNodes(db);
    await savePassport();
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/loop.ts"], repo_root: projDir });
    expect(view.candidates.length).toBe(1);
    const c = view.candidates[0];
    expect(c.qualification).toBe("reusable");
    expect(c.trail_state).toBe("fresh");
    expect(c.covered.map((x) => x.node_id).sort()).toEqual(["refresh-decision", "sup-loop"]);
    expect(c.gaps).toEqual([]);
    // Ни один случай не повышает доверие молча: оговорка обязательна.
    expect(view.note).toMatch(/не.*покрыти|читай текущий участок|не заменяет чтение/i);
    expect(c.notes.join(" ")).toMatch(/читай текущий участок|не.*покрыти/i);
  });

  it("другой тип задачи: найденный разбор — не тот вопрос; кандидатов нет, ответ явный (пропуск анализа не разрешён молча)", async () => {
    insertFixtureNodes(db);
    await savePassport();
    const view = await qualifyReuse(db, { task_type: "performance_investigation", files: ["src/auth/refresh.ts"], repo_root: projDir });
    expect(view.candidates).toEqual([]);
    expect(view.found).toBe(0);
    expect(view.note).toMatch(/паспорт|reuse|анализ/i);
  });

  it("новый файл в области: запрошенный файл вне scope → gap new_file_in_scope, квалификация candidate", async () => {
    insertFixtureNodes(db);
    await savePassport();
    writeProjFile("src/auth/extra.ts", "export const X = 1;\n");
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/extra.ts"], repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("candidate");
    expect(c.gaps.some((g) => g.kind === "new_file_in_scope" && g.detail.includes("src/auth/extra.ts"))).toBe(true);
  });

  it("изменённая конфигурация/файл: хеш разошёлся → stale_input; затронутый вывод не в covered, вывод не объявляется ложным", async () => {
    insertFixtureNodes(db);
    await savePassport();
    writeProjFile("src/auth/refresh.ts", "export function refresh() { return 43; }\n");
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/loop.ts"], repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("stale_input");
    expect(c.gaps.some((g) => g.kind === "file_changed" && g.detail.includes("src/auth/refresh.ts"))).toBe(true);
    // Затронутый вывод исключён из covered; независимый (loop.ts) остаётся.
    expect(c.covered.map((x) => x.node_id)).toEqual(["sup-loop"]);
    expect(c.notes.join(" ")).toMatch(/перепровер|не объявляется (автоматически )?ложным|stale/i);
  });

  it("источник недоступен: файл исчез → incomplete, reuse запрещён (пропуск анализа не разрешён)", async () => {
    insertFixtureNodes(db);
    await savePassport();
    fs.unlinkSync(path.join(projDir, "src/auth/loop.ts"));
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/loop.ts"], repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("incomplete");
    expect(c.gaps.some((g) => g.kind === "file_missing")).toBe(true);
    expect(c.covered).toEqual([]);
  });

  it("неполное первоначальное обследование: completeness=partial и пропущенные проверки едут в gaps → incomplete", async () => {
    insertFixtureNodes(db);
    await savePassport({
      completenessDegree: "partial",
      gaps: ["тесты не запускались"],
      limitations: ["обследован только модуль auth"],
      omitted: [{ what: "npm test", reason: "вне бюджета обследования" }],
    });
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/loop.ts"], repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("incomplete");
    expect(c.gaps.some((g) => g.kind === "completeness" && g.detail.includes("неполное"))).toBe(true);
    expect(c.gaps.some((g) => g.kind === "omitted_check" && g.detail.includes("npm test"))).toBe(true);
    expect(c.gaps.some((g) => g.kind === "limitation" && g.detail.includes("модуль auth"))).toBe(true);
  });

  it("отсутствующий результат проверки: тело паспорта вытеснено ретеншном журнала → unknown по trail_only, reuse запрещён", async () => {
    insertFixtureNodes(db);
    const body = await savePassport();
    // Вытеснение: журнал обрезается до 1 записи, последняя — посторонняя
    // (прямая вставка события, как это делает любой последующий вызов).
    db.insertTimelineEntry({
      tool: "understand",
      params: JSON.stringify({ query: "посторонний вызов вытесняет тело паспорта" }),
      result_summary: "0 matches",
      is_write: false,
      is_error: false,
      affected_ids: [],
    });
    const prev = process.env.MEGAMEMORY_TIMELINE_MAX_ENTRIES;
    process.env.MEGAMEMORY_TIMELINE_MAX_ENTRIES = "1";
    try {
      db.pruneTimeline();
    } finally {
      if (prev === undefined) delete process.env.MEGAMEMORY_TIMELINE_MAX_ENTRIES;
      else process.env.MEGAMEMORY_TIMELINE_MAX_ENTRIES = prev;
    }
    const rows = db.execSqlAll(
      `SELECT COUNT(*) AS n FROM timeline WHERE tool = 'trail_save' AND params LIKE '%"passport_format"%'`
    ) as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
    const view = await qualifyReuse(db, { task_type: TASK, trail_id: body.trail_id, repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("unknown");
    expect(c.body_source).toBe("trail_only");
    expect(c.covered).toEqual([]);
    expect(c.gaps.some((g) => g.detail.includes("ретеншн") || g.detail.toLowerCase().includes("журнал"))).toBe(true);
  });

  it("опора опровергнута при неизменных байтах файлов → refuted_support: вывод требует пересмотра, история сохраняется", async () => {
    insertFixtureNodes(db);
    const body = await savePassport();
    // Байты не менялись — ошибочный вывод опровергнут явным действием.
    db.setEpistemicStatus("sup-loop", "refuted", "контрпример: интервал не 10 секунд", null);
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/loop.ts"], repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("refuted_support");
    expect(c.gaps.some((g) => g.kind === "member_refuted" && g.node_ids?.includes("sup-loop"))).toBe(true);
    expect(c.covered).toEqual([]);
    // История сохраняется: снимок отпечатка на момент проверки виден.
    expect(trailGet(db, body.trail_id).members.find((m) => m.node_id === "sup-loop")?.state).toBe("stale");
  });

  it("участник изменил смысл (трейл stale) → stale_input с адресной причиной", async () => {
    insertFixtureNodes(db);
    await savePassport();
    db.updateNode("sup-loop", { summary: "refreshLoop переписан: проверка каждые 60 секунд" });
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/loop.ts"], repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("stale_input");
    expect(c.trail_state).toBe("stale");
    expect(c.gaps.some((g) => g.kind === "member_stale" && g.node_ids?.includes("sup-loop"))).toBe(true);
  });

  it("опора потеряна (hard-deleted) → broken, только перестройка", async () => {
    insertFixtureNodes(db);
    await savePassport();
    db.hardDeleteNode("sup-loop");
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/loop.ts"], repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("broken");
    expect(c.gaps.some((g) => g.kind === "member_broken")).toBe(true);
    expect(c.covered).toEqual([]);
  });

  it("неверный repo/worktree: другой корень → wrong_repo, никакого reuse", async () => {
    insertFixtureNodes(db);
    await savePassport();
    const other = path.join(tmpDir, "other-proj");
    fs.mkdirSync(other, { recursive: true });
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts"], repo_root: other });
    const c = view.candidates[0];
    expect(c.qualification).toBe("wrong_repo");
    expect(c.covered).toEqual([]);
  });

  it("истечение срока паспорта → expired: не использовать без новой проверки", async () => {
    insertFixtureNodes(db);
    await savePassport({ validUntil: new Date(Date.now() - 1000).toISOString() });
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts"], repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("expired");
    expect(c.covered).toEqual([]);
  });

  it("ограничение вычислительного бюджета: max_files меньше области → incomplete с честной причиной", async () => {
    insertFixtureNodes(db);
    await savePassport();
    const view = await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts"], repo_root: projDir, max_files: 1 });
    const c = view.candidates[0];
    expect(c.qualification).toBe("incomplete");
    expect(c.gaps.some((g) => g.detail.includes("лимит"))).toBe(true);
  });

  it("без области (только тип задачи) — только ориентация: candidate, covered пуст", async () => {
    insertFixtureNodes(db);
    await savePassport();
    const view = await qualifyReuse(db, { task_type: TASK, repo_root: projDir });
    const c = view.candidates[0];
    expect(c.qualification).toBe("candidate");
    expect(c.covered).toEqual([]);
  });

  it("паспортов нет: пустой список кандидатов явный, не молчаливый", async () => {
    const view = await qualifyReuse(db, { task_type: TASK, repo_root: projDir });
    expect(view.candidates).toEqual([]);
    expect(view.found).toBe(0);
    expect(view.note).toBeTruthy();
  });
});

// ---- P1.3: reuse-договор understand (covered/gaps/qualification) ----

describe("P1.3 opt-in reuse в understand", () => {
  it("compact + reuse: ответ несёт секцию passport_reuse с covered/gaps/qualification", async () => {
    insertFixtureNodes(db);
    await savePassport();
    const result = (await understand(db, {
      query: "тихое обновление токена",
      mode: "compact",
      max_tokens: 4000,
      reuse: { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/loop.ts"], repo_root: projDir },
    })) as unknown as { passport_reuse?: { candidates: Array<{ qualification: string }> } };
    expect(result.passport_reuse).toBeDefined();
    expect(result.passport_reuse?.candidates[0]?.qualification).toBe("reusable");
  });

  it("без reuse прежний ответ: секции passport_reuse нет", async () => {
    insertFixtureNodes(db);
    await savePassport();
    const result = (await understand(db, {
      query: "тихое обновление токена",
      mode: "compact",
      max_tokens: 4000,
    })) as unknown as { passport_reuse?: unknown };
    expect(result.passport_reuse).toBeUndefined();
  });

  it("reuse поддержан только в compact: full/brief — явная ошибка", async () => {
    insertFixtureNodes(db);
    await savePassport();
    await expect(
      understand(db, { query: "q", mode: "full", reuse: { task_type: TASK } })
    ).rejects.toThrow(/reuse.*compact|compact.*reuse/i);
    await expect(
      understand(db, { query: "q", mode: "brief", reuse: { task_type: TASK } })
    ).rejects.toThrow(/reuse.*compact|compact.*reuse/i);
  });

  it("reuse участвует в бюджете: tokens_estimated считается по фактической wire-форме с секцией", async () => {
    const { measureMcpPayload } = await import("../tools.js");
    insertFixtureNodes(db);
    await savePassport();
    const input = {
      query: "тихое обновление токена",
      mode: "compact" as const,
      max_tokens: 6000,
      reuse: { task_type: TASK, files: ["src/auth/refresh.ts", "src/auth/loop.ts"], repo_root: projDir },
    };
    const result = (await understand(db, input)) as unknown as Record<string, unknown> & {
      meta: { tokens_estimated: number };
    };
    const wire = JSON.stringify(result, null, 2);
    expect(result.meta.tokens_estimated).toBe(measureMcpPayload(result));
    expect(wire).toContain("passport_reuse");
  });

  it("квалификация не пишет ничего: снимки и наблюдения артефактов не создаются (без confirm_supports)", async () => {
    insertFixtureNodes(db);
    await savePassport();
    const baselinesBefore = (db.execSqlAll("SELECT COUNT(*) AS n FROM support_baselines") as Array<{ n: number }>)[0].n;
    const artifactsBefore = (db.execSqlAll("SELECT COUNT(*) AS n FROM node_artifacts") as Array<{ n: number }>)[0].n;
    await qualifyReuse(db, { task_type: TASK, files: ["src/auth/refresh.ts"], repo_root: projDir });
    const baselinesAfter = (db.execSqlAll("SELECT COUNT(*) AS n FROM support_baselines") as Array<{ n: number }>)[0].n;
    const artifactsAfter = (db.execSqlAll("SELECT COUNT(*) AS n FROM node_artifacts") as Array<{ n: number }>)[0].n;
    expect(baselinesAfter).toBe(baselinesBefore);
    expect(artifactsAfter).toBe(artifactsBefore);
  });
});
