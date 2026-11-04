/**
 * 2.1.3 F1: the support revision journal. Written where the snapshot is
 * written (confirm_supports, the create_concept evidence carve-out, the
 * merge carry), read via provenance_history, capped per pair (50) and by
 * days (365). Mutations and reads never journal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB, SUPPORT_REVISIONS_MAX_PER_PAIR, SUPPORT_REVISIONS_RETENTION_DAYS } from "../db.js";
import { link, createConcept } from "../tools.js";
import {
  CheckBudget,
  claimDigestOf,
  computeSupportCheck,
  confirmSupports,
  edgeDigestOf,
  provenanceHistory,
  statusDigestOf,
} from "../support-baselines.js";
import { MergeEngine } from "../merge.js";

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-revisions-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

// Close only: libsql on Windows can hold the file for a while after close
// (see helpers/cleanup.ts). Temp dirs are the OS's to clean.
afterEach(() => {
  db.close();
});

function node(id: string, kind = "config", summary = `s-${id}`) {
  db.insertNode({ id, name: id.toUpperCase(), kind, summary });
}

function supportEdge(from: string, to: string, description = `why ${to}`) {
  link(db, { from, to, relation: "informed_by", description });
}

/** Confirm the current state of the given supports of `decisionId`. */
function confirm(decisionId: string, supportIds: string[]) {
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

/** Confirm on an arbitrary db (merge test) — digests read from the rows. */
function confirmOn(target: KnowledgeDB, decisionId: string, supportIds: string[]) {
  const decision = target.getNode(decisionId)!;
  const edges = target.getInformedByEdges(decisionId, "ancestry", false);
  return confirmSupports(target, {
    decision_id: decisionId,
    expected_claim_digest: claimDigestOf(decision.summary),
    items: supportIds.map((sid) => {
      const edge = edges.find((e) => e.other_id === sid)!;
      const support = target.getNode(sid)!;
      return {
        support_id: sid,
        expected_claim_digest: claimDigestOf(support.summary),
        expected_status_digest: statusDigestOf(support.status, support.epistemic_status),
        expected_edge_digest: edgeDigestOf(edge.description),
      };
    }),
  });
}

/** Decision with supports, confirmed the plain way. */
function confirmedDecision(id: string, supports: string[]) {
  node(id, "decision", `decision ${id}`);
  for (const s of supports) {
    node(s, "fact");
    supportEdge(id, s);
  }
  confirm(id, supports);
  return id;
}

function revisions(decisionId: string, supportId?: string) {
  return db.getSupportRevisions(decisionId, supportId ?? null, 1000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. повторное подтверждение изменившейся опоры ----

describe("F1: journal writes", () => {
  it("1. reconfirming a changed support journals the old version as superseded/reconfirmed", async () => {
    confirmedDecision("d", ["f"]); // journal: agent/confirmed (v1)
    await sleep(5);
    db.updateNode("f", { summary: "f v2" });
    confirm("d", ["f"]); // journal: superseded/reconfirmed (v1); v2 lives in the snapshot

    const rows = revisions("d", "f");
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.source === "superseded")!;
    expect(old.reason).toBe("reconfirmed");
    // the entry keeps the OLD version's digests and its own confirmation time
    expect(old.claim_digest).toBe(claimDigestOf("s-f"));
    const first = rows.find((r) => r.source === "agent")!;
    expect(first.reason).toBe("confirmed");
    // the new version is current in the snapshot: no divergence
    expect(computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!.state).toBe("unchanged");
  });

  it("2. empty confirmation after unlinking journals the pair as removed", () => {
    confirmedDecision("d", ["f"]);
    db.deleteEdge("d", "f", "informed_by");
    confirmSupports(db, {
      decision_id: "d",
      expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
      items: [],
    });

    const rows = revisions("d", "f");
    const removed = rows.find((r) => r.reason === "removed");
    expect(removed).toBeDefined();
    expect(removed!.source).toBe("superseded");
    // the baseline row is superseded, not deleted (F7) — the version stays readable
    expect(db.getSupportBaselines("d")[0].superseded_at).not.toBeNull();
  });

  it("3. create_concept with evidence journals agent/confirmed; a rollback leaves neither snapshot nor journal", async () => {
    node("f", "fact");
    const res = await createConcept(db, {
      name: "d",
      kind: "decision",
      summary: "decision d plus the fixture context of this check and the call keeps its contract with the evidence passed in the call",
      evidence: [{ node: "f", why: "because f" }],
    });
    const rows = revisions(res.id, "f");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("agent");
    expect(rows[0].reason).toBe("confirmed");

    // A failing transaction leaves NOTHING: the trigger aborts on the first
    // journal insert, and the whole create_concept call (node, edge, snapshot,
    // journal) rolls back — snapshot and journal share one transaction.
    db.execSql(`
      CREATE TRIGGER revisions_boom BEFORE INSERT ON support_revisions
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    let threw = false;
    try {
      await createConcept(db, {
        name: "d2",
        kind: "decision",
        summary: "decision d2 plus the fixture context of this check and the call keeps its contract",
        evidence: [{ node: "f", why: "because f too" }],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    db.execSql("DROP TRIGGER revisions_boom");
    expect(db.nodeExists("d2")).toBe(false);
    expect(db.getSupportBaselines("d2")).toHaveLength(0);
    expect(revisions("d2")).toHaveLength(0);
  });

  it("4. provenance_history: newest-first chain, limit honored, digests are previews", async () => {
    confirmedDecision("d", ["f"]); // 1 entry
    for (let i = 2; i <= 5; i++) {
      await sleep(5);
      db.updateNode("f", { summary: `f v${i}` });
      confirm("d", ["f"]); // +4 superseded entries
    }
    const full = provenanceHistory(db, { decision_id: "d", support_id: "f" });
    const revs = full.pairs[0].revisions;
    // 4 journal entries + the current snapshot version
    expect(revs).toHaveLength(6);
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i - 1].recorded_at >= revs[i].recorded_at).toBe(true);
    }
    expect(revs[0].is_current).toBe(true);
    expect(revs[0].claim_digest).toHaveLength(12);
    expect(revs.every((r) => r.claim_digest.length <= 12)).toBe(true);

    const limited = provenanceHistory(db, { decision_id: "d", support_id: "f", limit: 2 });
    expect(limited.pairs[0].revisions).toHaveLength(2);
    expect(limited.pairs[0].revisions_truncated).toBe(true);
  });

  it("5. merge carries both confirmed chains and journals them as import", () => {
    const left = new KnowledgeDB(path.join(tmpDir, "left.db"));
    left.insertNode({ id: "d", name: "D", kind: "decision", summary: "d" });
    left.insertNode({ id: "f", name: "F", kind: "fact", summary: "s-f" });
    left.insertEdge({ from_id: "d", to_id: "f", relation: "informed_by", description: "why f" });
    confirmOn(left, "d", ["f"]);
    left.close();

    const right = new KnowledgeDB(path.join(tmpDir, "right.db"));
    right.insertNode({ id: "d", name: "D", kind: "decision", summary: "d" });
    right.insertNode({ id: "g", name: "G", kind: "fact", summary: "s-g" });
    right.insertEdge({ from_id: "d", to_id: "g", relation: "informed_by", description: "why g" });
    confirmOn(right, "d", ["g"]);
    right.close();

    new MergeEngine().merge(
      path.join(tmpDir, "left.db"),
      path.join(tmpDir, "right.db"),
      path.join(tmpDir, "out.db")
    );

    const out = new KnowledgeDB(path.join(tmpDir, "out.db"));
    try {
      expect(out.getSupportBaselines("d").map((r) => r.support_id).sort()).toEqual(["f", "g"]);
      const hist = provenanceHistory(out, { decision_id: "d" });
      expect(hist.pairs.map((p) => p.support_id).sort()).toEqual(["f", "g"]);
      for (const pair of hist.pairs) {
        const imported = pair.revisions.find((r) => r.source === "import");
        expect(imported).toBeDefined();
        // the carried anchor is live in the output db
        expect(pair.revisions.some((r) => r.is_current)).toBe(true);
      }
      // the right pair's edge was re-anchored to a new rowid — the entry says so
      const gPair = hist.pairs.find((p) => p.support_id === "g")!;
      expect(gPair.revisions.find((r) => r.source === "import")!.reason).toBe("edge_relinked");
    } finally {
      out.close();
    }
  });

  it("6. retention: 60 confirmations leave 50 revisions, the oldest dropped", async () => {
    confirmedDecision("d", ["f"]); // entry 1 (agent/confirmed)
    for (let i = 0; i < 59; i++) {
      await sleep(3);
      db.updateNode("f", { summary: `f v${i}` });
      confirm("d", ["f"]); // +1 superseded entry each
    }
    const rows = revisions("d", "f");
    expect(rows).toHaveLength(SUPPORT_REVISIONS_MAX_PER_PAIR);
    // newest first, and the very first version's entry is gone
    expect(rows.every((r, i) => i === 0 || rows[i - 1].recorded_at >= r.recorded_at)).toBe(true);
    expect(rows.some((r) => r.reason === "confirmed")).toBe(false);
    // the newest journal entry is the superseded v57 — v58 lives in the snapshot
    expect(rows[0].claim_digest).toBe(claimDigestOf("f v57"));
  });

  it("6b. retention: revisions older than 365 days are purged on write", () => {
    confirmedDecision("d", ["f"]);
    const old = new Date(
      Date.now() - (SUPPORT_REVISIONS_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000
    ).toISOString();
    db.insertSupportRevision({
      decision_id: "d",
      support_id: "f",
      edge_key: "legacy",
      claim_digest: "c",
      status_digest: "s",
      edge_digest: "e",
      format_version: 1,
      confirmed_at: old,
      recorded_at: old,
      source: "agent",
      reason: "confirmed",
    });
    expect(db.countSupportRevisions()).toBe(2);
    expect(db.pruneSupportRevisions(new Date().toISOString())).toBe(1);
    expect(db.countSupportRevisions()).toBe(1);
  });

  it("7. link/unlink/update_concept never write the journal", () => {
    confirmedDecision("d", ["f", "g"]);
    const before = revisions("d").length;
    expect(before).toBe(2); // one agent/confirmed entry per pair

    db.updateNode("f", { summary: "edited" }); // mutation
    node("h", "fact");
    supportEdge("d", "h"); // link
    db.deleteEdge("d", "g", "informed_by"); // unlink

    expect(revisions("d").length).toBe(before);
  });
});
