import { createHash } from "node:crypto";
import type { KnowledgeDB } from "./db.js";
import type {
  ConfirmSupportsInput,
  ConfirmSupportsOutput,
  EdgeRow,
  SupportBaselineRow,
  SupportChangeReason,
  SupportCheckView,
  SupportPairChange,
} from "./types.js";

/**
 * Plan 4 v8: a snapshot of the justification.
 *
 * What the mechanism honestly promises (plan 4 v8 §0): it shows whether the
 * props an agent EXPLICITLY CONFIRMED have changed in the tracked content
 * fields. It is not a proof of truth and not a history: a support that
 * changed and changed back shows no divergence (the detector compares the
 * current state against the confirmed snapshot, it keeps no edit journal).
 * Only the support's `summary` (plus its status axes and the edge rationale)
 * is tracked; a change of the node body that is not reflected in the summary
 * is invisible, and so is a change of an external artifact behind a file
 * reference.
 *
 * The rule everything rests on (§2): a MUTATION never confirms. Neither link,
 * nor unlink, nor update_concept, nor auto-derivation, nor remove, nor merge,
 * nor consolidate writes support_baselines rows. Confirmation is a separate
 * operation — confirm_supports — with one carve-out: create_concept with
 * evidence may confirm the very versions it passed in the same call (§2.1),
 * because the agent has just written/read them.
 */

/** Bump when the digest payload changes; old rows honestly become `unknown`. */
export const BASELINE_FORMAT_VERSION = 1;

/** §6 defaults for one check call: 5000 edges / 2 MB of payload. */
export const DEFAULT_MAX_CHECK_EDGES = 5000;
export const DEFAULT_MAX_CHECK_BYTES = 2_000_000;

/** Digest prefix — part of the hash, so a format change invalidates old rows. */
const DIGEST_VERSION = "v1";

/**
 * claim_payload (plan 4 v8 §1.4): the summary, trimmed at the edges, CRLF
 * folded to \n (different OS is not different content). NO inner
 * normalization on purpose: collapsing "a  b" to "a b" would glue two
 * different claims together — test 11.
 */
function claimPayload(summary: string): string {
  return summary.replace(/\r\n?/g, "\n").trim();
}

/** sha256("v1\n" + payload) — the version prefix is part of the digest. */
function digestOf(payload: string): string {
  return createHash("sha256").update(DIGEST_VERSION + "\n" + payload).digest("hex");
}

/** The tracked claim digest of a node (its summary). */
export function claimDigestOf(summary: string): string {
  return digestOf(claimPayload(summary));
}

/** The rationale digest of an edge (plan 4 v8 §1.4). */
export function edgeDigestOf(description: string | null | undefined): string {
  return digestOf(claimPayload(description ?? ""));
}

/**
 * The status-axes digest of a node: lifecycle status + epistemic status.
 * Plan 4 v8 §4 lists "status" among the per-support reasons and test 8
 * requires it to be reported SEPARATELY from "summary" — so it gets its own
 * digest column in the snapshot (an addition to the §1.1 sketch, needed to
 * honour the §4 contract).
 */
export function statusDigestOf(
  status: string | null | undefined,
  epistemicStatus: string | null | undefined
): string {
  return digestOf(`${status ?? "active"}\n${epistemicStatus ?? ""}`);
}

/**
 * §6: the check is bounded by EDGES and BYTES, not only nodes — a decision
 * can have tens of thousands of direct supports, and texts can be large. One
 * budget instance is shared by every check of a single read call; when it
 * runs out the verdict is `incomplete`, never `unchanged`.
 */
export class CheckBudget {
  private edgesLeft: number;
  private bytesLeft: number;
  exceeded = false;

  constructor(maxEdges: number, maxBytes: number) {
    this.edgesLeft = maxEdges;
    this.bytesLeft = maxBytes;
  }

  get exhausted(): boolean {
    return this.exceeded || this.edgesLeft <= 0 || this.bytesLeft <= 0;
  }

  /** Consume one pair; returns false (and trips the flag) when over budget. */
  consume(bytes: number): boolean {
    if (this.exhausted) return false;
    this.edgesLeft -= 1;
    this.bytesLeft -= bytes;
    if (this.edgesLeft < 0 || this.bytesLeft < 0) {
      this.exceeded = true;
      return false;
    }
    return true;
  }
}

/** Live informed_by edges of a node in ancestry direction (its supports). */
function liveSupportEdges(db: KnowledgeDB, nodeId: string): Array<EdgeRow & { other_id: string }> {
  return db.getInformedByEdges(nodeId, "ancestry", false);
}

/** §6: one shared edge/byte budget for every check of a single read call; the
 * check is also output-bounded: the id arrays never travel in full (plan 4 v8
 * borrows the D2.3 philosophy — counts travel, huge id lists do not). */
const VIEW_LIST_CAP = 50;

/**
 * §3/§4: compare the current state against the confirmed snapshot, in ONE
 * read pass. Reads never write (§2.2) — no lazy snapshotting.
 *
 * Returns null when there is nothing to check at all: no live supports, no
 * snapshot rows, no recorded confirmation. The block is absent from the
 * output in that case, so cards without provenance stay unchanged.
 */
export function computeSupportCheck(
  db: KnowledgeDB,
  nodeId: string,
  budget: CheckBudget
): SupportCheckView | null {
  const node = db.getNodeIncludingRemoved(nodeId);
  if (!node) return null;

  const baselines = db.getSupportBaselines(nodeId);
  const liveEdges = liveSupportEdges(db, nodeId);
  const confirmedAt = node.claim_digest_at ?? null;
  const claimAnchor = node.claim_digest ?? null;

  if (liveEdges.length === 0 && baselines.length === 0 && !claimAnchor) {
    return null; // never confirmed, nothing to compare against
  }

  const baselineAt = baselines.reduce<string | null>(
    (acc, r) => (acc === null || r.confirmed_at > acc ? r.confirmed_at : acc),
    confirmedAt
  );

  // Sets, not arrays: a 20k-support star must not pay O(n²) membership
  // checks; the returned lists are capped after the loop.
  const unknownSet = new Set<string>();
  const changedList: SupportPairChange[] = [];

  // The decision's own wording: the confirmation belongs to the wording the
  // agent saw (§1.2). A rewrite of the summary does not extend it — the
  // mismatch is surfaced as claim_changed (test 10).
  const claimChanged = claimAnchor !== null && claimAnchor !== claimDigestOf(node.summary);

  // Rows of an incompatible format are honest unknowns (§7): they must not
  // turn into a mass "everything changed" (baseline_incompatible).
  const bySupport = new Map<string, SupportBaselineRow[]>();
  for (const row of baselines) {
    if (!bySupport.has(row.support_id)) bySupport.set(row.support_id, []);
    bySupport.get(row.support_id)!.push(row);
  }

  let exhausted = budget.exhausted;
  const liveSupportIds = new Set<string>();

  for (const edge of liveEdges) {
    liveSupportIds.add(edge.other_id);
    if (exhausted) continue; // finish collecting support ids, check nothing
    const rows = bySupport.get(edge.other_id);
    if (!rows || rows.length === 0) {
      unknownSet.add(edge.other_id);
      continue;
    }
    // One live row per (from, to, relation) — pick the anchor matching the
    // live edge, else the latest confirmation (a carried-over snapshot can
    // hold several historical rows for one support).
    const anchor =
      rows.find((r) => r.edge_key === String(edge.id)) ??
      rows.reduce((a, b) => (a.confirmed_at >= b.confirmed_at ? a : b));
    if (anchor.format_version !== BASELINE_FORMAT_VERSION) {
      unknownSet.add(edge.other_id);
      continue;
    }
    const support = db.getNode(edge.other_id);
    const bytes =
      Buffer.byteLength(support?.summary ?? "", "utf8") +
      Buffer.byteLength(edge.description ?? "", "utf8");
    if (!budget.consume(bytes)) {
      exhausted = true;
      continue;
    }
    const reasons: SupportChangeReason[] = [];
    if (!support) {
      reasons.push("removed");
    } else {
      if (claimDigestOf(support.summary) !== anchor.claim_digest) reasons.push("summary");
      if (statusDigestOf(support.status, support.epistemic_status) !== anchor.status_digest) {
        reasons.push("status");
      }
      if (edgeDigestOf(edge.description) !== anchor.edge_digest) reasons.push("rationale");
    }
    if (reasons.length > 0) {
      changedList.push({ support: edge.other_id, reasons, since: anchor.confirmed_at });
    }
  }

  // Snapshot rows whose support is gone (removed node / tombstoned edge):
  // the row survives the deletion on purpose (§1.1) and reports "removed" —
  // that is distinct from "there were no supports" (test 5).
  for (const row of baselines) {
    if (!liveSupportIds.has(row.support_id)) {
      changedList.push({
        support: row.support_id,
        reasons: ["removed"],
        since: row.confirmed_at,
      });
    }
  }

  const state = exhausted
    ? "incomplete"
    : changedList.length > 0 || claimChanged
      ? "changed"
      : unknownSet.size > 0 || claimAnchor === null
        ? "unknown"
        : "unchanged";

  return {
    state,
    // Capped lists with honest totals — a 20k-entry array is exactly the
    // output bloat the weak-links bounds were written against.
    changed: changedList.slice(0, VIEW_LIST_CAP),
    ...(changedList.length > VIEW_LIST_CAP
      ? { changed_count: changedList.length }
      : {}),
    unknown: [...unknownSet].slice(0, VIEW_LIST_CAP).sort(compareIds),
    ...(unknownSet.size > VIEW_LIST_CAP ? { unknown_count: unknownSet.size } : {}),
    incomplete: exhausted,
    baseline_at: baselineAt,
    ...(claimChanged ? { claim_changed: true } : {}),
  };
}

/** Total order over ids for stable capped lists. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * §2.1: confirm_supports — verify every expectation and write the snapshot
 * ATOMICALLY, in one write transaction. Any divergence between the expected
 * and the current state refuses with `version_conflict` and a list of the
 * mismatched props; nothing is written. An empty `items` list confirms "no
 * supports" — a valid state, distinct from "never checked" (test 7).
 */
export function confirmSupports(
  db: KnowledgeDB,
  input: ConfirmSupportsInput
): ConfirmSupportsOutput {
  const decision = db.getNode(input.decision_id);
  if (!decision) {
    throw new Error(
      `confirm_supports: решение "${input.decision_id}" не найдено (или удалено).`
    );
  }
  if (!Array.isArray(input.items)) {
    throw new Error("confirm_supports: items обязателен (массив, возможно пустой).");
  }

  const now = new Date().toISOString();
  const currentClaim = claimDigestOf(decision.summary);
  const liveEdges = liveSupportEdges(db, input.decision_id);

  const mismatches: string[] = [];
  if (input.expected_claim_digest !== currentClaim) {
    mismatches.push(
      `решение "${input.decision_id}": формулировка изменилась с момента чтения ` +
        `(ожидался digest ${input.expected_claim_digest.slice(0, 12)}…, текущий ${currentClaim.slice(0, 12)}…)`
    );
  }

  // Deduplicate: the same support listed twice would race on the upsert.
  const seen = new Set<string>();
  const liveBySupport = new Map<string, EdgeRow & { other_id: string }>();
  for (const e of liveEdges) liveBySupport.set(e.other_id, e);

  if (input.items.length === 0 && liveEdges.length > 0) {
    mismatches.push(
      `подтверждение «опор нет» отклонено: у решения ${input.decision_id} есть ` +
        `${liveEdges.length} живых опор (${liveEdges.map((e) => e.other_id).slice(0, 5).join(", ")})`
    );
  }

  interface Planned {
    row: SupportBaselineRow;
    edgeId: number;
    auto: boolean;
  }
  const planned: Planned[] = [];

  for (const item of input.items) {
    const supportId = item.support_id;
    if (seen.has(supportId)) {
      throw new Error(`confirm_supports: опора "${supportId}" указана в items дважды.`);
    }
    seen.add(supportId);
    const edge = liveBySupport.get(supportId);
    if (!edge) {
      mismatches.push(
        `опора "${supportId}": нет живого ребра informed_by от "${input.decision_id}" — ` +
          `подтвердить пару без ребра нельзя`
      );
      continue;
    }
    const support = db.getNode(supportId);
    if (!support) {
      mismatches.push(`опора "${supportId}": узел отсутствует (или удалён)`);
      continue;
    }
    const currentSupportClaim = claimDigestOf(support.summary);
    if (item.expected_claim_digest !== currentSupportClaim) {
      mismatches.push(
        `опора "${supportId}": саммари изменилось с момента чтения ` +
          `(ожидался ${item.expected_claim_digest.slice(0, 12)}…, текущий ${currentSupportClaim.slice(0, 12)}…)`
      );
    }
    const currentEdgeDigest = edgeDigestOf(edge.description);
    if (item.expected_edge_digest !== currentEdgeDigest) {
      mismatches.push(
        `опора "${supportId}": рационал изменился с момента чтения ` +
          `(ожидался ${item.expected_edge_digest.slice(0, 12)}…, текущий ${currentEdgeDigest.slice(0, 12)}…)`
      );
    }
    planned.push({
      edgeId: edge.id,
      auto: (edge as EdgeRow).created_via === "auto",
      row: {
        decision_id: input.decision_id,
        support_id: supportId,
        edge_key: String(edge.id),
        claim_digest: currentSupportClaim,
        status_digest: statusDigestOf(support.status, support.epistemic_status),
        edge_digest: currentEdgeDigest,
        format_version: BASELINE_FORMAT_VERSION,
        confirmed_at: now,
        confirmed_by: "agent",
      },
    });
  }

  if (mismatches.length > 0) {
    // §2.1: nothing is written on any mismatch — the snapshot is all or nothing.
    throw new Error(
      `version_conflict: confirm_supports отклонён, ничего не записано.\n` +
        mismatches.map((m) => `- ${m}`).join("\n")
    );
  }

  db.runInTransaction(() => {
    // Plan-4-fixes-5: the snapshot is NOT wiped on every confirmation. Dead
    // anchors (support removed since the last confirmation) keep reporting
    // "removed" until the agent explicitly confirms the empty set — the only
    // overwrite they ever get. An unrelated confirmation of live supports
    // must not amnesty them.
    if (input.items.length === 0) db.clearSupportBaselines(input.decision_id);
    for (const p of planned) {
      db.upsertSupportBaseline(p.row);
    }
    db.setClaimDigest(input.decision_id, currentClaim, now);
    const accepted = db.acceptEdges(
      planned.filter((p) => p.auto).map((p) => p.edgeId),
      now
    );
    return accepted;
  });

  const acceptedAuto = planned.filter((p) => p.auto).length;
  return {
    decision_id: input.decision_id,
    confirmed: planned.length,
    claim_digest: currentClaim,
    baseline_at: now,
    accepted_auto_edges: acceptedAuto,
    message:
      `Снимок обоснования записан: ${planned.length} опор(ы) решения "${input.decision_id}"` +
      (input.items.length === 0 ? " (подтверждено: опор нет)" : "") +
      (acceptedAuto > 0 ? `, принято автоматических рёбер: ${acceptedAuto}` : "") +
      ".",
  };
}

/**
 * §8: four different numbers — none of them measures reasoning quality by
 * itself, and none may be substituted for another in reports.
 * - created by an explicit agent call — created_via = 'agent';
 * - explicitly accepted by the agent — accepted_at IS NOT NULL;
 * - has a live support — over the graph;
 * - supports match the confirmed snapshot — over support_check.state.
 */
export function provenanceMetrics(
  db: KnowledgeDB,
  budget: CheckBudget
): {
  edges_by_origin: { agent: number; auto: number; unknown: number };
  edges_accepted: number;
  decisions_with_live_support: number;
  decisions_by_check_state: {
    unchanged: number;
    changed: number;
    unknown: number;
    incomplete: number;
  };
  metrics_truncated: boolean;
} {
  const origin = { agent: 0, auto: 0, unknown: 0 };
  for (const r of db.execSqlAll(
    `SELECT created_via, COUNT(*) AS n FROM edges
     WHERE removed_at IS NULL GROUP BY created_via`
  ) as Array<{ created_via: string; n: number }>) {
    if (r.created_via === "agent") origin.agent = r.n;
    else if (r.created_via === "auto") origin.auto = r.n;
    else origin.unknown += r.n;
  }
  const edgesAccepted = (
    db.execSqlFirst(
      "SELECT COUNT(*) AS n FROM edges WHERE removed_at IS NULL AND accepted_at IS NOT NULL"
    ) as { n: number }
  ).n;

  const decisions = db.execSqlAll(
    `SELECT DISTINCT n.id FROM nodes n
     JOIN edges e ON e.from_id = n.id AND e.relation = 'informed_by' AND e.removed_at IS NULL
     WHERE n.removed_at IS NULL AND n.kind = 'decision'
     ORDER BY n.id`
  ) as Array<{ id: string }>;

  const byState = { unchanged: 0, changed: 0, unknown: 0, incomplete: 0 };
  for (const { id } of decisions) {
    const view = computeSupportCheck(db, id, budget);
    if (view === null) {
      byState.unknown += 1; // nothing recorded — not checked
      continue;
    }
    byState[view.state] += 1;
    if (budget.exhausted) break;
  }

  return {
    edges_by_origin: origin,
    edges_accepted: edgesAccepted,
    decisions_with_live_support: decisions.length,
    decisions_by_check_state: byState,
    metrics_truncated: budget.exhausted,
  };
}
