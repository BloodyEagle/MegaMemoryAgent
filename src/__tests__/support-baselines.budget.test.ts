/**
 * 2.1.2: budget-family fixes for the support-baseline check and metrics —
 * F7 (the decision's own summary goes through the budget), F10 (CheckBudget
 * argument validation), F12 (consume flags an attempt beyond the limit).
 *
 * node:crypto is instrumented so the tests can see HOW MANY BYTES were
 * actually hashed — "полный текст не хешируется" must be observable, not
 * assumed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { link } from "../tools.js";
import {
  CheckBudget,
  claimDigestOf,
  computeSupportCheck,
  confirmSupports,
  edgeDigestOf,
  provenanceMetrics,
  statusDigestOf,
} from "../support-baselines.js";

const { hashStats } = vi.hoisted(() => ({ hashStats: { hashedBytes: 0 } }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: ((algorithm: string, options?: unknown) => {
      const hash = actual.createHash(algorithm, options as never);
      const origUpdate = hash.update.bind(hash) as typeof hash.update;
      hash.update = ((data: string | Uint8Array, ...rest: unknown[]) => {
        hashStats.hashedBytes +=
          typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
        return (origUpdate as (...a: unknown[]) => typeof hash)(data, ...rest);
      }) as typeof hash.update;
      return hash;
    }) as typeof actual.createHash,
  };
});

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-baselines-budget-"));
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

function supportEdge(from: string, to: string, description = `why ${to}`) {
  link(db, { from, to, relation: "informed_by", description });
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

// ---- F7: хеш саммари решения подчиняется байтовому бюджету ----

describe("2.1.2 F7: the decision's own summary is budgeted", () => {
  it("a 10 MB summary with max_check_bytes = 1 yields incomplete and hashes nothing", () => {
    const big = "x".repeat(10 * 1024 * 1024);
    node("d", "decision", big);
    node("f", "fact");
    supportEdge("d", "f");
    confirm("d", ["f"]);
    // The wording was rewritten after the confirmation — the claim must be
    // re-checked (and that check must pay the budget, not hash behind it).
    db.updateNode("d", { summary: `${big}!` });

    hashStats.hashedBytes = 0;
    const view = computeSupportCheck(db, "d", new CheckBudget(100, 1))!;
    expect(view.state).toBe("incomplete");
    expect(view.incomplete).toBe(true);
    // The 10 MB payload never reached the hasher.
    expect(hashStats.hashedBytes).toBe(0);
  });

  it("with a fitting budget the summary is hashed and the divergence is reported", () => {
    const big = "x".repeat(1 * 1024 * 1024);
    node("d", "decision", big);
    node("f", "fact");
    supportEdge("d", "f");
    confirm("d", ["f"]);
    db.updateNode("d", { summary: `${big}!` });

    hashStats.hashedBytes = 0;
    const view = computeSupportCheck(db, "d", new CheckBudget(100, 2_000_000))!;
    expect(view.state).toBe("changed");
    expect(view.claim_changed).toBe(true);
    // The summary went through the hasher — and through consume.
    expect(hashStats.hashedBytes).toBeGreaterThan(0);
    expect(view.incomplete).toBe(false);
  });
});

// ---- F10: аргументы CheckBudget валидируются ----

describe("2.1.2 F10: CheckBudget refuses NaN/Infinity/negative", () => {
  it("constructor throws on NaN, Infinity, -1, non-integer", () => {
    expect(() => new CheckBudget(Number.NaN, 100)).toThrow(/CheckBudget/);
    expect(() => new CheckBudget(100, Number.NaN)).toThrow(/CheckBudget/);
    expect(() => new CheckBudget(Number.POSITIVE_INFINITY, 100)).toThrow(/CheckBudget/);
    expect(() => new CheckBudget(100, Number.POSITIVE_INFINITY)).toThrow(/CheckBudget/);
    expect(() => new CheckBudget(-1, 100)).toThrow(/CheckBudget/);
    expect(() => new CheckBudget(100, -1)).toThrow(/CheckBudget/);
    expect(() => new CheckBudget(1.5, 100)).toThrow(/CheckBudget/);
  });

  it("zero budgets are legal and exhausted from the start", () => {
    const b = new CheckBudget(0, 0);
    expect(b.exhausted).toBe(true);
  });
});

// ---- F12: consume отличает точное исчерпание от отказа ----

describe("2.1.2 F12: consume flags an attempt beyond the limit", () => {
  it("exact exhaustion leaves exceeded false; one more attempt sets it true", () => {
    const b = new CheckBudget(2, 10);
    expect(b.consume(5)).toBe(true);
    expect(b.consume(5)).toBe(true);
    expect(b.exceeded).toBe(false); // exactly on the limit, nothing refused yet
    expect(b.consume(0)).toBe(false); // an extra edge over the limit
    expect(b.exceeded).toBe(true);
  });

  it("an over-limit byte charge trips exceeded on the same call", () => {
    const b = new CheckBudget(10, 5);
    expect(b.consume(6)).toBe(false);
    expect(b.exceeded).toBe(true);
  });
});

// ---- F8: запасной путь снимков не материализует всю историю пары ----

/** Count the rows the SQL engine hands back for support_baselines reads. */
function countBaselineRows(db: KnowledgeDB): () => number {
  const raw = (db as unknown as { db: Database }).db;
  const realPrepare = raw.prepare.bind(raw);
  let rows = 0;
  (raw as unknown as { prepare: (sql: string) => Database.Statement }).prepare = (
    sql: string
  ) => {
    const stmt = realPrepare(sql);
    if (/FROM support_baselines/i.test(sql) && !/COUNT\(/i.test(sql)) {
      const realAll = stmt.all.bind(stmt) as (...a: unknown[]) => unknown[];
      (stmt as unknown as { all: (...a: unknown[]) => unknown[] }).all = (
        ...a: unknown[]
      ) => {
        const out = realAll(...a);
        rows += out.length;
        return out;
      };
      const realGet = stmt.get.bind(stmt) as (...a: unknown[]) => unknown;
      (stmt as unknown as { get: (...a: unknown[]) => unknown }).get = (...a: unknown[]) => {
        const out = realGet(...a);
        if (out !== undefined) rows += 1;
        return out;
      };
    }
    return stmt;
  };
  return () => rows;
}

describe("2.1.2 F8: the fallback snapshot read fetches one row, not the pair history", () => {
  it("1000 active snapshots of one support + budget 1 -> one row materialized", () => {
    node("d", "decision", "decision d");
    node("f", "fact", "fact f");
    supportEdge("d", "f");
    confirm("d", ["f"]);
    // The same support with 999 more ACTIVE snapshot rows under different
    // edge_keys — the shape merge carry-over produces (relabeled/dead keys
    // are plain strings; the table has no FK on purpose). link/unlink cannot
    // build this: a revived edge keeps its rowid.
    const decision = db.getNode("d")!;
    const support = db.getNode("f")!;
    const edge = db.getInformedByEdges("d", "ancestry", false)[0];
    const base = {
      decision_id: "d",
      support_id: "f",
      claim_digest: claimDigestOf(support.summary),
      status_digest: statusDigestOf(support.status, support.epistemic_status),
      edge_digest: edgeDigestOf(edge.description),
      format_version: 1,
      confirmed_at: new Date().toISOString(),
      confirmed_by: "agent",
    };
    for (let i = 0; i < 999; i++) {
      db.upsertSupportBaseline({ ...base, edge_key: `legacy:${i}` });
    }
    const counted = db
      .execSqlAll(
        "SELECT COUNT(*) AS n FROM support_baselines WHERE decision_id = 'd' AND superseded_at IS NULL"
      )
      .map((r) => (r as { n: number }).n)[0];
    expect(counted).toBe(1000);

    // Budget 2 = the minimum that reaches the live pass under the F7
    // accounting (1 claim + 1 support): the bulk read stays out of reach
    // (1000 snapshots), so the check goes through the fallback path.
    const stop = countBaselineRows(db);
    const view = computeSupportCheck(db, "d", new CheckBudget(2, 1_000_000))!;
    const materialized = stop();
    console.log(`[F8] materialized baseline rows: ${materialized} (budget 2, 1000 snapshots)`);
    // The verdict stays honest over the single fetched row: the live edge's
    // anchor matches, so the pair is unchanged.
    expect(view.state).toBe("unchanged");
    expect(view.incomplete).toBe(false);
    // One anchor row for the live edge — not the pair's 1000-row history.
    expect(materialized).toBeLessThanOrEqual(3);
  }, 120_000);
});

// ---- F11: мёртвые снимки идут keyset-страницами, не OFFSET ----

describe("2.1.2 F11: dead anchors are walked by keyset, not OFFSET", () => {
  it("pages enumerate every dead support once, cursor = last support_id, no OFFSET", () => {
    node("d", "decision", "decision d");
    const WIDTH = 450;
    const ids: string[] = [];
    for (let i = 0; i < WIDTH; i++) ids.push(`s${String(i).padStart(4, "0")}`);
    for (const id of ids) {
      node(id, "fact", `fact ${id}`);
      supportEdge("d", id);
    }
    confirm("d", ids);
    // Tombstone every support edge: all 450 anchors become dead.
    for (const id of ids) expect(db.deleteEdge("d", id, "informed_by")).toBe(true);

    // Record every dead-page query: its SQL shape and its cursor argument.
    const raw = (db as unknown as { db: { prepare: (s: string) => unknown } }).db;
    const realPrepare = raw.prepare.bind(raw) as (s: string) => {
      all: (...a: unknown[]) => unknown[];
    };
    const deadQueries: Array<{ sql: string; args: unknown[] }> = [];
    (raw as unknown as { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } }).prepare =
      (sql: string) => {
        const stmt = realPrepare(sql);
        if (/GROUP BY b\.support_id/i.test(sql)) {
          const realAll = stmt.all.bind(stmt) as (...a: unknown[]) => unknown[];
          (stmt as unknown as { all: (...a: unknown[]) => unknown[] }).all = (
            ...a: unknown[]
          ) => {
            deadQueries.push({ sql, args: a });
            return realAll(...a);
          };
        }
        return stmt;
      };

    // Walk the pages the way computeSupportCheck does — cursor = last id.
    const walked: string[] = [];
    let cursor = "";
    for (;;) {
      const page = db.getDeadBaselineSupportsPage("d", cursor, 200);
      if (page.length === 0) break;
      for (const r of page) walked.push(r.support_id);
      cursor = page[page.length - 1].support_id;
    }

    // Complete, ordered, duplicate-free enumeration.
    expect(walked).toEqual(ids);
    expect(new Set(walked).size).toBe(WIDTH);
    // Three full pages (200/200/50) plus one empty terminator query — the
    // cursor is the last seen support_id each time, never an OFFSET.
    expect(deadQueries.length).toBe(4);
    for (const q of deadQueries) {
      expect(q.sql).toMatch(/support_id > \?/);
      expect(q.sql).not.toMatch(/OFFSET/i);
    }
    expect(deadQueries[1].args[1]).toBe(ids[199]);
    expect(deadQueries[2].args[1]).toBe(ids[399]);
    expect(deadQueries[3].args[1]).toBe(ids[449]);
  });
});

// ---- F9: метрики работают под бюджетом ----

/** Count the rows the SQL engine hands back for the metric decision scan. */
function countDecisionRows(db: KnowledgeDB): () => number {
  const raw = (db as unknown as { db: { prepare: (s: string) => unknown } }).db;
  const realPrepare = (raw.prepare as (s: string) => {
    all: (...a: unknown[]) => unknown[];
  }).bind(raw);
  let rows = 0;
  (raw as unknown as { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } }).prepare =
    (sql: string) => {
      const stmt = realPrepare(sql);
      if (/kind = 'decision'/i.test(sql)) {
        const realAll = stmt.all.bind(stmt) as (...a: unknown[]) => unknown[];
        (stmt as unknown as { all: (...a: unknown[]) => unknown[] }).all = (
          ...a: unknown[]
        ) => {
          const out = realAll(...a);
          rows += out.length;
          return out;
        };
      }
      return stmt;
    };
  return () => rows;
}

describe("2.1.2 F9: provenance_metrics under budget", () => {
  it("2000 decisions with budget 1 -> a page, not the whole list", () => {
    const WIDTH = 2000;
    db.runInTransaction(() => {
      for (let i = 0; i < WIDTH; i++) {
        const did = `d${String(i).padStart(5, "0")}`;
        const sid = `s${String(i).padStart(5, "0")}`;
        node(did, "decision", `decision ${did}`);
        node(sid, "fact", `fact ${sid}`);
        supportEdge(did, sid);
      }
    });

    const stop = countDecisionRows(db);
    const m = provenanceMetrics(db, new CheckBudget(1, 1_000_000));
    const materialized = stop();
    console.log(`[F9] materialized decision rows: ${materialized} (budget 1, ${WIDTH} decisions)`);
    // The budget bounds the work: a tiny budget must not materialize the
    // whole decision list.
    expect(materialized).toBeLessThanOrEqual(3);
    // One decision got a verdict, the rest are honestly reported as left out.
    const counted =
      m.decisions_by_check_state.unchanged +
      m.decisions_by_check_state.changed +
      m.decisions_by_check_state.unknown +
      m.decisions_by_check_state.incomplete;
    expect(counted).toBe(1);
    expect(m.metrics_truncated).toBe(true);
  }, 120_000);
});

// ---- F14: метрики читают внутри одной транзакции ----

describe("2.1.2 F14: provenance_metrics reads one snapshot", () => {
  it("the whole call runs inside a read transaction; a concurrent write is refused", () => {
    confirmedDecision("m1", ["x1"]);
    confirmedDecision("m2", ["x2"]);
    node("y", "fact"); // a fresh pair m1 -> y for the concurrent-write probe

    const txnSpy = vi.spyOn(db, "runInTransaction");

    // Second connection: try to write while the metrics read is in flight —
    // the held read transaction must refuse it (one snapshot, no tearing).
    const db2 = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
    // Fail fast instead of waiting the default 5 s per attempt: the point is
    // that the write is REFUSED inside the read transaction, not how long it
    // waits first.
    db2.execSqlRun("PRAGMA busy_timeout = 10");
    let writeError: unknown = null;
    let checks = 0;
    // The page SELECT puts both decisions in one page; the write attempt goes
    // on the SECOND per-decision check (countLiveInformedByEdges), i.e. while
    // the read transaction is open and half the answer is already computed.
    const origCount = db.countLiveInformedByEdges.bind(db);
    (db as unknown as Record<string, unknown>).countLiveInformedByEdges = (id: string) => {
      checks += 1;
      if (checks === 2) {
        try {
          db2.insertEdgeRaw({
            from_id: "m1",
            to_id: "y",
            relation: "informed_by",
            description: "late arrival",
          });
        } catch (err) {
          writeError = err;
        }
      }
      return origCount(id);
    };

    try {
      const m = provenanceMetrics(db, new CheckBudget(1000, 1_000_000));
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(txnSpy).toHaveBeenCalled();
      // The concurrent write hit the held read lock — it did not tear the
      // answer, it was refused while the transaction was open.
      expect(writeError).not.toBeNull();
      expect(String(writeError)).toMatch(/BUSY|locked|busy/i);
      expect(m.metrics_truncated).toBe(false);
      expect(m.decisions_by_check_state.unchanged).toBe(2);
    } finally {
      delete (db as unknown as Record<string, unknown>).getMetricDecisionsPage;
      db2.close();
    }

    // After the read transaction released the lock, the same write lands.
    db2IsClosedRefusedWriteLands();
  }, 30_000);

  function db2IsClosedRefusedWriteLands(): void {
    // (Reopening is unnecessary — the refused write is retried on the main
    // connection to prove it was refused, not lost.)
    const landed = db.execSqlAll(
      "SELECT 1 FROM edges WHERE from_id = 'm1' AND to_id = 'y' AND description = 'late arrival'"
    );
    expect(landed).toHaveLength(0); // refused write must NOT have landed silently
    db.insertEdgeRaw({
      from_id: "m1",
      to_id: "y",
      relation: "informed_by",
      description: "late arrival",
    });
    const landedNow = db.execSqlAll(
      "SELECT 1 FROM edges WHERE from_id = 'm1' AND to_id = 'y' AND description = 'late arrival'"
    );
    expect(landedNow).toHaveLength(1);
  }
});
