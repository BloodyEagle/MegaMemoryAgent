import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { understand, createConcept, listConflicts, removeConcept } from "../tools.js";
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
      summary: "use session cookies for auth",
    });
    await createConcept(db, {
      name: "Auth Decision v2",
      kind: "decision",
      summary: "use jwt tokens for auth instead",
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
        summary: "s",
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
      summary: "to be removed",
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
    await createConcept(db, { name: "A", kind: "feature", summary: "a" });
    await createConcept(db, { name: "B", kind: "feature", summary: "b", supersedes: ["a"] });
    const counts = db.getStatusCounts();
    expect(counts["active"]).toBe(1);
    expect(counts["superseded"]).toBe(1);
  });
});

describe("status history (U5)", () => {
  it("supersedes writes active -> superseded with a reason", async () => {
    const db = freshDb();
    await createConcept(db, { name: "Old Auth", kind: "decision", summary: "cookies" });
    await createConcept(db, {
      name: "New Auth",
      kind: "decision",
      summary: "jwt",
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
    await createConcept(db, { name: "Temp", kind: "feature", summary: "t" });
    removeConcept(db, { id: "temp", reason: "gone from code" });

    const hist = db.getStatusHistory("temp");
    expect(hist).toHaveLength(1);
    expect(hist[0].from_status).toBe("active");
    expect(hist[0].to_status).toBe("deprecated");
    expect(hist[0].reason).toBe("gone from code");
  });

  it("no row when the status does not change", async () => {
    const db = freshDb();
    await createConcept(db, { name: "Same", kind: "feature", summary: "s" });
    db.setNodeStatus("same", "active");
    expect(db.getStatusHistory("same")).toHaveLength(0);
  });

  it("getAllStatusHistory feeds the timeline (newest first)", async () => {
    const db = freshDb();
    await createConcept(db, { name: "A", kind: "feature", summary: "a" });
    await createConcept(db, { name: "B", kind: "feature", summary: "b", supersedes: ["a"] });
    removeConcept(db, { id: "b", reason: "cleanup" });
    const all = db.getAllStatusHistory(10);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].node_id).toBe("b"); // newest first
  });
});
