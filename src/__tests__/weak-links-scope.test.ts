import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { createConcept } from "../tools.js";
import { provenanceTrace } from "../provenance.js";
import type { ProvenanceTraceOutput } from "../types.js";
import { cleanupDir } from "./helpers/cleanup.js";

// 2.1.10 F3: weak_links проверяет опоры у всех носителей знания, а не только
// у decisions. Заглушка под pattern раньше была невидима (stats её считал,
// weak_links молчал); теперь проверяется любой узел с опорами. Решёние-ветки
// (no_support, support_check-состояния) остаются решёние-ветками.

let tmpDir: string;

function newDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-wl-scope-"));
  return new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
}

const dbs: KnowledgeDB[] = [];
afterEach(async () => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  await cleanupDir(tmpDir);
});

function node(
  db: KnowledgeDB,
  id: string,
  kind: string,
  summary: string,
  opts: { fileRefs?: string[]; via?: string } = {}
): void {
  db.insertNode({
    id,
    name: id.toUpperCase(),
    kind: kind as never,
    summary,
    ...(opts.fileRefs ? { file_refs: opts.fileRefs } : {}),
    created_via: opts.via ?? "agent",
  });
}

function edge(db: KnowledgeDB, from: string, to: string): void {
  db.insertEdgeRaw({
    from_id: from,
    to_id: to,
    relation: "informed_by",
    description: "why",
  });
}

function trace(
  db: KnowledgeDB,
  id: string,
  opts: { checkEdges?: number; checkBytes?: number } = {}
): ProvenanceTraceOutput {
  return provenanceTrace(db, {
    node_id: id,
    ...(opts.checkEdges !== undefined ? { max_check_edges: opts.checkEdges } : {}),
    ...(opts.checkBytes !== undefined ? { max_check_bytes: opts.checkBytes } : {}),
  });
}

const STUB = 'File-fact node for "src/x.ts:1-2" — created as a provenance support.';
const CLAIM = "хранилище возвращает превью по запросу и блокирует доступ без токена";

describe("2.1.10 F3: weak_links по всем носителям знания", () => {
  it("11. паттерн с заглушкой → stub_support", () => {
    const db = newDb();
    dbs.push(db);
    node(db, "p", "pattern", "паттерн кэширует превью и возвращает их при чтении");
    node(db, "s", "feature", STUB);
    edge(db, "p", "s");
    const out = trace(db, "p");
    const w = out.weak_links.find((t) => t.type === "stub_support");
    expect(w).toBeDefined();
    expect(w!.id).toBe("p");
    expect(w!.count).toBe(1);
    expect(w!.sample).toEqual(["s"]);
    // Якорь-одноимёнка не считается: тот же шаблон, но created_via='file_ref'.
    const db2 = newDb();
    dbs.push(db2);
    node(db2, "p2", "pattern", "паттерн кэширует превью и возвращает их при чтении");
    node(db2, "src/x.ts:1-2", "feature", STUB, { fileRefs: ["src/x.ts:1-2"], via: "file_ref" });
    edge(db2, "p2", "src/x.ts:1-2");
    expect(
      trace(db2, "p2").weak_links.find((t) => t.type === "stub_support")
    ).toBeUndefined();
  });

  it("12. паттерн с нормальным утверждением → чисто", () => {
    const db = newDb();
    dbs.push(db);
    node(db, "p", "pattern", "паттерн кэширует превью и возвращает их при чтении");
    node(db, "c", "feature", CLAIM, { fileRefs: ["src/store.ts:40-80"] });
    edge(db, "p", "c");
    const out = trace(db, "p");
    expect(out.weak_links.find((t) => t.type === "stub_support")).toBeUndefined();
    expect(out.weak_links.find((t) => t.type === "missing_support")).toBeUndefined();
    expect(out.weak_links.find((t) => t.type === "ungrounded_support")).toBeUndefined();
  });

  it("13. модуль без опор не проверяется (нет опор — не о чём говорить)", () => {
    const db = newDb();
    dbs.push(db);
    node(db, "m", "module", "короткий модуль");
    const out = trace(db, "m");
    expect(out.weak_links).toHaveLength(0);
    // В отличие от decision: решению без опор и без снимка — no_support.
    node(db, "d", "decision", CLAIM);
    const outD = trace(db, "d");
    expect(outD.weak_links.find((t) => t.type === "no_support")).toBeDefined();
  });

  it("14. бюджет по-прежнему ограничивает: incomplete честно travelling", async () => {
    const db = newDb();
    dbs.push(db);
    node(db, "c1", "feature", CLAIM, { fileRefs: ["src/store.ts:40-80"] });
    // Снимок записывается create_concept с evidence; перезапись формулировки
    // заставляет проверку пересчитать claim — и байтовый бюджет в 1 байт
    // обрывает её: incomplete, не «чисто».
    const big = "x".repeat(100);
    const r = await createConcept(db, {
      name: "d",
      kind: "decision",
      summary: big,
      evidence: [{ node: "c1", why: "хранение превью — тот же слой" }],
    });
    db.updateNode(r.id, { summary: `${big}!` });
    const out = trace(db, r.id, { checkBytes: 1 });
    expect(out.support_check?.state).toBe("incomplete");
    // Оборванная проверка — слабое звено (type support_unreviewed, note
    // честно называет support_check: incomplete).
    const w = out.weak_links.find(
      (t) => t.type === "support_unreviewed" && t.note.includes("incomplete")
    );
    expect(w).toBeDefined();
  });
});
