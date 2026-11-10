import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { provenanceTrace } from "../provenance.js";
import type { ProvenanceTraceOutput } from "../types.js";

// plan-3-fixes-3 (D2): batched support checks, bounded weak-link notes, the
// 8 KB response cap. The star fixtures mirror the verification pass: a
// decision root with N ungrounded supports, scanned with max_scan_nodes=100.

// Each describe owns its database: the star is built ONCE per describe
// (beforeAll), the small fixtures are rebuilt per test.

let tmpDir: string;
let db: KnowledgeDB;

function freshDb(prefix: string): KnowledgeDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
}

function node(
  id: string,
  kind = "config",
  opts: { epistemic?: string; fileRefs?: string[] } = {}
) {
  db.insertNode({
    id,
    name: id.toUpperCase(),
    kind,
    summary: `s-${id}`,
    // 2.1.10 F3: с проверкой опор на всех носителях знания узел с опорами
    // проверяется независимо от kind. В фиксстурах-«звёздах» листьям даны
    // file_refs, чтобы hub оставался тихим, как до 2.1.10.
    ...(opts.fileRefs ? { file_refs: opts.fileRefs } : {}),
    ...(opts.epistemic ? { epistemic_status: opts.epistemic } : {}),
  });
}

function edge(from: string, to: string, description = "why") {
  db.insertEdgeRaw({ from_id: from, to_id: to, relation: "informed_by", description });
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

/** Count DB-method calls (test 6): the query count must not grow with the
 * fan-out. Wraps the read methods traverse/weakLinks actually use. */
function instrumentQueries(target: KnowledgeDB) {
  const methods = [
    "getNode",
    "getNodeIncludingRemoved",
    "getInformedByEdges",
    "execSqlAll",
    "execSqlRun",
    "hasAnyInformedByRecord",
  ] as const;
  let calls = 0;
  const saved = new Map<string, unknown>();
  const self = target as unknown as Record<string, unknown>;
  for (const m of methods) {
    saved.set(m, self[m]);
    self[m] = (...args: unknown[]) => {
      calls += 1;
      // apply keeps `this` on the db instance — the methods reach this.db.
      return (saved.get(m) as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
  return {
    count: () => calls,
    restore: () => {
      for (const [m, fn] of saved) self[m] = fn;
    },
  };
}

// ---- 1–5. Звезда 20 000 опор, бюджет сканирования 100 ----

describe("20k-star with scan budget 100 (D2.1/D2.2/D2.3/D2.4)", () => {
  const WIDTH = 20000;
  const ROOT = "star";

  beforeAll(() => {
    db = freshDb("mm-provenance-star-");
    node(ROOT, "decision");
    for (let i = 1; i <= WIDTH; i++) node(`s${i}`);
    for (let i = 1; i <= WIDTH; i++) edge(ROOT, `s${i}`);
  }, 120000);

  // Close only: libsql on Windows can hold the file after close — the OS
  // cleans the temp dirs (same policy as the other provenance suites).
  afterAll(() => {
    db.close();
  });

  it("1. trace returns 99 edges under the 1200 ms smoke threshold (was 2874 ms)", () => {
    const runs: number[] = [];
    let out: ProvenanceTraceOutput | null = null;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      out = trace(ROOT, { scan: 100 });
      runs.push(performance.now() - t0);
    }
    const best = Math.min(...runs);
    console.log(
      `AFTER_T20K_MS runs=${runs.map((r) => r.toFixed(0)).join("/")} best=${best.toFixed(0)}`
    );
    // Smoke threshold only: it must catch a gross degradation (the
    // pre-batching code took 2874 ms) without reddening under machine load —
    // exact numbers belong to scripts/perf-trace.mjs (manual benchmark).
    expect(best).toBeLessThan(1200);
    // Correctness is the real assertion: the scan budget keeps the answer
    // bounded and honestly flagged.
    expect(out!.edges).toHaveLength(99);
    expect(out!.nodes).toHaveLength(100);
    expect(out!.shown).toBe(100);
    expect(out!.truncated_by).toBe("scan");
    expect(out!.total_exact).toBe(false);
  }, 60000);

  it("2. serialized weak_links stay under 8 KB (was 269 010 chars)", () => {
    const out = trace(ROOT, { scan: 100 });
    const size = JSON.stringify(out.weak_links).length;
    console.log(`AFTER_WEAK_LINKS_JSON=${size}`);
    expect(size).toBeLessThan(8192);
  });

  it("3. every note fits 300 chars; the truncated one carries «… и ещё»", () => {
    const out = trace(ROOT, { scan: 100 });
    const noted = out.weak_links.filter((w) => w.note !== undefined);
    expect(noted.length).toBeGreaterThan(0);
    for (const w of noted) expect(w.note!.length).toBeLessThanOrEqual(300);
    const ungrounded = out.weak_links.find((w) => w.type === "ungrounded_support")!;
    expect(ungrounded).toBeDefined();
    expect(ungrounded.note!).toContain("и ещё");
  });

  it("4. count equals the verified supports, sample holds at most 5 ids", () => {
    const out = trace(ROOT, { scan: 100 });
    const ungrounded = out.weak_links.find((w) => w.type === "ungrounded_support")!;
    expect(ungrounded).toBeDefined();
    expect(ungrounded.count).toBe(100); // the scan budget checked 100 of 20000
    expect(ungrounded.sample).toBeDefined();
    expect(ungrounded.sample!.length).toBeLessThanOrEqual(5);
    // The sample matches the checked prefix (first by id).
    expect(ungrounded.sample![0]).toBe("s1");
  });

  it("5. support_check_truncated reports checked=100 total=20000", () => {
    const out = trace(ROOT, { scan: 100 });
    const cut = out.weak_links.find((w) => w.type === "support_check_truncated")!;
    expect(cut).toBeDefined();
    expect(cut.id).toBe(ROOT);
    expect(cut.checked).toBe(100);
    expect(cut.total).toBe(WIDTH);
  });
});

// ---- 6. Число запросов к БД не растёт с числом опор ----

describe("query count follows the batch size, not the fan-out (D2.1)", () => {
  beforeEach(() => {
    db = freshDb("mm-provenance-queries-");
  });
  afterEach(() => {
    db.close();
  });

  it("on 100 and 10 000 supports with the same budget the query counts stay in the same range", () => {
    const build = (width: number) => {
      const rootId = `q${width}`;
      node(rootId, "decision");
      for (let i = 1; i <= width; i++) node(`n${width}_${i}`);
      for (let i = 1; i <= width; i++) edge(rootId, `n${width}_${i}`);
      return rootId;
    };
    build(100);
    build(10000);

    const probe = instrumentQueries(db);
    let q100 = 0;
    let q10000 = 0;
    try {
      trace("q100", { scan: 100 });
      q100 = probe.count();
      trace("q10000", { scan: 100 });
      q10000 = probe.count() - q100;
    } finally {
      probe.restore();
    }
    console.log(`QUERY_COUNT q100=${q100} q10000=${q10000} delta=${q10000 - q100}`);
    expect(q10000).toBeGreaterThan(0);
    // Same order of magnitude: the fan-out adds no per-support queries.
    expect(q10000 - q100).toBeLessThanOrEqual(5);
    expect(q100 - q10000).toBeLessThanOrEqual(5);
  }, 60000);
});

// ---- 7–8. Семантика предупреждений не изменилась ----

describe("support warning semantics within the budget (unchanged)", () => {
  beforeEach(() => {
    db = freshDb("mm-provenance-semantics-");
  });
  afterEach(() => {
    db.close();
  });

  it("7. three supports, two ungrounded + one missing -> ungrounded_support with count=2; a grounded third support keeps the decision silent", () => {
    node("d", "decision");
    node("u1");
    node("u2");
    edge("d", "u1");
    edge("d", "u2");
    db.pragma("foreign_keys = OFF");
    edge("d", "ghost"); // missing support node — needs FK off
    db.pragma("foreign_keys = ON");

    const out = trace("d");
    const ungrounded = out.weak_links.find((w) => w.type === "ungrounded_support")!;
    expect(ungrounded).toBeDefined();
    expect(ungrounded.id).toBe("d");
    expect(ungrounded.count).toBe(2);
    expect(ungrounded.sample).toEqual(["u1", "u2"]);
    // The type pair is unchanged: missing is its own record.
    expect(out.weak_links.some((w) => w.type === "missing_support" && w.count === 1)).toBe(true);

    // Same graph, but the third support is grounded — no warning at all.
    // (u3 carries file_refs: 2.1.10 F3 checks g — a non-decision with a
    // support — so an ungrounded u3 would now speak for g.)
    node("d2", "decision");
    node("u3", "config", { fileRefs: ["src/u3.ts:1-2"] });
    node("g", "config");
    edge("g", "u3"); // g has a live outgoing informed_by -> grounded
    edge("d2", "u1");
    edge("d2", "u2");
    edge("d2", "g");
    const quiet = trace("d2");
    expect(
      quiet.weak_links.some(
        (w) => w.type === "ungrounded_support" || w.type === "missing_support"
      )
    ).toBe(false);
  });

  it("8. impact direction: the supports are not shown, the warning still fires", () => {
    node("d", "decision");
    for (let i = 1; i <= 10; i++) node(`u${i}`);
    for (let i = 1; i <= 10; i++) edge("d", `u${i}`);

    const out = trace("u1", { direction: "impact" });
    expect(out.direction).toBe("impact");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["d", "u1"]);
    // d's other supports never appear in the impact output…
    expect(out.nodes.some((n) => n.id === "u2")).toBe(false);
    // …but its weak ground is still reported.
    const ungrounded = out.weak_links.find((w) => w.type === "ungrounded_support")!;
    expect(ungrounded).toBeDefined();
    expect(ungrounded.id).toBe("d");
    expect(ungrounded.count).toBe(10);
  });
});

// ---- 9–10. Потолок 8 КБ и приоритет ----

describe("8 KB weak_links cap (D2.4)", () => {
  beforeEach(() => {
    db = freshDb("mm-provenance-cap-");
  });
  afterEach(() => {
    db.close();
  });

  it("9. 150 no_support records overflow the cap: the marker reports shown/total and the payload fits", () => {
    node("hub");
    // file_refs on the leaves keep hub quiet under 2.1.10 F3 (hub is a
    // non-decision with supports — grounded leaves leave it silent).
    for (let i = 1; i <= 150; i++)
      node(`d${String(i).padStart(3, "0")}`, "decision", {
        fileRefs: [`src/d${i}.ts:1-2`],
      });
    for (let i = 1; i <= 150; i++) edge("hub", `d${String(i).padStart(3, "0")}`);

    const out = trace("hub", { maxNodes: 200 });
    const noSupport = out.weak_links.filter((w) => w.type === "no_support");
    const marker = out.weak_links.find((w) => w.type === "weak_links_truncated")!;
    expect(marker).toBeDefined();
    expect(marker.total).toBe(150);
    expect(marker.shown).toBe(noSupport.length);
    expect(marker.shown).toBeLessThan(150);
    expect(JSON.stringify(out.weak_links).length).toBeLessThanOrEqual(8192);
  });

  it("10. priority: a refuted node survives the cut that drops no_support records", () => {
    node("hub");
    for (let i = 1; i <= 150; i++) {
      const id = `d${String(i).padStart(3, "0")}`;
      node(id, "decision", {
        ...(i === 7 ? { epistemic: "refuted" } : {}),
        fileRefs: [`src/d${i}.ts:1-2`],
      });
      edge("hub", id);
    }

    const out = trace("hub", { maxNodes: 200 });
    expect(out.weak_links.some((w) => w.type === "refuted" && w.id === "d007")).toBe(true);
    const marker = out.weak_links.find((w) => w.type === "weak_links_truncated")!;
    expect(marker).toBeDefined();
    expect(marker.shown).toBeLessThan(marker.total!);
    // The refuted record is the FIRST thing kept — antiknowledge outranks
    // everything else in the priority order.
    expect(out.weak_links[0].type).toBe("refuted");
    expect(JSON.stringify(out.weak_links).length).toBeLessThanOrEqual(8192);
  });
});
