import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import {
  buildDigest,
  planDigests,
  maybeAutoDigest,
  digestSourceChildren,
  DIGEST_MIN_CHILDREN,
} from "../digest.js";
import { ensureSchema } from "../migrate-schema.js";
import { hybridSearch } from "../search.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-digest-"));
  db = new KnowledgeDB(tmpDir + "/knowledge.db");
  ensureSchema(db);
  return db;
}

afterEach(async () => {
  delete process.env.MEGAMEMORY_AUTO_DIGEST;
  if (db) await closeAndCleanup(db, tmpDir);
});

function makeModuleWithChildren(db: KnowledgeDB, count: number): string {
  db.insertNode({ id: "mod", name: "Payments Module", kind: "module", summary: "payments" });
  for (let i = 1; i <= count; i++) {
    db.insertNode({
      id: `mod/child-${i}`,
      name: `Child ${i}`,
      kind: "feature",
      summary: `does thing ${i}`,
      parent_id: "mod",
      file_refs: [`src/pay/child${i}.ts`],
    });
  }
  return "mod";
}

describe("digest building", () => {
  it("builds a digest from 5 children, refreshes after the 6th, no duplicates", async () => {
    const db = freshDb();
    makeModuleWithChildren(db, DIGEST_MIN_CHILDREN);

    const first = await buildDigest(db, "mod", { embed: false });
    expect(first.created).toBe(true);
    expect(first.children).toBe(5);
    expect(db.nodeExists(first.digestId)).toBe(true);

    const node = db.getNode(first.digestId)!;
    expect(node.kind).toBe("digest");
    expect(node.parent_id).toBe("mod");
    expect(node.summary).toContain("5 concepts:");
    expect(node.summary).toContain("Child 1 — does thing 1");
    // file_refs union capped at 10, includes children's refs
    const refs = JSON.parse(node.file_refs ?? "[]") as string[];
    expect(refs).toContain("src/pay/child1.ts");
    expect(refs.length).toBeLessThanOrEqual(10);

    // Add a 6th child and rebuild — same id, refreshed summary, no duplicate.
    db.insertNode({
      id: "mod/child-6",
      name: "Child 6",
      kind: "feature",
      summary: "does thing 6",
      parent_id: "mod",
    });
    const second = await buildDigest(db, "mod", { embed: false });
    expect(second.digestId).toBe(first.digestId);
    expect(second.created).toBe(false);
    expect(db.getNode(first.digestId)!.summary).toContain("6 concepts:");

    const digests = db
      .getAllNodesRaw()
      .filter((n) => n.kind === "digest");
    expect(digests).toHaveLength(1);
  });

  it("summary is capped at 800 chars", async () => {
    const db = freshDb();
    db.insertNode({ id: "big", name: "Big Module", kind: "module", summary: "big" });
    for (let i = 1; i <= 6; i++) {
      db.insertNode({
        id: `big/c${i}`,
        name: `Child ${i}`,
        kind: "feature",
        summary: "очень длинное описание ".repeat(20),
        parent_id: "big",
      });
    }
    const result = await buildDigest(db, "big", { embed: false });
    const node = db.getNode(result.digestId)!;
    expect(node.summary.length).toBeLessThanOrEqual(800);
    expect(node.summary.endsWith("…")).toBe(true);
  });

  it("planDigests is read-only and reports skips", async () => {
    const db = freshDb();
    makeModuleWithChildren(db, 3); // below threshold
    const { build, skipped } = planDigests(db);
    expect(build).toHaveLength(0);
    expect(skipped[0]?.children).toBe(3);

    const before = db.getAllNodesRaw().length;
    planDigests(db);
    expect(db.getAllNodesRaw().length).toBe(before);
  });
});

describe("auto-digest hook", () => {
  it("builds when the 5th child lands; MEGAMEMORY_AUTO_DIGEST=0 disables", async () => {
    const db = freshDb();
    makeModuleWithChildren(db, 4);
    expect(await maybeAutoDigest(db, "mod")).toBeNull();

    db.insertNode({
      id: "mod/child-5",
      name: "Child 5",
      kind: "feature",
      summary: "fifth",
      parent_id: "mod",
    });
    const digest = await maybeAutoDigest(db, "mod");
    expect(digest).not.toBeNull();
    expect(db.nodeExists(digest!.digestId)).toBe(true);

    // Second call: digest exists → no-op.
    expect(await maybeAutoDigest(db, "mod")).toBeNull();

    process.env.MEGAMEMORY_AUTO_DIGEST = "0";
    db.insertNode({
      id: "mod/child-6",
      name: "Child 6",
      kind: "feature",
      summary: "sixth",
      parent_id: "mod",
    });
    expect(await maybeAutoDigest(db, "mod")).toBeNull();
  });
});

describe("digest in search", () => {
  it("participates in hybridSearch with reduced weight", async () => {
    const db = freshDb();
    makeModuleWithChildren(db, 5);
    await buildDigest(db, "mod", { embed: false });

    const hits = await hybridSearch(db, "thing", { topK: 10 });
    const digestHit = hits.find((h) => h.id.startsWith("mod/") && h.id.endsWith("digest"));
    expect(digestHit).toBeDefined();
    // Digest never outranks the concrete child containing the same word.
    const childIndex = hits.findIndex((h) => h.id === "mod/child-1");
    const digestIndex = hits.findIndex((h) => h.id === digestHit!.id);
    if (childIndex !== -1) {
      expect(digestIndex).toBeGreaterThan(childIndex);
    }
  });
});

describe("digestSourceChildren (U4)", () => {
  it("returns sibling source concepts, never the digest itself; stale on newer child", async () => {
    const db = freshDb();
    makeModuleWithChildren(db, 5);
    const built = await buildDigest(db, "mod", { embed: false });
    const digestId = built.digestId;

    let info = digestSourceChildren(db, digestId);
    expect(info.children).toHaveLength(5);
    expect(info.children.some((c) => c.id === "mod/digest")).toBe(false);
    expect(info.children.every((c) => c.kind !== "digest")).toBe(true);
    expect(info.stale).toBe(false);

    // A sibling updated after the digest -> stale.
    db.execSqlRun(
      "UPDATE nodes SET updated_at = datetime('now', '+1 hour') WHERE id = 'mod/child-1'"
    );
    info = digestSourceChildren(db, digestId);
    expect(info.stale).toBe(true);
  });

  it("throws for a non-digest node", () => {
    const db = freshDb();
    db.insertNode({ id: "plain", name: "Plain", kind: "feature", summary: "x" });
    expect(() => digestSourceChildren(db, "plain")).toThrow(/not a digest/);
  });
});
