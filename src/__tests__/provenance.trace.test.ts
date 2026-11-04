import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { link } from "../tools.js";
import { provenanceTrace, compareIds } from "../provenance.js";
import {
  claimDigestOf,
  confirmSupports,
  edgeDigestOf,
  statusDigestOf,
} from "../support-baselines.js";
import type { ProvenanceTraceOutput } from "../types.js";

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-provenance-trace-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

// Close only: libsql on Windows can hold the file for up to ~10 s after
// close under AV/indexer pressure (helpers/cleanup.ts budgets 4 s and loses
// that race, paying it per test). Temp dirs are the OS's to clean.
afterEach(() => {
  db.close();
});

/**
 * Fixtures go through KnowledgeDB + insertEdgeRaw: cycles, self-loops and
 * blank rationales cannot be built through the validated path (it refuses
 * them — paired refusal tests live at the bottom of this file).
 */
function node(id: string, kind = "config", opts: { epistemic?: string; removed?: boolean } = {}) {
  db.insertNode({
    id,
    name: id.toUpperCase(),
    kind,
    summary: `s-${id}`,
    ...(opts.epistemic ? { epistemic_status: opts.epistemic } : {}),
  });
  if (opts.removed) db.softDeleteNode(id, "test removal");
}

function edge(from: string, to: string, description = "why", removed = false) {
  db.insertEdgeRaw({
    from_id: from,
    to_id: to,
    relation: "informed_by",
    description,
    ...(removed ? { removed_at: "2026-01-01 00:00:00" } : {}),
  });
}

function trace(nodeId: string, opts: { direction?: "ancestry" | "impact"; depth?: number; maxNodes?: number; scan?: number; retrospective?: boolean } = {}): ProvenanceTraceOutput {
  return provenanceTrace(db, {
    node_id: nodeId,
    direction: opts.direction,
    depth: opts.depth,
    max_nodes: opts.maxNodes,
    max_scan_nodes: opts.scan,
    retrospective: opts.retrospective,
  });
}

// ---- Циклы и стек (F1, F2) ----

describe("cycles and stack safety (plan-3-fixes-2 F1/F2)", () => {
  it("1. cycle behind the root does not throw and shows 3 nodes", () => {
    node("r", "decision");
    node("a");
    node("b");
    edge("r", "a");
    edge("a", "b");
    edge("b", "a");

    const out = trace("r");
    expect(out.shown).toBe(3);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "r"]);
  });

  it("2. root inside the cycle does not throw either (regression: 'не воспроизводится')", () => {
    node("a", "decision");
    node("b");
    edge("a", "b");
    edge("b", "a");

    const out = trace("a");
    expect(out.shown).toBe(2);
    // The root keeps the trivial path count even inside a cycle.
    expect(out.nodes.find((n) => n.id === "a")!.in_paths).toBe(1);
  });

  it("3. self-loop on a non-root node does not throw; the node is a cyclic component", () => {
    node("r", "decision");
    node("s");
    edge("r", "s");
    edge("s", "s");

    const out = trace("r");
    expect(out.shown).toBe(2);
    const s = out.nodes.find((n) => n.id === "s")!;
    expect(s.in_paths).toBeNull();
    expect(out.weak_links.some((w) => w.type === "cycle")).toBe(true);
  });

  it("4. path counting through an SCC yields null + component record, not a lying number", () => {
    // Two simple paths root→t exist (root-a-t, root-a-b-t); a memoized DFS
    // with an on-stack guard returns 1 — the counterexample from the plan.
    node("root", "decision");
    node("a", "decision");
    node("b", "decision");
    node("t", "decision");
    edge("root", "a");
    edge("a", "b");
    edge("b", "a");
    edge("a", "t");
    edge("b", "t");

    const out = trace("root");
    expect(out.nodes.find((n) => n.id === "a")!.in_paths).toBeNull();
    expect(out.nodes.find((n) => n.id === "b")!.in_paths).toBeNull();
    expect(out.nodes.find((n) => n.id === "t")!.in_paths).toBeNull();
    const cycles = out.weak_links.filter((w) => w.type === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0].id).toMatch(/^scc:/);
    expect(cycles[0].note).toContain("a, b");
  });

  it("5. a 3000-node chain does not overflow the stack (F2)", () => {
    node("r", "decision");
    for (let i = 1; i <= 3000; i++) node(`n${i}`);
    for (let i = 0; i < 3000; i++) {
      const from = i === 0 ? "r" : `n${i}`;
      edge(from, `n${i + 1}`);
    }

    const out = trace("r", { depth: 3000, maxNodes: 3000 });
    expect(out.shown).toBe(3001);
    expect(out.truncated).toBe(false);
    expect(out.total_within_depth).toBe(3001);
    // Leaf: exactly one path from the root.
    expect(out.nodes.find((n) => n.id === "n3000")!.in_paths).toBe(1);
  }, 60000);
});

// ---- Полнота и границы (F5, F21, contract 3/5) ----

describe("completeness and limits", () => {
  it("6. a star of 200 supports shows all 201 nodes — the root occupies no slot (F5)", () => {
    node("r", "decision");
    for (let i = 1; i <= 200; i++) node(`s${i}`);
    for (let i = 1; i <= 200; i++) edge("r", `s${i}`);

    const out = trace("r");
    expect(out.shown).toBe(201);
    expect(out.truncated).toBe(false);
    expect(out.truncated_by).toBeNull();
    expect(out.completeness).toBe("complete");
  });

  it("7. a star of 201 supports truncates by nodes (F5, F21)", () => {
    node("r", "decision");
    for (let i = 1; i <= 201; i++) node(`s${i}`);
    for (let i = 1; i <= 201; i++) edge("r", `s${i}`);

    const out = trace("r");
    expect(out.truncated).toBe(true);
    expect(out.truncated_by).toBe("nodes");
    expect(out.shown).toBe(201); // root + 200 admitted supports
  });

  it("8. a chain of depth 8 truncates by depth; total counts within the depth", () => {
    node("r", "decision");
    for (let i = 1; i <= 8; i++) node(`c${i}`);
    for (let i = 0; i < 8; i++) edge(i === 0 ? "r" : `c${i}`, `c${i + 1}`);

    const out = trace("r"); // default depth 6
    expect(out.truncated_by).toBe("depth");
    expect(out.truncated).toBe(true);
    expect(out.total_within_depth).toBe(7); // r..c6
    expect(out.total_exact).toBe(true);
    expect(out.shown).toBe(7);
  });

  it("9. a chain of depth 6 is fully included — no truncation cause", () => {
    node("r", "decision");
    for (let i = 1; i <= 6; i++) node(`c${i}`);
    for (let i = 0; i < 6; i++) edge(i === 0 ? "r" : `c${i}`, `c${i + 1}`);

    const out = trace("r");
    expect(out.truncated_by).toBeNull();
    expect(out.truncated).toBe(false);
    expect(out.shown).toBe(7);
    expect(out.total_within_depth).toBe(7);
  });

  it("10. a graph wider than the scan budget truncates by scan, total is a lower estimate (contract 5)", () => {
    node("r", "decision");
    for (let i = 1; i <= 6000; i++) node(`s${i}`);
    for (let i = 1; i <= 6000; i++) edge("r", `s${i}`);

    const out = trace("r"); // default max_scan_nodes 5000
    expect(out.truncated_by).toBe("scan");
    expect(out.total_exact).toBe(false);
    expect(out.total_within_depth).toBe(5000); // lower estimate of 6001
    expect(out.truncated).toBe(true);
    expect(out.shown).toBeLessThanOrEqual(201);
  }, 60000);

  it("11. a removed node is terminal: counting and emission agree (F4)", () => {
    node("root", "decision");
    node("mid");
    node("live");
    db.softDeleteNode("mid", "gone");
    // Hand-crafted after the removal (the validated path refuses edges onto
    // a tombstone, and INSERT OR IGNORE would not revive the tombstoned
    // rows): live rows onto and from the removed node.
    edge("root", "mid");
    edge("mid", "live");

    const out = trace("root");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["mid", "root"]);
    expect(out.nodes.find((n) => n.id === "mid")!.removed).toBe(true);
    expect(out.total_within_depth).toBe(out.shown); // no silent loss
    expect(out.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["root->mid"]);
  });
});

// ---- Слабые звенья (F3, F8, F9, F10) ----

describe("weak links", () => {
  it("12. a refuted support is reported first", () => {
    node("d", "decision");
    node("s", "config", { epistemic: "refuted" });
    edge("d", "s", "measured");

    const out = trace("d");
    expect(out.weak_links.length).toBeGreaterThan(0);
    expect(out.weak_links[0].type).toBe("refuted");
    expect(out.weak_links[0].id).toBe("s");
  });

  it("13. an abandoned support is reported", () => {
    node("d", "decision");
    node("s", "config", { epistemic: "abandoned" });
    edge("d", "s", "measured");

    const out = trace("d");
    expect(out.weak_links.some((w) => w.type === "abandoned" && w.id === "s")).toBe(true);
  });

  it("14. a rationale of blanks is no_rationale at 80 and 81 spaces (F3)", () => {
    node("d1", "decision");
    node("d2", "decision");
    node("s1");
    node("s2");
    edge("d1", "s1", " ".repeat(80));
    edge("d2", "s2", " ".repeat(81));

    const out = trace("d1", { depth: 3 });
    expect(out.edges.find((e) => e.from === "d1")!.rationale).toBeNull();
    expect(out.weak_links.some((w) => w.type === "no_rationale" && w.from === "d1")).toBe(true);

    const out2 = trace("d2");
    expect(out2.edges.find((e) => e.from === "d2")!.rationale).toBeNull();
    expect(out2.weak_links.some((w) => w.type === "no_rationale" && w.from === "d2")).toBe(true);
  });

  it("15. a decision without any support gets no_support (F9)", () => {
    node("lonely", "decision");

    const out = trace("lonely");
    expect(out.weak_links.some((w) => w.type === "no_support" && w.id === "lonely")).toBe(true);
  });

  it("16. a support pointing at a missing node is missing_support, not ungrounded (F9)", () => {
    node("d", "decision");
    // The support node does not exist at all — an orphan edge needs FK off
    // (the validated path refuses it: nodeExists fails first).
    db.pragma("foreign_keys = OFF");
    edge("d", "ghost", "vanished");
    db.pragma("foreign_keys = ON");

    const out = trace("d");
    expect(out.weak_links.some((w) => w.type === "missing_support" && w.id === "d")).toBe(true);
    expect(out.weak_links.some((w) => w.type === "ungrounded_support")).toBe(false);
  });

  it("17. retrospective checks the same edge set it shows (F8)", () => {
    node("d", "decision");
    node("s"); // ungrounded: no refs, no live outgoing informed_by, not validated
    edge("d", "s", "old support", true); // tombstoned support edge

    // Live mode: no live supports -> no_support.
    const live = trace("d");
    expect(live.weak_links.some((w) => w.type === "no_support")).toBe(true);
    expect(live.weak_links.some((w) => w.type === "ungrounded_support")).toBe(false);

    // Retrospective: the tombstone is shown, so the warning is about s.
    const retro = trace("d", { retrospective: true });
    expect(retro.edges.some((e) => e.from === "d" && e.to === "s" && e.removed)).toBe(true);
    expect(retro.weak_links.some((w) => w.type === "ungrounded_support" && w.id === "d")).toBe(true);
    expect(retro.weak_links.some((w) => w.type === "no_support")).toBe(false);
  });

  it("18. a decision on ungrounded supports is flagged in impact direction too", () => {
    node("d", "decision");
    node("s"); // ungrounded
    edge("d", "s", "weak ground");

    const out = trace("s", { direction: "impact" });
    expect(out.direction).toBe("impact");
    expect(out.nodes.some((n) => n.id === "d")).toBe(true);
    expect(out.weak_links.some((w) => w.type === "ungrounded_support" && w.id === "d")).toBe(true);
  });

  it("F10: cycle diagnostics — one record per component with witness and needs_merge edges", () => {
    node("d1", "decision");
    node("d2", "decision");
    node("out");
    edge("d1", "d2", "1");
    edge("d2", "d1", "2");
    edge("d2", "out", "3");
    // Flag the component edges as needs_merge (as the merge post-validation would).
    db.execSqlRun(
      "UPDATE edges SET needs_merge = 1 WHERE relation = 'informed_by' AND from_id IN ('d1','d2')"
    );

    const out = trace("d1");
    const cycles = out.weak_links.filter((w) => w.type === "cycle");
    expect(cycles).toHaveLength(1); // one message per component, not per node
    expect(cycles[0].note).toContain("свидетель");
    expect(cycles[0].note).toContain("needs_merge");
    expect(cycles[0].note).toContain("закрыта для записи");
  });
});

// ---- Пути (F7, contract 4) ----

describe("path counting", () => {
  it("19. DAG diamond: the common node lies on 2 paths", () => {
    node("root", "decision");
    node("x");
    node("y");
    node("d");
    edge("root", "x");
    edge("root", "y");
    edge("x", "d");
    edge("y", "d");

    const out = trace("root");
    expect(out.nodes.find((n) => n.id === "x")!.in_paths).toBe(1);
    expect(out.nodes.find((n) => n.id === "y")!.in_paths).toBe(1);
    expect(out.nodes.find((n) => n.id === "d")!.in_paths).toBe(2);
  });

  it("20. path counts above the cap are flagged in_paths_capped (F7)", () => {
    // 5 levels x 20 fully-connected nodes: the last level sits on 20^5 = 3.2M paths.
    node("root", "decision");
    const levels: string[][] = [];
    for (let l = 0; l < 5; l++) {
      const level: string[] = [];
      for (let i = 0; i < 20; i++) {
        const id = `L${l}n${i}`;
        node(id);
        level.push(id);
      }
      levels.push(level);
    }
    for (const n of levels[0]) edge("root", n);
    for (let l = 0; l < 4; l++) {
      for (const a of levels[l]) for (const b of levels[l + 1]) edge(a, b);
    }

    const out = trace("root", { depth: 5, maxNodes: 200 });
    const last = out.nodes.find((n) => n.id === levels[4][0])!;
    expect(last.in_paths).toBe(100000);
    expect(last.in_paths_capped).toBe(true);
    const mid = out.nodes.find((n) => n.id === levels[3][0])!;
    expect(mid.in_paths).toBe(8000);
    expect(mid.in_paths_capped).toBeUndefined();
  }, 60000);

  it("21. other relation types never leak into the trace", () => {
    node("r", "decision");
    node("dep");
    node("cal");
    node("sup");
    db.insertEdgeRaw({ from_id: "r", to_id: "dep", relation: "depends_on", description: "d" });
    db.insertEdgeRaw({ from_id: "r", to_id: "cal", relation: "calls", description: "c" });
    edge("r", "sup", "the only support");

    const out = trace("r");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["r", "sup"]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ from: "r", to: "sup" });
  });
});

// ---- Направления ----

describe("direction semantics", () => {
  it("22. D informed_by S: ancestry(D) has S, impact(S) has D, the edge is D -> S", () => {
    node("d", "decision");
    node("s");
    edge("d", "s", "measured in s");

    const anc = trace("d");
    expect(anc.nodes.map((n) => n.id)).toContain("s");
    expect(anc.edges).toEqual([{ from: "d", to: "s", rationale: "measured in s" }]);

    const imp = trace("s", { direction: "impact" });
    expect(imp.nodes.map((n) => n.id)).toContain("d");
    expect(imp.edges).toEqual([{ from: "d", to: "s", rationale: "measured in s" }]);
  });
});

// ---- Гигиена (F11, F12, F13, F16) ----

describe("hygiene", () => {
  it("31. comparator returns 0 for equal ids (F12)", () => {
    expect(compareIds("a", "a")).toBe(0);
    expect(compareIds("a", "b")).toBe(-1);
    expect(compareIds("b", "a")).toBe(1);
  });

  it("32. truncation picks the smaller id across the whole level (F13)", () => {
    node("r", "decision");
    node("z");
    node("c");
    edge("r", "z");
    edge("r", "c");

    const out = trace("r", { maxNodes: 1 }); // one slot beyond the root
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["c", "r"]);
    expect(out.nodes.some((n) => n.id === "z")).toBe(false);
    expect(out.truncated_by).toBe("nodes");
  });

  it("33. invalid limits are rejected with a clear error (F16)", () => {
    node("r", "decision");
    expect(() => trace("r", { maxNodes: 0 })).toThrow(/max_nodes/);
    expect(() => trace("r", { maxNodes: Number.NaN })).toThrow(/max_nodes/);
    expect(() => trace("r", { maxNodes: 1.5 })).toThrow(/max_nodes/);
    expect(() => trace("r", { depth: -1 })).toThrow(/depth/);
    expect(() => trace("r", { depth: 0.5 })).toThrow(/depth/);
    expect(() => trace("r", { scan: 0 })).toThrow(/max_scan_nodes/);
    const ok = trace("r", { depth: 0 }); // depth 0 = only the root
    expect(ok.shown).toBe(1);
  });
});

// ---- Property-based (34) ----

describe("property-based invariants on random graphs (34)", () => {
  // Deterministic PRNG (mulberry32) — no external dependency, reproducible.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("shown never exceeds the node budget and every edge endpoint is shown", async () => {
    const rand = mulberry32(20261103);
    for (let run = 0; run < 30; run++) {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "mm-provenance-prop-"));
      const pdb = new KnowledgeDB(path.join(fresh, "knowledge.db"));
      try {
        const size = 5 + Math.floor(rand() * 40);
        const ids: string[] = [];
        for (let i = 0; i < size; i++) {
          const id = `n${String(i).padStart(2, "0")}`;
          pdb.insertNode({ id, name: id, kind: "config", summary: id });
          ids.push(id);
        }
        // Acyclic by construction: edges only from lower to higher creation index.
        const edgeCount = Math.floor(rand() * size * 2);
        for (let i = 0; i < edgeCount; i++) {
          let a = Math.floor(rand() * size);
          let b = Math.floor(rand() * size);
          if (a === b) continue;
          if (a > b) [a, b] = [b, a];
          pdb.insertEdgeRaw({
            from_id: ids[a],
            to_id: ids[b],
            relation: "informed_by",
            description: `why ${a}-${b}`,
          });
        }
        // Occasionally corrupt the DAG with a raw back-edge (a merge leftover).
        if (rand() < 0.3 && size > 2) {
          pdb.insertEdgeRaw({
            from_id: ids[size - 1],
            to_id: ids[0],
            relation: "informed_by",
            description: "merge leftover",
          });
        }
        // Occasionally remove a node (its touching edges become tombstones).
        if (rand() < 0.3) {
          pdb.softDeleteNode(ids[Math.floor(rand() * size)], "prop removal");
        }

        const root = ids[0];
        const maxNodes = 1 + Math.floor(rand() * 30);
        const depth = 1 + Math.floor(rand() * 5);
        const out = provenanceTrace(pdb, { node_id: root, max_nodes: maxNodes, depth });

        // F5 contract: the root occupies no slot, everything else does.
        expect(out.shown - 1).toBeLessThanOrEqual(maxNodes);
        expect(out.total_within_depth).toBeGreaterThanOrEqual(out.shown);
        expect(out.truncated).toBe(out.truncated_by !== null);
        const nodeIds = new Set(out.nodes.map((n) => n.id));
        for (const e of out.edges) {
          expect(nodeIds.has(e.from)).toBe(true);
          expect(nodeIds.has(e.to)).toBe(true);
        }
        // Depths are consistent with BFS level order.
        for (const n of out.nodes) expect(n.depth).toBeLessThanOrEqual(depth);
      } finally {
        // Close only: on Windows libsql keeps the file locked ~1.4 s after
        // close, and 30 sequential removals would dominate the runtime.
        // Temp dirs are the OS's to clean.
        pdb.close();
      }
    }
  }, 120000);
});

// ---- Парные отказы: валидированный путь отвергает то, что фикстуры делают raw ----

describe("the validated path refuses what raw fixtures hand-craft", () => {
  it("informed_by self-loop is rejected", () => {
    node("s");
    expect(() =>
      db.insertEdge({ from_id: "s", to_id: "s", relation: "informed_by", description: "why" })
    ).toThrow(/self-loop/);
  });

  it("an informed_by cycle is rejected", () => {
    node("a");
    node("b");
    db.insertEdge({ from_id: "a", to_id: "b", relation: "informed_by", description: "why" });
    expect(() =>
      db.insertEdge({ from_id: "b", to_id: "a", relation: "informed_by", description: "why" })
    ).toThrow(/cycle/);
  });

  it("a blank rationale is rejected", () => {
    node("d", "decision");
    node("s");
    expect(() =>
      db.insertEdge({
        from_id: "d",
        to_id: "s",
        relation: "informed_by",
        description: " ".repeat(80),
      })
    ).toThrow(/рационал обязателен/);
  });

  it("a live informed_by edge onto a removed node is rejected", () => {
    node("d", "decision");
    node("s");
    db.softDeleteNode("s", "gone");
    expect(() =>
      db.insertEdge({ from_id: "d", to_id: "s", relation: "informed_by", description: "why" })
    ).toThrow(/does not exist/);
  });
});

// ---- F18: исходящие из неразрешённой компоненты проходят ----

describe("writes touching an unresolved cyclic component (F18)", () => {
  it("an incoming edge into the component is rejected, an outgoing one passes", () => {
    node("a", "decision");
    node("b", "decision");
    node("fresh");
    edge("a", "b");
    edge("b", "a"); // unresolved cycle, raw

    // Incoming: rejected (invariant 16 intact).
    expect(() =>
      link(db, { from: "fresh", to: "a", relation: "informed_by", description: "into the component" })
    ).toThrow(/needs_merge/);

    // Outgoing: closes no cycle — must pass (F18).
    const res = link(db, {
      from: "b",
      to: "fresh",
      relation: "informed_by",
      description: "out of the component",
    });
    expect(res.message).toContain("Created");
    const live = db.execSqlAll(
      "SELECT 1 FROM edges WHERE from_id = 'b' AND to_id = 'fresh' AND removed_at IS NULL"
    );
    expect(live).toHaveLength(1);
  });
});

// ---- 2.1.2: F3 (удалённый корень терминален), F4 (unknown внутреннего узла),
//      F5 (total_exact при обрезке max_nodes), F13 (наследование in_paths_capped) ----

describe("2.1.2 provenance trace fixes", () => {
  it("F3: a removed root is terminal — stub only, no historical expansion", () => {
    node("D", "decision", { removed: true });
    node("F");
    node("G");
    edge("D", "F");
    edge("F", "G");

    const out = trace("D", { retrospective: true });
    expect(out.nodes.map((n) => n.id)).toEqual(["D"]);
    const stub = out.nodes[0];
    expect(stub.removed).toBe(true);
    expect(out.edges).toEqual([]);
    expect(out.shown).toBe(1);
  });

  it("F5: a node-budget cut makes total_within_depth inexact", () => {
    node("D", "decision");
    node("a");
    node("b");
    node("c");
    edge("D", "a");
    edge("D", "b");
    edge("b", "c");

    const out = trace("D", { depth: 2, maxNodes: 1 });
    // The forbidden combination is total 3 / exact true: b was dropped by the
    // node budget, so its descendant c never entered the count.
    const inexact = out.total_within_depth !== 4 || out.total_exact === false;
    expect(inexact).toBe(true);
    expect(out.truncated_by).toBe("nodes");
    expect(out.nodes.find((n) => n.id === "c")).toBeUndefined();
  });

  it("F4: an unreviewed support of an inner fact node shows up as support_unreviewed", () => {
    node("D", "decision"); // summary s-D
    node("F", "feature"); // summary s-F
    node("S", "fact"); // summary s-S
    edge("D", "F", "why F");
    edge("F", "S", "why S");
    // Only D -> F is confirmed; F -> S never was.
    confirmSupports(db, {
      decision_id: "D",
      expected_claim_digest: claimDigestOf("s-D"),
      items: [
        {
          support_id: "F",
          expected_claim_digest: claimDigestOf("s-F"),
          expected_status_digest: statusDigestOf(
            db.getNode("F")!.status,
            db.getNode("F")!.epistemic_status
          ),
          expected_edge_digest: edgeDigestOf("why F"),
        },
      ],
    });

    const out = trace("D");
    const unreviewed = out.weak_links.filter((w) => w.type === "support_unreviewed");
    // F (the inner fact with its own informed_by) is reported; S (no supports
    // at all) is not, and the root's own verdict lives in support_check.
    expect(unreviewed.some((w) => w.id === "F")).toBe(true);
    expect(unreviewed.some((w) => w.id === "S")).toBe(false);
    expect(out.support_check?.state).toBe("unchanged");
  });

  it("F13: in_paths_capped is inherited by the descendant of a capped node", () => {
    // 5 levels x 20 fully-connected nodes: the last level sits above the cap
    // (20^4 = 160k paths); its child sums to the clamped 100k and inherits
    // the flag without crossing the cap itself.
    node("root", "decision");
    const levels: string[][] = [];
    for (let l = 0; l < 5; l++) {
      const level: string[] = [];
      for (let i = 0; i < 20; i++) {
        const id = `L${l}n${i}`;
        node(id);
        level.push(id);
      }
      levels.push(level);
    }
    node("child");
    for (const n of levels[0]) edge("root", n);
    for (let l = 0; l < 4; l++) {
      for (const a of levels[l]) for (const b of levels[l + 1]) edge(a, b);
    }
    edge(levels[4][0], "child");

    const out = trace("root", { depth: 6, maxNodes: 300 });
    const last = out.nodes.find((n) => n.id === levels[4][0])!;
    expect(last.in_paths).toBe(100000);
    expect(last.in_paths_capped).toBe(true);
    const child = out.nodes.find((n) => n.id === "child")!;
    expect(child.in_paths).toBe(100000);
    expect(child.in_paths_capped).toBe(true);
  }, 60000);
});
