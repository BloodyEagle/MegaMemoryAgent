/**
 * P2.1 (план 20+21 v3 §11): файловая ступень инкрементальной актуальности.
 *
 * Ключевые решения:
 * - Восстановимый ОБРАТНЫЙ индекс «источник → использующие выводы/паспорта».
 *   Индекс — ПРОИЗВОДНЫЕ данные, не источник знания: он целиком пересобирается
 *   из БД (узлы с file_refs, наблюдения артефактов, тела паспортов в журнале).
 *   Хранилище — файл-кэш рядом с БД (<dir БД>/freshness-index.json), таблицы
 *   БД не трогаются (схема 14 заморожена). Кэш валиден только при совпадении
 *   версии формата и отпечатка исходных данных; несоответствие, повреждение,
 *   «старый» кэш или отсутствие → тихий rebuild из БД (rebuild — единственный
 *   источник истины; процедура: buildFreshnessIndex + запись файла; ошибка
 *   записи не ломает проверку — индекс остаётся в памяти процесса).
 * - Проверка — ЯВНОЕ opt-in действие (инструмент check_freshness), обычный
 *   поиск её не запускает. Проверка ТОЛЬКО читает: не пишет наблюдения (это
 *   contract check_artifacts), не подтверждает опоры, не меняет граф.
 * - После изменения источника проверяются СВЯЗАННЫЕ записи (обратный индекс),
 *   не весь граф. Записи квалифицируются по СВОИМ источникам: префикс не
 *   выдаётся за весь граф — непроверенные источники едут в unchecked_sources,
 *   состояние partial.
 * - Один и тот же физический источник хешируется ОДИН раз за проверку (дедуп
 *   по абсолютному пути при совпадающих repo и правилах наблюдения); reuse
 *   hashFile/hashGitBlob/resolveGitRefSha из artifacts.ts. mtime/size НЕ
 *   используются как доказательство: совпадение определяется sha256 содержимого.
 * - Git — существующие паттерны (refs.ts classifyRef/parseRef, repo pin
 *   наблюдений); вызовы git — spawn с массивом аргументов, без shell-строк.
 *   Прежний HEAD НЕ доказательство неизменности working tree: хешируется
 *   working tree; HEAD и dirty-состояние едут в отчёте как наблюдение.
 * - Изменение входов ВО ВРЕМЯ проверки (TOCTOU): повторное сравнение в конце;
 *   расхождение → статус unstable → связанные записи unknown — стабильный
 *   снимок НЕ объявляется.
 * - Отчёт адресной перепроверки: sources (статусы), records (затронутое/
 *   проверенное/partial), summary (affected/checked/unknown/truncated),
 *   limitations (причины неполноты) и expected_versions — текущие наблюдения
 *   для повторной сверки перед применением правки (P2.3).
 * - Проверка свежести НЕ поднимает reuse-квалификацию паспорта (P1) и не
 *   делает вывод подтверждённым: обновление индекса — обслуживание кэша.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KnowledgeDB } from "./db.js";
import {
  hashFile,
  hashGitBlob,
  resolveGitRefSha,
  runGit,
} from "./artifacts.js";
import { classifyRef, parseRef } from "./refs.js";
import { findPassportBodies } from "./passport.js";
import {
  adapterResolveSymbol,
  adapterRdepsOfFile,
  detectAdapterCapability,
  resolveAdapterConfig,
} from "./code-adapter.js";
import type {
  CheckFreshnessInput,
  FreshnessExpectedVersion,
  FreshnessIndex,
  FreshnessIndexEntry,
  FreshnessRecordCheck,
  FreshnessReport,
  FreshnessSourceCheck,
  FreshnessSourceStatus,
  NodeArtifactRow,
  PassportPayload,
} from "./types.js";

/** Версия формата файла-кэша обратного индекса; несовпадение → rebuild. */
export const FRESHNESS_INDEX_FORMAT = 1;

/** Имя файла-кэша рядом с БД. */
export const FRESHNESS_INDEX_FILENAME = "freshness-index.json";

/** Дефолтные бюджеты проверки. */
export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_MAX_DEPS = 20;

/** Пределы «честных списков» в отчёте (обрезка помечается truncated). */
const DIRTY_LIST_CAP = 20;
const LIMITATIONS_CAP = 12;

/** Нормализация пути источника: локатор снимается, слеши унифицируются. */
export function normalizeSourceKey(ref: string): string {
  return parseRef(ref).path.replace(/\\/g, "/");
}

/** Дедуп-ключ физического источника: абсолютный путь (на Windows — без регистра). */
function absKey(absPath: string): string {
  const norm = absPath.replace(/\\/g, "/");
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

function fileRefsOf(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

// ---- Обратный индекс: сборка из БД (единственный источник истины) ----

/**
 * Отпечаток исходных данных индекса: дёшево вычисляемая сводка (счётчики и
 * максимумы узлов/timeline/наблюдений/trails). Любая запись, меняющая file_refs,
 * тела паспортов (timeline) или наблюдения, меняет отпечаток → кэш перестроится.
 */
export function freshnessSourceFingerprint(db: KnowledgeDB): string {
  const nodeStats = db.execSqlAll(
    `SELECT COUNT(*) AS c,
            COALESCE(MAX(updated_at), '') AS max_updated,
            COALESCE(MAX(created_at), '') AS max_created,
            COALESCE(MAX(removed_at), '') AS max_removed,
            COALESCE(MAX(COALESCE(file_refs, '')), '') AS max_refs
     FROM nodes`
  ) as Array<{ c: number; max_updated: string; max_created: string; max_removed: string; max_refs: string }>;
  const timelineStats = db.execSqlAll(
    `SELECT COUNT(*) AS c, COALESCE(MAX(seq), 0) AS max_seq FROM timeline`
  ) as Array<{ c: number; max_seq: number }>;
  let artifactStats = "";
  if (db.hasNodeArtifactsTable()) {
    const rows = db.execSqlAll(
      `SELECT COUNT(*) AS c, COALESCE(MAX(checked_at), '') AS max_checked FROM node_artifacts`
    ) as Array<{ c: number; max_checked: string }>;
    artifactStats = `${rows[0]?.c ?? 0}|${rows[0]?.max_checked ?? ""}`;
  }
  let trailCount = "";
  try {
    const rows = db.execSqlAll(`SELECT COUNT(*) AS c FROM trails`) as Array<{ c: number }>;
    trailCount = String(rows[0]?.c ?? 0);
  } catch {
    trailCount = "?";
  }
  const n = nodeStats[0];
  const t = timelineStats[0];
  return createHash("sha256")
    .update(
      [
        `nodes:${n?.c ?? 0}|${n?.max_updated ?? ""}|${n?.max_created ?? ""}|${n?.max_removed ?? ""}|${n?.max_refs ?? ""}`,
        `timeline:${t?.c ?? 0}|${t?.max_seq ?? 0}`,
        `artifacts:${artifactStats}`,
        `trails:${trailCount}`,
      ].join("\n")
    )
    .digest("hex");
}

/**
 * Собрать индекс из БД. Источники: file_refs живых узлов, файловые наблюдения
 * node_artifacts, области паспортов (тела в timeline). Записи отсутствующих
 * узлов/паспортов отфильтровываются (индекс восстанавливается, история не теряется).
 */
export function buildFreshnessIndex(db: KnowledgeDB): FreshnessIndex {
  const entries: Record<string, FreshnessIndexEntry[]> = {};
  const push = (key: string, entry: FreshnessIndexEntry): void => {
    const bucket = entries[key] ?? (entries[key] = []);
    bucket.push(entry);
  };

  // 1. Живые узлы с file_refs.
  const nodeRows = db.execSqlAll(
    `SELECT id, file_refs FROM nodes WHERE removed_at IS NULL AND file_refs IS NOT NULL`
  ) as Array<{ id: string; file_refs: string }>;
  for (const row of nodeRows) {
    for (const ref of fileRefsOf(row.file_refs)) {
      push(normalizeSourceKey(ref), { record: "node", id: row.id, via: "node_file_ref", ref });
    }
  }

  // 2. Файловые наблюдения артефактов (история наблюдений тоже «использует» источник).
  if (db.hasNodeArtifactsTable()) {
    const artifactRows = db.execSqlAll(
      `SELECT node_id, ref FROM node_artifacts WHERE kind = 'file'`
    ) as Array<{ node_id: string; ref: string }>;
    for (const row of artifactRows) {
      if (db.getNode(row.node_id) === undefined) continue; // узел hard-deleted
      push(normalizeSourceKey(row.ref), { record: "node", id: row.node_id, via: "artifact", ref: row.ref });
    }
  }

  // 3. Области паспортов (тела в params событий trail_save).
  try {
    for (const { trail_id, body } of findPassportBodies(db)) {
      for (const f of body.scope.files) {
        push(normalizeSourceKey(f.ref), {
          record: "passport",
          id: trail_id,
          via: "passport_scope",
          ref: f.ref,
        });
      }
    }
  } catch {
    // Таблицы trail могут отсутствовать в старой базе — индекс строится без паспортов.
  }

  return {
    index_format: FRESHNESS_INDEX_FORMAT,
    built_at: new Date().toISOString(),
    source_fingerprint: freshnessSourceFingerprint(db),
    entries,
  };
}

/** Путь кэша: каталог БД (живая база: <project>/.megamemory/freshness-index.json). */
export function freshnessIndexCachePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), FRESHNESS_INDEX_FILENAME);
}

/**
 * Загрузить кэш и провалидировать; любой отказ (нет файла, повреждён JSON,
 * другая версия формата, другой отпечаток исходных данных, «старый» кэш) —
 * тихий rebuild из БД. Ошибка записи кэша не ломает проверку: индекс остаётся
 * в памяти (это восстанавливаемый кэш, не источник знания).
 */
export function loadFreshnessIndex(db: KnowledgeDB): FreshnessIndex {
  const cachePath = freshnessIndexCachePath(db.dbPath);
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as FreshnessIndex;
    const valid =
      raw &&
      typeof raw === "object" &&
      raw.index_format === FRESHNESS_INDEX_FORMAT &&
      typeof raw.source_fingerprint === "string" &&
      raw.entries &&
      typeof raw.entries === "object" &&
      raw.source_fingerprint === freshnessSourceFingerprint(db);
    if (valid) return raw;
  } catch {
    // нет файла / повреждён — rebuild ниже
  }
  const index = buildFreshnessIndex(db);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(index), "utf8");
  } catch {
    // read-only каталог или гонка записи — индекс остаётся в памяти этого процесса
  }
  return index;
}

// ---- Git: состояние working tree (наблюдение, не доказательство) ----

interface GitDirtyState {
  head: string | null;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  renamed: string[];
  truncated: boolean;
  error: string | null;
  /** Путь (repo-relative, slash) → код состояния porcelain (« M», «M », «??», «R»). */
  byPath: Map<string, string>;
}

/**
 * git status --porcelain -z + git rev-parse HEAD. Аргументы массивом, без
 * shell-строк. Ошибка git (не репозиторий) — не падение: отчёт честно несёт
 * git_error, файловые хеши всё равно проверяются.
 */
export async function observeGitState(root: string): Promise<GitDirtyState> {
  const state: GitDirtyState = {
    head: null,
    staged: [],
    unstaged: [],
    untracked: [],
    renamed: [],
    truncated: false,
    error: null,
    byPath: new Map(),
  };
  try {
    const headBuf = await runGit(["rev-parse", "--verify", "HEAD"], root, 4096);
    const head = headBuf.toString("utf8").trim();
    state.head = /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    state.head = null; // не репозиторий / нет git — HEAD не наблюдаем
  }
  let raw: string;
  try {
    const buf = await runGit(["status", "--porcelain", "-z"], root, 1024 * 1024);
    raw = buf.toString("utf8");
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    return state;
  }
  const fields = raw.split("\0").filter((f) => f !== "");
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const rest = entry.slice(3).replace(/\\/g, "/");
    // -z формат: переименование — ДВА поля (новый путь, затем исходный).
    if (xy[0] === "R" || xy[1] === "R") {
      const orig = (fields[i + 1] ?? "").replace(/\\/g, "/");
      i += 1;
      state.renamed.push(`${orig} -> ${rest}`);
      state.byPath.set(orig, xy);
      state.byPath.set(rest, xy);
      continue;
    }
    state.byPath.set(rest, xy);
    if (xy === "??") {
      state.untracked.push(rest);
    } else {
      if (xy[0] !== " ") state.staged.push(rest);
      if (xy[1] !== " ") state.unstaged.push(rest);
    }
  }
  const cap = DIRTY_LIST_CAP;
  const cut = (a: string[]): boolean => a.length > cap;
  const truncatedList =
    cut(state.staged) || cut(state.unstaged) || cut(state.untracked) || cut(state.renamed);
  state.staged = state.staged.slice(0, cap);
  state.unstaged = state.unstaged.slice(0, cap);
  state.untracked = state.untracked.slice(0, cap);
  state.renamed = state.renamed.slice(0, cap);
  state.truncated = truncatedList;
  return state;
}

// ---- Проверка ----

interface Comparison {
  origin: FreshnessIndexEntry["via"];
  record: "node" | "passport";
  id: string;
  digest: string | null;
  recorded_missing: boolean;
  where: string;
  repo_pin: string | null;
}

interface SourceWork {
  raw: string;
  key: string; // normalizeSourceKey
  abs: string;
  kind: "file" | "git_blob" | "git_ref";
  rev?: string;
  scheme?: "tag" | "commit" | "branch";
  name?: string;
}

/**
 * Одно наблюдение источника. file — чтение working tree; git_blob — чтение
 * объекта ревизии; git_ref — разрешение в sha коммита (тег переехал → другой
 * sha). null — источника нет (missing — это запись, не падение).
 */
async function observeSource(
  work: SourceWork,
  root: string
): Promise<{ digest: string | null; size: number | null } | { error: string }> {
  if (work.kind === "git_blob") {
    try {
      const fresh = await hashGitBlob(work.rev!, work.raw, root);
      return fresh ? { digest: fresh.digest, size: fresh.size } : { digest: null, size: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (work.kind === "git_ref") {
    try {
      const sha = await resolveGitRefSha(work.scheme!, work.name!, root);
      return sha ? { digest: sha, size: null } : { digest: null, size: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  const hashed = await hashFile(work.abs);
  return hashed ? { digest: hashed.digest, size: hashed.size } : { digest: null, size: null };
}

/**
 * Адресная перепроверка связанных записей (P2.1): обратный индекс находит
 * использующие выводы/паспорта для указанных источников, проверяются СВЯЗАННЫЕ
 * источники (не весь граф), сравнение — по sha256 с записанными версиями
 * (наблюдения check_artifacts, хеши области паспортов). Только чтение:
 * ни наблюдений, ни снимков, ни записей графа.
 */
export async function checkFreshness(
  db: KnowledgeDB,
  input: CheckFreshnessInput
): Promise<FreshnessReport> {
  if (!Array.isArray(input.sources) && !Array.isArray(input.node_ids) &&
      !Array.isArray(input.trail_ids) && !Array.isArray(input.symbols)) {
    throw new Error(
      "check_freshness: укажи sources, node_ids, trail_ids или symbols — проверка адресная, весь граф не обходится."
    );
  }
  const maxFiles = input.max_files ?? DEFAULT_MAX_FILES;
  if (!Number.isFinite(maxFiles) || !Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error(`check_freshness: max_files должен быть целым ≥ 1, получено: ${String(input.max_files)}.`);
  }
  const maxDeps = input.max_deps ?? DEFAULT_MAX_DEPS;
  if (!Number.isFinite(maxDeps) || !Number.isInteger(maxDeps) || maxDeps < 1) {
    throw new Error(`check_freshness: max_deps должен быть целым ≥ 1, получено: ${String(input.max_deps)}.`);
  }
  const root = input.repo_root ?? process.cwd();
  const now = new Date().toISOString();

  // ---- adapter (P2.2): конфиг и capability до работы ----
  const adapterCfg = resolveAdapterConfig(input.adapter, root);
  const capability = adapterCfg ? await detectAdapterCapability(adapterCfg) : null;

  // ---- 1. Обратный индекс (восстановимый кэш; rebuild при расхождении) ----
  const index = loadFreshnessIndex(db);

  // ---- 2. Целевые источники и связанные записи ----
  const sourceWorks = new Map<string, SourceWork>(); // ключ — normalizeSourceKey
  const relatedRecords = new Map<string, FreshnessIndexEntry>();
  const recordKey = (record: string, id: string, via: string, ref: string): string =>
    `${record}:${id}:${via}:${ref}`;

  const queueRef = (raw: string): void => {
    const key = normalizeSourceKey(raw);
    if (sourceWorks.has(key)) return;
    const cls = classifyRef(raw);
    const parsed = parseRef(raw);
    if (cls.kind === "file") {
      const abs = path.isAbsolute(parsed.path) ? parsed.path : path.resolve(root, parsed.path);
      sourceWorks.set(key, { raw, key, abs, kind: "file" });
    } else {
      sourceWorks.set(key, {
        raw,
        key,
        abs: parsed.path,
        kind: cls.kind,
        ...(cls.kind === "git_blob" ? { rev: cls.rev } : {}),
        ...(cls.kind === "git_ref" ? { scheme: cls.scheme, name: cls.name } : {}),
      });
    }
  };

  const noteRecord = (entry: FreshnessIndexEntry): void => {
    relatedRecords.set(recordKey(entry.record, entry.id, entry.via, entry.ref), entry);
  };

  // Явные источники.
  for (const raw of input.sources ?? []) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`check_freshness: sources содержит пустую/нестроковую ссылку: ${String(raw)}`);
    }
    queueRef(raw);
    for (const entry of index.entries[normalizeSourceKey(raw)] ?? []) noteRecord(entry);
  }

  // Явно названные узлы: их refs и наблюдения попадают в проверку целиком.
  const nodeRefs = new Map<string, string[]>();
  for (const nodeId of input.node_ids ?? []) {
    const node = db.getNode(nodeId);
    if (!node) continue;
    const refs = fileRefsOf(node.file_refs);
    nodeRefs.set(nodeId, refs);
    for (const ref of refs) {
      queueRef(ref);
      noteRecord({ record: "node", id: nodeId, via: "node_file_ref", ref });
    }
    if (db.hasNodeArtifactsTable()) {
      for (const row of db.getNodeArtifacts(nodeId)) {
        if (row.kind !== "file") continue;
        queueRef(row.ref);
        noteRecord({ record: "node", id: nodeId, via: "artifact", ref: row.ref });
      }
    }
  }

  // Явно названные паспорта: области целиком (или честный unknown без тела).
  const passportBodies = new Map<string, PassportPayload | null>();
  const loadPassportBody = (trailId: string): PassportPayload | null =>
    findPassportBodies(db).find((b) => b.trail_id === trailId)?.body ?? null;
  for (const trailId of input.trail_ids ?? []) {
    passportBodies.set(trailId, loadPassportBody(trailId));
    const body = passportBodies.get(trailId);
    if (!body) continue;
    for (const f of body.scope.files) {
      queueRef(f.ref);
      noteRecord({ record: "passport", id: trailId, via: "passport_scope", ref: f.ref });
    }
  }

  // Связанные записи из индекса: их ДРУГИЕ источники тоже проверяются,
  // иначе квалификация записи была бы префиксом, выданным за весь граф.
  for (const entry of [...relatedRecords.values()]) {
    if (entry.record === "node") {
      if (!nodeRefs.has(entry.id)) {
        const node = db.getNode(entry.id);
        if (node) nodeRefs.set(entry.id, fileRefsOf(node.file_refs));
      }
      for (const ref of nodeRefs.get(entry.id) ?? []) queueRef(ref);
    } else {
      if (!passportBodies.has(entry.id)) passportBodies.set(entry.id, loadPassportBody(entry.id));
      const body = passportBodies.get(entry.id);
      if (body) for (const f of body.scope.files) queueRef(f.ref);
    }
  }

  // Детерминированный порядок проверки: явные sources, затем refs записей
  // в порядке записи. Map сохраняет порядок вставки.
  const orderedWorks: SourceWork[] = [...sourceWorks.values()];

  // ---- 3. Git-наблюдение working tree (один раз) ----
  const git = await observeGitState(root);

  // ---- 4. Проход 1: наблюдение источников (дедуп по физическому источнику, бюджет) ----
  const observations = new Map<string, { digest: string | null; size: number | null }>();
  const observeErrors = new Map<string, string>();
  // P2.1.4: один и тот же ФИЗИЧЕСКИЙ источник хешируется один раз за проверку
  // (совпадают repo и правила наблюдения): кэш по абсолютному пути (файл) или
  // по виду git-объекта. Разные refs к одному файлу (с локаторами и без) делят
  // одно наблюдение; результаты разных refs/снимков не смешиваются.
  const physCache = new Map<string, { digest: string | null; size: number | null } | { error: string }>();
  const physKeyOf = (work: SourceWork): string =>
    work.kind === "file" ? `file:${absKey(work.abs)}` : `git:${work.kind}:${work.raw}`;
  let checkedCount = 0;
  let truncatedByFiles = false;
  const skippedKeys = new Set<string>();
  for (const work of orderedWorks) {
    if (checkedCount >= maxFiles) {
      skippedKeys.add(work.key);
      truncatedByFiles = true;
      continue;
    }
    checkedCount += 1;
    const pk = physKeyOf(work);
    let outcome = physCache.get(pk);
    if (!outcome) {
      outcome = await observeSource(work, root);
      physCache.set(pk, outcome);
    }
    if ("error" in outcome) {
      observeErrors.set(work.key, outcome.error);
      observations.set(work.key, { digest: null, size: null });
    } else {
      observations.set(work.key, outcome);
    }
  }

  // ---- Инъекция изменения между фазами (детерминированная, §17.2) ----
  await input.fault_injection?.("after_first_pass");

  // ---- 5. Проход 2: согласованность наблюдения (TOCTOU, P2.3) ----
  const unstableKeys = new Set<string>();
  for (const [key, first] of [...observations]) {
    const work = sourceWorks.get(key);
    if (!work) continue;
    const second = await observeSource(work, root);
    const secondDigest = "error" in second ? null : second.digest;
    if (secondDigest !== first.digest || ("error" in second) !== observeErrors.has(key)) {
      unstableKeys.add(key);
      observations.set(key, { digest: null, size: null }); // ни одно из двух наблюдений не заявляется
      observeErrors.delete(key);
    }
  }

  // ---- 6. Записанные версии (наблюдения/паспорта) и связанные записи ----
  //
  // СРАВНЕНИЕ идёт только с реально записанными версиями (наблюдения
  // check_artifacts, хеши области паспортов). file_refs узла БЕЗ наблюдения —
  // это связь «источник → использующая запись», а не записанная версия: она
  // даёт affected_records и unobserved-статус, но не материал сравнения.
  const comparisons = new Map<string, Comparison[]>();
  const addComparison = (key: string, cmp: Comparison): void => {
    const bucket = comparisons.get(key);
    if (bucket) bucket.push(cmp);
    else comparisons.set(key, [cmp]);
  };

  const normRoot = root.replace(/\\/g, "/").toLowerCase();
  const sameRoot = (pin: string | null | undefined): boolean =>
    pin == null ? true : pin.replace(/\\/g, "/").toLowerCase() === normRoot;

  for (const entry of relatedRecords.values()) {
    if (entry.record === "node") {
      let rows: NodeArtifactRow[] = [];
      try {
        rows = db.hasNodeArtifactsTable() ? db.getNodeArtifacts(entry.id) : [];
      } catch {
        rows = [];
      }
      for (const row of rows) {
        const key = normalizeSourceKey(row.ref);
        if (!sourceWorks.has(key)) continue;
        // Одна связка (узел, ref) — одно наблюдение: file_ref и artifact
        // записи того же узла дедуплицируются.
        const dup = comparisons.get(key)?.some((c) => c.record === "node" && c.id === entry.id && c.origin === "artifact");
        if (dup) continue;
        addComparison(key, {
          origin: "artifact",
          record: "node",
          id: entry.id,
          digest: row.digest,
          recorded_missing: row.digest === null,
          where: `наблюдение check_artifacts узла ${entry.id} (checked_at ${row.checked_at})`,
          repo_pin: row.repo_path ?? null,
        });
      }
    } else {
      const body = passportBodies.get(entry.id);
      if (!body) continue;
      for (const f of body.scope.files) {
        const key = normalizeSourceKey(f.ref);
        if (!sourceWorks.has(key)) continue;
        addComparison(key, {
          origin: "passport_scope",
          record: "passport",
          id: entry.id,
          digest: f.sha256,
          recorded_missing: f.missing === true,
          where: `область паспорта trail ${entry.id} (checked_at ${body.checked_at})`,
          repo_pin: body.repo.root,
        });
      }
    }
  }

  // Затронутые записи источника — все связанные записи по индексу, а не только
  // те, у которых была записанная версия.
  const affectedBySource = new Map<string, Array<{ record: "node" | "passport"; id: string; via: FreshnessIndexEntry["via"] }>>();
  for (const entry of relatedRecords.values()) {
    const key = normalizeSourceKey(entry.ref);
    if (!sourceWorks.has(key)) continue;
    const bucket = affectedBySource.get(key) ?? (affectedBySource.set(key, []), affectedBySource.get(key)!);
    if (!bucket.some((b) => b.record === entry.record && b.id === entry.id && b.via === entry.via)) {
      bucket.push({ record: entry.record, id: entry.id, via: entry.via });
    }
  }

  // ---- 7. Статусы источников ----
  const sourceChecks: FreshnessSourceCheck[] = [];
  for (const work of orderedWorks) {
    const cur = observations.get(work.key) ?? null;
    const cmps = comparisons.get(work.key) ?? [];
    let status: FreshnessSourceStatus;
    let note: string | null = null;

    const observeError = observeErrors.get(work.key);
    if (skippedKeys.has(work.key)) {
      status = "skipped";
      note = `бюджет max_files=${maxFiles} исчерпан — источник не проверен (срез детерминированный)`;
    } else if (unstableKeys.has(work.key)) {
      status = "unstable";
      note = "источник менялся ВО ВРЕМЯ проверки — стабильный снимок не объявляется (conflict/unknown)";
    } else if (observeError) {
      status = "unknown";
      note = `наблюдение не удалось: ${observeError}`;
    } else {
      const valid = cmps.filter((c) => sameRoot(c.repo_pin));
      const crossRepo = cmps.length > 0 && valid.length === 0;
      const present = cur != null && cur.digest !== null;
      if (crossRepo) {
        status = "other_repo";
        note = `закреплённый repo наблюдения — другой worktree (${cmps[0].repo_pin}): одинаковый путь в разных репозиториях не одна опора; сравнение байтов не делается`;
      } else if (!present) {
        if (valid.some((c) => !c.recorded_missing && c.digest !== null)) {
          status = "missing";
          note = "источника больше нет на диске (удалён/переименован)";
        } else if (valid.some((c) => c.recorded_missing)) {
          status = "unchanged";
          note = "отсутствовал и при записи версии — состояние не изменилось";
        } else {
          status = "missing";
          note = "источника нет; записанной версии для сравнения нет";
        }
      } else if (valid.length === 0) {
        status = "unobserved";
        note = "записанной версии для сравнения нет — текущий дайджест в expected_versions";
      } else if (valid.some((c) => c.recorded_missing)) {
        status = "changed";
        note = "источник появился после записи версии (был missing)";
      } else if (valid.some((c) => c.digest !== null && c.digest !== cur!.digest)) {
        status = "changed";
        note = "sha256 разошёлся с записанной версией — связанные записи затронуты; вывод не объявляется автоматически ложным";
      } else {
        status = "unchanged";
      }
    }

    const affected = affectedBySource.get(work.key) ?? [];
    const parsedRaw = parseRef(work.raw);
    const gitState =
      work.kind === "file" && !path.isAbsolute(parsedRaw.path)
        ? git.byPath.get(parsedRaw.path.replace(/\\/g, "/")) ?? null
        : null;
    sourceChecks.push({
      source: work.raw,
      kind: work.kind,
      status,
      current_digest: cur?.digest ?? null,
      current_size: cur?.size ?? null,
      compared_to: cmps.length > 0
        ? { origin: cmps[0].origin, digest: cmps[0].digest, where: cmps[0].where }
        : null,
      affected_records: affected,
      git_state: gitState,
      note,
    });
  }

  // ---- 8. Квалификация связанных записей ----
  const statusByKey = new Map(sourceChecks.map((s) => [normalizeSourceKey(s.source), s.status]));
  const recordRefs = (record: "node" | "passport", id: string): string[] =>
    record === "node"
      ? (nodeRefs.get(id) ?? [])
      : (passportBodies.get(id)?.scope.files.map((f) => f.ref) ?? []);
  const recordName = (record: "node" | "passport", id: string): string | null =>
    record === "node" ? (db.getNode(id)?.name ?? null) : (db.getTrail(id)?.name ?? null);

  const records: FreshnessRecordCheck[] = [];
  const seenRecords = new Set<string>();
  for (const entry of relatedRecords.values()) {
    const dedupKey = `${entry.record}:${entry.id}`;
    if (seenRecords.has(dedupKey)) continue;
    seenRecords.add(dedupKey);

    // Паспорт без тела (ретеншн журнала) — область и версии неизвестны.
    if (entry.record === "passport" && passportBodies.get(entry.id) == null) {
      records.push({
        record: "passport",
        id: entry.id,
        name: recordName("passport", entry.id),
        state: "unknown",
        checked_sources: [],
        unchecked_sources: [],
        reasons: [
          "тело паспорта не найдено в журнале (ретеншн timeline) — область и записанные версии неизвестны; квалификация unknown",
        ],
      });
      continue;
    }
    // Узел исчез (hard-deleted или устаревший кэш индекса) — доверие не выдаётся.
    if (entry.record === "node" && !nodeRefs.has(entry.id)) {
      records.push({
        record: "node",
        id: entry.id,
        name: null,
        state: "unknown",
        checked_sources: [],
        unchecked_sources: [],
        reasons: [
          "узел не найден в БД (hard-deleted или кэш индекса устарел) — квалификация unknown; индекс перестроится при следующей проверке",
        ],
      });
      continue;
    }

    const refs = recordRefs(entry.record, entry.id);
    const checkedSources: Array<{ source: string; status: FreshnessSourceStatus }> = [];
    const unchecked: string[] = [];
    const reasons: string[] = [];
    let state: FreshnessRecordCheck["state"] = "fresh";
    let otherRepoPin: string | null = null;
    for (const ref of refs) {
      const key = normalizeSourceKey(ref);
      const st = statusByKey.get(key);
      if (st === undefined) {
        unchecked.push(ref);
        continue;
      }
      checkedSources.push({ source: ref, status: st });
      if (st === "skipped") {
        // Не влез в бюджет: это НЕПРОВЕРЕННЫЙ источник записи (префикс ≠ весь граф).
        unchecked.push(ref);
        continue;
      }
      if (st === "changed") {
        reasons.push(`"${ref}" изменился после записи версии — перепроверь затронутое; вывод не объявляется автоматически ложным`);
        if (state !== "unknown") state = "stale_input";
      } else if (st === "missing") {
        reasons.push(`"${ref}" недоступен — источник проверки исчез`);
        if (state !== "unknown") state = "stale_input";
      } else if (st === "unstable") {
        reasons.push(`"${ref}" менялся во время проверки — квалификация записи неизвестна (не стабильный снимок)`);
        state = "unknown";
      } else if (st === "other_repo") {
        reasons.push(`"${ref}" закреплён за другим worktree — сравнение байтов не делалось`);
        state = "unknown";
        otherRepoPin = comparisons.get(key)?.[0]?.repo_pin ?? otherRepoPin;
      } else if (st === "unknown") {
        reasons.push(`"${ref}" не проверен (ошибка наблюдения)`);
        state = "unknown";
      }
    }
    if (otherRepoPin) {
      reasons.push(`запись связана с другим repo/worktree (${otherRepoPin}) — одинаковый путь в разных репозиториях не одна опора`);
    }
    if (unchecked.length > 0 && state !== "unknown") {
      if (state !== "stale_input") state = "partial";
      reasons.push(
        `${unchecked.length} источник(ов) записи вне проверенного набора — проверен только префикс, это НЕ весь граф`
      );
    }
    if (state === "stale_input") {
      reasons.push("проверка свежести не поднимает reuse-квалификацию и не подтверждает опоры");
    }
    records.push({
      record: entry.record,
      id: entry.id,
      name: recordName(entry.record, entry.id),
      state,
      checked_sources: checkedSources,
      unchecked_sources: unchecked,
      reasons,
    });
  }

  // ---- 9. Обход зависимостей изменённых источников (adapter, opt-in) ----
  let dependencies: FreshnessReport["dependencies"] = null;
  let truncatedByDeps = false;
  const limitations: string[] = [
    "проверка свежести не поднимает reuse-квалификацию и не подтверждает опоры (confirm_supports — явное действие)",
    "прежде чем применять правку, сверь expected_versions повторно — вывод привязан к наблюдавшемуся состоянию",
  ];
  if (input.with_dependencies) {
    if (!adapterCfg) {
      limitations.push(
        "обход зависимостей недоступен: adapter не сконфигурирован (adapter.graph_tool или MEGAMEMORY_CODE_ADAPTER) — зависимые файлы НЕ обследованы, это не «зависимостей нет»"
      );
    } else if (!capability?.available) {
      limitations.push(
        `обход зависимостей недоступен: adapter не отвечает (${capability?.reason ?? "?"}) — зависимые файлы НЕ обследованы, это не «зависимостей нет»`
      );
    } else {
      const deps: NonNullable<FreshnessReport["dependencies"]> = [];
      let depBudget = maxDeps;
      for (const s of sourceChecks) {
        if (s.kind !== "file") continue;
        if (s.status !== "changed" && s.status !== "missing") continue;
        const parsed = parseRef(s.source);
        if (path.isAbsolute(parsed.path)) continue;
        const outcome = await adapterRdepsOfFile(adapterCfg, parsed.path.replace(/\\/g, "/"));
        if (outcome.error) {
          limitations.push(`зависимости "${s.source}": ошибка adapter (${outcome.error}) — это не «зависимостей нет»`);
          continue;
        }
        const dependents = outcome.dependents.slice(0, Math.max(0, depBudget));
        if (outcome.dependents.length > dependents.length) truncatedByDeps = true;
        depBudget -= dependents.length;
        const depRecordSeen = new Set<string>();
        for (const dep of dependents) {
          for (const entry of index.entries[normalizeSourceKey(dep)] ?? []) {
            const dk = `${entry.record}:${entry.id}`;
            if (depRecordSeen.has(dk)) continue;
            depRecordSeen.add(dk);
            const rec = records.find((x) => x.record === entry.record && x.id === entry.id);
            const reasonText =
              `изменённый источник "${s.source}" импортируется "${entry.ref}" (static import-граф adapter, объявленный scope) — неизменные байты вывода не доказывают независимость от изменения зависимости`;
            if (rec) {
              rec.reasons.push(reasonText);
            } else {
              // Запись цитирует только зависимый файл — она вне file-статусов,
              // но потенциально затронута: добавляем с пометкой.
              records.push({
                record: entry.record,
                id: entry.id,
                name: recordName(entry.record, entry.id),
                state: "partial",
                checked_sources: [],
                unchecked_sources: [entry.ref],
                reasons: [reasonText],
              });
            }
          }
        }
        if (!outcome.complete) {
          limitations.push(
            `import-граф "${s.source}" неполон по данным adapter (importedByTotal > выданных) — префикс не весь граф`
          );
        }
        deps.push({ source: s.source, dependents, complete: outcome.complete, scope: outcome.scan_root });
      }
      dependencies = deps;
    }
  }

  // ---- 10. Символьная ступень (P2.2, пилот) ----
  const symbols: FreshnessReport["symbols"] = [];
  if (input.symbols && input.symbols.length > 0) {
    if (!adapterCfg) {
      limitations.push(
        "symbols запрошены, но adapter не сконфигурирован — символьный уровень недоступен (файловый режим ЯВНО)"
      );
      for (const loc of input.symbols) {
        symbols.push({
          locator: loc,
          status: "adapter_error",
          candidates: [],
          matched_locators: [],
          locator_moved: false,
          note: "adapter не сконфигурирован (adapter.graph_tool или MEGAMEMORY_CODE_ADAPTER) — разрешение символа требует чтения или конфигурации",
        });
      }
    } else if (!capability?.available) {
      limitations.push(`adapter сконфигурирован (${adapterCfg.source}), но недоступен: ${capability?.reason ?? "?"} — фолбэк на файловый уровень ЯВНО, не молча`);
      for (const loc of input.symbols) {
        symbols.push({
          locator: loc,
          status: "adapter_error",
          candidates: [],
          matched_locators: [],
          locator_moved: false,
          note: `adapter недоступен: ${capability?.reason ?? "?"} — остаётся файловая проверка`,
        });
      }
    } else {
      for (const loc of input.symbols) {
        const outcome = await adapterResolveSymbol(adapterCfg, loc);
        if (outcome.status === "adapter_error") {
          symbols.push({
            locator: loc,
            status: "adapter_error",
            candidates: [],
            matched_locators: [],
            locator_moved: false,
            note: `ошибка adapter: ${outcome.error} — фолбэк файлового уровня, не молча`,
          });
          continue;
        }
        if (outcome.status === "missing") {
          symbols.push({
            locator: loc,
            status: "missing",
            candidates: [],
            matched_locators: [],
            locator_moved: false,
            note: "определение не найдено в scope adapter — требуется чтение, выбор первого совпадения запрещён",
          });
          continue;
        }
        const candidates = outcome.status === "unique" ? [outcome.candidate] : outcome.candidates;
        // Сопоставление с локаторами связанных записей (path:N-M) по файлу.
        const candFile = candidates[0]?.file.replace(/\\/g, "/") ?? null;
        const matched: FreshnessReport["symbols"][number]["matched_locators"] = [];
        let moved = false;
        if (candFile) {
          for (const [key, bucket] of Object.entries(index.entries)) {
            if (key.toLowerCase() !== candFile.toLowerCase()) continue;
            for (const entry of bucket) {
              const parsed = parseRef(entry.ref);
              if (!parsed.locator) continue;
              const m = parsed.locator.match(/^(\d+)(?:-(\d+))?$/);
              if (!m) continue;
              matched.push({ record: entry.record, id: entry.id, ref: entry.ref, range: parsed.locator });
              if (outcome.status === "unique" && outcome.candidate.start_line != null && outcome.candidate.end_line != null) {
                const n = Number(m[1]);
                const mm = m[2] ? Number(m[2]) : n;
                if (n !== outcome.candidate.start_line || mm !== outcome.candidate.end_line) moved = true;
              }
            }
          }
        }
        let note: string | null = null;
        if (outcome.status === "ambiguous") {
          note = "неоднозначное определение — требуется чтение, выбор первого совпадения запрещён";
        } else {
          const cand = outcome.candidate;
          const fileStatus = statusByKey.get(normalizeSourceKey(cand.file));
          if (fileStatus === "changed" || fileStatus === "missing") {
            note = moved
              ? "файл изменился и диапазон символа разошёлся с записанным локатором — символ считается изменившимся (номера строк — текущий результат разрешения, не идентичность)"
              : "файл изменился; записанного диапазона для сравнения нет — консервативно символ считается изменившимся (file-level); перед правкой читай текущий участок";
          } else if (fileStatus === "unchanged") {
            note = "байты файла не изменились — символ актуален по содержимому (номера строк — текущее разрешение)";
          } else if (fileStatus === "unobserved" || fileStatus === "skipped") {
            note = moved
              ? "диапазон разошёлся с записанным локатором (номера строк — текущее разрешение, не идентичность); актуальность по байтам не устанавливалась"
              : "актуальность по байтам не устанавливалась (записанной версии файла нет) — перед правкой читай текущий участок";
          } else if (fileStatus === undefined) {
            note = "файл символа не входил в адресную проверку — актуальность по байтам не устанавливалась";
          }
          if (cand.start_line == null || cand.end_line == null) {
            note = `${note ?? "adapter не дал надёжных границ диапазона"} — консервативно file-level`.trim();
          }
        }
        symbols.push({
          locator: loc,
          status: outcome.status,
          candidates: candidates.map((c) => ({
            file: c.file,
            ...(c.kind ? { kind: c.kind } : {}),
            ...(c.owner ? { owner: c.owner } : {}),
            ...(c.line != null ? { line: c.line } : {}),
            ...(c.start_line != null ? { start_line: c.start_line } : {}),
            ...(c.end_line != null ? { end_line: c.end_line } : {}),
            ...(c.body_start_line != null ? { body_start_line: c.body_start_line } : {}),
            ...(c.body_end_line != null ? { body_end_line: c.body_end_line } : {}),
          })),
          matched_locators: matched,
          locator_moved: moved,
          note,
        });
      }
      limitations.push(
        `статическая полнота символьного уровня — только объявленный scope adapter; runtime-связи, динамический код и файлы вне scope — file-level/чтение`
      );
    }
  }

  // ---- 11. Отчёт ----
  if (adapterCfg && !capability?.available) {
    limitations.push(`adapter сконфигурирован (${adapterCfg.source}), но недоступен — режим file; это ЯВНЫЙ фолбэк`);
  }
  if (capability?.available && adapterCfg) {
    limitations.push(
      "тестовые файлы: default-исключения adapter не маскируются — вывод, опирающийся на тесты вне scope adapter, требует файловой проверки"
    );
  }
  if (truncatedByFiles) {
    limitations.push(`бюджет max_files=${maxFiles}: часть источников не проверена (skipped, срез детерминированный)`);
  }
  if (truncatedByDeps) limitations.push(`бюджет max_deps=${maxDeps}: список зависимых усечён`);
  if (git.error) limitations.push(`git-состояние working tree не наблюдаемо: ${git.error}`);
  if (git.head) limitations.push("HEAD в отчёте — наблюдение, не доказательство неизменности working tree");
  if (limitations.length > LIMITATIONS_CAP) {
    const dropped = limitations.length - LIMITATIONS_CAP;
    limitations.splice(LIMITATIONS_CAP, dropped, `+${dropped} причин неполноты опущено лимитом отчёта`);
  }

  const expectedVersions: FreshnessExpectedVersion[] = [];
  for (const s of sourceChecks) {
    if (s.current_digest == null) continue;
    if (s.status === "unstable" || s.status === "unknown") continue; // нестабильное наблюдение — не ожидаемая версия
    expectedVersions.push({
      source: s.source,
      kind: s.kind,
      sha256: s.current_digest,
      size_bytes: s.current_size,
      checked_at: now,
    });
  }

  const unknownSources = sourceChecks.filter(
    (s) => s.status === "unstable" || s.status === "unknown" || s.status === "other_repo" || s.status === "skipped"
  ).length;

  return {
    repo: {
      root,
      head_at_check: git.head,
      dirty: {
        staged: git.staged,
        unstaged: git.unstaged,
        untracked: git.untracked,
        renamed: git.renamed,
        truncated: git.truncated,
      },
      git_error: git.error,
    },
    sources: sourceChecks,
    records,
    dependencies,
    symbols,
    adapter: {
      configured: adapterCfg != null,
      available: capability?.available ?? false,
      mode: capability?.available ? "symbol" : "file",
      version: capability?.version ?? null,
      error: capability?.reason ?? null,
      static_scope: capability?.available ? capability.project_type : null,
    },
    summary: {
      affected: records.filter((r) => r.state === "stale_input").length,
      checked: sourceChecks.filter(
        (s) => s.status === "unchanged" || s.status === "changed" || s.status === "missing" || s.status === "unobserved"
      ).length,
      unknown: unknownSources,
      truncated: truncatedByFiles || truncatedByDeps || git.truncated,
      truncated_by: truncatedByFiles ? "max_files" : truncatedByDeps ? "max_deps" : null,
      limitations,
    },
    expected_versions: expectedVersions,
  };
}
