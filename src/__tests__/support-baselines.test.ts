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
      return {
        support_id: sid,
        expected_claim_digest: claimDigestOf(db.getNode(sid)!.summary),
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
      confirmSupports(left, {
        decision_id: "d",
        expected_claim_digest: claimDigestOf("decision d"),
        items: [
          {
            support_id: "f",
            expected_claim_digest: claimDigestOf("f v1"),
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
        confirmSupports(d, {
          decision_id: "d",
          expected_claim_digest: claimDigestOf("decision d"),
          items: [
            {
              support_id: "f",
              expected_claim_digest: claimDigestOf("f v1"),
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
    confirmSupports(db, {
      decision_id: res.id,
      expected_claim_digest: claimDigestOf("auto d"),
      items: [
        {
          support_id: supportId,
          expected_claim_digest: claimDigestOf(db.getNode(supportId)!.summary),
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

  it("22. only the explicit 'no supports' confirmation clears the dead row", () => {
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
    // "no supports" statement — the rows go with it, and only with it.
    db.deleteEdge("d", "g", "informed_by");
    confirmSupports(db, {
      decision_id: "d",
      expected_claim_digest: claimDigestOf(db.getNode("d")!.summary),
      items: [],
    });
    expect(db.getSupportBaselines("d")).toEqual([]);
    const empty = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(empty.state).toBe("unchanged");
    expect(empty.changed).toEqual([]);
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
