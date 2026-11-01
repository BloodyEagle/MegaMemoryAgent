import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { runDoctor, summarizeFtsProbe } from "../doctor.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-fts-drift-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("FTS drift detection (F13)", () => {
  it("healthy index: no problems", () => {
    const db = freshDb();
    db.insertNode({ id: "a", name: "Alpha", kind: "feature", summary: "alpha body" });
    db.insertNode({ id: "b", name: "Beta", kind: "feature", summary: "beta body" });

    const { checks, problems } = runDoctor(db);
    const fts = checks.find((c) => c.name === "FTS index");
    expect(fts?.ok).toBe(true);
    expect(fts?.detail).toContain("2/2");
    // health issues other than FTS may exist but FTS itself is clean
    expect(fts?.ok ? 0 : 1).toBe(0);
    void problems;
  });

  it("drift probe aggregation (F13): libsql auto-syncs, so unit-test the math", () => {
    // libsql keeps external-content FTS in sync on writes, and even rowid
    // shifts are followed — artificial drift cannot be reproduced here.
    // The aggregation is still worth pinning down:
    expect(summarizeFtsProbe(0, 0)).toBeNull();
    expect(summarizeFtsProbe(20, 0)).toBeNull();
    expect(summarizeFtsProbe(20, 20)).toBe(
      "all 20 sampled node(s) missing from the index"
    );
    expect(summarizeFtsProbe(20, 3)).toBe(
      "3/20 sampled node(s) missing from the index"
    );
  });

  it("the sample probe runs clean on a healthy index (no false drift)", () => {
    const db = freshDb();
    db.insertNode({ id: "a", name: "Alpha", kind: "feature", summary: "alpha body" });
    db.insertNode({ id: "b", name: "Beta", kind: "feature", summary: "beta body" });

    const { checks, problems } = runDoctor(db);
    const fts = checks.find((c) => c.name === "FTS index");
    expect(fts?.ok).toBe(true);
    expect(fts?.detail).toContain("2/2");
    void problems;
  });
});
