import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB, SCHEMA_VERSION } from "../db.js";
import { closeAndCleanup, cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
let openDb: KnowledgeDB | undefined;

function freshDbPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migrate-v8-"));
  return tmpDir + "/knowledge.db";
}

afterEach(async () => {
  if (openDb) {
    await closeAndCleanup(openDb, tmpDir);
    openDb = undefined;
    return;
  }
  await cleanupDir(tmpDir);
});

describe("migration v7 -> v8 (plan 4 v8: support baselines)", () => {
  it("a v7 database is upgraded on open: columns, snapshot table, defaults, user_version", async () => {
    const dbPath = freshDbPath();
    // Build with the current code, then strip the v8 pieces to reproduce a
    // genuine v7 file: old column set, old user_version, no snapshot table.
    const v7 = new KnowledgeDB(dbPath);
    v7.insertNode({ id: "d", name: "D", kind: "decision", summary: "d" });
    v7.insertNode({ id: "f", name: "F", kind: "config", summary: "f" });
    v7.insertEdge({ from_id: "d", to_id: "f", relation: "informed_by", description: "why" });
    v7.close();
    const strip = new Database(dbPath);
    strip.exec(`
      DROP INDEX IF EXISTS idx_edges_created_via;
      DROP INDEX IF EXISTS idx_baselines_decision;
      ALTER TABLE nodes DROP COLUMN claim_digest;
      ALTER TABLE nodes DROP COLUMN claim_digest_at;
      ALTER TABLE edges DROP COLUMN created_via;
      ALTER TABLE edges DROP COLUMN accepted_at;
      DROP TABLE support_baselines;
    `);
    strip.pragma("user_version = 7");
    strip.close();

    const reopened = new KnowledgeDB(dbPath);
    openDb = reopened;
    expect(reopened.getUserVersion()).toBe(SCHEMA_VERSION);
    // plan-4-fixes-6: superseded_at lives in v9, on top of the v8 table.
    // plan-4-fixes-7 (2.1.1): the live-edge index rides as v10 — the v9
    // stamp already shipped in 2.1.0, so released databases would never
    // re-run a v9 block; the version keeps moving forward only.
    // 2.1.3: the revision journal + artifact observations ride as v11.
    // 2.1.10: nodes.created_via rides as v12. This assert pinned the
    // then-current SCHEMA_VERSION and was updated with the bump — the old
    // value asserted a falsehood after the bump (see the 2.1.3 report,
    // «изменённые ассерты»).
    expect(SCHEMA_VERSION).toBe(14);

    const nodeCols = (
      reopened.pragma("table_info(nodes)") as Array<{ name: string }>
    ).map((c) => c.name);
    expect(nodeCols).toContain("claim_digest");
    expect(nodeCols).toContain("claim_digest_at");
    const edgeCols = (
      reopened.pragma("table_info(edges)") as Array<{ name: string }>
    ).map((c) => c.name);
    expect(edgeCols).toContain("created_via");
    expect(edgeCols).toContain("accepted_at");
    expect(reopened.hasSupportBaselinesTable()).toBe(true);
    const baselineCols = (
      reopened.pragma("table_info(support_baselines)") as Array<{ name: string }>
    ).map((c) => c.name);
    expect(baselineCols).toContain("superseded_at");

    // Pre-v8 rows are honestly unknown (test 16 of plan 4 v8 §9) and the
    // data itself survives.
    const edge = reopened.getInformedByEdges("d", "ancestry", false)[0];
    expect(edge.created_via).toBe("unknown");
    expect(edge.accepted_at ?? null).toBeNull();
    expect(reopened.getStats().nodes).toBe(2);
    expect(reopened.getStats().edges).toBe(1);
  });

  it("the migration is idempotent: reopen changes nothing", async () => {
    const dbPath = freshDbPath();
    const first = new KnowledgeDB(dbPath);
    first.insertNode({ id: "t1", name: "T", kind: "decision", summary: "s" });
    first.close();
    const second = new KnowledgeDB(dbPath);
    expect(second.getUserVersion()).toBe(SCHEMA_VERSION);
    second.close();

    const third = new KnowledgeDB(dbPath);
    openDb = third;
    expect(third.getUserVersion()).toBe(SCHEMA_VERSION);
    expect(third.getStats().nodes).toBe(1);
    expect(third.hasSupportBaselinesTable()).toBe(true);
  });
});
