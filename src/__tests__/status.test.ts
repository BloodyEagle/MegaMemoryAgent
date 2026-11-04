import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { understand, createConcept, listConflicts, removeConcept, updateConcept } from "../tools.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-status-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("supersedes lifecycle", () => {
  it("supersedes marks old node, understand hides it, include_inactive shows it", async () => {
    const db = freshDb();
    await createConcept(db, {
      name: "Auth Decision",
      kind: "decision",
      summary: "auth хранит сессию в cookie и возвращает её на каждый запрос",
    });
    await createConcept(db, {
      name: "Auth Decision v2",
      kind: "decision",
      summary: "auth v2 хранит сессию в jwt-токене и отдаёт её вместо cookie-сессии",
      supersedes: ["auth-decision"],
    });

    // Old node marked superseded with valid_until.
    const node = db.getNodeIncludingRemoved("auth-decision");
    expect(node?.status).toBe("superseded");
    expect(node?.valid_until).toBeTruthy();
    // Edge new--supersedes-->old exists.
    const edges = db.getOutgoingEdges("auth-decision-v2");
    expect(edges.some((e) => e.relation === "supersedes" && e.to_id === "auth-decision")).toBe(true);

    // understand hides superseded by default...
    const hidden = await understand(db, { query: "auth", mode: "full" });
    expect(hidden.matches.some((m) => m.id === "auth-decision")).toBe(false);
    // ...but include_inactive shows it with status.
    const shown = await understand(db, {
      query: "auth",
      mode: "full",
      include_inactive: true,
    });
    const old = shown.matches.find((m) => m.id === "auth-decision");
    expect(old).toBeDefined();
    expect(old?.status).toBe("superseded");
  });

  it("supersedes unknown id fails after creating the node, reports missing", async () => {
    const db = freshDb();
    await expect(
      createConcept(db, {
        name: "Ghost Replacer",
        kind: "decision",
        summary: "заменитель хранит ссылку на несуществующий узел — supersedes падает после создания",
        supersedes: ["does-not-exist"],
      })
    ).rejects.toThrow(/does-not-exist/);
    // Node itself was created before the failure — still present.
    expect(db.nodeExists("ghost-replacer")).toBe(true);
  });

  it("removeConcept deprecates status", async () => {
    const db = freshDb();
    await createConcept(db, {
      name: "Temp Feature",
      kind: "feature",
      summary: "временный узел хранит только пометку к удалению",
    });
    removeConcept(db, { id: "temp-feature", reason: "obsolete" });
    expect(db.getNodeIncludingRemoved("temp-feature")?.status).toBe("deprecated");
  });
});

describe("contradicts in listConflicts", () => {
  it("lists contradicted facts with their opponents", () => {
    const db = freshDb();
    db.insertNode({ id: "fact-a", name: "Fact A", kind: "decision", summary: "x is 5" });
    db.insertNode({ id: "fact-b", name: "Fact B", kind: "decision", summary: "x is 7" });
    db.insertEdge({ from_id: "fact-b", to_id: "fact-a", relation: "contradicts" });

    const result = listConflicts(db);
    expect(result.conflicts).toEqual([]);
    expect(result.contradicted).toHaveLength(1);
    expect(result.contradicted![0].id).toBe("fact-a");
    expect(result.contradicted![0].contradicted_by).toEqual(["fact-b"]);
  });
});

describe("status counts", () => {
  it("counts statuses for stats", async () => {
    const db = freshDb();
    await createConcept(db, { name: "A", kind: "feature", summary: "узел a хранит статус для подсчёта" });
    await createConcept(db, { name: "B", kind: "feature", summary: "узел b хранит статус и вытесняет a через supersedes", supersedes: ["a"] });
    const counts = db.getStatusCounts();
    expect(counts["active"]).toBe(1);
    expect(counts["superseded"]).toBe(1);
  });
});

describe("status history (U5)", () => {
  it("supersedes writes active -> superseded with a reason", async () => {
    const db = freshDb();
    await createConcept(db, { name: "Old Auth", kind: "decision", summary: "старая auth хранит сессию в cookies" });
    await createConcept(db, {
      name: "New Auth",
      kind: "decision",
      summary: "новая auth хранит сессию в jwt-токене",
      supersedes: ["old-auth"],
    });

    const hist = db.getStatusHistory("old-auth");
    expect(hist).toHaveLength(1);
    expect(hist[0].from_status).toBe("active");
    expect(hist[0].to_status).toBe("superseded");
    expect(hist[0].reason).toContain("new-auth");
  });

  it("removeConcept writes active -> deprecated with the given reason", async () => {
    const db = freshDb();
    await createConcept(db, { name: "Temp", kind: "feature", summary: "временный узел хранит причину удаления" });
    removeConcept(db, { id: "temp", reason: "gone from code" });

    const hist = db.getStatusHistory("temp");
    expect(hist).toHaveLength(1);
    expect(hist[0].from_status).toBe("active");
    expect(hist[0].to_status).toBe("deprecated");
    expect(hist[0].reason).toBe("gone from code");
  });

  it("no row when the status does not change", async () => {
    const db = freshDb();
    await createConcept(db, { name: "Same", kind: "feature", summary: "узел хранит неизменный статус active" });
    db.setNodeStatus("same", "active");
    expect(db.getStatusHistory("same")).toHaveLength(0);
  });

  it("getAllStatusHistory feeds the timeline (newest first)", async () => {
    const db = freshDb();
    await createConcept(db, { name: "A", kind: "feature", summary: "узел a хранит статус для подсчёта" });
    await createConcept(db, { name: "B", kind: "feature", summary: "узел b хранит статус и вытесняет a через supersedes", supersedes: ["a"] });
    removeConcept(db, { id: "b", reason: "cleanup" });
    const all = db.getAllStatusHistory(10);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].node_id).toBe("b"); // newest first
  });
});

describe("epistemic status (plan 1)", () => {
  it("create defaults to open; explicit values are accepted", async () => {
    const db = freshDb();
    await createConcept(db, { name: "Hypothesis", kind: "decision", summary: "гипотеза хранит неподтверждённый вывод" });
    expect(db.getNode("hypothesis")?.epistemic_status).toBe("open");

    await createConcept(db, {
      name: "Checked Fact",
      kind: "decision",
      summary: "проверенный факт хранит ссылку на артефакт проверки",
      epistemic_status: "validated",
      status_scope: { env: "ci", artifact: "run-123" },
    });
    expect(db.getNode("checked-fact")?.epistemic_status).toBe("validated");
  });

  it("invalid transition is rejected; validated without scope/artifact fails", async () => {
    const db = freshDb();
    await createConcept(db, { name: "Claim", kind: "decision", summary: "узел хранит вывод для эпистемических переходов" });

    // open -> validated requires scope with artifact.
    await expect(
      updateConcept(db, { id: "claim", changes: { epistemic_status: "validated", epistemic_reason: "looks fine" } })
    ).rejects.toThrow(/artifact/);

    await expect(
      updateConcept(db, {
        id: "claim",
        changes: {
          epistemic_status: "validated",
          epistemic_reason: "tested",
          status_scope: { env: "ci", artifact: "run-1" },
        },
      })
    ).resolves.toBeTruthy();
    expect(db.getNode("claim")?.epistemic_status).toBe("validated");

    // validated -> open is not a legal move (must go through refuted/abandoned).
    await expect(
      updateConcept(db, { id: "claim", changes: { epistemic_status: "open", epistemic_reason: "reopen" } })
    ).rejects.toThrow(/Invalid epistemic transition/);
  });

  it("epistemic_status without reason is rejected; reason without status too", async () => {
    const db = freshDb();
    await createConcept(db, { name: "R", kind: "decision", summary: "узел хранит вывод для эпистемических переходов" });
    await expect(
      updateConcept(db, { id: "r", changes: { epistemic_status: "refuted" } })
    ).rejects.toThrow(/epistemic_reason/);
    await expect(
      updateConcept(db, { id: "r", changes: { epistemic_reason: "no status" } })
    ).rejects.toThrow(/no-op/);
  });

  it("refuted node stays in the graph and surfaces in the refuted block", async () => {
    const db = freshDb();
    await createConcept(db, { name: "Wrong Guess", kind: "decision", summary: "cache хранит превью на диске и возвращает их — вывод будет опровергнут" });
    await createConcept(db, { name: "Plain Fact", kind: "decision", summary: "факт хранит истинное утверждение о поведении" });

    await updateConcept(db, {
      id: "wrong-guess",
      changes: { epistemic_status: "refuted", epistemic_reason: "benchmarks show otherwise" },
    });

    // Still in the graph, with lifecycle status untouched.
    expect(db.getNode("wrong-guess")).toBeDefined();
    expect(db.getNode("wrong-guess")?.status).toBe("active");

    // understand: excluded from matches (even with include_inactive), present
    // in the refuted block with the reason.
    const res = await understand(db, { query: "cache", mode: "full" });
    expect(res.matches.some((m) => m.id === "wrong-guess")).toBe(false);
    const refuted = (res.refuted ?? []) as Array<{ id: string; refuted_reason?: string | null }>;
    expect(refuted.some((m) => m.id === "wrong-guess" && m.refuted_reason === "benchmarks show otherwise")).toBe(true);

    // refuted survives include_inactive=false as well (compact mode).
    const compact = await understand(db, { query: "cache" });
    expect((compact.refuted ?? []).some((m) => m.id === "wrong-guess")).toBe(true);
  });

  it("every epistemic transition writes status_history with field + reason", async () => {
    const db = freshDb();
    await createConcept(db, { name: "E", kind: "decision", summary: "узел хранит вывод для эпистемических переходов" });
    await updateConcept(db, { id: "e", changes: { epistemic_status: "refuted", epistemic_reason: "wrong" } });
    await updateConcept(db, { id: "e", changes: { epistemic_status: "open", epistemic_reason: "reopened after discussion" } });

    const rows = db.execSqlAll(
      "SELECT from_status, to_status, reason, field FROM status_history WHERE node_id = 'e' AND field = 'epistemic_status' ORDER BY id"
    ) as Array<{ from_status: string; to_status: string; reason: string; field: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ from_status: "open", to_status: "refuted", reason: "wrong", field: "epistemic_status" });
    expect(rows[1]).toMatchObject({ from_status: "refuted", to_status: "open", reason: "reopened after discussion" });
  });
});
