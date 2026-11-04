/**
 * 2.1.3 F2: digests of external artifacts. check_artifacts is the only
 * writer; the support-check verdict compares the snapshot's saved
 * artifacts_digest against the current observation — by content, never by
 * clocks. Files and git blobs; missing is a record, not a crash.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { KnowledgeDB } from "../db.js";
import { link } from "../tools.js";
import { provenanceTrace } from "../provenance.js";
import {
  CheckBudget,
  claimDigestOf,
  computeSupportCheck,
  confirmSupports,
  edgeDigestOf,
  statusDigestOf,
} from "../support-baselines.js";
import { checkArtifacts } from "../artifacts.js";

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async () => Buffer.alloc(0)),
  embeddingText: vi.fn((name: string, kind: string, summary: string) => `${kind}: ${name} — ${summary}`),
  findTopK: vi.fn(),
  embedForStorage: vi.fn(async () => null),
  vectorSearchEnabled: vi.fn(() => false),
  cosineSimilarity: vi.fn(() => 0),
  queryText: vi.fn((q: string) => q),
}));

let tmpDir: string;
let db: KnowledgeDB;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-artifacts-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

// Close only: libsql on Windows can hold the file for a while after close
// (see helpers/cleanup.ts). Temp dirs are the OS's to clean.
afterEach(() => {
  db.close();
});

function fileNode(id: string, ref: string, summary = `s-${id}`) {
  db.insertNode({ id, name: id.toUpperCase(), kind: "fact", summary, file_refs: [ref] });
}

function decisionWithSupport(id: string, supportId: string, ref: string) {
  db.insertNode({ id, name: id.toUpperCase(), kind: "decision", summary: `decision ${id}` });
  fileNode(supportId, ref);
  link(db, { from: id, to: supportId, relation: "informed_by", description: `why ${supportId}` });
}

/** Confirm after the artifacts have been checked (what the plan calls
 * "the agent re-read the support and its artifact"). */
function confirmNow(decisionId: string, supportIds: string[]) {
  const decision = db.getNode(decisionId)!;
  const edges = db.getInformedByEdges(decisionId, "ancestry", false);
  return confirmSupports(db, {
    decision_id: decisionId,
    expected_claim_digest: claimDigestOf(decision.summary),
    items: supportIds.map((sid) => {
      const edge = edges.find((e) => e.other_id === sid)!;
      const support = db.getNode(sid)!;
      return {
        support_id: sid,
        expected_claim_digest: claimDigestOf(support.summary),
        expected_status_digest: statusDigestOf(support.status, support.epistemic_status),
        expected_edge_digest: edgeDigestOf(edge.description),
      };
    }),
  });
}

function check(nodeIds: string[], maxFiles?: number) {
  return checkArtifacts(db, { node_ids: nodeIds, max_files: maxFiles, cwd: tmpDir });
}

// ---- 1. первая запись digest и повторная проверка без изменений ----

describe("F2: check_artifacts", () => {
  it("1. first check records the digest; a same-content re-check changes nothing", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v1");
    fileNode("s", "f.txt");

    const first = await check(["s"]);
    expect(first.checked).toBe(1);
    expect(first.changed).toEqual([]);
    expect(first.missing).toEqual([]);
    expect(first.truncated).toBe(false);

    const row = db.getNodeArtifacts("s")[0];
    expect(row.kind).toBe("file");
    expect(row.digest).toBe(sha256("content v1"));
    expect(row.changed_at).toBeNull(); // a first observation is not a divergence

    await sleep(5);
    const second = await check(["s"]);
    expect(second.changed).toEqual([]);
    const row2 = db.getNodeArtifacts("s")[0];
    expect(row2.digest).toBe(sha256("content v1"));
    expect(row2.changed_at).toBeNull(); // same content: changed_at does NOT move
    expect(row2.checked_at >= row.checked_at).toBe(true); // but checked_at does
  });

  it("2. a changed file reports old→new and fires artifact_changed in weak_links", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v1");
    decisionWithSupport("d", "s", "f.txt");
    await check(["s"]);
    confirmNow("d", ["s"]); // the snapshot saves the observed state

    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v2");
    const res = await check(["s"]);
    expect(res.changed).toEqual([
      { node_id: "s", ref: "f.txt", old: sha256("content v1"), new: sha256("content v2") },
    ]);

    const trace = provenanceTrace(db, { node_id: "d" });
    const art = trace.weak_links.find((w) => w.type === "artifact_changed");
    expect(art).toBeDefined();
    expect(art!.count).toBe(1);
    expect(art!.sample).toEqual(["s"]);
    // path + both digest previews in the note
    expect(art!.note).toContain("f.txt");
    expect(art!.note).toContain(sha256("content v1").slice(0, 12));
    expect(art!.note).toContain(sha256("content v2").slice(0, 12));

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    expect(view.changed![0].artifact_changed).toBe(true);
    expect(view.changed![0].reasons).toEqual([]); // the summary is untouched
    expect(view.changed![0].artifacts![0].ref).toBe("f.txt");
    expect(view.artifact_changed_count).toBe(1);
  });

  it("3. a deleted file is a missing record, not a crash", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v1");
    fileNode("s", "f.txt");
    await check(["s"]);

    fs.unlinkSync(path.join(tmpDir, "f.txt"));
    const res = await check(["s"]);
    expect(res.checked).toBe(1);
    expect(res.missing).toEqual([
      { node_id: "s", ref: "f.txt", kind: "file", digest: null, missing: true },
    ]);
    expect(res.changed).toEqual([]);
    // the row keeps the last-seen digest in prev_digest for the warning text
    const row = db.getNodeArtifacts("s")[0];
    expect(row.digest).toBeNull();
    expect(row.prev_digest).toBe(sha256("content v1"));
    expect(row.changed_at).not.toBeNull();
  });

  it("4. git_blob for a commit ref and a plain path for the working tree", async () => {
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    const git = (args: string) => {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      execSync(`git ${args}`, { cwd: repo, stdio: "ignore" });
    };
    git("init");
    git("config user.email t@example.com");
    git("config user.name t");
    fs.writeFileSync(path.join(repo, "committed.txt"), "committed content");
    fs.writeFileSync(path.join(repo, "dirty.txt"), "working tree content");
    git("add committed.txt");
    git("commit -m init");

    const repoDb = new KnowledgeDB(path.join(repo, "knowledge.db"));
    try {
      repoDb.insertNode({
        id: "s",
        name: "S",
        kind: "fact",
        summary: "s-s",
        file_refs: ["HEAD:committed.txt", "dirty.txt"],
      });
      const res = await checkArtifacts(repoDb, { node_ids: ["s"], cwd: repo });
      expect(res.checked).toBe(2);
      expect(res.changed).toEqual([]);
      const rows = repoDb.getNodeArtifacts("s");
      expect(rows.map((r) => r.kind).sort()).toEqual(["file", "git_blob"]);
      const blob = rows.find((r) => r.kind === "git_blob")!;
      expect(blob.ref).toBe("HEAD:committed.txt");
      expect(blob.digest).toBe(sha256("committed content"));
      const plain = rows.find((r) => r.kind === "file")!;
      expect(plain.digest).toBe(sha256("working tree content"));
    } finally {
      repoDb.close();
    }
  });

  it("5. max_files caps the work and reports truncated", async () => {
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(tmpDir, `f${i}.txt`), `content ${i}`);
      fileNode(`s${i}`, `f${i}.txt`);
    }
    const res = await check(Array.from({ length: 100 }, (_, i) => `s${i}`), 50);
    expect(res.checked).toBe(50);
    expect(res.truncated).toBe(true);
    // the cut is deterministic: first 50 nodes in the passed order
    expect(db.countNodeArtifacts()).toBe(50);
    expect(db.getNodeArtifacts("s49")).toHaveLength(1);
    expect(db.getNodeArtifacts("s50")).toHaveLength(0);
  });

  // ---- 6. support_changed и artifact_changed в одном ответе ----

  it("6. support_check distinguishes support_changed from artifact_changed", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a v1");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b v1");
    db.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
    fileNode("s1", "a.txt");
    fileNode("s2", "b.txt", "s2 v1");
    link(db, { from: "d", to: "s1", relation: "informed_by", description: "why s1" });
    link(db, { from: "d", to: "s2", relation: "informed_by", description: "why s2" });
    await check(["s1", "s2"]);
    confirmNow("d", ["s1", "s2"]);

    // s2's summary moves (support_changed), s1's FILE moves (artifact_changed)
    db.updateNode("s2", { summary: "s2 v2" });
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a v2");
    await check(["s1"]);

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    const byId = new Map(view.changed!.map((c) => [c.support, c]));
    expect(byId.get("s1")!.reasons).toEqual([]);
    expect(byId.get("s1")!.artifact_changed).toBe(true);
    expect(byId.get("s2")!.reasons).toEqual(["summary"]);
    expect(byId.get("s2")!.artifact_changed).toBeUndefined();
    expect(view.artifact_changed_count).toBe(1);

    const trace = provenanceTrace(db, { node_id: "d" });
    const supportChanged = trace.weak_links.find((w) => w.type === "support_changed")!;
    const artifactChanged = trace.weak_links.find((w) => w.type === "artifact_changed")!;
    expect(supportChanged.count).toBe(1); // artifact-only s1 is NOT counted here
    expect(supportChanged.sample).toEqual(["s2"]);
    expect(artifactChanged.count).toBe(1);
    expect(artifactChanged.sample).toEqual(["s1"]);
  });

  it("7. first-ever check after confirmation with no changes: no signal, state unchanged", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v1");
    decisionWithSupport("d", "s", "f.txt");
    confirmNow("d", ["s"]); // confirmed BEFORE any artifact observation (saves NULL)

    await check(["s"]); // first observation, content unchanged since the confirm

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("unchanged");
    expect(view.changed).toEqual([]);
    expect(view.artifact_changed_count).toBeUndefined();
  });

  it("8. an artifact changed twice after confirmation keeps the signal (compare vs confirmed)", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v1");
    decisionWithSupport("d", "s", "f.txt");
    await check(["s"]);
    confirmNow("d", ["s"]); // snapshot saves digest(content v1)

    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v2");
    const res2 = await check(["s"]);
    expect(res2.changed[0].new).toBe(sha256("content v2"));

    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v3");
    const res3 = await check(["s"]);
    expect(res3.changed).toEqual([
      { node_id: "s", ref: "f.txt", old: sha256("content v2"), new: sha256("content v3") },
    ]);

    // two divergences observed, but the verdict compares against the
    // CONFIRMED digest — the signal survives the second change
    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    expect(view.changed![0].artifact_changed).toBe(true);
    expect(view.artifact_changed_count).toBe(1);
    // the warning text shows the last observed transition (v2 → v3)
    expect(view.changed![0].artifacts![0].prev_digest).toBe(sha256("content v2").slice(0, 12));
    expect(view.changed![0].artifacts![0].digest).toBe(sha256("content v3").slice(0, 12));
  });

  it("9. re-confirmation after a check clears artifact_changed", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v1");
    decisionWithSupport("d", "s", "f.txt");
    await check(["s"]);
    confirmNow("d", ["s"]);

    fs.writeFileSync(path.join(tmpDir, "f.txt"), "content v2");
    await check(["s"]);
    expect(computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!.state).toBe("changed");

    confirmNow("d", ["s"]); // the agent re-read the support and the artifact
    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("unchanged");
    expect(view.artifact_changed_count).toBeUndefined();
  });
});
