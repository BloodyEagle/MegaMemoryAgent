import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB, SCHEMA_VERSION } from "../db.js";
import { createConcept } from "../tools.js";
import { provenanceTrace } from "../provenance.js";
import { runStats } from "../stats.js";
import {
  looksLikeFileRefAnchor,
  supportQualityBreakdown,
} from "../stub.js";
import { cleanupDir } from "./helpers/cleanup.js";

// 2.1.10 F1: якорь отличается от заглушки. Серверный путь evidence: [{ref}]
// создаёт узлы с шаблонным саммари — так задумано и описано в README, но
// STUB_SUMMARY_PATTERN ловил ровно этот шаблон, и метрика считала легитимные
// опоры заглушками. Схема v12: nodes.created_via отделяет якоря (file_ref)
// от ручных узлов (agent); заглушка — только ручной узел.

vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    // Пустой буфер: векторный канал честно выключен, имя-канал дедупликации
    // работает (тесты дедупликации — в dedupe-create.test.ts).
    embedForStorage: vi.fn(async () => Buffer.alloc(0)),
  };
});

let tmpDir: string;

function newDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-created-via-"));
  return new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
}

const dbs: KnowledgeDB[] = [];
afterEach(async () => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  await cleanupDir(tmpDir);
});

const ANCHOR_NAME = "server/src/lib/scanner.ts:817-878";
const ANCHOR_SUMMARY = `File-fact node for "${ANCHOR_NAME}" — created as a provenance support.`;

/** Якорь ищется по имени (id — слаг имени, не сам путь). */
function findByName(db: KnowledgeDB, name: string): { id: string; created_via: string | null } | undefined {
  return db.execSqlFirst(
    "SELECT id, created_via FROM nodes WHERE name = ? AND removed_at IS NULL",
    name
  ) as { id: string; created_via: string | null } | undefined;
}

describe("2.1.10 F1: created_via на путях записи", () => {
  it("1. evidence: [{ref}] → узел-якорь с created_via='file_ref'", async () => {
    const db = newDb();
    dbs.push(db);
    const r = await createConcept(db, {
      name: "cache-decision",
      kind: "decision",
      summary: "кэш хранит превью на диске и возвращает его при чтении",
      evidence: [{ ref: ANCHOR_NAME, why: "в этих строках живёт запись в кэш" }],
    });
    const anchor = findByName(db, ANCHOR_NAME)!;
    expect(anchor).toBeDefined();
    expect(anchor.created_via).toBe("file_ref");
    expect(db.getNode(r.id)!.created_via).toBe("agent");
  });

  it("2. create_concept без evidence → created_via='agent'", async () => {
    const db = newDb();
    dbs.push(db);
    const r = await createConcept(db, {
      name: "plain-node",
      kind: "feature",
      summary: "хранилище возвращает превью по запросу и блокирует доступ без токена",
    });
    expect(db.getNode(r.id)!.created_via).toBe("agent");
  });

  it("8. allow_stub: true → created_via='agent', epistemic_status='stub'", async () => {
    const db = newDb();
    dbs.push(db);
    const r = await createConcept(db, {
      name: "stub-yes",
      kind: "feature",
      summary: ANCHOR_SUMMARY,
      allow_stub: true,
    });
    const node = db.getNode(r.id)!;
    expect(node.created_via).toBe("agent");
    expect(node.epistemic_status).toBe("stub");
  });
});

describe("2.1.10 F1: миграция v11 → v12 (бэкфилл created_via)", () => {
  /** Репродукция v11-базы: свежая схема, столбец снят, user_version = 11. */
  function buildV11(dbPath: string): void {
    const db = new KnowledgeDB(dbPath);
    db.insertNode({ id: "d", name: "D", kind: "decision", summary: "решение держит кэш" });
    db.insertNode({
      id: "anchor",
      name: ANCHOR_NAME,
      kind: "feature",
      summary: ANCHOR_SUMMARY,
      file_refs: [ANCHOR_NAME],
    });
    // Похожий по саммари узел, но file_refs[0] !== name — это НЕ якорь.
    db.insertNode({
      id: "impostor",
      name: "Scanner Copy",
      kind: "feature",
      summary: ANCHOR_SUMMARY,
      file_refs: ["server/src/other.ts:1-2"],
    });
    db.insertNode({ id: "hand", name: "H", kind: "feature", summary: "ручная заглушка" });
    db.insertEdgeRaw({ from_id: "d", to_id: "anchor", relation: "informed_by", description: "why" });
    db.insertEdgeRaw({ from_id: "d", to_id: "hand", relation: "informed_by", description: "why" });
    db.close();
    const strip = new Database(dbPath);
    strip.exec("ALTER TABLE nodes DROP COLUMN created_via;");
    strip.pragma("user_version = 11");
    strip.close();
  }

  it("3. старые якоря помечаются file_ref по трём признакам, остальные — agent", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migrate-v12-"));
    const dbPath = path.join(tmpDir, "knowledge.db");
    buildV11(dbPath);
    const db = new KnowledgeDB(dbPath);
    dbs.push(db);
    expect(db.getUserVersion()).toBe(SCHEMA_VERSION);
    expect(db.getNode("anchor")!.created_via).toBe("file_ref");
    // impostor: саммари шаблонное, но file_refs[0] !== name → не якорь.
    expect(db.getNode("impostor")!.created_via).toBe("agent");
    expect(db.getNode("d")!.created_via).toBe("agent");
    expect(db.getNode("hand")!.created_via).toBe("agent");
  });

  it("4. узел без file_refs[0]===name остаётся agent (предикат по трём признакам)", () => {
    // Тот же предикат вне миграции: саммари совпадает, имя похожее — но
    // file_refs[0] не равен имени.
    expect(
      looksLikeFileRefAnchor(ANCHOR_SUMMARY, ANCHOR_NAME, [ANCHOR_NAME])
    ).toBe(true);
    expect(
      looksLikeFileRefAnchor(ANCHOR_SUMMARY, ANCHOR_NAME + "-copy", [ANCHOR_NAME])
    ).toBe(false);
    expect(looksLikeFileRefAnchor(ANCHOR_SUMMARY, ANCHOR_NAME, null)).toBe(false);
    // Имя без «:строка»/«:старт-конец» — не якорь, даже при совпадении refs.
    expect(
      looksLikeFileRefAnchor(
        ANCHOR_SUMMARY,
        "server/src/lib/scanner.ts",
        ["server/src/lib/scanner.ts"]
      )
    ).toBe(false);
  });

  it("бэкфилл не оставляет NULL после миграции", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migrate-v12b-"));
    const dbPath = path.join(tmpDir, "knowledge.db");
    buildV11(dbPath);
    const db = new KnowledgeDB(dbPath);
    dbs.push(db);
    const nulls = db.execSqlAll(
      "SELECT count(*) AS n FROM nodes WHERE created_via IS NULL"
    ) as Array<{ n: number }>;
    expect(nulls[0].n).toBe(0);
  });
});

describe("2.1.10 F1: stats и weak_links различают якоря и заглушки", () => {
  function fixture(db: KnowledgeDB): void {
    db.insertNode({ id: "d", name: "D", kind: "decision", summary: "решение держит кэш превью на диске" });
    // 5 якорей — созданы сервером по evidence: [{ref}].
    for (let i = 1; i <= 5; i++) {
      const ref = `src/mod/file${i}.ts:10-20`;
      db.insertNode({
        id: ref,
        name: ref,
        kind: "feature",
        summary: `File-fact node for "${ref}" — created as a provenance support.`,
        file_refs: [ref],
        created_via: "file_ref",
      });
      db.insertEdgeRaw({ from_id: "d", to_id: ref, relation: "informed_by", description: "why" });
    }
    // 1 утверждение — ручной узел.
    db.insertNode({
      id: "claim",
      name: "CLAIM",
      kind: "feature",
      summary: "хранилище возвращает превью по запросу и блокирует доступ без токена",
      created_via: "agent",
    });
    db.insertEdgeRaw({ from_id: "d", to_id: "claim", relation: "informed_by", description: "why" });
  }

  it("5. stats: Supports 6 (anchors 5, claims 1), Stubs 0", async () => {
    const db = newDb();
    dbs.push(db);
    fixture(db);
    const split = supportQualityBreakdown(db);
    expect(split).toEqual({ total: 6, anchors: 5, claims: 1, stubs: 0 });

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await runStats(["--db", db.dbPath]);
    } finally {
      spy.mockRestore();
    }
    const text = logs.join("\n").replace(/\u001b\[\d+m/g, "");
    expect(text).toMatch(/Supports:\s*6\s*\(anchors 5, claims 1\)/);
    expect(text).toMatch(/Stubs:\s*0/);
  });

  it("6. weak_links не показывает stub_support для якорей", () => {
    const db = newDb();
    dbs.push(db);
    fixture(db);
    const trace = provenanceTrace(db, { node_id: "d" });
    expect(trace.weak_links.find((t) => t.type === "stub_support")).toBeUndefined();
    // supports[]: якорь — claim-grade, не stub.
    const byId = new Map(trace.supports!.map((s) => [s.support_id, s]));
    expect(byId.get("claim")!.quality).toBe("claim");
    expect(byId.get("src/mod/file1.ts:10-20")!.quality).toBe("claim");
  });

  it("7. шаблонный текст от агента по-прежнему отбивается (create_concept)", async () => {
    const db = newDb();
    dbs.push(db);
    await expect(
      createConcept(db, { name: "manual-anchor", kind: "feature", summary: ANCHOR_SUMMARY })
    ).rejects.toThrow(/утверждением о поведении/);
    expect(db.getNode("manual-anchor")).toBeUndefined();
  });
});
