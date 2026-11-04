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
