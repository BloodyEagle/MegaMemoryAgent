import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { provenanceTrace, provenanceAudit } from "../provenance.js";
import type { ProvenanceTraceOutput } from "../types.js";

// plan-3-verify: the second verification pass (F8 retrospective weak links,
// F17 scan budget, F14 snapshot, F13 determinism, audit persistence).

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-provenance-verify-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

// Close only: libsql on Windows can hold the file for up to ~10 s after
// close under AV/indexer pressure. Temp dirs are the OS's to clean.
afterEach(() => {
  db.close();
});

function node(id: string, kind = "config", opts: { epistemic?: string } = {}) {
  db.insertNode({
    id,
    name: id.toUpperCase(),
    kind,
    summary: `s-${id}`,
    ...(opts.epistemic ? { epistemic_status: opts.epistemic } : {}),
  });
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

function trace(
  nodeId: string,
  opts: {
    direction?: "ancestry" | "impact";
    depth?: number;
    maxNodes?: number;
    scan?: number;
    retrospective?: boolean;
  } = {}
): ProvenanceTraceOutput {
  return provenanceTrace(db, {
    node_id: nodeId,
    direction: opts.direction,
    depth: opts.depth,
    max_nodes: opts.maxNodes,
    max_scan_nodes: opts.scan,
    retrospective: opts.retrospective,
  });
}

// ---- 1. Ретроспектива: weak_links соответствуют выданному графу (F8) ----

describe("retrospective weak links match the shown graph (F8)", () => {
  it("live mode warns only about the supports it shows; retrospective warns about the same set it shows", () => {
    node("d", "decision");
    node("a"); // live support, ungrounded: no refs, no live outgoing informed_by, not validated
    node("b"); // support whose edge and node are removed
    edge("d", "a", "live support");
    edge("d", "b", "old support");
    db.softDeleteNode("b", "gone"); // tombstones the node AND its touching edges

    const supportWarningIds = (out: ProvenanceTraceOutput): string[] =>
      out.weak_links
        .filter((w) =>
          ["no_support", "missing_support", "ungrounded_support"].includes(w.type)
        )
        .flatMap((w) => (w.id ? [w.id] : []));

    // Live: only d -> a is shown, and only a is warned about.
    const live = trace("d");
    expect(live.nodes.map((n) => n.id).sort()).toEqual(["a", "d"]);
    expect(live.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["d->a"]);
    expect(supportWarningIds(live)).toEqual(["d"]);
    expect(live.weak_links.some((w) => w.note?.includes("b"))).toBe(false);
    const liveIds = new Set(live.nodes.map((n) => n.id));
    for (const id of supportWarningIds(live)) expect(liveIds.has(id)).toBe(true);

    // Retrospective: both edges are shown (b as a tombstone stub), and the
    // warning set describes exactly that shown set — missing b + ungrounded a.
    const retro = trace("d", { retrospective: true });
    const stub = retro.nodes.find((n) => n.id === "b")!;
    expect(stub.removed).toBe(true);
    expect(retro.edges.map((e) => [e.from, e.to, e.removed === true])).toEqual([
      ["d", "a", false],
      ["d", "b", true],
    ]);
    expect(
      retro.weak_links.some(
        (w) => w.type === "missing_support" && w.id === "d" && w.note?.includes("b")
      )
    ).toBe(true);
    expect(
      retro.weak_links.some(
        (w) => w.type === "ungrounded_support" && w.id === "d" && w.note?.includes("a")
      )
    ).toBe(true);
    expect(retro.weak_links.some((w) => w.type === "no_support")).toBe(false);
    // Every support mentioned by a warning is present in the issued graph.
    const retroIds = new Set(retro.nodes.map((n) => n.id));
    for (const id of supportWarningIds(retro)) expect(retroIds.has(id)).toBe(true);

    console.log("F8_LIVE_JSON " + JSON.stringify(live));
    console.log("F8_RETRO_JSON " + JSON.stringify(retro));
  });
});

// ---- 2. Бюджет сканирования (контракт 5, F17) ----

describe("scan budget bounds the work (F17, contract 5)", () => {
  it("max_scan_nodes=100 over a 10k and a 20k star: scan cut, inexact total, output size does not depend on graph size", () => {
    const runStar = (width: number): { out: ProvenanceTraceOutput; ms: number } => {
      const rootId = `root${width}`;
      node(rootId, "decision");
      for (let i = 1; i <= width; i++) node(`s${width}_${i}`);
      for (let i = 1; i <= width; i++) edge(rootId, `s${width}_${i}`);

      const t0 = performance.now();
      const out = trace(rootId, { scan: 100 });
      const ms = performance.now() - t0;
      return { out, ms };
    };

    const small = runStar(10000);
    expect(small.out.truncated_by).toBe("scan");
    expect(small.out.total_exact).toBe(false);
    expect(small.out.total_within_depth).toBe(100); // lower estimate
    expect(small.out.shown).toBe(100); // root + 99 discovered within the budget
    expect(small.out.edges).toHaveLength(99); // materialized only for included ends (F17)
    expect(small.out.completeness).toBe("truncated");

    const big = runStar(20000);
    // The answer is bounded by the budget, not by the graph size.
    expect(big.out.truncated_by).toBe("scan");
    expect(big.out.total_exact).toBe(false);
    expect(big.out.total_within_depth).toBe(100);
    expect(big.out.shown).toBe(100);
    expect(big.out.edges).toHaveLength(99);

    // Generous absolute bound — the walk must not degenerate into a full scan.
    expect(small.ms).toBeLessThan(10000);
    expect(big.ms).toBeLessThan(10000);
    console.log(
      `SCAN_T10K_MS ${small.ms.toFixed(0)} SCAN_T20K_MS ${big.ms.toFixed(0)}`
    );
  }, 60000);
});

// ---- 3. Снимок данных (F14) ----

describe("one reading transaction: a concurrent write cannot split the answer (F14)", () => {
  it("a write from a second connection during the traversal is refused (BUSY) and never leaks into the output", () => {
    node("root", "decision");
    node("x");
    node("late"); // exists up front so the FK check cannot mask the lock conflict
    edge("root", "x", "why");
    for (let i = 1; i <= 150; i++) {
      node(`n${i}`);
      edge(i === 1 ? "x" : `n${i - 1}`, `n${i}`);
    }

    const db2 = new KnowledgeDB(db.dbPath);
    try {
      // Fail fast on the write lock instead of stalling the synchronous hook.
      db2.pragma("busy_timeout = 20");

      let writeError: unknown = null;
      let calls = 0;
      const original = db.getInformedByEdges.bind(db);
      (db as unknown as Record<string, unknown>).getInformedByEdges = (
        id: string,
        direction: "ancestry" | "impact",
        retrospective: boolean
      ) => {
        calls += 1;
        if (calls === 3) {
          // Mid-traversal (the walk is inside its BEGIN IMMEDIATE here).
          try {
            db2.insertEdgeRaw({
              from_id: "root",
              to_id: "late",
              relation: "informed_by",
              description: "late arrival",
            });
          } catch (err) {
            writeError = err;
          }
        }
        return original(id, direction, retrospective);
      };

      let out: ProvenanceTraceOutput;
      try {
        out = provenanceTrace(db, { node_id: "root", depth: 1000, max_nodes: 1000 });
      } finally {
        delete (db as unknown as Record<string, unknown>).getInformedByEdges;
      }

      // The answer is one snapshot: the late edge is not in it, and the
      // shown/total pair cannot disagree.
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(out.nodes.some((n) => n.id === "late")).toBe(false);
      expect(out.shown).toBe(out.total_within_depth);
      expect(out.truncated).toBe(false);
      // The concurrent write hit the held write lock — it cannot tear the
      // snapshot, it is simply refused while the read transaction is open.
      expect(writeError).not.toBeNull();
      expect(String(writeError)).toMatch(/BUSY|locked|busy/i);

      // After the read transaction released the lock, the same write lands —
      // it was refused, not lost. (Read back over db2: after a BUSY refusal
      // inside a foreign transaction the committing connection reads a stale
      // snapshot — see plan-3-verify-report, finding D1.)
      db2.insertEdgeRaw({
        from_id: "root",
        to_id: "late",
        relation: "informed_by",
        description: "late arrival",
      });
      const landed = db2.execSqlAll(
        "SELECT 1 FROM edges WHERE from_id = 'root' AND to_id = 'late' AND removed_at IS NULL"
      );
      expect(landed).toHaveLength(1);
    } finally {
      db2.close();
    }
  });
});

// ---- 4. Детерминизм усечения (F13) ----

describe("truncation determinism at equal depth (F13)", () => {
  it("one free slot at depth 2 picks c over z regardless of which parent discovered it", () => {
    node("r", "decision");
    node("a");
    node("b");
    node("z");
    node("c");
    edge("r", "a");
    edge("r", "b");
    edge("a", "z"); // parent a discovers z
    edge("b", "c"); // parent b discovers c

    const out = trace("r", { maxNodes: 3 }); // root + a + b, one slot left at depth 2
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "r"]);
    expect(out.nodes.some((n) => n.id === "z")).toBe(false);
    expect(out.nodes.find((n) => n.id === "c")!.in_paths).toBe(1);
    expect(out.truncated_by).toBe("nodes");
    expect(out.total_within_depth).toBe(5); // honest: all 5 are within depth
    // 2.1.2 F5: z was dropped by the node budget and never expanded — any
    // descendants it grew past this point are unknown to the walk, so the
    // closure cannot be claimed exact. (Assert updated per plan-4-fixes-8
    // F5: the old `true` codified exactly the order-dependent lie the fix
    // removes; the fixture is unchanged.)
    expect(out.total_exact).toBe(false);

    // Same input -> same selection.
    const again = trace("r", { maxNodes: 3 });
    expect(again.nodes.map((n) => n.id).sort()).toEqual(out.nodes.map((n) => n.id).sort());
  });
});

// ---- 5. Запись аудита (plan 3 §10) ----

describe("provenance_audit persistence (plan 3 §10)", () => {
  it("writes one row per run: root_id, direction, params and result with at_risk", () => {
    node("d", "decision"); // epistemic_status NULL -> at_risk in the audit
    node("s");
    edge("d", "s", "why");

    const out = provenanceAudit(db, { node_id: "d" });
    expect(out.audit_run_id).toBeGreaterThan(0);
    expect(out.direction).toBe("impact"); // audit defaults to impact
    // Impact closure of d: nobody relies on d, so only the root itself is
    // shown; its support s lives in the ancestry direction, not here.
    expect(out.nodes.map((n) => n.id)).toEqual(["d"]);
    expect(out.nodes[0].at_risk).toBe(true); // epistemic_status NULL != validated
    expect(out.completeness).toBe("has_hidden"); // the d -> s record exists

    // The ancestry audit shows both endpoints at risk.
    const anc = provenanceAudit(db, { node_id: "d", direction: "ancestry" });
    expect(anc.nodes.map((n) => n.id).sort()).toEqual(["d", "s"]);
    expect(anc.nodes.every((n) => n.at_risk === true)).toBe(true);

    const runs = db.getProvenanceAuditRuns("d");
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(anc.audit_run_id); // newest first
    expect(runs[0].root_id).toBe("d");
    expect(runs[0].direction).toBe("ancestry");
    expect(JSON.parse(runs[0].params!)).toMatchObject({
      depth: 6,
      max_nodes: 200,
      retrospective: false,
    });
    const stored = JSON.parse(runs[0].result!);
    expect(stored.shown).toBe(anc.shown);
    expect(stored.completeness).toBe(anc.completeness);
    expect(stored.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "s", at_risk: true }),
      ])
    );
    expect(runs[1].direction).toBe("impact");
  });

  it("retention: the last 200 per root, 90-day age cutoff, other roots and repeats do not grow the table", () => {
    node("a", "decision");
    node("b", "decision");

    for (let i = 0; i < 205; i++) provenanceAudit(db, { node_id: "a" });
    const countA = () =>
      Number(
        (
          db.execSqlAll(
            "SELECT COUNT(*) AS c FROM provenance_audit_runs WHERE root_id = 'a'"
          ) as Array<{ c: number }>
        )[0].c
      );
    expect(countA()).toBe(200); // capped, not 205
    const kept = db.execSqlAll(
      "SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM provenance_audit_runs WHERE root_id = 'a'"
    ) as Array<{ min_id: number; max_id: number }>;
    expect(Number(kept[0].min_id)).toBe(6); // ids 6..205 — the newest 200
    expect(Number(kept[0].max_id)).toBe(205);

    // Age one row past the cutoff — the next run prunes it.
    db.execSqlRun(
      "UPDATE provenance_audit_runs SET created_at = datetime('now', '-100 days') " +
        "WHERE root_id = 'a' AND id = (SELECT MAX(id) FROM provenance_audit_runs WHERE root_id = 'a')"
    );
    provenanceAudit(db, { node_id: "a" });
    const aged = db.execSqlAll(
      "SELECT id FROM provenance_audit_runs WHERE root_id = 'a' AND created_at < datetime('now', '-90 days')"
    );
    expect(aged).toHaveLength(0);
    // One DELETE applies both rules at once: the aged row AND the row that
    // just fell out of the 200-cap are purged together — 199 until the next
    // run refills the slot.
    expect(countA()).toBe(199);

    // Retention is per root: b's runs are untouched by a's cap.
    for (let i = 0; i < 5; i++) provenanceAudit(db, { node_id: "b" });
    expect(db.getProvenanceAuditRuns("b")).toHaveLength(5);
    expect(countA()).toBe(199); // no a-run since the refill, so still 199

    // Repeated calls do not grow the table beyond the cap.
    for (let i = 0; i < 10; i++) provenanceAudit(db, { node_id: "a" });
    expect(countA()).toBe(200);
  }, 60000);
});
