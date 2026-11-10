import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { createConcept } from "../tools.js";
import { provenanceTrace } from "../provenance.js";
import { runDoctor } from "../doctor.js";
import { countStubSupports } from "../stub.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// Only embedForStorage is faked — the real module must stay intact for
// runDoctor (MODEL_NAME, isModelLoaded); importing it downloads nothing.
vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embedForStorage: vi.fn(async () => Buffer.alloc(0)),
  };
});

let db: KnowledgeDB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-stub-supports-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

// Close only: libsql on Windows can hold the file for up to ~10 s after
// close under AV/indexer pressure (helpers/cleanup.ts budgets 4 s and loses
// that race, paying it per test). Temp dirs are the OS's to clean.
afterEach(() => {
  db.close();
});

/** Заглушка из дефекта на TwonkyGrabber3: шаблон вместо утверждения. */
const STUB_SUMMARY =
  'File-fact node for "server/src/lib/scanner.ts:817-878" — created as a provenance support.';

/** CreateConceptResult.id опционален по API (отказ дедупликации); в этих сценариях узел всегда создаётся. */
function createdId(result: { id?: string }): string {
  if (result.id === undefined) throw new Error("createConcept returned no id");
  return result.id;
}

/** Raw inserts: заглушки уже записаны до 2.1.9 и не удаляются, только помечаются.
 * created_via="agent" явно (2.1.10: заглушкой бывает только ручной узел). */
function node(id: string, kind: string, summary: string): void {
  db.insertNode({
    id,
    name: id.toUpperCase(),
    kind: kind as never,
    summary,
    created_via: "agent",
  });
}

function edge(from: string, to: string): void {
  db.insertEdgeRaw({
    from_id: from,
    to_id: to,
    relation: "informed_by",
    description: "why",
  });
}

describe("2.1.9 F2: опоры-заглушки не принимаются", () => {
  it("7. шаблонный summary → отказ, узел не создан", async () => {
    await expect(
      createConcept(db, { name: "scanner-fact", kind: "feature", summary: STUB_SUMMARY })
    ).rejects.toThrow(/утверждением о поведении/);
    expect(db.getNode("scanner-fact")).toBeUndefined();
  });

  it("8. короткий summary без глагола-утверждения → отказ", async () => {
    await expect(
      createConcept(db, { name: "thin-decision", kind: "decision", summary: "быстрая проверка" })
    ).rejects.toThrow(/evidence: \[\{ref/);
    expect(db.getNode("thin-decision")).toBeUndefined();
  });

  it("9. короткий, но с утверждением → принят", async () => {
    const r = await createConcept(db, {
      name: "cache-preview",
      kind: "feature",
      summary: "кэш хранит превью на диске",
    });
    const created = db.getNode(createdId(r));
    expect(created).toBeDefined();
    expect(created!.summary).toBe("кэш хранит превью на диске");
  });

  it("10. allow_stub: true → узел записан с epistemic_status = stub", async () => {
    const r = await createConcept(db, {
      name: "stub-yes",
      kind: "feature",
      summary: STUB_SUMMARY,
      allow_stub: true,
    });
    expect(db.getNode(createdId(r))!.epistemic_status).toBe("stub");
  });

  it("11. kind=module с коротким summary → принят (проверка на модули не действует)", async () => {
    const r = await createConcept(db, {
      name: "auth-module",
      kind: "module",
      summary: "модуль",
    });
    expect(db.getNode(createdId(r))).toBeDefined();
  });

  it("12. weak_links показывает stub_support для существующей заглушки", () => {
    node("d1", "decision", "решение держит кэш превью на диске и возвращает его при чтении");
    node("stub1", "feature", STUB_SUMMARY);
    edge("d1", "stub1");
    const trace = provenanceTrace(db, { node_id: "d1" });
    const w = trace.weak_links.find((t) => t.type === "stub_support");
    expect(w).toBeDefined();
    expect(w!.count).toBe(1);
    expect(w!.sample).toEqual(["stub1"]);
    expect(w!.note).toContain("d1");
  });

  it("13. provenance_trace помечает опоры quality: stub | claim", () => {
    node("d2", "decision", "решение держит кэш превью на диске и возвращает его при чтении");
    node("stub2", "feature", STUB_SUMMARY);
    node("claim2", "feature", "хранилище возвращает превью по запросу и блокирует доступ без токена");
    edge("d2", "stub2");
    edge("d2", "claim2");
    const trace = provenanceTrace(db, { node_id: "d2" });
    expect(trace.supports).toHaveLength(2);
    const byId = new Map(trace.supports!.map((s) => [s.support_id, s]));
    expect(byId.get("stub2")!.quality).toBe("stub");
    expect(byId.get("claim2")!.quality).toBe("claim");
  });

  it("14. stats/doctor считают Stub supports: только опоры-заглушки, module и digest исключены", () => {
    node("d3", "decision", "решение держит кэш превью на диске и возвращает его при чтении");
    node("stub-a", "feature", STUB_SUMMARY);
    node("stub-b", "feature", "короткая заглушка");
    node("real", "feature", "хранилище возвращает превью по запросу и блокирует доступ без токена");
    node("mod", "module", "короткий модуль");
    node("dgv", "digest", "короткий дайджест");
    edge("d3", "stub-a");
    edge("d3", "stub-b");
    edge("d3", "real");
    edge("d3", "mod");
    edge("d3", "dgv");
    expect(countStubSupports(db)).toBe(2);
    const checks = runDoctor(db);
    const line = checks.checks.find((c) => c.name === "stub supports");
    expect(line).toBeDefined();
    expect(line!.detail).toContain("2");
  });
});
