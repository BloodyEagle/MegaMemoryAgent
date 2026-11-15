/**
 * P1 (план 20+21 v3 §10): паспорт проверенного разбора.
 *
 * Ключевые решения:
 * - Паспорт — версионное расширение trail, БЕЗ миграции схемы (schema 14 не
 *   трогается). Долговечное ядро — существующий механизм trail: члены цепочки
 *   с отпечатками смысла (trails/trail_members, переживают что угодно) и
 *   WHY-резюме в summary. Версионное ТЕЛО (тип задачи, область с хешами
 *   файлов, идентичность repo, источники, выполненные/невыполненные проверки,
 *   полнота, ограничения, срок) — JSON в params СУЩЕСТВУЮЩЕГО события
 *   timeline вызова trail_save: легальная структура без DDL (ретеншн журнала
 *   по умолчанию 90 дней; после вытеснения тела квалификация честно
 *   деградирует до unknown — reuse запрещён). Durable-расширение хранения —
 *   отдельный дизайн-документ для review-gate владельца (plans/new7/
 *   p1-migration-design.md), НЕ реализация.
 * - Квалификация переиспользования — таблица состояний §10.P1.2. Каждое
 *   состояние — явный статус ответа; НИ ОДИН случай не повышает доверие
 *   молча. Семантическая похожесть не доказывает одинаковую область: кандидат
 *   находится по ЯВНОМУ типу задачи и проверяемому scope (не по embedding).
 * - Консервативная актуальность первого пилота: ЦЕЛЫЕ файлы (sha256 всего
 *   файла на момент проверки и на момент запроса), зависимые опоры —
 *   отпечатки смысла членов цепочки (формулировка + epistemic статус + рёбра
 *   informed_by с рационалами) и существующий механизм trail fresh/stale/
 *   broken. Никаких обещаний «весь файл покрыт».
 * - Проверка применимости — ТОЛЬКО чтение: не пишет снимки (confirm_supports
 *   не вызывается), не трогает граф и наблюдения артефактов.
 * - Оценки состояния цепочек (trailMemberStates/trailState) переехали сюда из
 *   tools.ts БЕЗ изменения поведения: их использует и trail-домен, и
 *   квалификация паспортов (один механизм доверия, не параллельный).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { KnowledgeDB } from "./db.js";
import { isNodeExpired } from "./db.js";
import { parseRef } from "./refs.js";
import { hashFile } from "./artifacts.js";
import type {
  PassportPayload,
  PassportInput,
  PassportScopeFile,
  PassportReuseCandidate,
  PassportReuseGap,
  PassportReuseRequest,
  PassportReuseView,
  TrailMemberView,
  TrailView,
} from "./types.js";

/** Версия формата тела паспорта; изменение состава полей меняет это число. */
export const PASSPORT_FORMAT_VERSION = 1;

/**
 * Консервативный предел области: хешируется не более этого числа файлов
 * (и при сохранении, и при проверке). Превышение — честный truncated/
 * incomplete, не молчаливая порезка.
 */
export const PASSPORT_SCOPE_MAX_FILES = 50;

/** Маркер тела паспорта в params события timeline. */
const BODY_MARKER = '"passport_format"';

/** Максимум событий журнала, просматриваемых при поиске паспортов. */
const PASSPORT_SCAN_LIMIT = 200;

// ---- Оценки состояния цепочек (переехали из tools.ts без изменений) ----

/**
 * Per-member state of a saved chain. A member whose MEANING (summary,
 * epistemic status, live informed_by set with rationales) changed since the
 * save is stale; a hard-deleted member breaks the chain outright; refuted,
 * abandoned, expired) is stale however well its fingerprint matches. Expiry
 * is computed on the fresh clock at read time; it is never hashed into the
 * fingerprint, so natural expiry stales the chain without any write.
 */
export function trailMemberStates(
  db: KnowledgeDB,
  trailId: string
): TrailMemberView[] {
  return db.getTrailMembers(trailId).map((m) => {
    const node = db.getNodeIncludingRemoved(m.node_id);
    const view: TrailMemberView = {
      position: m.position,
      node_id: m.node_id,
      node_name: node?.name ?? null,
      fingerprint_at_save: m.fingerprint,
      fingerprint_now: null,
      state: "fresh",
      reason: null,
    };
    if (!node) {
      view.state = "broken";
      view.reason = `member "${m.node_id}" was hard-deleted — the chain is broken, only a rebuild helps`;
      return view;
    }
    if (node.removed_at) {
      view.state = "stale";
      view.reason = `member "${m.node_id}" was removed (${node.removed_reason ?? "no reason recorded"})`;
      return view;
    }
    if (node.epistemic_status === "refuted") {
      view.state = "stale";
      view.reason = `member "${m.node_id}" опровергнут — вывод на нём строить нельзя (причина в карточке узла)`;
      return view;
    }
    if (node.epistemic_status === "abandoned") {
      view.state = "stale";
      view.reason = `member "${m.node_id}" заброшен — вывод может устареть`;
      return view;
    }
    if (isNodeExpired(node)) {
      view.state = "stale";
      view.reason = `member "${m.node_id}" просрочен (valid_until ${node.valid_until}) — утверждение могло перестать быть верным`;
      return view;
    }
    const now = db.nodeFingerprint(m.node_id);
    view.fingerprint_now = now;
    if (now !== m.fingerprint) {
      view.state = "stale";
      view.reason = `member "${m.node_id}" meaning changed since the chain was saved (summary, epistemic status or informed_by)`;
    }
    return view;
  });
}

/** Whole-chain state: broken beats stale beats fresh. */
export function trailState(db: KnowledgeDB, trailId: string): TrailView["state"] {
  const members = trailMemberStates(db, trailId);
  if (members.some((m) => m.state === "broken")) return "broken";
  if (members.some((m) => m.state === "stale")) return "stale";
  return "fresh";
}

// ---- Сборка тела паспорта (P1.1) ----

/** file_refs узла из JSON-строки; мусор и не-строки отсеиваются. */
function parseFileRefsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** `git rev-parse --verify HEAD` в корне; null — не репозиторий/нет git. */
function gitHeadAt(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString("utf8").trim();
      resolve(code === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null);
    });
  });
}

/**
 * Валидация входа и сборка тела паспорта: хеши области (целые файлы),
 * идентичность repo/worktree (корень + базовая ревизия HEAD), выводы с их
 * файлами, источники, проверки, полнота. Все ошибки — ДО любой записи.
 */
export async function buildPassportBody(
  db: KnowledgeDB,
  input: PassportInput,
  nodeIds: string[],
  repoRoot: string | undefined
): Promise<Omit<PassportPayload, "trail_id">> {
  const taskType = (input.task_type ?? "").trim();
  if (!taskType) {
    throw new Error("passport: task_type обязателен — reuse ищется по явному типу задачи, не по похожести запроса.");
  }
  const goal = (input.goal ?? "").trim();
  if (!goal) {
    throw new Error("passport: goal обязателен — паспорт несёт цель и тип задачи.");
  }
  const scopeRefs = input.scope_files ?? [];
  if (!Array.isArray(scopeRefs) || scopeRefs.length === 0) {
    throw new Error("passport: scope_files обязателен (непустой массив ссылок) — без проверяемой области reuse не квалифицируется.");
  }
  const root = repoRoot ?? process.cwd();
  const files: PassportScopeFile[] = [];
  let truncated = false;
  for (const ref of scopeRefs) {
    if (typeof ref !== "string" || ref.trim() === "") {
      throw new Error(`passport: scope_files содержит пустую/нестроковую ссылку: ${String(ref)}`);
    }
    if (files.length >= PASSPORT_SCOPE_MAX_FILES) {
      truncated = true;
      break;
    }
    const parsed = parseRef(ref);
    const abs = path.isAbsolute(parsed.path) ? parsed.path : path.resolve(root, parsed.path);
    const hashed = await hashFile(abs);
    files.push({
      ref,
      ...(hashed ? { sha256: hashed.digest, size_bytes: hashed.size } : { sha256: null, size_bytes: null, missing: true as const }),
    });
  }
  const head = await gitHeadAt(root);
  return {
    passport_format: PASSPORT_FORMAT_VERSION,
    task_type: taskType,
    goal,
    repo: { root, head_at_check: head },
    scope: { files, truncated },
    conclusions: nodeIds.map((nodeId) => ({
      node_id: nodeId,
      file_refs: parseFileRefsJson(db.getNode(nodeId)?.file_refs ?? null),
    })),
    sources: input.sources ?? [],
    checks: {
      performed: input.checks_performed ?? [],
      omitted: input.checks_omitted ?? [],
    },
    completeness: {
      degree: input.completeness_degree ?? "full",
      gaps: input.completeness_gaps ?? [],
      limitations: input.completeness_limitations ?? [],
    },
    tools: input.tools ?? {},
    checked_at: new Date().toISOString(),
    valid_until: input.valid_until ?? null,
  };
}

// ---- Чтение тела паспорта из журнала (легальная структура timeline.params) ----

interface PassportTimelineRow {
  seq: number;
  params: string;
}

function parsePassportRow(row: PassportTimelineRow): { trail_id: string; body: PassportPayload } | null {
  try {
    const parsed = JSON.parse(row.params) as { trail_id?: string; passport?: PassportPayload };
    if (parsed?.passport?.passport_format === PASSPORT_FORMAT_VERSION && typeof parsed.trail_id === "string") {
      return { trail_id: parsed.trail_id, body: parsed.passport };
    }
    return null;
  } catch {
    return null;
  }
}

/** Последнее тело паспорта для trail (или null — тело вытеснено ретеншном). */
export function findLatestPassportBody(
  db: KnowledgeDB,
  trailId: string
): PassportPayload | null {
  const rows = db.execSqlAll(
    `SELECT seq, params FROM timeline
     WHERE tool = 'trail_save' AND params LIKE ?
     ORDER BY seq DESC LIMIT ${PASSPORT_SCAN_LIMIT}`,
    `%${BODY_MARKER}%`
  ) as PassportTimelineRow[];
  for (const row of rows) {
    const parsed = parsePassportRow(row);
    if (parsed?.trail_id === trailId) return parsed.body;
  }
  return null;
}

/** Все сохранённые тела паспортов, последние сначала (для reuse-поиска). */
function findPassportBodies(db: KnowledgeDB): Array<{ trail_id: string; body: PassportPayload }> {
  const rows = db.execSqlAll(
    `SELECT seq, params FROM timeline
     WHERE tool = 'trail_save' AND params LIKE ?
     ORDER BY seq DESC LIMIT ${PASSPORT_SCAN_LIMIT}`,
    `%${BODY_MARKER}%`
  ) as PassportTimelineRow[];
  const found: Array<{ trail_id: string; body: PassportPayload }> = [];
  for (const row of rows) {
    const parsed = parsePassportRow(row);
    if (parsed) found.push(parsed);
  }
  return found;
}

// ---- Квалификация переиспользования (P1.2/P1.4) ----

const DEFAULT_MAX_CANDIDATES = 2;
const MAX_CANDIDATES_CAP = 5;

function normalizePathOf(ref: string): string {
  const parsed = parseRef(ref);
  return parsed.path.replace(/\\/g, "/");
}

/**
 * Квалификация переиспользования: найти паспорта по ЯВНОМУ типу задачи,
 * сверить область (хеши целых файлов), состояние цепочки и выводов, срок и
 * полноту. Каждое состояние — явный статус; никакого молчаливого доверия.
 * Только чтение: ни снимков, ни наблюдений, ни записей графа.
 */
export async function qualifyReuse(
  db: KnowledgeDB,
  req: PassportReuseRequest
): Promise<PassportReuseView> {
  const taskType = (req.task_type ?? "").trim();
  if (!taskType) {
    throw new Error("qualify_reuse: task_type обязателен — кандидат ищется по явному типу задачи.");
  }
  const maxCandidates = Math.max(
    1,
    Math.min(req.max_candidates ?? DEFAULT_MAX_CANDIDATES, MAX_CANDIDATES_CAP)
  );
  const maxFiles = Math.max(1, req.max_files ?? PASSPORT_SCOPE_MAX_FILES);
  const root = req.repo_root ?? process.cwd();
  const allBodies = findPassportBodies(db);
  const matching: Array<{ trail_id: string; body: PassportPayload | null }> = allBodies
    .filter((b) => b.body.task_type === taskType)
    .map((b) => ({ trail_id: b.trail_id, body: b.body as PassportPayload }));
  // Прямой запрос по trail_id: тело может быть вытеснено ретеншном журнала —
  // цепочка всё равно квалифицируется по durable-ядру (unknown, trail_only).
  // Поиск по task_type без тела невозможен (тип задачи живёт в теле) — это
  // честное ограничение trail_only-хранения, задокументировано в отчёте.
  if (req.trail_id && !matching.some((m) => m.trail_id === req.trail_id)) {
    matching.push({ trail_id: req.trail_id, body: null });
  }
  const requestedPaths = new Set((req.files ?? []).map(normalizePathOf));

  const candidates: PassportReuseCandidate[] = [];
  for (const { trail_id, body } of matching) {
    if (candidates.length >= maxCandidates) break;
    if (req.trail_id && trail_id !== req.trail_id) continue;
    const trail = db.getTrail(trail_id);
    if (!trail) continue;

    // --- Тело паспорта отсутствует (ретеншн журнала) → unknown ---
    const states = trailMemberStates(db, trail_id);
    if (!body) {
      candidates.push({
        trail_id,
        trail_name: trail.name,
        task_type: taskType,
        qualification: "unknown",
        trail_state: trailState(db, trail_id),
        covered: [],
        gaps: [
          {
            kind: "limitation",
            detail:
              "тело паспорта не найдено в журнале (ретеншн timeline) — область, проверки и полнота неизвестны; пропуск анализа не разрешён",
          },
        ],
        checked_at: null,
        valid_until: null,
        body_source: "trail_only",
        notes: [NO_COVERAGE_NOTE],
      });
      continue;
    }

    const gaps: PassportReuseGap[] = [];
    const notes: string[] = [NO_COVERAGE_NOTE];

    // --- Идентичность repo/worktree ---
    if (normalizePathOf(body.repo.root) !== normalizePathOf(root)) {
      candidates.push({
        trail_id,
        trail_name: trail.name,
        task_type: taskType,
        qualification: "wrong_repo",
        trail_state: trailState(db, trail_id),
        covered: [],
        gaps: [
          {
            kind: "limitation",
            detail: `паспорт собран в другом repo/worktree (${body.repo.root}) — выводы на этот worktree не переносятся`,
          },
        ],
        checked_at: body.checked_at,
        valid_until: body.valid_until,
        body_source: "journal",
        notes,
      });
      continue;
    }
    if (body.repo.head_at_check) {
      const head = await gitHeadAt(root);
      if (head && head !== body.repo.head_at_check) {
        notes.push(
          "базовая ревизия HEAD изменилась после проверки — выводы с неизменными входами не объявляются ложными, но требуют внимательной перепроверки"
        );
      }
    }

    // --- Состояние цепочки и выводов (существующий механизм доверия trail) ---
    let refuted = false;
    let broken = false;
    let stale = false;
    for (const m of states) {
      if (m.state === "broken") {
        broken = true;
        gaps.push({ kind: "member_broken", node_ids: [m.node_id], detail: m.reason ?? "участник цепочки удалён" });
      } else if (m.state === "stale") {
        const node = db.getNodeIncludingRemoved(m.node_id);
        if (node?.epistemic_status === "refuted") {
          refuted = true;
          gaps.push({
            kind: "member_refuted",
            node_ids: [m.node_id],
            detail: `вывод опровергнут при неизменных байтах входов — требует пересмотра, история сохраняется: ${m.reason ?? ""}`,
          });
        } else {
          stale = true;
          gaps.push({ kind: "member_stale", node_ids: [m.node_id], detail: m.reason ?? "смысл участника изменился после проверки" });
        }
      }
    }

    // --- Срок применимости ---
    const expired = body.valid_until ? Date.parse(body.valid_until) < Date.now() : false;
    if (expired) {
      gaps.push({
        kind: "limitation",
        detail: `срок применимости паспорта истёк (${body.valid_until}) — не использовать без новой проверки`,
      });
    }

    // --- Область: хеши целых файлов на текущий момент ---
    const changedPaths = new Set<string>();
    let fileMissing = false;
    let hashed = 0;
    let scopeTruncatedNow = false;
    for (const f of body.scope.files) {
      if (hashed >= maxFiles) {
        scopeTruncatedNow = true;
        gaps.push({
          kind: "limitation",
          detail: `проверка области остановлена лимитом ${maxFiles} файлов — остаток области не сверен`,
        });
        break;
      }
      hashed += 1;
      const parsed = parseRef(f.ref);
      const abs = path.isAbsolute(parsed.path) ? parsed.path : path.resolve(root, parsed.path);
      const nowHashed = await hashFile(abs);
      if (f.missing) {
        if (nowHashed) {
          changedPaths.add(normalizePathOf(f.ref));
          gaps.push({ kind: "file_changed", detail: `"${f.ref}" появился после проверки` });
        }
        continue;
      }
      if (!nowHashed) {
        fileMissing = true;
        changedPaths.add(normalizePathOf(f.ref));
        gaps.push({
          kind: "file_missing",
          detail: `"${f.ref}" недоступен — источник проверки исчез; reuse запрещён`,
        });
        continue;
      }
      if (nowHashed.digest !== f.sha256) {
        changedPaths.add(normalizePathOf(f.ref));
        gaps.push({
          kind: "file_changed",
          detail: `"${f.ref}" изменился после проверки (sha256) — перепроверь затронутое; вывод не объявляется автоматически ложным`,
        });
      }
    }

    // --- Запрошенные файлы вне области паспорта ---
    const scopePaths = new Set(body.scope.files.map((f) => normalizePathOf(f.ref)));
    let newFilesInScope = 0;
    for (const rp of requestedPaths) {
      if (!scopePaths.has(rp)) {
        newFilesInScope += 1;
        gaps.push({
          kind: "new_file_in_scope",
          detail: `"${rp}" не входит в область паспорта — не покрыт проверенным разбором`,
        });
      }
    }

    // --- Полнота и ограничения обследования ---
    if (body.completeness.degree === "partial") {
      gaps.push({ kind: "completeness", detail: "паспорт фиксирует неполное первоначальное обследование" });
    }
    for (const g of body.completeness.gaps) gaps.push({ kind: "completeness", detail: `непроверенный участок: ${g}` });
    for (const l of body.completeness.limitations) gaps.push({ kind: "limitation", detail: `ограничение: ${l}` });
    for (const o of body.checks.omitted) {
      gaps.push({ kind: "omitted_check", detail: `невыполненная проверка: ${o.what} (${o.reason})` });
    }

    // --- covered: свежие выводы вне затронутых файлов ---
    const coveredComputed = states
      .filter((m) => m.state === "fresh")
      .filter((m) => {
        const conclusion = body.conclusions.find((c) => c.node_id === m.node_id);
        const conclusionPaths = (conclusion?.file_refs ?? []).map(normalizePathOf);
        return !conclusionPaths.some((p) => changedPaths.has(p));
      })
      .map((m) => ({
        node_id: m.node_id,
        note: "вывод доступен для переиспользования: задача/область/входы совпали, доказательство сохранено; перед правкой прочитай текущий участок кода",
      }));

    // --- Итоговая квалификация: строгие состояния побеждают ---
    let qualification: PassportReuseCandidate["qualification"];
    if (broken) qualification = "broken";
    else if (refuted) qualification = "refuted_support";
    else if (expired) qualification = "expired";
    else if (scopeTruncatedNow || fileMissing) qualification = "incomplete";
    else if (body.completeness.degree === "partial") qualification = "incomplete";
    else if (stale || changedPaths.size > 0) qualification = "stale_input";
    else if (newFilesInScope > 0) qualification = "candidate";
    else if (requestedPaths.size === 0) qualification = "candidate";
    else if (coveredComputed.length === 0) qualification = "candidate";
    else qualification = "reusable";
    // covered перечисляется только там, где reuse вывода действительно
    // допустим (P1.2): reusable и stale_input (затронутое перепроверяется,
    // незатронутые выводы остаются usable). incomplete/candidate/строгие
    // состояния covered не выдают — доверие не повышается молча.
    const covered =
      qualification === "reusable" || qualification === "stale_input" ? coveredComputed : [];
    if (qualification === "stale_input") {
      notes.push("изменился существенный вход — перепроверь затронутое; вывод не объявляется автоматически ложным");
    }

    candidates.push({
      trail_id,
      trail_name: trail.name,
      task_type: taskType,
      qualification,
      trail_state: trailState(db, trail_id),
      covered,
      gaps,
      checked_at: body.checked_at,
      valid_until: body.valid_until,
      body_source: "journal",
      notes,
    });
  }

  return {
    candidates,
    found: matching.length,
    note: NO_COVERAGE_NOTE,
  };
}

/** Обязательная оговорка reuse: паспорт не является покрытием кода. */
export const NO_COVERAGE_NOTE =
  "reuse паспорта не является покрытием кода: перед правкой прочитай текущий участок исходника; next.skip остаётся пустым";
