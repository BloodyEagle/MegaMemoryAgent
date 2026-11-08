import { createHash } from "crypto";
import type { KnowledgeDB } from "./db.js";
import type { EdgeRow, NodeRow } from "./types.js";

/**
 * Duplicate consolidation (plan T5): find near-identical active nodes by
 * embedding cosine similarity and merge them — older node survives, summary
 * and file_refs combine, edges move to the survivor.
 */

export interface DuplicateCandidate {
  a: string;
  b: string;
  similarity: number;
  name_similarity: number;
  same_parent: boolean;
  /** The older node — survives the merge. */
  older: string;
}

export interface FindDuplicatesOptions {
  /** Minimum embedding cosine to count as a duplicate (default 0.95). */
  threshold?: number;
  /** Max candidates returned (default 100). */
  limit?: number;
}

function toVector(raw: Buffer | ArrayBuffer | null): Float32Array | null {
  if (!raw) return null;
  const buf = raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
  if (buf.length === 0 || buf.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.length / Float32Array.BYTES_PER_ELEMENT
  );
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Dice coefficient over character bigrams — simple, language-agnostic. */
export function nameSimilarity(a: string, b: string): number {
  const sa = a.toLowerCase();
  const sb = b.toLowerCase();
  if (sa === sb) return 1;
  if (sa.length < 2 || sb.length < 2) return sa === sb ? 1 : 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < sa.length - 1; i++) {
    const g = sa.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < sb.length - 1; i++) {
    const g = sb.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hits += 1;
      grams.set(g, n - 1);
    }
  }
  return (2 * hits) / (sa.length - 1 + sb.length - 1);
}

/**
 * План 09 (R-06b): ключ блока — нормализованное имя (нижний регистр, без
 * пунктуации, схлопнутые пробелы). Внутри большой группы попарно сравниваются
 * только узлы одного блока; разные блоки не сравниваются вовсе. На bench-данных
 * плана 08 префиксные/токенные ключи схлопывались в один гигантский блок
 * (все имена «Module …»), возвращая квадратицу — поэтому берётся полное
 * нормализованное имя: размер блока ограничен реальными совпадениями имён.
 *
 * План 12 (R-06b) вернул полноту: пары из разных блоков снова доходят до
 * сравнения через ступень B (триграммы) и ступень C (LSH по векторам) —
 * см. комментарии в findDuplicates.
 */
function nameBlockKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Порог размера группы: меньше — дешевле прежний квадратичный проход. */
const BLOCK_GROUP_SIZE = 200;
/** Предел пар-кандидатов на узел в большом блоке (план 09: «50 ближайших»). */
const MAX_CANDIDATES_PER_NODE = 50;
/** Окно сравнения в астрономически больших блоках: узел сравнивается со
 * следующими WINDOW членами блока в порядке вставки, а не со всеми. Окно ≥
 * размеров приёмочных групп (500 одинаковых имён сравниваются целиком). */
const BLOCK_WINDOW = 2000;

// План 12 (R-06b): блокинг по точному имени пропускал пары с разными
// блоками («Модуль авторизации» / «Модуль аутентификации», опечатки).
// Ступень B возвращает их: кандидаты по триграммам нормализованного имени.

/** Минимум общих триграмм нормализованного имени у пары-кандидата. */
const TRIGRAM_MIN_SHARED = 3;
/** Триграммы с документной частотой выше лимита не индексируются: в
 * однородном корпусе («Module …» у каждого имени) они не выбирают пару, а
 * без лимита проход по postings вырождается в квадрат на общем префиксе.
 * Пары, у которых все общие триграммы сверхчастые, ловит ступень C. */
const TRIGRAM_MAX_DF = 256;

/** Триграммы нормализованного имени (тот же nameBlockKey, что у блоков
 * ступени A — нормализация не расходится между ступенями). */
function nameTrigrams(name: string): string[] {
  const norm = nameBlockKey(name);
  const out: string[] = [];
  for (let i = 0; i + 3 <= norm.length; i++) out.push(norm.slice(i, i + 3));
  return out;
}

export interface FindDuplicatesResult {
  candidates: DuplicateCandidate[];
  /**
   * Пары-кандидаты (sim ≥ threshold), не попавшие в выдачу из-за предела
   * на узел. Честный счётчик: усечение видно в отчёте, а не молчит.
   */
  candidates_truncated: number;
}

/** Near-duplicate candidates among active nodes, grouped by parent. */
export function findDuplicates(
  db: KnowledgeDB,
  opts: FindDuplicatesOptions = {}
): FindDuplicatesResult {
  const threshold = opts.threshold ?? 0.95;
  const limit = opts.limit ?? 100;

  // М7: digest nodes are derived summaries — never consolidation candidates
  // (merging two digests would corrupt the derived payload).
  const rows = db
    .getAllNodesRaw()
    .filter((n) => n.removed_at === null && n.kind !== "digest");
  const groups = new Map<string, NodeRow[]>();
  for (const row of rows) {
    const key = row.parent_id ?? "__root__";
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const candidates: DuplicateCandidate[] = [];
  let truncated = 0;

  const buildCandidate = (i: NodeRow, j: NodeRow, sim: number): DuplicateCandidate => ({
    a: i.id,
    b: j.id,
    similarity: sim,
    name_similarity: nameSimilarity(i.name, j.name),
    same_parent: i.parent_id === j.parent_id,
    older: (i.created_at ?? "") <= (j.created_at ?? "") ? i.id : j.id,
  });

  for (const group of groups.values()) {
    if (group.length < BLOCK_GROUP_SIZE) {
      // Маленькая группа: прежний квадратичный проход — блокинг тут дороже,
      // а выдача обязана совпадать байт в байт (фикстуры качества).
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const va = toVector(group[i].embedding);
          const vb = toVector(group[j].embedding);
          if (!va || !vb) continue; // consolidation needs vectors on both sides
          const sim = cosine(va, vb);
          if (sim < threshold) continue;
          candidates.push(buildCandidate(group[i], group[j], sim));
          if (candidates.length >= limit) {
            return { candidates, candidates_truncated: truncated };
          }
        }
      }
      continue;
    }

    // Большая группа: три ступени кандидатов (план 12) вместо одной.
    // Порог и функция сравнения не изменились — меняется только то, какие
    // пары до сравнения доходят.
    //
    // Предел на узел: у каждого узла свой топ-50 пар по убыванию схожести
    // (при равенстве — найденная раньше). Пара выбывает из выдачи, как только
    // вытеснена хотя бы у одного конца; первое вытеснение увеличивает
    // candidates_truncated, повторное — нет.
    type Kept = { key: string; sim: number; i: number; j: number };
    const kept = new Map<number, Kept[]>();
    const keptKeys = new Map<number, Set<string>>();
    const dead = new Set<string>();
    const countTruncated = (key: string): void => {
      if (!dead.has(key)) {
        dead.add(key);
        truncated += 1;
      }
    };
    const keepFor = (node: number, pair: Kept): boolean => {
      const arr = kept.get(node) ?? [];
      if (arr.length >= MAX_CANDIDATES_PER_NODE) {
        let worst = 0;
        for (let k = 1; k < arr.length; k++) {
          // худшая — минимальная схожесть, при равенстве более поздняя
          if (arr[k].sim < arr[worst].sim || (arr[k].sim === arr[worst].sim && k > worst)) {
            worst = k;
          }
        }
        const min = arr[worst];
        if (pair.sim <= min.sim) {
          // новому месту нет: пара не лучше худшей из топа
          countTruncated(pair.key);
          return false;
        }
        arr.splice(worst, 1);
        keptKeys.get(node)!.delete(min.key);
        countTruncated(min.key);
      }
      arr.push(pair);
      kept.set(node, arr);
      if (!keptKeys.has(node)) keptKeys.set(node, new Set());
      keptKeys.get(node)!.add(pair.key);
      return true;
    };

    /**
     * Единый путь пары из любой ступени: сравнение как раньше (косинус,
     * векторы нужны с обеих сторон), дедупликация между ступенями (одна пара
     * может найтись в нескольких) и поток в общий предел на узел. Вызывается
     * с i < j — ключ пары и обход kept предполагают «хозяин — меньший индекс».
     */
    const feedPair = (i: number, j: number): void => {
      const va = toVector(group[i].embedding);
      const vb = toVector(group[j].embedding);
      if (!va || !vb) return; // consolidation needs vectors on both sides
      const sim = cosine(va, vb);
      if (sim < threshold) return;
      const key = `${i}|${j}`;
      if (dead.has(key)) return;
      if (keptKeys.get(i)?.has(key) || keptKeys.get(j)?.has(key)) return;
      // Второй keepFor при отвержении первым уже не зовётся — пара мертва
      // в любом случае (нужна оба конца), счётчик не задвоен dead-набором.
      keepFor(i, { key, sim, i, j }) && keepFor(j, { key, sim, i, j });
    };

    // Есть ли в группе векторы: без них сравнение невозможно в принципе,
    // ступени B/C пропускаются целиком (FTS-режим — не ошибка, а режим).
    // Проверка через toVector: libsql отдаёт embedding то Buffer, то
    // ArrayBuffer — у последнего нет .length, только .byteLength.
    const groupHasVectors = group.some((r) => toVector(r.embedding) !== null);

    // Ступень A: точное имя. Блоки по нормализованному имени, пары только
    // внутри блока — 10 000 корней с разными именами не квадрат.
    const blocks = new Map<string, number[]>();
    for (let idx = 0; idx < group.length; idx++) {
      const key = nameBlockKey(group[idx].name);
      const block = blocks.get(key) ?? [];
      block.push(idx);
      blocks.set(key, block);
    }

    for (const block of blocks.values()) {
      for (let p = 0; p < block.length; p++) {
        const i = block[p];
        const windowEnd = Math.min(block.length, p + 1 + BLOCK_WINDOW);
        for (let q = p + 1; q < windowEnd; q++) {
          feedPair(i, block[q]);
        }
      }
    }

    // Ступень B: триграммы. Инвертированный индекс «триграмма нормализо-
    // ванного имени → список id» строится один раз на группу и живёт только
    // в памяти вызова. Кандидаты для узла i — ранее обработанные узлы (j < i),
    // у которых с ним не меньше K общих триграмм. Опечатки и перестановки
    // слов сохраняют внутренние триграммы — такие пары дошли до сравнения.
    if (groupHasVectors) {
      const postings = new Map<string, number[]>();
      const banned = new Set<string>();
      for (let i = 0; i < group.length; i++) {
        const grams = [...new Set(nameTrigrams(group[i].name))];
        if (grams.length > 0) {
          const counts = new Map<number, number>();
          for (const g of grams) {
            const post = postings.get(g);
            if (!post) continue;
            for (const j of post) counts.set(j, (counts.get(j) ?? 0) + 1);
          }
          for (const [j, c] of counts) {
            if (c >= TRIGRAM_MIN_SHARED) feedPair(j, i);
          }
        }
        for (const g of grams) {
          if (banned.has(g)) continue;
          const post = postings.get(g);
          if (post === undefined) postings.set(g, [i]);
          else if (post.length < TRIGRAM_MAX_DF) post.push(i);
          else {
            postings.delete(g);
            banned.add(g);
          }
        }
      }
    }

    // Финал: пара выдаётся, если осталась в топе ОБОИХ концов. Порядок
    // детерминирован обходом kept (владелец пары — меньший индекс).
    const blockCandidates: DuplicateCandidate[] = [];
    for (const [node, arr] of kept) {
      for (const pair of arr) {
        if (pair.i !== node) continue; // хозяин пары — меньший индекс
        if (keptKeys.get(pair.j)?.has(pair.key)) {
          blockCandidates.push(buildCandidate(group[pair.i], group[pair.j], pair.sim));
        }
      }
    }
    for (const cand of blockCandidates) {
      if (candidates.length >= limit) {
        // Пара найдена, но глобальный limit исчерпан — тоже честно считаем.
        truncated += 1;
        continue;
      }
      candidates.push(cand);
    }
    if (candidates.length >= limit) {
      return { candidates, candidates_truncated: truncated };
    }
  }
  return { candidates, candidates_truncated: truncated };
}

export interface MergeNodesResult {
  survivor: string;
  removed: string;
}

/**
 * F-03 (план 03, S-08): self-consolidation and dead participants are rejected
 * BEFORE the transaction — `mergeNodes(db, 'only', 'only')` used to pass both
 * lookups, "merge" the node into itself and then hard-delete it.
 */
function assertConsolidatable(
  db: KnowledgeDB,
  survivorId: string,
  otherId: string
): void {
  if (survivorId === otherId) {
    throw new Error(
      `Cannot consolidate "${survivorId}" into itself — survivor and duplicate must be distinct live nodes.`
    );
  }
  const survivor = db.getNode(survivorId);
  const other = db.getNodeIncludingRemoved(otherId);
  if (!survivor || !other) {
    throw new Error(`Cannot merge: node not found (${survivorId} / ${otherId}).`);
  }
  if (survivor.removed_at !== null || other.removed_at !== null) {
    const state = (n: NodeRow) => (n.removed_at !== null ? "removed" : "live");
    throw new Error(
      `Cannot merge: both nodes must be alive ` +
        `(${survivorId}: ${state(survivor)}, ${otherId}: ${state(other)}).`
    );
  }
}

/**
 * F-03 (план 03): перенос workflow-состояния удаляемого узла на выжившего.
 * Дети, слоты, участники сохранённых цепочек, артефакты, снимки опор и
 * алиасы не должны исчезать молча вместе с узлом (FK обнулил бы детей,
 * слот и членство в цепочке потеряли бы исполнителя). Рёбра не трогаются:
 * их переносит вызывающая сторона, которая знает, живут ли копии.
 *
 * Снимки опор (support_baselines) без OR IGNORE-коллизии переезжают на
 * выжившего; несместившиеся строки остаются с id удалённого узла как явное
 * свидетельство утраты — таблица без FK и существует именно для этого.
 * Задача: состояние выжившего приоритетно, дубликат заполняет только пустое.
 */
export function transferNodeIdentity(
  db: KnowledgeDB,
  fromId: string,
  toId: string
): void {
  // Survivor inside the removed node's subtree would turn the subtree into a
  // parent cycle — refuse the whole operation instead of corrupting the hierarchy.
  let cursor: NodeRow | undefined = db.getNodeIncludingRemoved(toId);
  const seen = new Set<string>();
  while (cursor?.parent_id) {
    if (cursor.parent_id === fromId || seen.has(cursor.parent_id)) {
      throw new Error(
        `Cannot merge "${fromId}" into "${toId}": the survivor lies inside the removed node's subtree — the hierarchy would become a cycle.`
      );
    }
    seen.add(cursor.parent_id);
    cursor = db.getNodeIncludingRemoved(cursor.parent_id);
  }

  db.execSqlRun(
    "UPDATE nodes SET parent_id = ?, updated_at = datetime('now') WHERE parent_id = ? AND id != ?",
    toId,
    fromId,
    toId
  );
  db.execSqlRun(
    "UPDATE slots SET node_id = ?, updated_at = datetime('now') WHERE node_id = ?",
    toId,
    fromId
  );
  // Fingerprints travel verbatim: the saved reasoning stays as saved; the
  // staleness check is trail_refresh's explicit job, not a silent rewrite.
  db.execSqlRun(
    "UPDATE trail_members SET node_id = ? WHERE node_id = ?",
    toId,
    fromId
  );
  // OR IGNORE: a colliding observation (node_id, kind, ref) means the survivor
  // already tracks that artifact — the duplicate row is the same observation,
  // the leftover is removed with the node.
  db.execSqlRun(
    "UPDATE OR IGNORE node_artifacts SET node_id = ? WHERE node_id = ?",
    toId,
    fromId
  );
  db.execSqlRun("DELETE FROM node_artifacts WHERE node_id = ?", fromId);
  db.execSqlRun(
    "UPDATE OR IGNORE support_baselines SET decision_id = ? WHERE decision_id = ?",
    toId,
    fromId
  );
  db.execSqlRun(
    "UPDATE OR IGNORE support_baselines SET support_id = ? WHERE support_id = ?",
    toId,
    fromId
  );
  db.execSqlRun(
    "UPDATE aliases SET new_id = ? WHERE new_id = ?",
    toId,
    fromId
  );

  const survivor = db.getNode(toId);
  const from = db.getNodeIncludingRemoved(fromId);
  if (
    survivor &&
    from &&
    (survivor.task_state ?? null) === null &&
    (from.task_state ?? null) !== null
  ) {
    db.execSqlRun(
      "UPDATE nodes SET task_state = ?, due_at = ?, updated_at = datetime('now') WHERE id = ?",
      from.task_state,
      from.due_at,
      toId
    );
  }
}

/**
 * F-03 (план 03, S-06): перенос рёбер удаляемого варианта на выжившего
 * identity — живые и надгробия, вербатим (created_via/accepted_at/removed_at),
 * чтобы утраченная опора не исчезала из провенанса и «связей нет» не
 * превращалось в ложный complete. Дедуп полагается на уникальный индекс
 * (from_id, to_id, relation): пара, уже стоящая у выжившего, не создаётся
 * второй раз — копия варианта уходит вместе с ним; надгробие выжившего при
 * этом не воскрешается (та же политика, что и в merge, F20).
 * Возвращает число фактически перенесённых строк.
 */
export function moveNodeEdges(
  db: KnowledgeDB,
  fromId: string,
  toId: string
): number {
  const edges = db
    .getAllEdgesRaw()
    .filter((e) => e.from_id === fromId || e.to_id === fromId);
  let moved = 0;
  for (const e of edges) {
    const from = e.from_id === fromId ? toId : e.from_id;
    const to = e.to_id === fromId ? toId : e.to_id;
    if (from === to) continue; // самопетля после ремапа — не свидетельство
    const res = db.insertEdgeRaw({
      from_id: from,
      to_id: to,
      relation: e.relation,
      description: e.description,
      created_at: e.created_at,
      merge_group: e.merge_group,
      needs_merge: e.needs_merge,
      source_branch: e.source_branch,
      merge_timestamp: e.merge_timestamp,
      removed_at: e.removed_at,
      created_via: e.created_via ?? "unknown",
      accepted_at: e.accepted_at ?? null,
    });
    if (res.inserted) moved++;
  }
  return moved;
}

/**
 * UX-01 (план 07), шаг 0: планировщик последствий слияния — чистая функция
 * от списков узлов и рёбер. Её вызывают и preview (describeConsolidation),
 * и apply (mergeNodes): пока preview и apply считают разными путями,
 * интерфейс обещает одно, а merge делает другое. Всё, что применит
 * applyConsolidationPlan, уже решено здесь — включая порядок переносов
 * рёбер и предсказуемые отказы informed_by.
 */
export interface ConsolidationPlanBase {
  /**
   * Дайджест входа планировщика — авторитетная привязка apply к preview:
   * POST возвращает его, и merge отказывает version_conflict, если вход
   * (карточки, рёбра, дети, workflow-счётчики) изменился. updated_at имеет
   * секундное разрешение, поэтому токены ниже — только диагностика.
   */
  digest?: string;
  /** Версии карточек (updated_at), против которых посчитан план. */
  survivor_updated_at: string | null;
  other_updated_at: string | null;
}

export interface PlannedEdgeMove {
  from_id: string;
  to_id: string;
  relation: string;
  description: string | null;
}

export interface ConsolidationPlan {
  survivor: string;
  other: string;
  base: ConsolidationPlanBase;
  /** Контент дубля войдёт в саммари выжившего. */
  summaryCombines: boolean;
  /** Полный текст summary выжившего после слияния. */
  finalSummary: string;
  /** Откуда берётся why выжившего (та же семантика `??`, что в apply). */
  whySource: "survivor" | "other" | "none";
  finalWhy: string | null;
  /** Итоговый объединённый список file_refs выжившего. */
  fileRefs: string[];
  /** Ссылки дубля, которые добавятся к выжившему. */
  refsAdded: string[];
  /** Рёбра дубля, которые переедут (концы уже перемаплены на выжившего). */
  edgesToMove: PlannedEdgeMove[];
  /** Живые рёбра дубля, которые НЕ переедут (самопетля/дубль у выжившего). */
  edgesDropped: number;
  /** Дети дубля, которые переедут под выжившего. */
  children: Array<{ id: string; name: string }>;
  slots: Array<{ project: string; role: string }>;
  trailMembers: number;
  artifacts: number;
  baselines: number;
  /** Состояние задачи дубля переедет (у выжившего пусто). */
  taskCarries: boolean;
  taskState: string | null;
  dueAt: string | null;
  /** Lifecycle/epistemic статус дубля расходится — он НЕ переносится. */
  statusDiverges: boolean;
  /** Перенесённые подтверждения покажут claim_changed: формулировки разные. */
  confirmationsAffected: boolean;
  /** Отказ и его причина — до транзакции, ничего не пишется. */
  rejection?: string;
}

export interface ConsolidationPlanInput {
  survivor: NodeRow;
  other: NodeRow;
  /** Все строки узлов базы (живые и надгробия) — живость концов и дети. */
  nodes: NodeRow[];
  /** Все строки рёбер базы (живые и надгробия). */
  edges: EdgeRow[];
  workflow: {
    slots: Array<{ project: string; role: string }>;
    trailMembers: number;
    artifacts: number;
    baselines: number;
  };
}

function parseRefsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Итеративная достижимость по живому слою informed_by (как informedByReaches). */
function informedByReaches(
  adj: Map<string, string[]>,
  start: string,
  target: string
): boolean {
  if (start === target) return true;
  const visited = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const next of adj.get(current) ?? []) {
      if (next === target) return true;
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/** node лежит на живом цикле informed_by ⟺ член нетривиальной SCC. */
function onInformedByCycle(adj: Map<string, string[]>, node: string): boolean {
  const visited = new Set<string>();
  const stack = [...(adj.get(node) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === node) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adj.get(current) ?? []));
  }
  return false;
}

/**
 * Дайджест входа планировщика: всё, что потребляет planConsolidation и
 * применяет applyConsolidationPlan. Канонический JSON (ключи отсортированы,
 * embedding исключён — план его не читает), sha256. Совпадение дайджеста
 * между preview и confirm гарантирует: применяется ровно тот план, что
 * был показан. K-10: это дайджест ВХОДА, а не current_digests.claim
 * старого снимка — «подтверждённая формулировка» тут ни при чём.
 */
function consolidationStateDigest(input: ConsolidationPlanInput): string {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (value instanceof Buffer || value instanceof ArrayBuffer) return undefined;
    const record = value as Record<string, unknown>;
    if (ArrayBuffer.isView(record)) return undefined; // TypedArray (embedding)
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])])
        .filter(([, v]) => v !== undefined)
    );
  };
  const shape = {
    survivor: canonical({ ...input.survivor, embedding: null }),
    other: canonical({ ...input.other, embedding: null }),
    nodes: input.nodes
      .map((n) => ({ id: n.id, removed_at: n.removed_at ?? null, parent_id: n.parent_id ?? null }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: input.edges
      .map((e) => ({
        id: e.id,
        from_id: e.from_id,
        to_id: e.to_id,
        relation: e.relation,
        description: e.description ?? null,
        removed_at: e.removed_at ?? null,
      }))
      .sort((a, b) => a.id - b.id),
    workflow: input.workflow,
  };
  return createHash("sha256").update(JSON.stringify(shape), "utf8").digest("hex");
}

export function planConsolidation(input: ConsolidationPlanInput): ConsolidationPlan {
  const { survivor, other, nodes, edges, workflow } = input;
  const base: ConsolidationPlanBase = {
    digest: consolidationStateDigest(input),
    survivor_updated_at: survivor.updated_at ?? null,
    other_updated_at: other.updated_at ?? null,
  };

  const summaryCombines =
    !!other.summary &&
    !survivor.summary.includes(other.summary) &&
    other.summary !== survivor.summary;
  const finalSummary = summaryCombines
    ? `${survivor.summary}\n\n${other.summary}`
    : survivor.summary;
  // Та же семантика `??`, что в apply: пустая строка — это значение survivor.
  const finalWhy = survivor.why ?? other.why;
  const whySource =
    survivor.why != null ? "survivor" : other.why != null ? "other" : "none";

  const survivorRefs = parseRefsJson(survivor.file_refs);
  const otherRefs = parseRefsJson(other.file_refs);
  const fileRefs = [...new Set([...survivorRefs, ...otherRefs])];
  const survivorRefSet = new Set(survivorRefs);
  const refsAdded = [...new Set(otherRefs)].filter((r) => !survivorRefSet.has(r));

  // Живые узлы — фильтр концов тот же, что в getOutgoingEdges/getIncomingEdges:
  // живое ребро с живым дальним концом. Надгробия не переезжают (apply их
  // никогда не переносил — preview раньше считал их и обещал лишнее).
  const liveNodes = new Set(
    nodes.filter((n) => n.removed_at === null).map((n) => n.id)
  );

  const existingKeys = new Set(
    edges
      .filter(
        (e) =>
          e.removed_at === null &&
          (e.from_id === survivor.id || e.to_id === survivor.id) &&
          liveNodes.has(e.from_id) &&
          liveNodes.has(e.to_id)
      )
      .map((e) => `${e.from_id}|${e.to_id}|${e.relation}`)
  );

  const liveTouched = edges
    .filter(
      (e) =>
        e.removed_at === null &&
        (e.from_id === other.id || e.to_id === other.id) &&
        liveNodes.has(e.from_id === other.id ? e.to_id : e.from_id)
    )
    .sort((a, b) => a.id - b.id);

  const edgesToMove: PlannedEdgeMove[] = [];
  const movedKeys = new Set<string>();
  let edgesDropped = 0;
  for (const e of liveTouched) {
    const from = e.from_id === other.id ? survivor.id : e.from_id;
    const to = e.to_id === other.id ? survivor.id : e.to_id;
    if (from === to) {
      edgesDropped++;
      continue;
    }
    const key = `${from}|${to}|${e.relation}`;
    if (existingKeys.has(key) || movedKeys.has(key)) {
      edgesDropped++;
      continue;
    }
    movedKeys.add(key);
    edgesToMove.push({
      from_id: from,
      to_id: to,
      relation: e.relation,
      description: e.description,
    });
  }

  // Дети — из списка узлов, тем же условием, которым transferNodeIdentity
  // делает UPDATE: parent_id = дубль AND id != выживший.
  const children = nodes
    .filter((n) => n.parent_id === other.id && n.id !== survivor.id)
    .map((n) => ({ id: n.id, name: n.name }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const taskCarries =
    (survivor.task_state ?? null) === null && (other.task_state ?? null) !== null;

  const plan: ConsolidationPlan = {
    survivor: survivor.id,
    other: other.id,
    base,
    summaryCombines,
    finalSummary,
    whySource,
    finalWhy,
    fileRefs,
    refsAdded,
    edgesToMove,
    edgesDropped,
    children,
    slots: workflow.slots,
    trailMembers: workflow.trailMembers,
    artifacts: workflow.artifacts,
    baselines: workflow.baselines,
    taskCarries,
    taskState: taskCarries ? other.task_state ?? null : null,
    dueAt: taskCarries ? other.due_at ?? null : null,
    statusDiverges:
      (survivor.status ?? "active") !== (other.status ?? "active") ||
      (survivor.epistemic_status ?? null) !== (other.epistemic_status ?? null),
    confirmationsAffected:
      workflow.baselines > 0 && (other.summary ?? "") !== survivor.summary,
  };

  // Предсказуемые отказы переносов informed_by: apply вставляет рёбра в
  // состоянии ПОСЛЕ слияния (рёбра дубля уже удалены, выживший жив), и
  // insertEdge прогоняет assertInformedByWritable против этого состояния.
  // Планировщик проверяет те же инварианты над тем же состоянием, чтобы
  // preview не обещал merge, который атомарно откатится.
  const ibAdj = new Map<string, string[]>();
  for (const e of edges) {
    if (
      e.relation !== "informed_by" ||
      e.removed_at !== null ||
      e.from_id === other.id ||
      e.to_id === other.id ||
      !liveNodes.has(e.from_id) ||
      !liveNodes.has(e.to_id)
    ) {
      continue;
    }
    const list = ibAdj.get(e.from_id) ?? [];
    list.push(e.to_id);
    ibAdj.set(e.from_id, list);
  }
  for (const move of plan.edgesToMove) {
    if (move.relation !== "informed_by") continue;
    const rejection = informedByMoveRejection(ibAdj, move);
    if (rejection) {
      return rejectedPlan(survivor.id, other.id, base, rejection);
    }
    const list = ibAdj.get(move.from_id) ?? [];
    list.push(move.to_id);
    ibAdj.set(move.from_id, list);
  }

  return plan;
}

/** Те же проверки, что assertInformedByWritable делает на вставке переноса. */
function informedByMoveRejection(
  ibAdj: Map<string, string[]>,
  move: PlannedEdgeMove
): string | undefined {
  if (!move.description || move.description.trim().length === 0) {
    return (
      `informed_by: рационал обязателен — что именно в узле-to поддерживает from. ` +
      `Перенос "${move.from_id}" -> "${move.to_id}" отклонён, слияние не выполнено.`
    );
  }
  if (informedByReaches(ibAdj, move.to_id, move.from_id)) {
    return (
      `informed_by cycle rejected: "${move.to_id}" already reaches "${move.from_id}" over live ` +
      `informed_by edges — adding "${move.from_id} -> ${move.to_id}" would close a cycle.`
    );
  }
  if (onInformedByCycle(ibAdj, move.to_id)) {
    return (
      `informed_by write rejected: "${move.to_id}" sits inside an unresolved ` +
      `informed_by cycle (needs_merge). Resolve the merge conflict first, then retry.`
    );
  }
  return undefined;
}

function rejectedPlan(
  survivorId: string,
  otherId: string,
  base: ConsolidationPlanBase,
  rejection: string
): ConsolidationPlan {
  return {
    survivor: survivorId,
    other: otherId,
    base,
    summaryCombines: false,
    finalSummary: "",
    whySource: "none",
    finalWhy: null,
    fileRefs: [],
    refsAdded: [],
    edgesToMove: [],
    edgesDropped: 0,
    children: [],
    slots: [],
    trailMembers: 0,
    artifacts: 0,
    baselines: 0,
    taskCarries: false,
    taskState: null,
    dueAt: null,
    statusDiverges: false,
    confirmationsAffected: false,
    rejection,
  };
}

/**
 * Валидация, одинаковая для preview и apply: самослияние, мёртвые участники,
 * цикл по поддереву. Возвращает текст отказа или undefined. Тексты — те же,
 * что бросали assertConsolidatable и transferNodeIdentity (S-08, план 03).
 */
function consolidationRejection(
  db: KnowledgeDB,
  survivorId: string,
  otherId: string
): string | undefined {
  try {
    assertConsolidatable(db, survivorId, otherId);
    // Цикл по поддереву — та же проверка, что в transferNodeIdentity.
    let cursor = db.getNodeIncludingRemoved(survivorId);
    const seen = new Set<string>();
    while (cursor?.parent_id) {
      if (cursor.parent_id === otherId || seen.has(cursor.parent_id)) {
        return `Cannot merge "${otherId}" into "${survivorId}": the survivor lies inside the removed node's subtree — the hierarchy would become a cycle.`;
      }
      seen.add(cursor.parent_id);
      cursor = db.getNodeIncludingRemoved(cursor.parent_id);
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return undefined;
}

/**
 * Workflow-счётчики для планировщика — теми же запросами, которыми
 * transferNodeIdentity переносит строки. И preview, и apply собирают их
 * одинаково.
 */
function collectWorkflowCounts(
  db: KnowledgeDB,
  otherId: string
): ConsolidationPlanInput["workflow"] {
  return {
    slots: (
      db.execSqlAll(
        "SELECT project, role FROM slots WHERE node_id = ?",
        otherId
      ) as Array<{ project: string; role: string }>
    ).map((s) => ({ ...s })),
    trailMembers: (
      db.execSqlFirst(
        "SELECT COUNT(*) AS n FROM trail_members WHERE node_id = ?",
        otherId
      ) as { n: number }
    ).n,
    artifacts: (
      db.execSqlFirst(
        "SELECT COUNT(*) AS n FROM node_artifacts WHERE node_id = ?",
        otherId
      ) as { n: number }
    ).n,
    baselines: (
      db.execSqlFirst(
        "SELECT COUNT(*) AS n FROM support_baselines WHERE decision_id = ? OR support_id = ?",
        otherId,
        otherId
      ) as { n: number }
    ).n,
  };
}

/**
 * F-03.6 (план 03), UX-01 (план 07): read-only описание последствий слияния
 * для preview. Валидация — та же, что в apply; последствия считает
 * planConsolidation — та же чистая функция, которой применяет mergeNodes.
 * Ни граф, ни снимки, ни история не пишутся.
 */
export function describeConsolidation(
  db: KnowledgeDB,
  survivorId: string,
  otherId: string
): ConsolidationPlan {
  const rejection = consolidationRejection(db, survivorId, otherId);
  const survivor = db.getNodeIncludingRemoved(survivorId);
  const other = db.getNodeIncludingRemoved(otherId);
  const base: ConsolidationPlanBase = {
    survivor_updated_at: survivor?.updated_at ?? null,
    other_updated_at: other?.updated_at ?? null,
  };
  if (rejection || !survivor || !other) {
    return rejectedPlan(
      survivorId,
      otherId,
      base,
      rejection ?? `Cannot merge: node not found (${survivorId} / ${otherId}).`
    );
  }

  return planConsolidation({
    survivor,
    other,
    nodes: db.getAllNodesRaw(),
    edges: db.getAllEdgesRaw(),
    workflow: collectWorkflowCounts(db, otherId),
  });
}

/**
 * UX-01 (план 07): нода изменилась или удалена между preview и confirm.
 * Атомарный отказ до первой записи — POST несёт версии карточек/плана
 * (updated_at), и merge отказывает 409, а не применяет устаревший план.
 */
export class VersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionConflictError";
  }
}

export interface MergeNodesExpect {
  /**
   * Авторитетная привязка к версии плана (plan.base.digest): вход
   * планировщика должен быть байт-в-байт тем же, что на preview.
   */
  digest?: string;
  /**
   * Запасные токены для вызовов без дайджеста. updated_at пишется с
   * секундным разрешением — изменение в ту же секунду токен не меняет,
   * поэтому при наличии digest токены не проверяются.
   */
  survivor_updated_at?: string | null;
  other_updated_at?: string | null;
}

export interface MergeNodesOptions {
  /**
   * Версии, на которых пользователь подтверждал preview (plan.base).
   * Отсутствие — CLI-вызов без preview, проверка не проводится.
   */
  expect?: MergeNodesExpect;
}

/**
 * Применяет готовый план. Вызывается ТОЛЬКО внутри транзакции mergeNodes;
 * порядок переносов — как решил planConsolidation, чтобы проверка
 * informed_by в insertEdge шла против того же состояния, против которого
 * планировщик считал достижимость (рёбра дубля уже удалены).
 */
function applyConsolidationPlan(db: KnowledgeDB, plan: ConsolidationPlan): void {
  db.updateNode(plan.survivor, {
    summary: plan.finalSummary,
    why: plan.finalWhy ?? undefined,
    file_refs: plan.fileRefs.length > 0 ? plan.fileRefs : undefined,
  });

  // F-03: дети, слоты, цепочки, артефакты, снимки и алиасы следуют за
  // выжившим — участники не теряются молча вместе с дублем.
  transferNodeIdentity(db, plan.other, plan.survivor);

  // hardDeleteNode removes remaining edges of the other node — рёбра дубля
  // уходят ДО переносов, чтобы informed_by-проверки видели итоговый граф.
  db.hardDeleteNode(plan.other);

  for (const edge of plan.edgesToMove) {
    db.insertEdge({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      description: edge.description,
      // Plan 4 v8 §1.3: a server-side re-creation during consolidation —
      // the original row's origin is gone with it, so the new row is
      // honestly 'unknown', not laundered into 'agent'.
      via: "unknown",
    });
  }
}

/**
 * Merge node `other` into `survivor`: combine summary/why/file_refs, move
 * edges, hard-delete the other node. Caller decides which one survives —
 * findDuplicates marks the older one.
 *
 * UX-01 (план 07): последствия считает planConsolidation — та же чистая
 * функция, что и у preview; apply исполняет готовый план, ничего не
 * пересчитывая. С opts.expect отказ version_conflict атомарен: проверка
 * версий — первое действие внутри BEGIN IMMEDIATE, до любой записи.
 */
export function mergeNodes(
  db: KnowledgeDB,
  survivorId: string,
  otherId: string,
  options?: MergeNodesOptions
): MergeNodesResult {
  db.runInTransaction(() => {
    // Stale preview: привязка к версии плана проверяется до валидации
    // слияния — изменённая/удалённая нода отвечает version_conflict, а не
    // общим 400, и ни одна запись не делается.
    if (options?.expect) {
      const conflict = (reason: string): VersionConflictError =>
        new VersionConflictError(
          `version_conflict: ${reason} Nothing was written — re-read the cards and confirm again.`
        );
      const survivorNow = db.getNodeIncludingRemoved(survivorId);
      const otherNow = db.getNodeIncludingRemoved(otherId);
      if (!survivorNow) throw conflict(`node "${survivorId}" no longer exists.`);
      if (!otherNow) throw conflict(`node "${otherId}" no longer exists.`);
      const inputNow = {
        survivor: survivorNow,
        other: otherNow,
        nodes: db.getAllNodesRaw(),
        edges: db.getAllEdgesRaw(),
        workflow: collectWorkflowCounts(db, otherId),
      };
      if (
        options.expect.digest !== undefined &&
        consolidationStateDigest(inputNow) !== options.expect.digest
      ) {
        throw conflict(
          `the merge inputs changed since the preview (survivor "${survivorId}", other "${otherId}").`
        );
      }
      // Запасные токены — только когда дайджеста нет (клиент без preview-плана).
      if (options.expect.digest === undefined) {
        if (
          options.expect.survivor_updated_at !== undefined &&
          (survivorNow.updated_at ?? null) !== options.expect.survivor_updated_at
        ) {
          throw conflict(`node "${survivorId}" changed since the preview.`);
        }
        if (
          options.expect.other_updated_at !== undefined &&
          (otherNow.updated_at ?? null) !== options.expect.other_updated_at
        ) {
          throw conflict(`node "${otherId}" changed since the preview.`);
        }
      }
    }
    // S-08: самослияние и мёртвые участники отвергаются без единой записи;
    // повторный запрос по уже удалённому узлу тоже сюда попадает.
    const rejection = consolidationRejection(db, survivorId, otherId);
    if (rejection) {
      throw new Error(rejection);
    }
    const survivor = db.getNode(survivorId)!;
    const other = db.getNodeIncludingRemoved(otherId)!;
    const plan = planConsolidation({
      survivor,
      other,
      nodes: db.getAllNodesRaw(),
      edges: db.getAllEdgesRaw(),
      workflow: collectWorkflowCounts(db, otherId),
    });
    if (plan.rejection) {
      // Предсказанный отказ переносов informed_by — тот же атомарный отказ,
      // который раньше случился бы на вставке внутри этой же транзакции.
      throw new Error(plan.rejection);
    }
    applyConsolidationPlan(db, plan);
  });

  return { survivor: survivorId, removed: otherId };
}
