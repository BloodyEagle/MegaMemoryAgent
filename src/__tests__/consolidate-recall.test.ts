import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { findDuplicates } from "../consolidate.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

/**
 * План 12 (R-06b): recall качества поиска дублей в больших группах.
 *
 * План 09 заменил квадратичный проход блокингом по нормализованному имени —
 * в группах от 200 узлов пары с разными блоками больше не сравниваются
 * вовсе. Фикстура: 10 000 корневых узлов, 100 заранее известных пар-дублей
 * четырёх типов (30 опечаток, 30 перестановок слов, 20 синонимов, 20
 * разного написания). Метрика — recall по 100 парам; требование плана —
 * ≥ 95 при включённых эмбеддингах. Пары без эмбеддингов считаются
 * отдельно: сравнение в findDuplicates по-прежнему требует векторы с
 * обеих сторон, поэтому FTS-режим честно даёт ноль кандидатов.
 *
 * Все имена и векторы порождаются seeded-PRNG — фикстура детерминирована,
 * результат воспроизводим между прогонами.
 */

// ---- детерминированный PRNG (тот же алгоритм, что в LSH ступени C) ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = 24;

function unitVector(rnd: () => number): Float32Array {
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    v[i] = rnd() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

/** Вектор, близкий к базовому: b + eps*u, перенормированный (cos ≈ 1 - eps²/2). */
function closeVector(rnd: () => number, base: Float32Array, eps: number): Float32Array {
  const noise = unitVector(rnd);
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    v[i] = base[i] + eps * noise[i];
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

function embeddingBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

// ---- имена фикстуры ----

const WORDS = [
  "кеш", "очередь", "аренда", "журнал", "реестр", "шлюз", "контур", "лимит",
  "квота", "снимок", "миграция", "воркер", "таймаут", "ретрай", "дайджест",
  "инвалидация", "партиция", "схема", "индекс", "транзакция",
];

/** Однобуквенная опечатка: первая гласная слова заменяется на соседнюю. */
function typoWord(word: string): string {
  const map: Record<string, string> = { о: "а", а: "о", е: "и", и: "е", у: "ю", ю: "у" };
  for (let i = 0; i < word.length; i++) {
    const repl = map[word[i]];
    if (repl) return word.slice(0, i) + repl + word.slice(i + 1);
  }
  return word + "ъ";
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export type DupKind = "typo" | "perm" | "synonym" | "spelling";

export interface ExpectedPair {
  idA: string;
  idB: string;
  kind: DupKind;
}

interface RecallFixture {
  db: KnowledgeDB;
  tmpDir: string;
  pairs: ExpectedPair[];
}

/**
 * 10 000 корневых узлов (одна большая группа — блокинг и ступени активны).
 * Сначала 200 конечных точек известных пар (их редкие serial-триграммы не
 * вытесняются из postings лимитом частоты), затем 9 800 наполнителей.
 */
function buildRecallDb(withEmbeddings: boolean): RecallFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-recall-"));
  const db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);

  const pairs: ExpectedPair[] = [];
  const rows: Array<{ id: string; name: string; vec: Float32Array | null }> = [];
  const rnd = mulberry32(0x1234abcd);

  // 100 известных пар: типы по 30/30/20/20 (как в плане 12).
  for (let k = 0; k < 100; k++) {
    const idA = `dup-${k}-a`;
    const idB = `dup-${k}-b`;
    const base = unitVector(rnd);
    // eps 0.08 → косинус в паре ≈ 0.997 — «близкий вектор» по плану.
    const vecA = base;
    const vecB = closeVector(rnd, base, 0.08);
    let kind: DupKind;
    let nameA: string;
    let nameB: string;
    if (k < 30) {
      // опечатка в одном слове
      kind = "typo";
      const w = WORDS[k % WORDS.length];
      const s = `т${pad3(k + 1)}`;
      nameA = `Ревизия ${w} ${s}`;
      nameB = `Ревизия ${typoWord(w)} ${s}`;
    } else if (k < 60) {
      // перестановка слов
      kind = "perm";
      const w1 = WORDS[(k * 3 + 1) % WORDS.length];
      const w2 = WORDS[(k * 7 + 5) % WORDS.length];
      const s = `п${pad3(k + 1)}`;
      nameA = `${w1} ${s} ${w2} очередь`;
      nameB = `очередь ${w2} ${s} ${w1}`;
    } else if (k < 80) {
      // синоним: вектор близок, имя общих триграмм не имеет
      kind = "synonym";
      const n1 = 160 + (k - 80);
      const n2 = 260 + (k - 80);
      nameA = `Аутентификация запроса ${n1}`;
      nameB = `Авторизация доступа ${n2}`;
    } else {
      // разное написание/регистр/пунктуация — один нормализованный блок
      kind = "spelling";
      const s = `р${pad3(k + 1)}`;
      nameA = `Отчёт реестр ${s}`;
      nameB = `отчёт   —реестр!! ${s}`;
    }
    pairs.push({ idA, idB, kind });
    rows.push({ id: idA, name: nameA, vec: vecA });
    rows.push({ id: idB, name: nameB, vec: vecB });
  }

  // 9 800 наполнителей: случайные векторы (косинус между случайными
  // направлениями в 24-мерном пространстве ниже порога с огромным запасом),
  // имена из общего пула слов — частота их триграмм уходит за лимит индекса.
  for (let i = 0; i < 9800; i++) {
    const w1 = WORDS[Math.floor(rnd() * WORDS.length)];
    const w2 = WORDS[Math.floor(rnd() * WORDS.length)];
    const w3 = WORDS[Math.floor(rnd() * WORDS.length)];
    rows.push({
      id: `filler-${i}`,
      name: `Заметка ${i + 1} ${w1} ${w2} ${w3}`,
      vec: withEmbeddings ? unitVector(rnd) : null,
    });
  }

  db.runInTransaction(() => {
    for (const row of rows) {
      db.insertNode({
        id: row.id,
        name: row.name,
        kind: "convention",
        summary: `Фикстура recall: ${row.name}`,
        embedding: withEmbeddings && row.vec ? embeddingBuffer(row.vec) : null,
        created_via: "file_ref",
      });
    }
  });

  return { db, tmpDir, pairs };
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

let cleanupDir: string | null = null;
let cleanupDb: KnowledgeDB | null = null;

afterEach(async () => {
  if (cleanupDb && cleanupDir) {
    await closeAndCleanup(cleanupDb, cleanupDir);
    cleanupDb = null;
    cleanupDir = null;
  }
});

function track(db: KnowledgeDB, tmpDir: string): void {
  cleanupDb = db;
  cleanupDir = tmpDir;
}

describe("recall поиска дублей (план 12, R-06b)", () => {
  it("10 000 узлов, 100 известных пар: recall ≥ 95, ложных кандидатов нет, повторный вызов детерминирован", () => {
    const { db, tmpDir, pairs } = buildRecallDb(true);
    track(db, tmpDir);

    const first = findDuplicates(db, { threshold: 0.95 });
    const found = new Set(first.candidates.map((c) => pairKey(c.a, c.b)));

    // Ни одного кандидата вне 100 известных пар (нет ложных срабатываний).
    const known = new Set(pairs.map((p) => pairKey(p.idA, p.idB)));
    const falsePositives = first.candidates.filter((c) => !known.has(pairKey(c.a, c.b)));
    expect(falsePositives.map((c) => pairKey(c.a, c.b))).toEqual([]);

    // Recall: по типам и суммарно. Требование плана — ≥ 95 из 100.
    const byKind: Record<DupKind, { found: number; total: number }> = {
      typo: { found: 0, total: 0 },
      perm: { found: 0, total: 0 },
      synonym: { found: 0, total: 0 },
      spelling: { found: 0, total: 0 },
    };
    let total = 0;
    for (const p of pairs) {
      byKind[p.kind].total += 1;
      if (found.has(pairKey(p.idA, p.idB))) {
        byKind[p.kind].found += 1;
        total += 1;
      }
    }
    const detail = Object.entries(byKind)
      .map(([k, v]) => `${k} ${v.found}/${v.total}`)
      .join(", ");
    expect(
      total,
      `recall ${total}/100 (${detail}) — требование плана 12: ≥ 95`
    ).toBeGreaterThanOrEqual(95);

    // Детерминизм LSH: повторный вызов на тех же данных — тот же набор.
    const second = findDuplicates(db, { threshold: 0.95 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  }, 120_000);

  it("без эмбеддингов (FTS-режим) кандидатов нет: сравнение требует векторы с обеих сторон", () => {
    const { db, tmpDir } = buildRecallDb(false);
    track(db, tmpDir);

    const { candidates, candidates_truncated } = findDuplicates(db, { threshold: 0.95 });
    expect(candidates).toHaveLength(0);
    expect(candidates_truncated).toBe(0);
  }, 120_000);
});
