/**
 * Plan 4 v8: support baselines — a snapshot of the justification.
 *
 * The 20 acceptance scenarios from plan-4-fingerprint-design-v2 §9, in order.
 * Acceptance-critical: 1, 2, 4, 5, 7.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { KnowledgeDB } from "../db.js";
import { link, createConcept, updateConcept, removeConcept, resolveConflict } from "../tools.js";
import { provenanceTrace } from "../provenance.js";
import {
  CheckBudget,
  claimDigestOf,
  computeSupportCheck,
  confirmSupports,
  edgeDigestOf,
  provenanceMetrics,
  statusDigestOf,
} from "../support-baselines.js";
import { MergeEngine } from "../merge.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-baselines-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

// Close only: libsql on Windows can hold the file for up to ~10 s after
// close under AV/indexer pressure (helpers/cleanup.ts budgets 4 s and loses
// that race, paying it per test). Temp dirs are the OS's to clean.
afterEach(() => {
  db.close();
});

function node(id: string, kind = "config", summary = `s-${id}`) {
  db.insertNode({ id, name: id.toUpperCase(), kind, summary });
}

/** Support edge written by the agent path (link) so created_via = 'agent'. */
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

/** Decision with evidence confirmed the plain way (no createConcept needed). */
function confirmedDecision(id: string, supports: string[]) {
  node(id, "decision", `decision ${id}`);
  for (const s of supports) {
    node(s, "fact");
    supportEdge(id, s);
  }
  confirm(id, supports);
  return id;
}

// ---- 1. Сигнал по F жив; добавление G не подтверждает F (приёмка) ----

describe("§9.1 mutation never confirms", () => {
  it("changing F then adding an unrelated support G keeps the F signal; G is unknown", async () => {
    confirmedDecision("d", ["f"]);
    db.updateNode("f", { summary: "f changed" });
    node("g", "fact");
    supportEdge("d", "g");

    const view = computeSupportCheck(db, "d", new CheckBudget(100, 1_000_000))!;
    expect(view.state).toBe("changed");
    const fChange = view.changed!.find((c) => c.support === "f");
    expect(fChange?.reasons).toEqual(["summary"]);
    expect(view.unknown).toEqual(["g"]);
  });
});

// ---- 2. Смена рационала тем же link, каким пользуется агент (приёмка) ----

describe("§9.2 rationale rewrite via link", () => {
  it("upsert with a new rationale reports reasons ['rationale'], the anchor survives", () => {
    confirmedDecision("d", ["f"]);
    const before = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(before.state).toBe("unchanged");

    // The agent's route to a new rationale: unlink (tombstone) + link (revive
    // of the same row with the new description).
    expect(db.deleteEdge("d", "f", "informed_by")).toBe(true);
    supportEdge("d", "f", "why f, rewritten");

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    const change = view.changed!.find((c) => c.support === "f");
    expect(change?.reasons).toEqual(["rationale"]);
    // The comparison base was not destroyed: same confirmation time.
    expect(change?.since).toBe(before.baseline_at);
  });
});

// ---- 3. Идемпотентный link и чужой unlink/link не трогают состояние ----

describe("§9.3 idempotent writes", () => {
  it("idempotent link and unlink/relink of another edge leave the pair and baseline_at", () => {
    confirmedDecision("d", ["f"]);
    const before = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;

    const res = link(db, { from: "d", to: "f", relation: "informed_by", description: "why f" });
    expect(res.message).toContain("already exists");

    node("g", "fact");
    supportEdge("d", "g");
    expect(db.deleteEdge("d", "g", "informed_by")).toBe(true);
    supportEdge("d", "g");

    const after = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    // The confirmed pair f keeps its state; the churned edge g is honestly
    // unknown (adding/relinking never confirms — §2). The snapshot itself
    // did not move: same baseline_at.
    expect(after.changed).toEqual([]);
    expect(after.unknown).toEqual(["g"]);
    expect(after.baseline_at).toBe(before.baseline_at);
  });
});

// ---- 4. version_conflict: v2 не принимается (приёмка) ----

describe("§9.4 version_conflict", () => {
  it("confirm with stale digests is refused and writes nothing", () => {
    node("d", "decision");
    node("f", "fact");
    supportEdge("d", "f");
    const stale = claimDigestOf(db.getNode("f")!.summary);
    const staleEdge = edgeDigestOf(db.getInformedByEdges("d", "ancestry", false)[0].description);

    // Another writer moves f to v2.
    db.updateNode("f", { summary: "f v2" });

    let message = "";
    try {
      confirmSupports(db, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
        items: [{ support_id: "f", expected_claim_digest: stale, expected_edge_digest: staleEdge }],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("version_conflict");
    expect(message).toContain("f");
    // Nothing written: no snapshot, no claim anchor.
    expect(db.getSupportBaselines("d")).toEqual([]);
    expect(db.getNode("d")!.claim_digest ?? null).toBeNull();
  });
});

// ---- 5. Удалённая опора: строка жива, видно removed (приёмка) ----

describe("§9.5 removed support", () => {
  it("force-removal keeps the snapshot row and reports removed — distinct from no supports", () => {
    confirmedDecision("d", ["f"]);

    // Full hygiene removal: the node and its edges go, the row must stay.
    removeConcept(db, { id: "f", reason: "gone", force: true });

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    expect(view.changed).toEqual([
      expect.objectContaining({ support: "f", reasons: ["removed"] }),
    ]);

    // ...and it is distinct from a confirmed "no supports" state.
    confirmSupports(db, {
      decision_id: "d",
      expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
      items: [],
    });
    const empty = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(empty.state).toBe("unchanged");
    expect(empty.changed).toEqual([]);
    expect(empty.baseline_at).not.toBe(view.baseline_at);
  });
});

// ---- 6. Старое решение без снимка: unknown, не unchanged ----

describe("§9.6 bootstrap honesty", () => {
  it("a rewritten support of a never-confirmed decision reads unknown", () => {
    node("d", "decision");
    node("f", "fact");
    // Raw write: no confirmation ever happened.
    db.insertEdgeRaw({ from_id: "d", to_id: "f", relation: "informed_by", description: "why" });
    db.updateNode("f", { summary: "rewritten before the first read" });

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("unknown");
    expect(view.unknown).toEqual(["f"]);
    expect(view.baseline_at).toBeNull();
  });
});

// ---- 7. Три состояния, не один «пустой» (приёмка) ----

describe("§9.7 three distinct states", () => {
  it("no snapshot / confirmed empty / budget-cut are three different verdicts", () => {
    // (a) never confirmed
    node("d1", "decision");
    node("f1", "fact");
    supportEdge("d1", "f1");
    const a = computeSupportCheck(db, "d1", new CheckBudget(10, 1_000_000))!;
    expect(a.state).toBe("unknown");

    // (b) confirmed empty set
    node("d2", "decision");
    confirmSupports(db, {
      decision_id: "d2",
      expected_claim_digest: claimDigestOf(db.getNode("d2")!.summary),
      items: [],
    });
    const b = computeSupportCheck(db, "d2", new CheckBudget(10, 1_000_000))!;
    expect(b.state).toBe("unchanged");
    expect(b.changed).toEqual([]);
    expect(b.unknown).toEqual([]);
    expect(b.baseline_at).not.toBeNull();

    // (c) budget cut: unchanged must NOT be issued
    confirmedDecision("d3", ["f3a", "f3b", "f3c"]);
    const c = computeSupportCheck(db, "d3", new CheckBudget(2, 1_000_000))!;
    expect(c.state).toBe("incomplete");
    expect(c.incomplete).toBe(true);
  });
});

// ---- 8. Разные поля у разных опор ----

describe("§9.8 per-support reasons", () => {
  it("two supports changed in different fields report the right reasons each", () => {
    confirmedDecision("d", ["f1", "f2"]);
    // f1: status only.
    db.setEpistemicStatus("f1", "validated", "test artifact", { artifact: "run-1" });
    // f2: summary AND status at once.
    db.updateNode("f2", { summary: "f2 new" });
    db.setEpistemicStatus("f2", "refuted", "wrong");

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    expect(view.changed!.find((c) => c.support === "f1")!.reasons).toEqual(["status"]);
    expect(view.changed!.find((c) => c.support === "f2")!.reasons).toEqual(["summary", "status"]);
  });
});

// ---- 9. Транзитивность: локальное расхождение у F1 с путём ----

describe("§9.9 check at every level", () => {
  it("editing F2 surfaces a local divergence on F1 in the trace from D", () => {
    node("d", "decision");
    node("f1", "fact");
    node("f2", "fact");
    supportEdge("d", "f1");
    supportEdge("f1", "f2");
    confirm("d", ["f1"]);
    confirm("f1", ["f2"]);

    db.updateNode("f2", { summary: "f2 rewritten" });

    const out = provenanceTrace(db, { node_id: "d" });
    const f1 = out.nodes.find((n) => n.id === "f1")!;
    expect(f1.support_check).toBeDefined();
    expect(f1.support_check!.state).toBe("changed");
    expect(f1.support_check!.changed![0].support).toBe("f2");
    expect(f1.support_check!.changed![0].reasons).toEqual(["summary"]);
    // The root's own snapshot is intact: its support f1 did not move.
    expect(out.support_check!.state).toBe("unchanged");
  });
});

// ---- 10. Переписали D — прежнее подтверждение не действует ----

describe("§9.10 claim rewrite", () => {
  it("rewriting the decision does not extend the old confirmation", async () => {
    confirmedDecision("d", ["f"]);
    await updateConcept(db, { id: "d", changes: { summary: "d rewritten" } });

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.claim_changed).toBe(true);
    expect(view.state).toBe("changed");
    expect(view.changed).toEqual([]); // supports themselves did not move
  });
});

// ---- 11. Внутренняя нормализация не схлопывает "a  b" и "a b" ----

describe("§9.11 no inner normalization", () => {
  it("a double-space to single-space summary change is detected", () => {
    confirmedDecision("d", ["f"]);
    db.updateNode("f", { summary: "a b" });
    // Guard: the fixture really had the doubled space.
    expect(claimDigestOf("a  b")).not.toBe(claimDigestOf("a b"));

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.changed!.find((c) => c.support === "f")!.reasons).toEqual(["summary"]);
  });
});

// ---- 12. Бюджет рёбер: incomplete, снимок не пишется ----

describe("§9.12 edge budget", () => {
  it("more supports than max_check_edges yields incomplete, never unchanged", () => {
    confirmedDecision("d", ["f1", "f2", "f3"]);
    const view = computeSupportCheck(db, "d", new CheckBudget(2, 1_000_000))!;
    expect(view.state).toBe("incomplete");
    expect(view.incomplete).toBe(true);
  });
});

// ---- 13. Бюджеты рёбер и байт соблюдаются ----

describe("§9.13 byte budget", () => {
  it("large texts are counted in bytes; the budget stops the check", () => {
    node("d", "decision");
    node("f1", "fact", "x".repeat(1000));
    node("f2", "fact", "y".repeat(1000));
    supportEdge("d", "f1");
    supportEdge("d", "f2");
    confirm("d", ["f1", "f2"]);

    // Byte budget trips on the second support.
    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1500))!;
    expect(view.state).toBe("incomplete");
    // Edge budget of 1 trips on the first support.
    const view2 = computeSupportCheck(db, "d", new CheckBudget(1, 10_000_000))!;
    expect(view2.state).toBe("incomplete");
  });
});

/** Best-effort: Windows/libsql can hold a closed file for a while (EBUSY) —
 * temp dirs are the OS's to clean, so a failed unlink must not fail the test. */
function rmTemp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leave it to the OS */
  }
}

// ---- 14. Merge: расхождение сохраняется ----

describe("§9.14 merge keeps the divergence", () => {
  it("D confirmed against F@v1 + surviving F@v2 stays changed with import origin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-baselines-merge-"));
    try {
      const leftPath = path.join(dir, "left.db");
      const rightPath = path.join(dir, "right.db");
      const outPath = path.join(dir, "out.db");

      const left = new KnowledgeDB(leftPath);
      left.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
      left.insertNode({ id: "f", name: "F", kind: "feature", summary: "f v1" });
      left.insertEdge({ from_id: "d", to_id: "f", relation: "informed_by", description: "why f" });
      const fRow = left.getNode("f")!;
      confirmSupports(left, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf("decision d"),
        items: [
          {
            support_id: "f",
            expected_claim_digest: claimDigestOf("f v1"),
            expected_status_digest: statusDigestOf(fRow.status, fRow.epistemic_status),
            expected_edge_digest: edgeDigestOf("why f"),
          },
        ],
      });
      left.close();

      const right = new KnowledgeDB(rightPath);
      right.insertNode({ id: "f", name: "F", kind: "feature", summary: "f v2" });
      right.close();

      // The versions diverge -> a conflict group; the resolution writes the
      // truth ("f v2") onto the canonical id.
      const result = new MergeEngine().merge(leftPath, rightPath, outPath);
      expect(result.baselinesCarried).toBe(1);
      const group = result.mergeGroups[0];

      const out = new KnowledgeDB(outPath);
      await resolveConflict(out, {
        merge_group: group,
        resolved: { summary: "f v2" },
        reason: "right side is the current truth",
      });

      const rows = out.getSupportBaselines("d");
      expect(rows).toHaveLength(1);
      expect(rows[0].confirmed_by).toBe("import");
      expect(rows[0].claim_digest).toBe(claimDigestOf("f v1")); // content preserved, not amnestied

      const view = computeSupportCheck(out, "d", new CheckBudget(10, 1_000_000))!;
      expect(view.state).toBe("changed");
      expect(view.changed![0].reasons).toEqual(["summary"]);
      expect(view.changed![0].since).toBe(rows[0].confirmed_at);
      out.close();
    } finally {
      rmTemp(dir);
    }
  });
});

// ---- 15. Чистый remap id при merge: ложных изменений нет ----

describe("§9.15 clean merge remap", () => {
  it("identical inputs carry the snapshot without mass false changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-baselines-merge2-"));
    try {
      const build = (p: string): void => {
        const d = new KnowledgeDB(p);
        d.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
        d.insertNode({ id: "f", name: "F", kind: "feature", summary: "f v1" });
        d.insertEdge({ from_id: "d", to_id: "f", relation: "informed_by", description: "why f" });
        const fRow = d.getNode("f")!;
        confirmSupports(d, {
          decision_id: "d",
          expected_claim_digest: claimDigestOf("decision d"),
          items: [
            {
              support_id: "f",
              expected_claim_digest: claimDigestOf("f v1"),
              expected_status_digest: statusDigestOf(fRow.status, fRow.epistemic_status),
              expected_edge_digest: edgeDigestOf("why f"),
            },
          ],
        });
        d.close();
      };
      const leftPath = path.join(dir, "left.db");
      const rightPath = path.join(dir, "right.db");
      const outPath = path.join(dir, "out.db");
      build(leftPath);
      build(rightPath);

      new MergeEngine().merge(leftPath, rightPath, outPath);
      const out = new KnowledgeDB(outPath);
      const view = computeSupportCheck(out, "d", new CheckBudget(10, 1_000_000))!;
      expect(view.state).toBe("unchanged");
      // The edge rowid changed under the snapshot — edge_key was remapped.
      const edge = out.getInformedByEdges("d", "ancestry", false)[0];
      expect(out.getSupportBaselines("d")[0].edge_key).toBe(String(edge.id));
      out.close();
    } finally {
      rmTemp(dir);
    }
  });
});

// ---- 16. Старые рёбра: created_via = 'unknown' ----

describe("§9.16 origin metrics", () => {
  it("raw (imported/migrated) edges are unknown, link edges are agent", () => {
    node("d", "decision");
    node("f", "fact");
    db.insertEdgeRaw({ from_id: "d", to_id: "f", relation: "informed_by", description: "old row" });
    node("d2", "decision");
    node("f2", "fact");
    supportEdge("d2", "f2");

    const m = provenanceMetrics(db, new CheckBudget(100, 1_000_000));
    expect(m.edges_by_origin.agent).toBe(1);
    expect(m.edges_by_origin.unknown).toBe(1);
    expect(m.edges_by_origin.auto).toBe(0);
  });
});

// ---- 17. Принятие авто-ребра: created_via не переписывается ----

describe("§9.17 accepted auto edge", () => {
  it("confirming an auto edge sets accepted_at and keeps created_via", async () => {
    // auto_ground derives supports from file_refs for decisions.
    fs.writeFileSync(
      path.join(tmpDir, "megamemory.config.json"),
      JSON.stringify({ provenance: { auto_ground: true } })
    );
    node("src", "feature");
    db.updateNode("src", { file_refs: ["src/a.ts"] });
    // resolveFileRef matches nodes whose file_refs JSON contains the ref.
    const res = await createConcept(db, {
      name: "auto decision",
      kind: "decision",
      summary: "auto d",
      why: "from the file",
      file_refs: ["src/a.ts"],
    });
    const edges = db.getInformedByEdges(res.id, "ancestry", false);
    expect(edges.length).toBe(1);
    expect((edges[0] as { created_via?: string }).created_via).toBe("auto");

    const supportId = edges[0].other_id;
    const supportRow = db.getNode(supportId)!;
    confirmSupports(db, {
      decision_id: res.id,
      expected_claim_digest: claimDigestOf("auto d"),
      items: [
        {
          support_id: supportId,
          expected_claim_digest: claimDigestOf(supportRow.summary),
          expected_status_digest: statusDigestOf(supportRow.status, supportRow.epistemic_status),
          expected_edge_digest: edgeDigestOf(edges[0].description),
        },
      ],
    });
    const after = db.getEdgeById(edges[0].id)!;
    expect(after.created_via).toBe("auto"); // never rewritten
    expect(after.accepted_at).not.toBeNull(); // acceptance is a separate fact

    const m = provenanceMetrics(db, new CheckBudget(10, 1_000_000));
    expect(m.edges_accepted).toBe(1);
  });
});

// ---- 18. Снимок не изменить через update_concept/импорт ----

describe("§9.18 snapshot is not writable sideways", () => {
  it("update_concept rewrites content but never the snapshot", async () => {
    confirmedDecision("d", ["f"]);
    const before = db.getSupportBaselines("d");

    await updateConcept(db, { id: "d", changes: { why: "new why" } });
    await updateConcept(db, { id: "f", changes: { summary: "f rewritten" } });

    const after = db.getSupportBaselines("d");
    expect(after).toEqual(before); // digests and confirmed_at untouched
    // And the check honestly reports the divergence instead of hiding it.
    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
  });
});

// ---- 19. Обрезка weak_links: счётчики причин, support_changed жив ----

describe("§9.19 truncation counters", () => {
  it("many weak links keep support_changed and carry reason_counts", () => {
    // One connected closure so a single trace sees every decision: a chain
    // dd0 -> dd1 -> ... -> dd44, each link also leaning on its own confirmed
    // support ff_i (changed after the confirmation), plus one refuted node.
    node("rf", "fact");
    db.setEpistemicStatus("rf", "refuted", "wrong");
    for (let i = 0; i < 45; i++) {
      node(`dd${i}`, "decision");
      node(`ff${i}`, "fact");
    }
    for (let i = 0; i < 45; i++) {
      supportEdge(`dd${i}`, `ff${i}`);
      if (i < 44) supportEdge(`dd${i}`, `dd${i + 1}`, "chain of reasoning");
      confirm(`dd${i}`, [`ff${i}`]);
      db.updateNode(`ff${i}`, { summary: `ff${i} moved` });
    }
    supportEdge("dd39", "rf");

    // The chain is 40 deep — raise the depth so one trace sees every link
    // (function-level cap is 100000; the MCP schema caps tighter).
    const out = provenanceTrace(db, { node_id: "dd0", depth: 50 });
    const marker = out.weak_links.find((w) => w.type === "weak_links_truncated");
    expect(marker).toBeDefined();
    expect(marker!.reason_counts).toBeDefined();
    expect(marker!.reason_counts!["support_changed"]).toBe(45);
    // Priority keeps the changed verdict in the kept set.
    expect(out.weak_links.some((w) => w.type === "support_changed")).toBe(true);
  });
});

// ---- 20. Журнала нет: вернувшееся значение не расходится ----

describe("§9.20 no history journal", () => {
  it("a support changed back shows no divergence — the doc says so", () => {
    confirmedDecision("d", ["f"]);
    db.updateNode("f", { summary: "f v2" });
    db.updateNode("f", { summary: "s-f" }); // back to the confirmed text

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("unchanged");
  });
});

// ---- Инструмент: create_concept с evidence подтверждает сам вызов ----

describe("create_concept evidence snapshot", () => {
  it("evidence supports are confirmed in the same call; auto-ground is not", async () => {
    node("f", "fact");
    const res = await createConcept(db, {
      name: "d",
      kind: "decision",
      summary: "decision d",
      evidence: [{ node: "f", why: "because f" }],
    });
    const rows = db.getSupportBaselines(res.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].support_id).toBe("f");
    expect(rows[0].confirmed_by).toBe("agent");
    const view = computeSupportCheck(db, res.id, new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("unchanged");
  });

  it("a decision without evidence stays unconfirmed (unknown)", async () => {
    const res = await createConcept(db, {
      name: "plain",
      kind: "feature",
      summary: "plain feature",
    });
    expect(computeSupportCheck(db, res.id, new CheckBudget(10, 1_000_000))).toBeNull();
  });
});

// ---- Инструмент: confirm_supports пустым списком ----

describe("confirm_supports empty items", () => {
  it("refuses to confirm 'no supports' while live supports exist", () => {
    confirmedDecision("d", ["f"]);
    let message = "";
    try {
      confirmSupports(db, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
        items: [],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("version_conflict");
  });
});

// ---- plan-4-fixes-5: снятая опора живёт в снимке до явного подтверждения ----

describe("removed supports keep their snapshot rows (plan-4-fixes-5)", () => {
  it("21. a tombstoned support edge reports changed/removed and the row survives", () => {
    confirmedDecision("d", ["f"]);
    db.deleteEdge("d", "f", "informed_by"); // the agent unlinks the support

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    expect(view.changed).toEqual([
      expect.objectContaining({ support: "f", reasons: ["removed"] }),
    ]);
    // The row IS the fact "confirmed, then removed" — nothing deleted it.
    expect(db.getSupportBaselines("d").map((r) => r.support_id)).toEqual(["f"]);
  });

  it("22. the explicit 'no supports' confirmation supersedes the dead rows, it does not erase them (F7)", () => {
    confirmedDecision("d", ["f", "g"]);
    db.deleteEdge("d", "f", "informed_by");

    // Confirming the live support g must not amnesty the dead anchor f.
    confirm("d", ["g"]);
    expect(db.getSupportBaselines("d").map((r) => r.support_id)).toEqual(["f", "g"]);
    const afterG = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(afterG.state).toBe("changed");
    expect(afterG.changed).toEqual([
      expect.objectContaining({ support: "f", reasons: ["removed"] }),
    ]);

    // The empty confirm (accepted only with zero live edges) is the explicit
    // "no supports" statement. F7: the dead rows are MARKED superseded, not
    // deleted — "confirmed and later removed" stays distinguishable from
    // "supports never existed".
    db.deleteEdge("d", "g", "informed_by");
    confirmSupports(db, {
      decision_id: "d",
      expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
      items: [],
    });
    const rows = db.getSupportBaselines("d");
    expect(rows.map((r) => r.support_id)).toEqual(["f", "g"]);
    expect(rows.every((r) => r.superseded_at !== null)).toBe(true);
    const empty = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(empty.state).toBe("unchanged");
    expect(empty.changed).toEqual([]);
    expect(empty.had_supports).toBe(true);

    // A fresh confirmation of the same pair un-supersedes its row.
    supportEdge("d", "g");
    confirm("d", ["g"]);
    const revived = db.getSupportBaselines("d").find((r) => r.support_id === "g")!;
    expect(revived.superseded_at).toBeNull();
    expect(
      db.getSupportBaselines("d").find((r) => r.support_id === "f")!.superseded_at
    ).not.toBeNull();
  });

  it("23. a decision that never had supports reports no_support, not changed", () => {
    node("d", "decision"); // no supports ever, never confirmed

    expect(computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))).toBeNull();
    const out = provenanceTrace(db, { node_id: "d" });
    expect(out.support_check).toBeUndefined();
    expect(out.weak_links.some((w) => w.type === "no_support" && w.id === "d")).toBe(true);
    expect(out.weak_links.some((w) => w.type === "support_changed")).toBe(false);
  });

  it("24. force-removing the support node keeps the snapshot alive and the trace honest", () => {
    confirmedDecision("d", ["f"]);
    removeConcept(db, { id: "f", reason: "gone", force: true });

    // Full hygiene removal, no cascade deletion: the snapshot row survives.
    expect(db.getSupportBaselines("d").map((r) => r.support_id)).toEqual(["f"]);
    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    expect(view.changed).toEqual([
      expect.objectContaining({ support: "f", reasons: ["removed"] }),
    ]);

    // The trace completes and reports the divergence — the decision was
    // confirmed, so this is support_check, not a fresh no_support warning.
    const out = provenanceTrace(db, { node_id: "d" });
    expect(out.support_check!.state).toBe("changed");
    expect(out.weak_links.some((w) => w.type === "no_support" && w.id === "d")).toBe(false);
  });
});

// ---- plan-4-fixes-6: дыры подтверждения, бюджет и идентичность рёбер ----

describe("F1: edges from input.edges never confirm", () => {
  it("25. a decision created with an informed_by edge but no evidence has no snapshot", async () => {
    node("f", "fact");
    const res = await createConcept(db, {
      name: "d",
      kind: "decision",
      summary: "decision d",
      edges: [{ to: "f", relation: "informed_by", description: "why f" }],
    });
    // The edge exists — but nothing was confirmed along with it.
    expect(db.getInformedByEdges(res.id, "ancestry", false)).toHaveLength(1);
    expect(db.getNode(res.id)!.claim_digest ?? null).toBeNull();
    expect(db.getSupportBaselines(res.id)).toEqual([]);
    const view = computeSupportCheck(db, res.id, new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("unknown");
  });

  it("26. evidence in the same call still confirms (the §2.1 carve-out holds)", async () => {
    node("f", "fact");
    const res = await createConcept(db, {
      name: "d2",
      kind: "decision",
      summary: "decision d2",
      evidence: [{ node: "f", why: "because f" }],
    });
    const rows = db.getSupportBaselines(res.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed_by).toBe("agent");
    expect(computeSupportCheck(db, res.id, new CheckBudget(10, 1_000_000))!.state).toBe(
      "unchanged"
    );
  });
});

describe("F2: the budget bounds the work, not only the verdict", () => {
  function buildStar(width: number): void {
    // One transaction — the fixture build must not dominate the timing.
    db.runInTransaction(() => {
      node("star", "decision", "decision star");
      for (let i = 1; i <= width; i++) {
        node(`s${i}`, "config", `s-${i}`);
        db.insertEdgeRaw({
          from_id: "star",
          to_id: `s${i}`,
          relation: "informed_by",
          description: "why",
        });
      }
    });
  }

  it(
    "27. a 20k star with max_check_edges = 1 stays incomplete and bounded",
    () => {
      buildStar(20_000);
      const t0 = performance.now();
      const view = computeSupportCheck(db, "star", new CheckBudget(1, 1_000_000_000))!;
      const ms = performance.now() - t0;
      expect(view.state).toBe("incomplete");
      expect(view.incomplete).toBe(true);
      expect(view.unknown_count ?? view.unknown!.length).toBeLessThanOrEqual(1);
      // Bounded work: two page reads, not 20 000 — the same star with a full
      // budget (next test) does the linear pass, so this one must be far
      // cheaper than it. A generous 500 ms guard against linear regressions.
      expect(ms).toBeLessThan(500);
    },
    60_000
  );

  it(
    "28. the same star with a full budget scans everything and stays honest",
    () => {
      buildStar(20_000);
      const view = computeSupportCheck(
        db,
        "star",
        new CheckBudget(20_000, 1_000_000_000)
      )!;
      expect(view.state).toBe("unknown");
      expect(view.incomplete).toBe(false);
      expect(view.unknown_count).toBe(20_000);
    },
    60_000
  );

  it("29. an unchanged confirmed graph gives no false added/removed at any budget", () => {
    confirmedDecision("d", ["f1", "f2", "f3"]);
    for (const [edges, bytes] of [
      [10, 1_000_000],
      [3, 1_000_000],
      [2, 1_000_000],
    ] as const) {
      const view = computeSupportCheck(db, "d", new CheckBudget(edges, bytes))!;
      expect(view.changed ?? []).toEqual([]);
      expect(view.state === "unchanged" || view.state === "incomplete").toBe(true);
      if (view.state === "unchanged") expect(view.incomplete).toBe(false);
    }
  });

  it(
    "39. a 20k star with budget 1 stays under the smoke threshold on the keyset walk (F2, 2.1.1)",
    () => {
      buildStar(20_000);
      const t0 = performance.now();
      const view = computeSupportCheck(db, "star", new CheckBudget(1, 1_000_000_000))!;
      const ms = performance.now() - t0;
      // Same result the offset walk used to produce…
      expect(view.state).toBe("incomplete");
      expect(view.unknown_count ?? view.unknown!.length).toBeLessThanOrEqual(1);
      // …at the plan-4-fixes-7 threshold: per-page work is the page (index
      // prefix read), not a re-sort of the whole star. The full-scan cost of
      // this graph is an order of magnitude higher (test 28 does the linear
      // pass), so 1200 ms leaves linear regressions nowhere to hide.
      expect(ms).toBeLessThan(1200);
    },
    60_000
  );

  it("40. keyset pages return exactly the full ordered support list (F2, 2.1.1)", () => {
    const WIDTH = 1000;
    db.runInTransaction(() => {
      node("kd", "decision", "decision kd");
      for (let i = 1; i <= WIDTH; i++) {
        node(`k${i}`, "config", `s-k${i}`);
        db.insertEdgeRaw({
          from_id: "kd",
          to_id: `k${i}`,
          relation: "informed_by",
          description: "why",
        });
      }
    });

    // Walk the pages the way computeSupportCheck does — cursor = last to_id.
    const walked: string[] = [];
    let cursor = "";
    for (;;) {
      const page = db.getLiveSupportEdgesPage("kd", cursor, 37); // non-divisor on purpose
      if (page.length === 0) break;
      for (const e of page) walked.push(e.to_id);
      cursor = page[page.length - 1].to_id;
    }

    const canonical = (
      db.execSqlAll(
        `SELECT to_id FROM edges
         WHERE from_id = ? AND relation = 'informed_by' AND removed_at IS NULL
         ORDER BY to_id`,
        "kd"
      ) as Array<{ to_id: string }>
    ).map((r) => r.to_id);
    expect(walked).toEqual(canonical);
    expect(walked).toHaveLength(WIDTH);
  });
});

describe("F3: the status axes are confirmed like every other field", () => {
  it("30. a status-only change refuses a stale confirmation", () => {
    confirmedDecision("d", ["f"]);
    const support = db.getNode("f")!;
    const staleStatus = statusDigestOf(support.status, support.epistemic_status);
    const edge = db.getInformedByEdges("d", "ancestry", false)[0];

    db.setEpistemicStatus("f", "validated", "test artifact", { artifact: "run-1" });

    let message = "";
    try {
      confirmSupports(db, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
        items: [
          {
            support_id: "f",
            expected_claim_digest: claimDigestOf(support.summary),
            expected_status_digest: staleStatus,
            expected_edge_digest: edgeDigestOf(edge.description),
          },
        ],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("version_conflict");
    expect(message).toContain("статус");
    // Nothing was written: the old confirmation keeps its timestamp.
    const rows = db.getSupportBaselines("d");
    expect(rows).toHaveLength(1);
    expect(rows[0].status_digest).toBe(staleStatus);
  });

  it("31. a confirmation without expected_status_digest is refused", () => {
    confirmedDecision("d", ["f"]);
    const before = db.getSupportBaselines("d");
    const edge = db.getInformedByEdges("d", "ancestry", false)[0];
    const support = db.getNode("f")!;

    let message = "";
    try {
      confirmSupports(db, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
        items: [
          {
            support_id: "f",
            expected_claim_digest: claimDigestOf(support.summary),
            expected_edge_digest: edgeDigestOf(edge.description),
          },
        ],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("version_conflict");
    expect(message).toContain("expected_status_digest");
    expect(db.getSupportBaselines("d")).toEqual(before);
  });
});

describe("F4: verification and write share one BEGIN IMMEDIATE", () => {
  it("32. a second connection moving a support between read and confirm is caught", () => {
    node("d", "decision");
    node("f", "fact");
    supportEdge("d", "f");

    const staleClaim = claimDigestOf(db.getNode("f")!.summary);
    const staleStatus = statusDigestOf(
      db.getNode("f")!.status,
      db.getNode("f")!.epistemic_status
    );
    const staleEdge = edgeDigestOf(db.getInformedByEdges("d", "ancestry", false)[0].description);

    // The second writer moves f AFTER the agent read its digests and BEFORE
    // the confirm runs. The confirm must re-read inside its write
    // transaction, see v2 and refuse — not write a snapshot of a version
    // that no longer exists.
    const second = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
    try {
      second.updateNode("f", { summary: "f v2 by another writer" });
    } finally {
      second.close();
    }

    let message = "";
    try {
      confirmSupports(db, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
        items: [
          {
            support_id: "f",
            expected_claim_digest: staleClaim,
            expected_status_digest: staleStatus,
            expected_edge_digest: staleEdge,
          },
        ],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("version_conflict");
    // Zero writes: no snapshot, no claim anchor.
    expect(db.getSupportBaselines("d")).toEqual([]);
    expect(db.getNode("d")!.claim_digest ?? null).toBeNull();
  });
});

describe("F5: the confirmation follows the edge's identity, not its ends", () => {
  it("33. after a removed edge is re-created, the snapshot stays with the dead row", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-baselines-f5-"));
    try {
      const aPath = path.join(dir, "a.db");
      const a = new KnowledgeDB(aPath);
      a.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
      a.insertNode({ id: "f", name: "F", kind: "feature", summary: "f" });
      a.insertEdge({ from_id: "d", to_id: "f", relation: "informed_by", description: "why f" });
      const fRow = a.getNode("f")!;
      confirmSupports(a, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf("decision d"),
        items: [
          {
            support_id: "f",
            expected_claim_digest: claimDigestOf("f"),
            expected_status_digest: statusDigestOf(fRow.status, fRow.epistemic_status),
            expected_edge_digest: edgeDigestOf("why f"),
          },
        ],
      });
      const deadKey = a.getSupportBaselines("d")[0].edge_key;

      // The confirmed edge row goes away and a new one takes the same ends —
      // unlink+link would revive the same row, so model the replacement by a
      // hard row delete (the only way two generations of one pair diverge).
      a.execSqlRun("DELETE FROM edges WHERE from_id = 'd' AND to_id = 'f'");
      a.insertEdge({ from_id: "d", to_id: "f", relation: "informed_by", description: "why f" });
      const live = a.getInformedByEdges("d", "ancestry", false)[0];
      expect(String(live.id)).not.toBe(deadKey);

      // In-base honesty: the new pair is not the confirmed one.
      const inBase = computeSupportCheck(a, "d", new CheckBudget(10, 1_000_000))!;
      expect(inBase.state).toBe("unknown");
      expect(a.getSupportBaselines("d")[0].edge_key).toBe(deadKey);
      a.close();

      // Through a merge in both insertion orders: the snapshot keeps pointing
      // at the dead row and the live edge stays unconfirmed.
      const bPath = path.join(dir, "b.db");
      const b = new KnowledgeDB(bPath);
      b.insertNode({ id: "z", name: "Z", kind: "config", summary: "z" });
      b.close();

      for (const [left, right] of [
        [aPath, bPath],
        [bPath, aPath],
      ]) {
        const outPath = path.join(dir, `out-${path.basename(left)}.db`);
        new MergeEngine().merge(left, right, outPath);
        const out = new KnowledgeDB(outPath);
        const rows = out.getSupportBaselines("d");
        expect(rows).toHaveLength(1);
        // The dead anchor is carried with a non-collidable key: it must never
        // re-anchor a live edge, however the output numbers its rows.
        expect(rows[0].edge_key).toBe(`dead:${deadKey}`);
        const outLive = out.getInformedByEdges("d", "ancestry", false)[0];
        expect(computeSupportCheck(out, "d", new CheckBudget(10, 1_000_000))!.state).toBe(
          "unknown"
        );
        expect(outLive).toBeDefined();
        out.close();
      }
    } finally {
      rmTemp(dir);
    }
  });
});

describe("F6: the last unlinked support still speaks in weak_links", () => {
  it("34. confirm, unlink — the trace reports support_changed/removed, not no_support", () => {
    confirmedDecision("d", ["f"]);
    db.deleteEdge("d", "f", "informed_by");

    const out = provenanceTrace(db, { node_id: "d" });
    const changed = out.weak_links.find(
      (w) => w.type === "support_changed" && w.id === "d"
    );
    expect(changed).toBeDefined();
    expect(out.weak_links.some((w) => w.type === "no_support" && w.id === "d")).toBe(false);
    // The root's own block agrees with the weak link.
    expect(out.support_check!.state).toBe("changed");
    expect(out.support_check!.changed![0].reasons).toEqual(["removed"]);
  });
});

describe("F7: 'confirmed and removed' stays distinguishable from 'never had'", () => {
  it("35. the two histories differ in support_check and in the metrics", () => {
    // (a) had a confirmed support, unlinked, acknowledged gone.
    confirmedDecision("d1", ["f1"]);
    db.deleteEdge("d1", "f1", "informed_by");
    confirmSupports(db, {
      decision_id: "d1",
      expected_claim_digest: claimDigestOf(db.getNode("d1")!.summary),
      items: [],
    });

    // (b) never had any supports, confirmed the emptiness.
    node("d2", "decision");
    confirmSupports(db, {
      decision_id: "d2",
      expected_claim_digest: claimDigestOf(db.getNode("d2")!.summary),
      items: [],
    });

    const a = computeSupportCheck(db, "d1", new CheckBudget(10, 1_000_000))!;
    const b = computeSupportCheck(db, "d2", new CheckBudget(10, 1_000_000))!;
    expect(a.state).toBe("unchanged");
    expect(b.state).toBe("unchanged");
    expect(a.had_supports).toBe(true);
    expect(b.had_supports).toBeUndefined();

    const m = provenanceMetrics(db, new CheckBudget(100, 1_000_000));
    expect(m.decisions_with_superseded_supports).toBe(1);
    expect(m.no_live_supports).toBe(2);
  });
});

describe("F8: metrics cover decisions without live edges", () => {
  it("36. a decision whose last support was unlinked counts in changed + no_live_supports", () => {
    confirmedDecision("d", ["f"]);
    db.deleteEdge("d", "f", "informed_by");
    // A second decision with live supports keeps the old counters honest.
    confirmedDecision("d2", ["f2"]);

    const m = provenanceMetrics(db, new CheckBudget(100, 1_000_000));
    expect(m.decisions_by_check_state.changed).toBe(1);
    expect(m.no_live_supports).toBe(1);
    expect(m.decisions_with_live_support).toBe(1);
    expect(m.metrics_truncated).toBe(false);
  });
});

describe("F4 (2.1.1): metrics_truncated means decisions left unchecked", () => {
  it(
    "42. a budget exhausted exactly on the last decision is not truncation",
    () => {
      // Two decisions, one confirmed support each — since 2.1.2 F7 a check
      // of a confirmed decision consumes TWO edges (the claim digest + the
      // support), so a budget of 4 runs out exactly on the second, last one.
      // (Budget bumped from 2 for the new accounting; the property under
      // test — exact exhaustion is not truncation — is unchanged.)
      confirmedDecision("d1", ["f1"]);
      confirmedDecision("d2", ["f2"]);

      const m = provenanceMetrics(db, new CheckBudget(4, 1_000_000));
      expect(m.decisions_by_check_state.unchanged).toBe(2);
      expect(m.metrics_truncated).toBe(false);
    }
  );

  it("43. decisions past the exhausted budget leave metrics_truncated true", () => {
    confirmedDecision("d1", ["f1"]);
    confirmedDecision("d2", ["f2"]);
    confirmedDecision("d3", ["f3"]);

    // Budget 4 (= 2 checks under the 2.1.2 F7 accounting): d3 never gets a
    // verdict — the flag must say so.
    const m = provenanceMetrics(db, new CheckBudget(4, 1_000_000));
    expect(m.metrics_truncated).toBe(true);
    const counted =
      m.decisions_by_check_state.unchanged +
      m.decisions_by_check_state.changed +
      m.decisions_by_check_state.unknown +
      m.decisions_by_check_state.incomplete;
    expect(counted).toBe(2);
  });

  it("44. a decision with only a claim anchor is counted, not dropped", () => {
    // Confirmed "no supports": a claim anchor exists, no live edges, no
    // snapshot rows — the case the deleted dead branch pretended to cover.
    // The WHERE keeps such decisions in the metric, and computeSupportCheck
    // gives them an honest verdict (unchanged: confirmed-empty, nothing
    // moved); the bucket total proves the decision is not lost.
    node("solo", "decision", "decision solo");
    confirmSupports(db, {
      decision_id: "solo",
      expected_claim_digest: claimDigestOf("decision solo"),
      items: [],
    });

    const m = provenanceMetrics(db, new CheckBudget(10, 1_000_000));
    expect(m.no_live_supports).toBe(1);
    const counted =
      m.decisions_by_check_state.unchanged +
      m.decisions_by_check_state.changed +
      m.decisions_by_check_state.unknown +
      m.decisions_by_check_state.incomplete;
    expect(counted).toBe(1);
    expect(m.decisions_by_check_state.unchanged).toBe(1);
    expect(m.metrics_truncated).toBe(false);
  });
});

describe("F9: edge provenance survives a merge", () => {
  it("37. created_via and accepted_at travel with the row", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-baselines-f9-"));
    try {
      const build = (p: string, withExtra: boolean): void => {
        const d = new KnowledgeDB(p);
        d.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
        d.insertNode({ id: "f", name: "F", kind: "feature", summary: "f" });
        if (withExtra) d.insertNode({ id: "z", name: "Z", kind: "config", summary: "z" });
        // The agent path: link writes created_via = 'agent'.
        link(d, { from: "d", to: "f", relation: "informed_by", description: "why f" });
        const e = d.getInformedByEdges("d", "ancestry", false)[0];
        d.acceptEdges([e.id], "2026-01-01T00:00:00.000Z");
        d.close();
      };
      const aPath = path.join(dir, "a.db");
      const bPath = path.join(dir, "b.db");
      build(aPath, false);
      build(bPath, true);

      const outPath = path.join(dir, "out.db");
      new MergeEngine().merge(aPath, bPath, outPath);
      const out = new KnowledgeDB(outPath);
      const edge = out.getInformedByEdges("d", "ancestry", false)[0];
      expect(edge.created_via).toBe("agent");
      expect(edge.accepted_at).not.toBeNull();

      // A raw row without provenance stays honestly unknown.
      const raw = out.execSqlFirst(
        `SELECT created_via FROM edges WHERE created_via = 'unknown'`
      ) as { created_via: string } | undefined;
      expect(raw).toBeUndefined();
      out.close();
    } finally {
      rmTemp(dir);
    }
  });

  it(
    "41. every created_via value survives the merge as itself (F3, 2.1.1)",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-baselines-f3-"));
      try {
        // Left source: the agent edge (link) and the auto edge (raw row).
        const aPath = path.join(dir, "a.db");
        const a = new KnowledgeDB(aPath);
        a.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
        a.insertNode({ id: "f1", name: "F1", kind: "config", summary: "f1" });
        a.insertNode({ id: "f2", name: "F2", kind: "config", summary: "f2" });
        link(a, { from: "d", to: "f1", relation: "informed_by", description: "why f1" });
        a.insertEdgeRaw({
          from_id: "d",
          to_id: "f2",
          relation: "informed_by",
          description: "why f2",
          created_via: "auto",
        });
        a.close();

        // Right source: a pre-v8 database — the edges table has no
        // created_via/accepted_at columns at all. Reopening re-adds them with
        // the 'unknown' default, which is exactly the production path for old
        // files: the origin was never recorded, so 'unknown' is honest.
        const bPath = path.join(dir, "b.db");
        const b = new KnowledgeDB(bPath);
        b.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
        b.insertNode({ id: "f3", name: "F3", kind: "config", summary: "f3" });
        b.insertEdgeRaw({ from_id: "d", to_id: "f3", relation: "informed_by", description: "why f3" });
        b.close();
        const strip = new Database(bPath);
        strip.exec(`
          DROP INDEX IF EXISTS idx_edges_created_via;
          DROP INDEX IF EXISTS idx_edges_live_from_to;
          ALTER TABLE edges DROP COLUMN created_via;
          ALTER TABLE edges DROP COLUMN accepted_at;
        `);
        strip.pragma("user_version = 7");
        strip.close();
        // Sanity: after the strip+reopen the old row is honestly unknown.
        const bReopened = new KnowledgeDB(bPath);
        const bEdge = bReopened.getInformedByEdges("d", "ancestry", false)[0];
        expect(bEdge.created_via).toBe("unknown");
        bReopened.close();

        const expectOrigins = (outPath: string): void => {
          const out = new KnowledgeDB(outPath);
          try {
            const byTarget = new Map(
              out
                .getInformedByEdges("d", "ancestry", false)
                .map((e) => [e.to_id, e.created_via])
            );
            expect(byTarget.get("f1")).toBe("agent");
            expect(byTarget.get("f2")).toBe("auto");
            expect(byTarget.get("f3")).toBe("unknown");
            expect(byTarget.size).toBe(3);
          } finally {
            out.close();
          }
        };

        const outAB = path.join(dir, "ab.db");
        new MergeEngine().merge(aPath, bPath, outAB);
        expectOrigins(outAB);

        // Both orders: the right-hand copy must travel as faithfully as the
        // left-hand one — the union path treats the sides symmetrically, this
        // pins it.
        const outBA = path.join(dir, "ba.db");
        new MergeEngine().merge(bPath, aPath, outBA);
        expectOrigins(outBA);
      } finally {
        rmTemp(dir);
      }
    },
    60_000
  );
});

describe("F10: the merge carries the OLD claim digest, not the current wording", () => {
  it("38. a rewritten decision keeps its stale anchor through the merge", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-baselines-f10-"));
    try {
      const aPath = path.join(dir, "a.db");
      const a = new KnowledgeDB(aPath);
      a.insertNode({ id: "d", name: "D", kind: "decision", summary: "decision d" });
      a.insertNode({ id: "f", name: "F", kind: "feature", summary: "f" });
      a.insertEdge({ from_id: "d", to_id: "f", relation: "informed_by", description: "why f" });
      const fRow = a.getNode("f")!;
      confirmSupports(a, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf("decision d"),
        items: [
          {
            support_id: "f",
            expected_claim_digest: claimDigestOf("f"),
            expected_status_digest: statusDigestOf(fRow.status, fRow.epistemic_status),
            expected_edge_digest: edgeDigestOf("why f"),
          },
        ],
      });
      const oldDigest = a.getNode("d")!.claim_digest!;
      // The wording moves on AFTER the confirmation — the anchor goes stale.
      a.updateNode("d", { summary: "decision d, rewritten" });
      a.close();

      const bPath = path.join(dir, "b.db");
      const b = new KnowledgeDB(bPath);
      b.insertNode({ id: "q", name: "Q", kind: "config", summary: "q" });
      b.close();

      const outPath = path.join(dir, "out.db");
      new MergeEngine().merge(aPath, bPath, outPath);
      const out = new KnowledgeDB(outPath);
      const carried = out.getNodeIncludingRemoved("d")!;
      // The OLD digest travels verbatim — the snapshot keeps pointing at the
      // wording it confirmed, and the check reports claim_changed.
      expect(carried.claim_digest).toBe(oldDigest);
      expect(carried.claim_digest).not.toBe(claimDigestOf(carried.summary!));
      const view = computeSupportCheck(out, "d", new CheckBudget(10, 1_000_000))!;
      expect(view.claim_changed).toBe(true);
      out.close();
    } finally {
      rmTemp(dir);
    }
  });
});

describe("F11: an incomplete inner check is visible", () => {
  it("39. a budget cut on an inner node sets the counter and degrades completeness", () => {
    node("d", "decision");
    node("f1", "fact");
    node("f2", "fact");
    supportEdge("d", "f1");
    supportEdge("f1", "f2");
    confirm("d", ["f1"]);
    confirm("f1", ["f2"]);

    const out = provenanceTrace(db, { node_id: "d", max_check_edges: 1 });
    // d's own pair consumed the single edge; f1's check ran out.
    expect(out.inner_nodes_incomplete).toBe(1);
    expect(out.completeness).toBe("truncated");
    // The unreviewed inner fact keeps its own block off the answer (§5).
    const f1 = out.nodes.find((n) => n.id === "f1")!;
    expect(f1.support_check).toBeUndefined();

    // A full budget: no counter, verdict complete.
    const full = provenanceTrace(db, { node_id: "d", max_check_edges: 10 });
    expect(full.inner_nodes_incomplete).toBeUndefined();
    expect(full.completeness).toBe("complete");
  });
});

describe("F12: reads never write; the audit writes only its journal", () => {
  it("40. provenance_trace/get_concept leave nothing behind; audit touches only the journal", async () => {
    const { getConcept } = await import("../tools.js");
    const { provenanceAudit } = await import("../provenance.js");
    confirmedDecision("d", ["f"]);

    const snapshotOf = () => ({
      baselines: db.getSupportBaselines("d").length,
      nodes: db.getNodeIncludingRemoved("d")?.updated_at ?? null,
      edges: db.getInformedByEdges("d", "ancestry", false).length,
      auditRuns: db.getProvenanceAuditRuns("d").length,
    });

    const before = snapshotOf();
    provenanceTrace(db, { node_id: "d" });
    getConcept(db, { id: "d" });
    expect(snapshotOf()).toEqual(before);

    provenanceAudit(db, { node_id: "d" });
    const after = snapshotOf();
    expect(after.auditRuns).toBe(before.auditRuns + 1); // the journal, and only it
    expect(after.baselines).toBe(before.baselines);
    expect(after.edges).toBe(before.edges);
  });
});

// ---- 2.1.2 F6: нестроковые ожидания — version_conflict, а не TypeError ----

describe("2.1.2 F6: non-string expectations refuse via version_conflict", () => {
  type Bad = "absent" | "null" | "number";
  const badValues: Array<[Bad, unknown]> = [
    ["absent", undefined],
    ["null", null],
    ["number", 12345],
  ];

  it("each of the three expectations refuses on absent/null/number, writing nothing", () => {
    const cases: Array<{
      label: string;
      patch: (item: Record<string, unknown>, decision: Record<string, unknown>, v: unknown) => void;
    }> = [
      {
        label: "decision expected_claim_digest",
        patch: (_item, decision, v) => {
          decision.expected_claim_digest = v;
        },
      },
      {
        label: "item expected_claim_digest",
        patch: (item, _decision, v) => {
          item.expected_claim_digest = v;
        },
      },
      {
        label: "item expected_status_digest",
        patch: (item, _decision, v) => {
          item.expected_status_digest = v;
        },
      },
      {
        label: "item expected_edge_digest",
        patch: (item, _decision, v) => {
          item.expected_edge_digest = v;
        },
      },
    ];

    let run = 0;
    for (const c of cases) {
      for (const [kind, value] of badValues) {
        run += 1;
        const did = `d${run}`;
        const sid = `f${run}`;
        confirmedDecision(did, [sid]);
        const before = db.getSupportBaselines(did).length;
        const decision = db.getNode(did)!;
        const support = db.getNode(sid)!;
        const edge = db.getInformedByEdges(did, "ancestry", false)[0];
        const decisionInput: Record<string, unknown> = {
          decision_id: did,
          expected_claim_digest: claimDigestOf(decision.summary),
        };
        const item: Record<string, unknown> = {
          support_id: sid,
          expected_claim_digest: claimDigestOf(support.summary),
          expected_status_digest: statusDigestOf(support.status, support.epistemic_status),
          expected_edge_digest: edgeDigestOf(edge.description),
        };
        c.patch(item, decisionInput, value);
        if (kind === "absent" && c.label.startsWith("decision")) {
          // "absent" for the decision-level digest: delete the key outright
          delete decisionInput.expected_claim_digest;
        }

        let message = "";
        try {
          confirmSupports(db, {
            ...(decisionInput as unknown as Parameters<typeof confirmSupports>[1]),
            items: [item as unknown as Parameters<typeof confirmSupports>[1]["items"][0]],
          });
          throw new Error(`expected a refusal for ${c.label} / ${kind}`);
        } catch (err) {
          message = String(err);
        }
        expect(message).toContain("version_conflict");
        // Nothing written, no crash: the row count is untouched.
        expect(db.getSupportBaselines(did).length).toBe(before);
      }
    }
  });
});
