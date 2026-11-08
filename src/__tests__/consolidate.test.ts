import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { findDuplicates, mergeNodes, nameSimilarity } from "../consolidate.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-consolidate-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function setEmbedding(db: KnowledgeDB, id: string, vec: number[]): void {
  const v = new Float32Array(vec);
  db.execSqlRun(
    "UPDATE nodes SET embedding = @e WHERE id = @id",
    { e: Buffer.from(v.buffer, v.byteOffset, v.byteLength), id }
  );
}

// План 12: наполнителям больших групп нужны различающиеся векторы — при
// триграммной ступени кандидатов одинаковые векторы наполнителей честно
// становятся парами-дубликатами и затаптывают предел на узел. 24-мерные
// случайные направления не поднимаются над порогом попарно.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnitEmbedding(seed: number): number[] {
  const rnd = mulberry32(seed);
  const v = new Float32Array(24);
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] = rnd() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return Array.from(v);
}

describe("findDuplicates", () => {
  it("finds near-identical pairs, skips dissimilar nodes", () => {
    const db = freshDb();
    db.insertNode({ id: "dup-a", name: "Payment Module", kind: "module", summary: "processes payments via stripe" });
    db.insertNode({ id: "dup-b", name: "Payment Module Copy", kind: "module", summary: "processes payments via stripe (copy)" });
    db.insertNode({ id: "other", name: "Logging", kind: "module", summary: "writes logs to files" });
    setEmbedding(db, "dup-a", [1, 0, 0, 0]);
    setEmbedding(db, "dup-b", [0.99, 0.1, 0, 0]); // ≈0.995 cosine
    setEmbedding(db, "other", [0, 1, 0, 0]); // orthogonal

    const { candidates } = findDuplicates(db, { threshold: 0.95 });
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect([c.a, c.b].sort()).toEqual(["dup-a", "dup-b"]);
    expect(c.same_parent).toBe(true);
    expect(c.older).toBe("dup-a"); // created first
  });

  it("dry run (findDuplicates) never mutates the database", () => {
    const db = freshDb();
    db.insertNode({ id: "x1", name: "Same", kind: "module", summary: "same" });
    db.insertNode({ id: "x2", name: "Same", kind: "module", summary: "same" });
    setEmbedding(db, "x1", [1, 0, 0, 0]);
    setEmbedding(db, "x2", [1, 0, 0, 0]);

    const before = db.getAllNodesRaw().length;
    findDuplicates(db, { threshold: 0.9 });
    expect(db.getAllNodesRaw().length).toBe(before);
  });
});

describe("findDuplicates blocking (R-06b, план 09)", () => {
  it("группа из 500 одинаковых имён не вешает процесс: время ограничено, усечение честное", () => {
    const db = freshDb();
    db.runInTransaction(() => {
      for (let i = 0; i < 500; i++) {
        db.insertNode({ id: `same-${i}`, name: "Same", kind: "module", summary: `s ${i}` });
      }
    });
    for (let i = 0; i < 500; i++) setEmbedding(db, `same-${i}`, [1, 0, 0, 0]);

    const { candidates, candidates_truncated } = findDuplicates(db, { threshold: 0.9 });
    // Предел на узел (50) ограничивает выдачу: усечение видно в отчёте, а не молчит.
    expect(candidates.length).toBeLessThanOrEqual(100);
    expect(candidates_truncated).toBeGreaterThan(0);
    // Все усечённые пары — выше порога, попарная схожесть единица.
    for (const c of candidates) expect(c.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it("большая группа: одинаковые имена и близкие имена с одинаковым вектором находятся (план 12: компромисс 09 снят ступенью B)", () => {
    const db = freshDb();
    db.runInTransaction(() => {
      // Пара с одинаковыми именами — попадает в один блок (ступень A).
      db.insertNode({ id: "twin-a", name: "Twin Alpha", kind: "module", summary: "first" });
      db.insertNode({ id: "twin-b", name: "Twin Alpha", kind: "module", summary: "second" });
      // Пара с разными именами и одинаковым вектором — блоки разные, но
      // триграммы общие («solo», «module») — ступень B доводит до сравнения.
      db.insertNode({ id: "solo-one", name: "Solo Module One", kind: "module", summary: "one" });
      db.insertNode({ id: "solo-two", name: "Solo Module Two", kind: "module", summary: "two" });
      // Наполнители с уникальными именами до большой группы (порог блокинга 200).
      for (let i = 0; i < 250; i++) {
        db.insertNode({ id: `filler-${i}`, name: `Unique Filler ${i}`, kind: "module", summary: `f ${i}` });
      }
    });
    for (const id of ["twin-a", "twin-b"]) setEmbedding(db, id, [1, 0, 0, 0]);
    for (const id of ["solo-one", "solo-two"]) setEmbedding(db, id, [0, 1, 0, 0]);
    for (let i = 0; i < 250; i++) {
      setEmbedding(db, `filler-${i}`, randomUnitEmbedding(1000 + i));
    }

    const { candidates, candidates_truncated } = findDuplicates(db, { threshold: 0.95 });
    const pairs = candidates.map((c) => [c.a, c.b].sort().join("|"));
    expect(pairs).toContain("twin-a|twin-b");
    expect(pairs).toContain("solo-one|solo-two");
    expect(candidates_truncated).toBe(0); // давления на предел не было
  });

  it("большая группа: имена без общих триграмм с одинаковым вектором находятся через LSH (ступень C)", () => {
    const db = freshDb();
    db.runInTransaction(() => {
      // «склад восток» / «очередь запад»: ни одной общей триграммы — ступень
      // B слепа, блоки ступени A разные. Пару приносит только векторная
      // корзина (план 12: «вектор близок, имя нет»).
      db.insertNode({ id: "lex-a", name: "Склад Восток", kind: "module", summary: "a" });
      db.insertNode({ id: "lex-b", name: "Очередь Запад", kind: "module", summary: "b" });
      for (let i = 0; i < 250; i++) {
        db.insertNode({ id: `pad-${i}`, name: `Filler Node ${i}`, kind: "module", summary: `p ${i}` });
      }
    });
    setEmbedding(db, "lex-a", [0, 0, 1, 0]);
    setEmbedding(db, "lex-b", [0, 0, 1, 0]);
    for (let i = 0; i < 250; i++) {
      setEmbedding(db, `pad-${i}`, randomUnitEmbedding(3000 + i));
    }

    const { candidates, candidates_truncated } = findDuplicates(db, { threshold: 0.95 });
    const pairs = candidates.map((c) => [c.a, c.b].sort().join("|"));
    expect(pairs).toContain("lex-a|lex-b");
    expect(candidates_truncated).toBe(0);
  });

  it("имена отличаются только регистром и пунктуацией — один блок, пара находится", () => {
    const db = freshDb();
    db.runInTransaction(() => {
      db.insertNode({ id: "case-a", name: "Payment Module", kind: "module", summary: "a" });
      db.insertNode({ id: "case-b", name: "payment—module!!", kind: "module", summary: "b" });
      for (let i = 0; i < 250; i++) {
        db.insertNode({ id: `pad-${i}`, name: `Filler Node ${i}`, kind: "module", summary: `p ${i}` });
      }
    });
    setEmbedding(db, "case-a", [1, 0, 0, 0]);
    setEmbedding(db, "case-b", [1, 0, 0, 0]);
    for (let i = 0; i < 250; i++) {
      setEmbedding(db, `pad-${i}`, randomUnitEmbedding(2000 + i));
    }

    const { candidates } = findDuplicates(db, { threshold: 0.95 });
    const pairs = candidates.map((c) => [c.a, c.b].sort().join("|"));
    expect(pairs).toContain("case-a|case-b");
  });
});

describe("mergeNodes", () => {
  it("merges into the older node, combines summary, moves edges, removes twin", () => {
    const db = freshDb();
    db.insertNode({ id: "old", name: "Old Node", kind: "module", summary: "first version" });
    db.insertNode({ id: "twin", name: "Twin Node", kind: "module", summary: "second version" });
    db.insertNode({ id: "peer", name: "Peer", kind: "module", summary: "peer" });
    // Edges touching the twin must survive via the survivor.
    db.insertEdge({ from_id: "twin", to_id: "peer", relation: "connects_to" });
    db.insertEdge({ from_id: "peer", to_id: "twin", relation: "depends_on" });

    const before = db.getAllNodesRaw().length;
    const beforeEdges = db.getAllEdgesRaw().length;
    const result = mergeNodes(db, "old", "twin");

    expect(result).toEqual({ survivor: "old", removed: "twin" });
    expect(db.getAllNodesRaw().length).toBe(before - 1);
    expect(db.nodeExists("twin")).toBe(false);
    expect(db.nodeExists("old")).toBe(true);

    // Summary combined.
    const survivor = db.getNode("old")!;
    expect(survivor.summary).toContain("first version");
    expect(survivor.summary).toContain("second version");

    // Edges moved: count preserved (2 moved, none lost, none duplicated).
    expect(db.getAllEdgesRaw().length).toBe(beforeEdges);
    expect(db.getOutgoingEdges("old").some((e) => e.to_id === "peer" && e.relation === "connects_to")).toBe(true);
    expect(db.getIncomingEdges("old").some((e) => e.from_id === "peer" && e.relation === "depends_on")).toBe(true);
  });
});

describe("nameSimilarity", () => {
  it("is 1 for identical names, low for different ones", () => {
    expect(nameSimilarity("Payment Module", "payment module")).toBe(1);
    expect(nameSimilarity("Payment Module", "Payment Module Copy")).toBeGreaterThan(0.5);
    expect(nameSimilarity("Payment Module", "Logging")).toBeLessThan(0.5);
  });
});

describe("М7: digest excluded from consolidation", () => {
  it("digest nodes are never candidates even with identical vectors", () => {
    const db = freshDb();
    db.insertNode({ id: "m", name: "Module", kind: "module", summary: "m" });
    db.insertNode({ id: "m/d1", name: "Digest one", kind: "digest", summary: "digest payload", parent_id: "m" });
    db.insertNode({ id: "m/d2", name: "Digest two", kind: "digest", summary: "digest payload 2", parent_id: "m" });
    setEmbedding(db, "m/d1", [1, 0, 0, 0]);
    setEmbedding(db, "m/d2", [1, 0, 0, 0]);
    const { candidates } = findDuplicates(db, { threshold: 0.9 });
    expect(candidates).toHaveLength(0);
  });
});
