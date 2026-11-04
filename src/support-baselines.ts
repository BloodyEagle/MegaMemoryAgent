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

  /** F2: how many more pairs fit before the edge cap — page sizing. */
  get remainingEdges(): number {
    return Math.max(0, this.edgesLeft);
  }

  get remainingBytes(): number {
    return Math.max(0, this.bytesLeft);
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

/** F2: page size for the budgeted support reads — one indexed query per page,
 * the caller keeps the total within the budget. */
const SUPPORT_PAGE = 200;

/** §6: one shared edge/byte budget for every check of a single read call; the
 * check is also output-bounded: the id arrays never travel in full (plan 4 v8
 * borrows the D2.3 philosophy — counts travel, huge id lists do not). */
const VIEW_LIST_CAP = 50;

/**
 * §3/§4: compare the current state against the confirmed snapshot. Reads
 * never write (§2.2) — no lazy snapshotting.
 *
 * F2: the budget bounds the WORK, not only the verdict — supports are counted
 * before they are read, fetched in pages, and EVERY support of any state
 * (confirmed, unconfirmed, format-incompatible) passes budget.consume before
 * anything about it is materialized. When the budget runs out the verdict is
 * `incomplete` and never a clean `unchanged`/`changed` over a partial scan.
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

  const confirmedAt = node.claim_digest_at ?? null;
  const claimAnchor = node.claim_digest ?? null;

  // F2: COUNT before materializing. The old code read, copied and sorted the
  // full edge and baseline lists before ever looking at the budget — a star
  // of 20 000 supports paid for all of them even with max_check_edges = 1.
  const liveCount = db.countLiveInformedByEdges(nodeId);
  const { active: activeBaselineCount, superseded: supersededCount } =
    db.countSupportBaselines(nodeId);

  if (liveCount === 0 && activeBaselineCount === 0 && supersededCount === 0 && !claimAnchor) {
    return null; // never confirmed, nothing to compare against
  }

  const baselineAt = db.lastActiveBaselineAt(nodeId) ?? confirmedAt;

  // Sets, not arrays: a 20k-support star must not pay O(n²) membership
  // checks; the returned lists are capped after the loop.
  const unknownSet = new Set<string>();
  const changedList: SupportPairChange[] = [];
  let exhausted = false;

  // The decision's own wording: the confirmation belongs to the wording the
  // agent saw (§1.2). A rewrite of the summary does not extend it — the
  // mismatch is surfaced as claim_changed (test 10).
  // 2.1.2 F7: the summary goes through the budget TOO — hashing a 10 MB
  // wording under a 1-byte budget must not happen behind the check's back.
  // The bytes are charged via consume before hashing; when they do not fit,
  // the verdict is `incomplete`, never a clean verdict over a skipped claim.
  let claimChanged = false;
  if (claimAnchor !== null) {
    if (!budget.consume(Buffer.byteLength(node.summary, "utf8"))) {
      exhausted = true;
    } else {
      claimChanged = claimAnchor !== claimDigestOf(node.summary);
    }
  }

  // Snapshot rows within the budget's reach: when every active row can be
  // checked anyway, one bulk read beats a query per support; otherwise rows
  // are fetched per support, so an out-of-reach row is never read at all.
  const bulkRows =
    activeBaselineCount > 0 && activeBaselineCount <= budget.remainingEdges
      ? db.getActiveSupportBaselines(nodeId)
      : null;
  const bySupport = new Map<string, SupportBaselineRow[]>();
  if (bulkRows) {
    for (const row of bulkRows) {
      if (!bySupport.has(row.support_id)) bySupport.set(row.support_id, []);
      bySupport.get(row.support_id)!.push(row);
    }
  }
  const rowsFor = (supportId: string): SupportBaselineRow[] => {
    if (activeBaselineCount === 0) return [];
    if (bulkRows) return bySupport.get(supportId) ?? [];
    return db.getSupportBaselineRowsFor(nodeId, supportId);
  };

  // Live supports, in deterministic id order, in pages the budget sizes.
  // EVERY support passes through budget.consume — confirmed, unconfirmed,
  // format-incompatible alike: an unseen support must cost the budget, or a
  // tiny budget would scan an unbounded unknown tail (F2).
  // F2 (2.1.1): the page cursor is the last seen to_id (keyset), not an
  // OFFSET — a page must cost its own rows, not a re-sort of the whole star.
  let processed = 0;
  let lastToId = "";
  while (!exhausted && processed < liveCount) {
    const take = Math.max(1, Math.min(SUPPORT_PAGE, budget.remainingEdges));
    const page = db.getLiveSupportEdgesPage(nodeId, lastToId, take);
    if (page.length === 0) break;
    for (const edge of page) {
      const rows = rowsFor(edge.other_id);
      // F5: the anchor is the row written for THIS edge row (edge_key =
      // edges.id) — no fallback to "the latest row of this support". A
      // snapshot of a dead edge never validates a live one: after
      // confirm → unlink → (re)link the new pair stays unconfirmed until an
      // explicit confirm_supports.
      const anchor = rows.find((r) => r.edge_key === String(edge.id)) ?? null;
      const compatible =
        anchor !== null && anchor.format_version === BASELINE_FORMAT_VERSION;
      const support = compatible ? db.getNode(edge.other_id) : undefined;
      // Bytes are charged for what is actually read: payload texts for a
      // compatible pair, nothing for an unknown one (F2).
      const bytes = compatible
        ? Buffer.byteLength(support?.summary ?? "", "utf8") +
          Buffer.byteLength(edge.description ?? "", "utf8")
        : 0;
      if (!budget.consume(bytes)) {
        exhausted = true;
        break;
      }
      if (!compatible) {
        // Rows of an incompatible format are honest unknowns too (§7): they
        // must not turn into a mass "everything changed".
        unknownSet.add(edge.other_id);
      } else if (support) {
        const reasons: SupportChangeReason[] = [];
        if (claimDigestOf(support.summary) !== anchor.claim_digest) reasons.push("summary");
        if (statusDigestOf(support.status, support.epistemic_status) !== anchor.status_digest) {
          reasons.push("status");
        }
        if (edgeDigestOf(edge.description) !== anchor.edge_digest) reasons.push("rationale");
        if (reasons.length > 0) {
          changedList.push({ support: edge.other_id, reasons, since: anchor.confirmed_at });
        }
      } else {
        // The support node is gone while the edge lives — the pair diverged.
        changedList.push({
          support: edge.other_id,
          reasons: ["removed"],
          since: anchor.confirmed_at,
        });
      }
      processed++;
      lastToId = edge.to_id;
    }
  }
  if (processed < liveCount) exhausted = true;

  // Snapshot rows whose support is gone (removed node / tombstoned edge):
  // the row survives the deletion on purpose (§1.1) and reports "removed" —
  // that is distinct from "there were no supports" (test 5). Superseded rows
  // are history acknowledged by an explicit empty confirmation (F7) and stay
  // out of the comparison. The scan runs only when the live pass finished —
  // over a truncated live prefix a row past it would be misread as removed.
  if (!exhausted) {
    let deadProcessed = 0;
    for (;;) {
      const take = Math.max(1, Math.min(SUPPORT_PAGE, budget.remainingEdges));
      const dead = db.getDeadBaselineSupportsPage(nodeId, deadProcessed, take);
      if (dead.length === 0) break;
      let stop = false;
      for (const r of dead) {
        if (!budget.consume(0)) {
          exhausted = true;
          stop = true;
          break;
        }
        changedList.push({
          support: r.support_id,
          reasons: ["removed"],
          since: r.confirmed_at,
        });
        deadProcessed++;
      }
      if (stop || dead.length < take) break;
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
    // F7: "confirmed, then acknowledged as gone" is readable history.
    ...(supersededCount > 0 ? { had_supports: true } : {}),
  };
}

/** Total order over ids for stable capped lists. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * §2.1: confirm_supports — verify every expectation and write the snapshot
 * ATOMICALLY. F4: the whole verification runs INSIDE the same BEGIN
 * IMMEDIATE transaction that writes — an expectation checked outside would
 * leave a window where a concurrent writer moves a support and the snapshot
 * still lands on the stale version. Any divergence refuses with
 * `version_conflict`; the transaction rolls back and nothing is written.
 *
 * F3: the status axes are confirmed like every other tracked field — the
 * digest must be passed AND match. A missing `expected_status_digest`
 * refuses the whole call (chosen over "record without the status axis": a
 * silent partial confirmation would read as clean while the status drifts).
 *
 * An empty `items` list confirms "no supports" — a valid state, distinct
 * from "never checked" (test 7). F7: it does NOT delete the dead anchor rows
 * any more — it marks them superseded_at, so "confirmed and later removed"
 * stays distinguishable from "supports never existed".
 */
export function confirmSupports(
  db: KnowledgeDB,
  input: ConfirmSupportsInput
): ConfirmSupportsOutput {
  if (!Array.isArray(input.items)) {
    throw new Error("confirm_supports: items обязателен (массив, возможно пустой).");
  }

  return db.runInTransaction(() => {
    const decision = db.getNode(input.decision_id);
    if (!decision) {
      throw new Error(
        `confirm_supports: решение "${input.decision_id}" не найдено (или удалено).`
      );
    }

    const now = new Date().toISOString();
    const currentClaim = claimDigestOf(decision.summary);
    const liveEdges = liveSupportEdges(db, input.decision_id);

    const mismatches: string[] = [];
    // 2.1.2 F6: every expectation is type-checked BEFORE any comparison — a
    // missing/null/number digest must refuse via version_conflict, not crash
    // on .slice() while building the divergence message.
    if (typeof input.expected_claim_digest !== "string") {
      mismatches.push(
        `решение "${input.decision_id}": не передан expected_claim_digest (строка) — ` +
          `подтверждать можно только прочитанную формулировку (перечитай через get_concept/provenance_trace и повтори)`
      );
    } else if (input.expected_claim_digest !== currentClaim) {
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
      // 2.1.2 F6: the claim digest is type-checked like the other two axes —
      // a non-string expectation refuses the call instead of throwing.
      if (typeof item.expected_claim_digest !== "string") {
        mismatches.push(
          `опора "${supportId}": не передан expected_claim_digest (строка) — подтверждать можно ` +
            `только прочитанное саммари (перечитай опору через get_concept/provenance_trace и повтори)`
        );
      } else if (item.expected_claim_digest !== currentSupportClaim) {
        mismatches.push(
          `опора "${supportId}": саммари изменилось с момента чтения ` +
            `(ожидался ${item.expected_claim_digest.slice(0, 12)}…, текущий ${currentSupportClaim.slice(0, 12)}…)`
        );
      }
      const currentStatusDigest = statusDigestOf(support.status, support.epistemic_status);
      if (typeof item.expected_status_digest !== "string") {
        mismatches.push(
          `опора "${supportId}": не передан expected_status_digest — подтверждать можно только ` +
            `прочитанный статус (перечитай опору через get_concept/provenance_trace и повтори)`
        );
        continue;
      }
      if (item.expected_status_digest !== currentStatusDigest) {
        mismatches.push(
          `опора "${supportId}": статус изменился с момента чтения ` +
            `(ожидался ${item.expected_status_digest.slice(0, 12)}…, текущий ${currentStatusDigest.slice(0, 12)}…)`
        );
      }
      const currentEdgeDigest = edgeDigestOf(edge.description);
      if (typeof item.expected_edge_digest !== "string") {
        mismatches.push(
          `опора "${supportId}": не передан expected_edge_digest (строка) — подтверждать можно ` +
            `только прочитанный рационал (перечитай связь через get_concept/provenance_trace и повтори)`
        );
      } else if (item.expected_edge_digest !== currentEdgeDigest) {
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
          status_digest: currentStatusDigest,
          edge_digest: currentEdgeDigest,
          format_version: BASELINE_FORMAT_VERSION,
          confirmed_at: now,
          confirmed_by: "agent",
        },
      });
    }

    if (mismatches.length > 0) {
      // §2.1: nothing is written on any mismatch — the snapshot is all or
      // nothing, and the throw rolls the transaction back (F4).
      throw new Error(
        `version_conflict: confirm_supports отклонён, ничего не записано.\n` +
          mismatches.map((m) => `- ${m}`).join("\n")
      );
    }

    // Plan-4-fixes-5: the snapshot is NOT wiped on every confirmation. Dead
    // anchors (support removed since the last confirmation) keep reporting
    // "removed" until the agent explicitly confirms the empty set — the only
    // overwrite they ever get. An unrelated confirmation of live supports
    // must not amnesty them. F7: the empty confirmation MARKS the rows
    // superseded instead of deleting them — the history stays readable.
    if (input.items.length === 0) {
      db.markSupportBaselinesSuperseded(input.decision_id, now);
    }
    for (const p of planned) {
      db.upsertSupportBaseline(p.row);
    }
    db.setClaimDigest(input.decision_id, currentClaim, now);
    const accepted = db.acceptEdges(
      planned.filter((p) => p.auto).map((p) => p.edgeId),
      now
    );

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
  });
}

/**
 * §8: four different numbers — none of them measures reasoning quality by
 * itself, and none may be substituted for another in reports.
 * - created by an explicit agent call — created_via = 'agent';
 * - explicitly accepted by the agent — accepted_at IS NOT NULL;
 * - has a live support — over the graph;
 * - supports match the confirmed snapshot — over support_check.state.
 *
 * F8: the state counters cover EVERY decision with a snapshot or a claim
 * anchor, not only those with live edges — a decision whose last support was
 * unlinked used to vanish from the counts while metrics_truncated stayed
 * false. no_live_supports counts exactly those; decisions_with_live_support
 * keeps its old meaning (live informed_by edge, snapshot or not).
 */
export function provenanceMetrics(
  db: KnowledgeDB,
  budget: CheckBudget
): {
  edges_by_origin: { agent: number; auto: number; unknown: number };
  edges_accepted: number;
  decisions_with_live_support: number;
  no_live_supports: number;
  decisions_with_superseded_supports: number;
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

  const baselineClause = db.hasSupportBaselinesTable()
    ? `OR EXISTS (SELECT 1 FROM support_baselines b
                   WHERE b.decision_id = n.id AND b.superseded_at IS NULL)`
    : "";
  const decisions = db.execSqlAll(
    `SELECT n.id,
            EXISTS (SELECT 1 FROM edges e
                    WHERE e.from_id = n.id AND e.relation = 'informed_by'
                      AND e.removed_at IS NULL) AS has_live
     FROM nodes n
     WHERE n.removed_at IS NULL AND n.kind = 'decision'
       AND (n.claim_digest IS NOT NULL
         OR EXISTS (SELECT 1 FROM edges e
                    WHERE e.from_id = n.id AND e.relation = 'informed_by'
                      AND e.removed_at IS NULL)
         ${baselineClause})
     ORDER BY n.id`
  ) as Array<{ id: string; has_live: number }>;

  const byState = { unchanged: 0, changed: 0, unknown: 0, incomplete: 0 };
  let withLive = 0;
  let noLive = 0;
  let checked = 0;
  for (const { id, has_live } of decisions) {
    if (has_live) withLive += 1;
    else noLive += 1;
    const view = computeSupportCheck(db, id, budget);
    // Invariant: the SELECT above guarantees every decision carries a claim
    // anchor, a live edge or a snapshot row — exactly the inputs
    // computeSupportCheck needs to return a verdict, so it never returns null
    // here. The assertion keeps a future WHERE change from silently dropping
    // decisions from every bucket: it fails loudly instead.
    byState[view!.state] += 1;
    checked += 1;
    if (budget.exhausted) break;
  }

  const supersededDecisions = db.hasSupportBaselinesTable()
    ? (
        db.execSqlFirst(
          `SELECT COUNT(DISTINCT decision_id) AS n FROM support_baselines WHERE superseded_at IS NOT NULL`
        ) as { n: number }
      ).n
    : 0;

  return {
    edges_by_origin: origin,
    edges_accepted: edgesAccepted,
    decisions_with_live_support: withLive,
    no_live_supports: noLive,
    decisions_with_superseded_supports: Number(supersededDecisions),
    decisions_by_check_state: byState,
    // F4 (2.1.1): true only when decisions were left UNCHECKED — a budget
    // that runs out exactly on the last decision still produced a verdict
    // for every row, and calling that "truncated" was a false alarm.
    metrics_truncated: checked < decisions.length,
  };
}
