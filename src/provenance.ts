import fs from "fs";
import path from "path";
import type { KnowledgeDB } from "./db.js";
import { isNodeExpired } from "./db.js";
import type { NodeRow } from "./types.js";
import type {
  ProvenanceTraceInput,
  ProvenanceTraceOutput,
  ProvenanceAuditOutput,
  ProvenanceCompleteness,
  ProvenanceNodeView,
  ProvenanceEdgeView,
  ProvenanceWeakLink,
  SupportCheckView,
  CurrentDigestsView,
  ProvenanceSupportDigest,
} from "./types.js";
import {
  CheckBudget,
  BASELINE_FORMAT_VERSION,
  DEFAULT_MAX_CHECK_BYTES,
  DEFAULT_MAX_CHECK_EDGES,
  claimDigestOf,
  computeSupportCheck,
  edgeDigestOf,
  statusDigestOf,
} from "./support-baselines.js";
import { isStubSummary } from "./stub.js";

// ---- Config flags (plan 3 §4.1.3, §11) ----

export interface ProvenanceConfig {
  /** decision without any support is refused (default false). */
  require_support: boolean;
  /**
   * auto-derive supports from why + file_refs (default FALSE, F19: edges the
   * server invents must not masquerade as agent-declared provenance — the
   * "решения с опорой" metric would otherwise measure the server, not the
   * agent; enable explicitly per database when wanted).
   */
  auto_ground: boolean;
}

const DEFAULTS: ProvenanceConfig = { require_support: false, auto_ground: false };

/**
 * Strict-mode rejection text (plan 3 step 8.2). Exact wording matters: the
 * agent reads it and must understand both the fix (evidence in the same
 * call) and the reason ("I'll add support later" is rejected on purpose).
 */
export const REQUIRE_SUPPORT_MESSAGE =
  "Узел типа decision принимается только вместе с опорой: передай evidence (файл или узел + рационал) в этом же вызове. Опора «добавлю потом» отклоняется: к следующему вызову источник вывода утерян.";

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return undefined;
}

function configFileFor(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), "megamemory.config.json");
}

/**
 * Read the provenance flags FRESH on every call (plan 3 §11: "флаг читается
 * из конфига на каждом вызове: включение меняет поведение без релиза и
 * рестарта"). Priority: env override > config file next to the db > defaults.
 * An unreadable config file falls back to defaults — a broken config must not
 * take the server down.
 */
export function readProvenanceConfig(dbPath: string): ProvenanceConfig {
  let config: ProvenanceConfig = { ...DEFAULTS };
  const file = configFileFor(dbPath);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        provenance?: Partial<ProvenanceConfig>;
      };
      if (parsed && typeof parsed === "object" && parsed.provenance) {
        if (typeof parsed.provenance.require_support === "boolean") {
          config.require_support = parsed.provenance.require_support;
        }
        if (typeof parsed.provenance.auto_ground === "boolean") {
          config.auto_ground = parsed.provenance.auto_ground;
        }
      }
    }
  } catch {
    // unreadable config -> defaults
  }
  const envRequire =
    envFlag("MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT") ??
    envFlag("MEGAMEMORY_REQUIRE_SUPPORT"); // plan 3 step 8.1 short alias
  if (envRequire !== undefined) config.require_support = envRequire;
  const envAuto = envFlag("MEGAMEMORY_PROVENANCE_AUTO_GROUND");
  if (envAuto !== undefined) config.auto_ground = envAuto;
  return config;
}

// ---- Ungrounded (plan 3 §4.1, computed — no column by design, §3) ----

function parseScope(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A node is ungrounded when nothing anchors it to a source: no live outgoing
 * informed_by, no file_refs, and no `validated` with a structural artifact in
 * status_scope. Ungrounded nodes fall out of the trust closure — quoting them
 * as proven knowledge is exactly what the weak-links block must prevent.
 */
export function isUngrounded(db: KnowledgeDB, node: NodeRow): boolean {
  return isUngroundedRow(node, db.getInformedByEdges(node.id, "ancestry", false).length > 0);
}

/**
 * Pure core of isUngrounded: the caller supplies the "has a live outgoing
 * informed_by edge" fact, so the batched support check (plan-3-fixes-3 D2.1)
 * can decide thousands of supports from ONE prefetched set instead of issuing
 * a query per node. The anchoring rules themselves are identical.
 */
export function isUngroundedRow(node: NodeRow, hasLiveOutgoingInformedBy: boolean): boolean {
  if (hasLiveOutgoingInformedBy) return false;
  try {
    const refs = node.file_refs ? (JSON.parse(node.file_refs) as unknown) : null;
    if (Array.isArray(refs) && refs.length > 0) return false;
  } catch {
    // unparseable refs anchor nothing
  }
  if (node.epistemic_status === "validated") {
    const scope = parseScope(node.status_scope);
    if (scope && scope.artifact) return false;
  }
  return true;
}

/** Normalize a file ref for comparison: backslashes -> slashes, no trailing line range. */
function normalizeRef(ref: string): string {
  return ref.replace(/\\/g, "/").replace(/:(\d+)(-\d+)?$/, "");
}

/**
 * Find a live node whose file_refs contain `ref` (plan 3 §4.1.1). The SQL
 * LIKE is a cheap prefilter (over-matching is fine — the JS pass decides);
 * deterministic order: shortest id wins so repeated calls resolve to the
 * same node.
 */
export function resolveFileRef(db: KnowledgeDB, ref: string): NodeRow | undefined {
  const rows = db.execSqlAll(
    "SELECT id FROM nodes WHERE removed_at IS NULL AND file_refs LIKE ? ORDER BY LENGTH(id), id",
    `%"${ref}"%`
  ) as Array<{ id: string }>;
  const norm = normalizeRef(ref);
  for (const { id } of rows) {
    const node = db.getNode(id);
    if (!node || !node.file_refs) continue;
    let refs: unknown;
    try {
      refs = JSON.parse(node.file_refs);
    } catch {
      continue;
    }
    if (!Array.isArray(refs)) continue;
    for (const r of refs) {
      if (typeof r !== "string") continue;
      if (r === ref || normalizeRef(r) === norm) return node;
    }
  }
  return undefined;
}

// ---- Traversal core (plan 3 §4.2, plan-3-fixes-2 contracts) ----

const DEFAULT_DEPTH = 6;
const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_SCAN_NODES = 5000;
// Function-level upper bounds (F16). The MCP tool schema keeps tighter caps
// (depth ≤ 20, max_nodes ≤ 2000) on top of these; direct callers may go
// deeper — a 3000-node chain must be traceable without a stack overflow.
const MAX_DEPTH_LIMIT = 100000;
const MAX_NODES_LIMIT = 100000;
const MAX_SCAN_NODES_LIMIT = 1000000;
// Plan 4 v8 §6: the support-baseline check budget — edges and bytes, not
// only nodes. Defaults live in support-baselines.ts (§6: 5000 / 2 MB).
const MAX_CHECK_EDGES_LIMIT = 1000000;
const MAX_CHECK_BYTES_LIMIT = 100_000_000;
const RATIONALE_TRIM = 80;
/** Cap for the path counting — capped values are flagged, not silent (F7). */
const PATH_COUNT_CAP = 100000;
// plan-3-fixes-3 D2: the support check and the weak-link text are bounded.
/** D2.3: hard cap on any weak-link note; the full id list is never returned. */
const MAX_NOTE_CHARS = 300;
/** D2.3: ids shown in a note before the "… и ещё N" tail. */
const NOTE_SAMPLE = 5;
/** D2.1: ids per batched lookup — the query count follows this, not the fan-out. */
const SUPPORT_LOOKUP_CHUNK = 500;
/** D2.4: JSON.stringify(weak_links) may never exceed this. */
const WEAK_LINKS_JSON_LIMIT = 8192;

/**
 * Total order over ids (F12): returns 0 for equal ids — the previous
 * `a < b ? -1 : 1` comparators sorted equal elements unpredictably.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function trimRationale(text: string | null): string | null {
  if (!text) return null;
  if (text.length <= RATIONALE_TRIM) return text;
  return text.slice(0, RATIONALE_TRIM - 1).trimEnd() + "…";
}

/**
 * F3: a rationale of blanks trims to "" and must surface as null — the old
 * code trimmed FIRST ("…"), so `trim().length === 0` never fired and
 * no_rationale was silently swallowed.
 */
function rationaleView(raw: string | null): string | null {
  if (!raw || raw.trim().length === 0) return null;
  return trimRationale(raw);
}

interface ValidatedLimits {
  depth: number;
  maxNodes: number;
  maxScanNodes: number;
  maxCheckEdges: number;
  maxCheckBytes: number;
}

/**
 * F16: limits are validated as integers within bounds before they reach any
 * comparison — 0, NaN and fractional values previously corrupted the walk.
 */
function validateLimits(input: ProvenanceTraceInput): ValidatedLimits {
  const check = (name: string, value: unknown, min: number, max: number): number => {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      (value as number) < min ||
      (value as number) > max
    ) {
      throw new Error(
        `provenance_trace: ${name} must be an integer in [${min}, ${max}], got ${String(value)}.`
      );
    }
    return value as number;
  };
  return {
    depth: check("depth", input.depth ?? DEFAULT_DEPTH, 0, MAX_DEPTH_LIMIT),
    maxNodes: check("max_nodes", input.max_nodes ?? DEFAULT_MAX_NODES, 1, MAX_NODES_LIMIT),
    maxScanNodes: check(
      "max_scan_nodes",
      input.max_scan_nodes ?? DEFAULT_MAX_SCAN_NODES,
      1,
      MAX_SCAN_NODES_LIMIT
    ),
    maxCheckEdges: check(
      "max_check_edges",
      input.max_check_edges ?? DEFAULT_MAX_CHECK_EDGES,
      1,
      MAX_CHECK_EDGES_LIMIT
    ),
    maxCheckBytes: check(
      "max_check_bytes",
      input.max_check_bytes ?? DEFAULT_MAX_CHECK_BYTES,
      1,
      MAX_CHECK_BYTES_LIMIT
    ),
  };
}

/**
 * Plan 4 v8 §6: one shared check budget per read call, with a per-node cache
 * — the same node's snapshot is compared once even though both the weak-links
 * block and the per-node support_check block need it.
 */
class SupportChecker {
  private cache = new Map<string, SupportCheckView | null>();

  constructor(
    private db: KnowledgeDB,
    readonly budget: CheckBudget
  ) {}

  check(nodeId: string): SupportCheckView | null {
    if (!this.cache.has(nodeId)) {
      this.cache.set(nodeId, computeSupportCheck(this.db, nodeId, this.budget));
    }
    return this.cache.get(nodeId)!;
  }
}

interface TraverseResult {
  nodes: ProvenanceNodeView[];
  edges: ProvenanceEdgeView[];
  shown: number;
  totalWithinDepth: number;
  totalExact: boolean;
  truncatedBy: "depth" | "nodes" | "scan" | null;
  /** Cyclic SCCs of the SHOWN subgraph (size > 1 or self-loop), deterministically ordered. */
  cyclicComponents: string[][];
}

/**
 * Iterative Tarjan over the shown subgraph (F1/F2: no recursion anywhere —
 * a 3000-node chain or a cycle behind the root must not touch the call
 * stack). Returns ALL components in Tarjan emission order, which is reverse
 * topological over the condensation: downstream components first.
 */
function tarjanComponents(
  nodes: Iterable<string>,
  childrenOf: (id: string) => string[]
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    index.set(start, counter);
    lowlink.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);
    const callStack: Array<{ node: string; pos: number }> = [{ node: start, pos: 0 }];
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const successors = childrenOf(frame.node);
      if (frame.pos < successors.length) {
        const next = successors[frame.pos++];
        if (!index.has(next)) {
          index.set(next, counter);
          lowlink.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          callStack.push({ node: next, pos: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(next)!));
        }
      } else {
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          lowlink.set(
            parent.node,
            Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!)
          );
        }
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
            if (w === frame.node) break;
          }
          components.push(component);
        }
      }
    }
  }
  return components;
}

/**
 * BFS over ONE relation (informed_by) in ONE direction (plan 3 §2, invariant 5:
 * a single projection per walk — supersedes/contradicts/parent_id never leak
 * in). One level-ordered pass produces BOTH the honest total and the shown
 * subgraph, so they can never disagree (F4); the same rules apply to both:
 *
 * - a removed node is TERMINAL (contract 2): counted and shown as a stub,
 *   never expanded through;
 * - the root occupies no node-budget slot (F5);
 * - admission within a level is by id over the WHOLE next frontier (F13),
 *   not per parent;
 * - an edge view is materialized only once its second end is included (F17);
 * - the scan budget (contract 5) bounds the WORK: expansion stops at
 *   max_scan_nodes fetched nodes and the closure is marked inexact.
 *
 * Everything is iterative: BFS by levels, Tarjan for SCCs, dynamic
 * programming over the condensation for path counts (F1, F2). Path counts
 * over the condensation: nodes inside a cyclic SCC get in_paths = null and a
 * weak-link record — a lying number is worse than an honest unknown.
 */
function traverse(
  db: KnowledgeDB,
  rootId: string,
  direction: "ancestry" | "impact",
  limits: ValidatedLimits,
  retrospective: boolean
): TraverseResult {
  const { depth: depthLimit, maxNodes, maxScanNodes } = limits;
  const fetch = (id: string) =>
    db.getInformedByEdges(id, direction, retrospective).map((e) => ({
      other_id: e.other_id,
      description: e.description,
      removed_at: e.removed_at ?? null,
    }));

  let truncatedBy: "depth" | "nodes" | "scan" | null = null;
  let totalExact = true;

  const nodeById = new Map<string, ProvenanceNodeView>();
  const rootNode = db.getNodeIncludingRemoved(rootId)!;
  const rootRemoved = !rootNode || rootNode.removed_at !== null;
  nodeById.set(rootId, {
    id: rootId,
    // F15: the removed root obeys the same contract as any removed node.
    name: rootRemoved ? null : rootNode!.name,
    kind: rootRemoved ? null : rootNode!.kind,
    status: rootRemoved ? null : rootNode!.status ?? null,
    epistemic_status: rootRemoved ? null : rootNode!.epistemic_status ?? null,
    depth: 0,
    in_paths: 1,
    // 2.1.12 F1: просроченный корень не прячется — обход честно идёт, но
    // пометка говорит «читай как историю, не как факт».
    ...(!rootRemoved && isNodeExpired(rootNode!) ? { expired: true } : {}),
    ...(rootRemoved ? { removed: true } : {}),
  });

  const seen = new Set<string>([rootId]);
  const edgeViews: ProvenanceEdgeView[] = [];
  const emittedEdgeKeys = new Set<string>(); // JSON keys — pipe-safe (F11)
  let total = 1;
  // 2.1.2 F3: a removed root is terminal (contract 2) — the stub is shown,
  // its historical edges are not expanded, so the frontier starts empty.
  let frontier: string[] = rootRemoved ? [] : [rootId];
  let depth = 0;

  while (frontier.length > 0) {
    const candidates: string[] = [];
    const levelRows: Array<{
      parent: string;
      other: string;
      description: string | null;
      removedEdge: boolean;
    }> = [];
    let scanCut = false;

    // Discovery: expand the frontier while the scan budget lasts (contract 5
    // bounds the WORK — the budget counts DISCOVERED nodes, so a wide root
    // cannot pull in an unbounded closure in one fetch; F17 — edges are
    // fetched only for nodes actually being expanded).
    for (const id of frontier) {
      if (seen.size >= maxScanNodes) {
        scanCut = true;
        break;
      }
      for (const r of fetch(id)) {
        levelRows.push({
          parent: id,
          other: r.other_id,
          description: r.description,
          removedEdge: r.removed_at !== null,
        });
        if (seen.has(r.other_id)) continue;
        if (seen.size >= maxScanNodes) {
          scanCut = true;
          break;
        }
        seen.add(r.other_id);
        if (depth + 1 > depthLimit) {
          truncatedBy = truncatedBy ?? "depth";
          continue; // beyond the depth contract — not counted in total
        }
        total++;
        candidates.push(r.other_id);
      }
      if (scanCut) break;
    }
    if (scanCut) {
      truncatedBy = truncatedBy ?? "scan";
      totalExact = false;
    }

    // Admission: the whole next level competes for the remaining slots,
    // ordered by (depth, id) — not each parent's private slice (F13).
    candidates.sort(compareIds);
    let budget = maxNodes - (nodeById.size - 1); // root occupies no slot (F5)
    const nextFrontier: string[] = [];
    for (const cand of candidates) {
      if (budget <= 0) {
        truncatedBy = truncatedBy ?? "nodes";
        // 2.1.2 F5: a node dropped by the node budget is never expanded, so
        // its descendants never enter the count — total_within_depth is a
        // lower estimate, and claiming exactness would be a lie.
        totalExact = false;
        continue;
      }
      const other = db.getNodeIncludingRemoved(cand);
      const isRemoved = !other || other.removed_at !== null;
      nodeById.set(cand, {
        id: cand,
        name: isRemoved ? null : other!.name,
        kind: isRemoved ? null : other!.kind,
        status: isRemoved ? null : other!.status ?? null,
        epistemic_status: isRemoved ? null : other!.epistemic_status ?? null,
        depth: depth + 1,
        in_paths: null,
        // 2.1.12 F1: просроченный предшественник НЕ обрывает цепочку —
        // обход, счёт путей и раскрытие продолжаются, но expired: true
        // отделяет «это было верно тогда» от «это верно сейчас».
        ...(!isRemoved && isNodeExpired(other!) ? { expired: true } : {}),
        ...(isRemoved ? { removed: true } : {}),
      });
      budget--;
      if (!isRemoved) nextFrontier.push(cand); // removed nodes are terminal (contract 2)
    }

    // Edge materialization: only rows whose second end is included (F17);
    // a blank rationale surfaces as null (F3).
    for (const row of levelRows) {
      if (!nodeById.has(row.other)) continue;
      const key = JSON.stringify([row.parent, row.other]);
      if (emittedEdgeKeys.has(key)) continue;
      emittedEdgeKeys.add(key);
      edgeViews.push({
        from: direction === "ancestry" ? row.parent : row.other,
        to: direction === "ancestry" ? row.other : row.parent,
        rationale: rationaleView(row.description),
        ...(row.removedEdge ? { removed: true } : {}),
      });
    }

    if (scanCut) break;
    frontier = nextFrontier;
    depth++;
  }

  // Path counts over the SHOWN subgraph (contract 4). Orient parent→child
  // (the side closer to the root is the parent), decompose into SCCs
  // iteratively, then run the DP in topological order of the condensation.
  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const e of edgeViews) {
    const parent = direction === "ancestry" ? e.from : e.to;
    const child = direction === "ancestry" ? e.to : e.from;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(child);
    if (!parentsOf.has(child)) parentsOf.set(child, []);
    parentsOf.get(child)!.push(parent);
  }

  const components = tarjanComponents(nodeById.keys(), (id) => childrenOf.get(id) ?? []);
  const cyclicOfComp = components.map(
    (c) => c.length > 1 || (childrenOf.get(c[0]) ?? []).includes(c[0])
  );

  const count = new Map<string, number | null>();
  const capped = new Set<string>();
  count.set(rootId, 1); // the trivial path — even when the root sits in a cycle
  // Tarjan emits downstream components first, so the reverse order is
  // topological: every parent is finalized before its child.
  for (let i = components.length - 1; i >= 0; i--) {
    for (const n of components[i]) {
      if (count.has(n)) continue;
      if (cyclicOfComp[i]) {
        count.set(n, null); // path crosses an unresolved SCC — honest unknown (F1)
        continue;
      }
      let sum = 0;
      let unknown = false;
      let capHit = false;
      for (const p of parentsOf.get(n) ?? []) {
        const c = count.get(p);
        if (c === undefined || c === null) {
          unknown = true;
          break;
        }
        sum += c;
        // 2.1.2 F13: a parent already sitting on the cap passes its clamped
        // number downstream — the child inherits the flag, or the clamped
        // value would read as an exact count.
        if (capped.has(p)) capHit = true;
        if (sum > PATH_COUNT_CAP) {
          sum = PATH_COUNT_CAP;
          capHit = true;
          break;
        }
      }
      count.set(n, unknown ? null : sum);
      if (capHit) capped.add(n); // F7: the cap is flagged, not silent
    }
  }
  for (const [id, view] of nodeById) {
    if (id === rootId) continue;
    view.in_paths = count.get(id) ?? null;
    if (capped.has(id)) view.in_paths_capped = true;
  }

  const cyclicComponents = components
    .filter((_, i) => cyclicOfComp[i])
    .map((c) => [...c].sort(compareIds))
    .sort((a, b) => compareIds(a[0], b[0]));

  const nodes = [...nodeById.values()].sort(
    (a, b) => a.depth - b.depth || compareIds(a.id, b.id)
  );

  return {
    nodes,
    edges: edgeViews,
    shown: nodes.length,
    totalWithinDepth: total,
    totalExact,
    truncatedBy,
    cyclicComponents,
  };
}

// ---- Batched support check and bounded weak-link text (plan-3-fixes-3 D2) ----

/**
 * D2.1: live nodes for a batch of ids, in chunks of SUPPORT_LOOKUP_CHUNK —
 * the query count follows the chunk size, never the number of supports.
 */
function fetchNodesByIds(db: KnowledgeDB, ids: string[]): Map<string, NodeRow> {
  const out = new Map<string, NodeRow>();
  for (let i = 0; i < ids.length; i += SUPPORT_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + SUPPORT_LOOKUP_CHUNK);
    const rows = db.execSqlAll(
      `SELECT * FROM nodes WHERE removed_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`,
      ...chunk
    ) as NodeRow[];
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

/** D2.1: which of `ids` have at least one LIVE outgoing informed_by edge. */
function fetchLiveInformedBySources(db: KnowledgeDB, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += SUPPORT_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + SUPPORT_LOOKUP_CHUNK);
    const rows = db.execSqlAll(
      `SELECT DISTINCT from_id FROM edges
       WHERE relation = 'informed_by' AND removed_at IS NULL
         AND from_id IN (${chunk.map(() => "?").join(",")})`,
      ...chunk
    ) as Array<{ from_id: string }>;
    for (const r of rows) out.add(r.from_id);
  }
  return out;
}

/**
 * D2.3: the id list inside a note — `2: a, b` when short, otherwise
 * `20000, первые: a1, …, a5 … и ещё 19995`. The count and the "… и ещё N"
 * tail win over the sample: with pathological id lengths the sample shrinks
 * (5 → 4 → …) so the numbers always survive within MAX_NOTE_CHARS. The full
 * list is never returned.
 */
function idListForNote(ids: string[]): string {
  if (ids.length === 0) return "0";
  if (ids.length <= NOTE_SAMPLE) return `${ids.length}: ${ids.join(", ")}`;
  const head = `${ids.length}, первые: `;
  const tail = ` … и ещё ${ids.length - NOTE_SAMPLE}`;
  for (let take = NOTE_SAMPLE; take >= 1; take--) {
    const body = ids.slice(0, take).join(", ");
    if (head.length + body.length + tail.length <= MAX_NOTE_CHARS) {
      return head + body + tail;
    }
  }
  // Even a single id overflows the cap — cut the id text, keep the tail.
  const room = Math.max(0, MAX_NOTE_CHARS - head.length - tail.length - 1);
  return head + ids[0].slice(0, room) + "…" + tail;
}

/** D2.3: hard guarantee — no record's note exceeds MAX_NOTE_CHARS. */
function clampNote(note: string): string {
  return note.length <= MAX_NOTE_CHARS ? note : note.slice(0, MAX_NOTE_CHARS - 1).trimEnd() + "…";
}

/** Serialized size of the array without building intermediate strings twice. */
function weakLinksJsonSize(list: ProvenanceWeakLink[]): number {
  let size = 2; // "[]"
  for (let i = 0; i < list.length; i++) {
    if (i > 0) size += 1; // comma
    size += JSON.stringify(list[i]).length;
  }
  return size;
}

/** D2.4 keep order: antiknowledge first, service records last. Plan 4 v8 §4
 * puts the support-baseline verdicts right after the cycles: a decision whose
 * confirmed snapshot no longer matches is as dangerous as a cycle. */
const WEAK_LINK_PRIORITY: Record<ProvenanceWeakLink["type"], number> = {
  refuted: 0,
  abandoned: 1,
  // 2.1.12 F1: срок годности вышел — тот же класс опасности «читать нельзя,
  // история видна», что у abandoned.
  expired: 2,
  cycle: 3,
  support_changed: 4,
  // 2.1.3 F2: the source moved while the summary may be untouched — the same
  // danger class as a snapshot divergence, right after it.
  artifact_changed: 5,
  support_unreviewed: 6,
  missing_support: 7,
  no_support: 8,
  ungrounded_support: 9,
  // 2.1.9 F2: stub supports — same danger class as ungrounded ones.
  stub_support: 10,
  no_rationale: 11,
  support_check_truncated: 12,
  weak_links_truncated: 13,
};

/**
 * D2.4: when the serialized weak_links exceed 8 KB, keep records by priority
 * (ties keep construction order — the sort is stable), then append ONE
 * weak_links_truncated marker with shown/total. Dropping warnings silently is
 * not allowed; a record that does not fit is skipped, shorter ones after it
 * may still make the cut. Plan 4 v8 §4: the priority orders the cut, it does
 * not suppress — the marker also carries the per-reason counts over ALL
 * produced records, so a cut never hides how many of each kind existed.
 */
function capWeakLinks(weak: ProvenanceWeakLink[]): ProvenanceWeakLink[] {
  if (weakLinksJsonSize(weak) <= WEAK_LINKS_JSON_LIMIT) return weak;
  const reasonCounts: Record<string, number> = {};
  for (const w of weak) {
    reasonCounts[w.type] = (reasonCounts[w.type] ?? 0) + 1;
  }
  const markerFor = (shown: number): ProvenanceWeakLink => ({
    type: "weak_links_truncated",
    shown,
    total: weak.length,
    reason_counts: reasonCounts,
  });
  const byPriority = weak
    .map((w, i) => ({ w, i }))
    .sort(
      (a, b) => WEAK_LINK_PRIORITY[a.w.type] - WEAK_LINK_PRIORITY[b.w.type] || a.i - b.i
    )
    .map(({ w }) => w);
  const kept: ProvenanceWeakLink[] = [];
  for (const w of byPriority) {
    // +2 slack covers the marker's own growth as `shown` gains a digit.
    if (weakLinksJsonSize([...kept, w, markerFor(kept.length + 1)]) > WEAK_LINKS_JSON_LIMIT + 2) {
      continue;
    }
    kept.push(w);
  }
  return kept.length === weak.length ? kept : [...kept, markerFor(kept.length)];
}

function weakLinks(
  db: KnowledgeDB,
  result: TraverseResult,
  direction: "ancestry" | "impact",
  retrospective: boolean,
  maxScanSupports: number,
  checker: SupportChecker,
  rootId: string
): ProvenanceWeakLink[] {
  const weak: ProvenanceWeakLink[] = [];

  // 1. refuted / abandoned inside the closure — antiknowledge on the path.
  for (const n of result.nodes) {
    if (n.epistemic_status === "refuted") {
      weak.push({
        type: "refuted",
        id: n.id,
        note: clampNote(`узел "${n.id}" опровергнут — не использовать как факт`),
      });
    } else if (n.epistemic_status === "abandoned") {
      weak.push({
        type: "abandoned",
        id: n.id,
        note: clampNote(`узел "${n.id}" заброшен — вывод может устареть`),
      });
    } else if (n.expired) {
      // 2.1.12 F1: просроченный факт — верно на дату записи, срок вышел.
      weak.push({
        type: "expired",
        id: n.id,
        note: clampNote(
          `узел "${n.id}" просрочен (valid_until в прошлом) — утверждение могло перестать быть верным`
        ),
      });
    }
  }

  // 2. unresolved cycles — ONE record per cyclic component (F10), with the
  // component id, a witness edge and the needs_merge edges; the component is
  // closed for new informed_by writes until the conflict is resolved. Path
  // counts through it are null (contract 4), never a lying number.
  for (let i = 0; i < result.cyclicComponents.length; i++) {
    const comp = result.cyclicComponents[i];
    const componentId = `scc:${i + 1}`;
    const members = new Set(comp);
    const witness = result.edges.find((e) => members.has(e.from) && members.has(e.to));
    const needsMerge = db
      .execSqlAll(
        `SELECT from_id, to_id FROM edges
         WHERE relation = 'informed_by' AND removed_at IS NULL AND needs_merge = 1
           AND (from_id IN (${comp.map(() => "?").join(",")})
             OR to_id IN (${comp.map(() => "?").join(",")}))
         ORDER BY from_id, to_id`,
        ...comp,
        ...comp
      )
      .map((r) => `${(r as { from_id: string }).from_id} -> ${(r as { to_id: string }).to_id}`);
    const parts = [
      // D2.3: a huge SCC used to inline every member id into the note.
      `цикл informed_by: ${idListForNote(comp)}`,
      witness ? `свидетель ${witness.from} -> ${witness.to}` : null,
      needsMerge.length > 0 ? `needs_merge: ${needsMerge.join(", ")}` : null,
      "компонента закрыта для записи (needs_merge)",
    ].filter(Boolean);
    weak.push({
      type: "cycle",
      id: componentId,
      note: clampNote(`${parts.join("; ")}`),
    });
  }

  // 3. edges without a rationale (legacy rows can predate the check). F3: a
  // blank original already surfaces as null — trimming no longer hides it.
  for (const e of result.edges) {
    if (!e.rationale) {
      weak.push({
        type: "no_rationale",
        from: e.from,
        to: e.to,
        note: clampNote(`ребро ${e.from} -> ${e.to} без рационала — связь нечитаема`),
      });
    }
  }

  // 4. decisions without honest support — in BOTH directions: an impact walk
  // must not skip the fact that an affected decision stands on sand (its
  // supports are always read over ancestry edges of that node). F8: the
  // checked edge set follows the OUTPUT mode — retrospective checks the same
  // tombstone-carrying set that is shown, live mode checks only live edges,
  // never a mixture. F9: no supports at all is the most important case and
  // gets its own type; a missing support node is distinct from an ungrounded
  // one.
  //
  // plan-3-fixes-3 D2.1/D2.2: the supports are verified in BATCHES (one
  // chunked lookup for the support nodes, one for their live outgoing
  // informed_by edges) instead of two queries per support, and the check is
  // bounded by the scan budget: at most maxScanSupports supports are verified
  // per walk — first by id, honestly reported via support_check_truncated.
  // The warning semantics within the verified prefix are unchanged: still
  // every direct support of the decision, not just the shown subgraph.
  let supportBudget = maxScanSupports;
  for (const n of result.nodes) {
    // 2.1.10 F3: every knowledge carrier with supports is checked, not only
    // decisions — a stub under a pattern must speak too. The decision-only
    // branches stay decision-only: no_support is a decision obligation, and
    // the support-baseline check states (changed/unknown/incomplete) live on
    // decisions (inner nodes keep their own 4b record below).
    if (n.removed) continue;
    const isDecision = n.kind === "decision";
    const subject = isDecision ? "решение" : "узел";
    const supports = db
      .getInformedByEdges(n.id, "ancestry", retrospective)
      .map((e) => e.other_id)
      .sort(compareIds); // deterministic pick when the budget cuts the list
    if (supports.length === 0) {
      if (!isDecision) continue; // нет опор — не о чём говорить
      // Plan 4 v8 §2.1: an explicit "confirmed: no supports" snapshot is a
      // valid state — the warning fires only when the decision was never
      // confirmed as supportless. F6: a recorded snapshot with no live
      // edges ("confirmed, then unlinked") still checks — the dead anchors
      // must speak as support_changed/removed, not vanish into this branch.
      const decision = db.getNode(n.id);
      if (!decision?.claim_digest) {
        weak.push({
          type: "no_support",
          id: n.id,
          note: clampNote(`решение "${n.id}" не имеет ни одной опоры`),
        });
        continue;
      }
    }
    // Plan 4 v8 §3/§4: `unknown` and `incomplete` are not cleanliness — the
    // verdict of the support-baseline check travels as a weak link too, so
    // an unreviewed decision is never silently treated as verified.
    const check = isDecision ? checker.check(n.id) : null;
    if (check && check.state === "changed") {
      const changed = check.changed ?? [];
      const changedTotal = check.changed_count ?? changed.length;
      // 2.1.3 F2: artifact-only pairs must not inflate the support_changed
      // record — the divergence of an external artifact is its own type.
      // artifact_changed_count is the honest full-set total of artifact
      // pairs (the changed list is capped), so the reason-pair total is the
      // difference; both counters travel on the view.
      const artifactTotal = check.artifact_changed_count ?? 0;
      const reasonPairs = changed.filter((c) => c.reasons.length > 0);
      const reasonTotal = Math.max(0, changedTotal - artifactTotal);
      const reasonCounts: Record<string, number> = {};
      for (const c of reasonPairs) {
        for (const r of c.reasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
      }
      if (check.claim_changed) reasonCounts["claim"] = (reasonCounts["claim"] ?? 0) + 1;
      const detail = reasonPairs
        .slice(0, NOTE_SAMPLE)
        .map((c) => `${c.support}(${c.reasons.join("+")})`)
        .join(", ");
      const tail =
        reasonTotal > reasonPairs.length
          ? ""
          : reasonTotal > NOTE_SAMPLE
            ? ` … и ещё ${reasonTotal - NOTE_SAMPLE}`
            : "";
      if (reasonTotal > 0 || check.claim_changed) {
        weak.push({
          type: "support_changed",
          id: n.id,
          count: reasonTotal,
          sample: reasonPairs.slice(0, NOTE_SAMPLE).map((c) => c.support),
          note: clampNote(
            `опоры решения "${n.id}" разошлись с подтверждённым снимком (${reasonTotal}` +
              `${Object.keys(reasonCounts).length > 0 ? `: ${Object.entries(reasonCounts).map(([r, c]) => `${r} ${c}`).join(", ")}` : ""})` +
              `${detail ? `: ${detail}` : ""}${tail}; baseline ${check.baseline_at ?? "—"}`
          ),
        });
      }
      // The artifact divergence speaks for itself: path + both digest
      // previews («было → стало»), one record per decision.
      const artifactPairs = changed.filter((c) => c.artifact_changed);
      if (artifactPairs.length > 0) {
        const first = artifactPairs[0];
        const artifact = first.artifacts?.[0];
        const previewText = artifact
          ? `: ${artifact.ref} (${artifact.prev_digest ?? "—"} → ${artifact.digest ?? "—"}, замечено ${artifact.changed_at})`
          : "";
        weak.push({
          type: "artifact_changed",
          id: n.id,
          count: artifactTotal,
          sample: artifactPairs.slice(0, NOTE_SAMPLE).map((c) => c.support),
          note: clampNote(
            `артефакты опор решения "${n.id}" разошлись с подтверждённым снимком (${artifactTotal}` +
              `${previewText ? `, пример — опора ${first.support}${previewText}` : ""})`
          ),
        });
      }
    } else if (check && check.state === "unknown") {
      weak.push({
        type: "support_unreviewed",
        id: n.id,
        count: check.unknown_count ?? check.unknown?.length ?? 0,
        note: clampNote(
          `решение "${n.id}" не подтверждено снимком (support_check: unknown` +
            `${check.unknown_count ?? check.unknown?.length ? `, не покрыто опор: ${check.unknown_count ?? check.unknown?.length}` : ""}) — ` +
            `проверка не считается чистотой, вызови confirm_supports после сверки`
        ),
      });
    } else if (check && check.state === "incomplete") {
      weak.push({
        type: "support_unreviewed",
        id: n.id,
        count: check.unknown_count ?? check.unknown?.length ?? 0,
        note: clampNote(
          `проверка опор решения "${n.id}" оборвана бюджетом (support_check: incomplete) — ` +
            `вердикт «не изменилось» не выдаётся, увеличь max_check_edges/max_check_bytes`
        ),
      });
    }
    const checkedCount = Math.min(supports.length, supportBudget);
    supportBudget -= checkedCount;
    const checked = supports.slice(0, checkedCount);
    if (checkedCount < supports.length) {
      weak.push({
        type: "support_check_truncated",
        id: n.id,
        checked: checkedCount,
        total: supports.length,
        note: clampNote(
          `проверено ${checkedCount} из ${supports.length} опор решения "${n.id}" — бюджет сканирования`
        ),
      });
    }
    if (checked.length === 0) continue;
    const nodeRows = fetchNodesByIds(db, checked);
    const groundedSources = fetchLiveInformedBySources(db, checked);
    const missing: string[] = [];
    const ungrounded: string[] = [];
    for (const sid of checked) {
      const row = nodeRows.get(sid);
      if (!row) missing.push(sid);
      else if (isUngroundedRow(row, groundedSources.has(sid))) ungrounded.push(sid);
    }
    if (missing.length + ungrounded.length === checked.length) {
      if (missing.length > 0) {
        weak.push({
          type: "missing_support",
          id: n.id,
          count: missing.length,
          sample: missing.slice(0, NOTE_SAMPLE),
          note: clampNote(
            `${subject} "${n.id}" ссылается на отсутствующие узлы (${idListForNote(missing)})`
          ),
        });
      }
      if (ungrounded.length > 0) {
        weak.push({
          type: "ungrounded_support",
          id: n.id,
          count: ungrounded.length,
          sample: ungrounded.slice(0, NOTE_SAMPLE),
          note: clampNote(
            `${subject} "${n.id}" опирается только на ungrounded-узлы (${idListForNote(ungrounded)})`
          ),
        });
      }
    }
    // 2.1.9 F2: stub supports — узлы с шаблонным или слишком коротким
    // саммари. Уже записанные заглушки не удаляются, но не должны читаться
    // как подтверждение: одна запись на решение, count/sample как у
    // missing_support, срабатывает при хотя бы одной заглушке среди
    // проверенных опор. 2.1.10 F1: только ручные узлы (created_via='agent') —
    // якорь file_ref обязан выглядеть шаблонно и заглушкой не считается.
    const stubs = checked.filter((sid) => {
      const row = nodeRows.get(sid);
      return (
        row !== undefined &&
        isStubSummary(row.summary, row.kind, row.created_via)
      );
    });
    if (stubs.length > 0) {
      weak.push({
        type: "stub_support",
        id: n.id,
        count: stubs.length,
        sample: stubs.slice(0, NOTE_SAMPLE),
        note: clampNote(
          `${subject} "${n.id}" опирается на заглушки без утверждения (${idListForNote(stubs)}) — замени ref'ом или настоящим саммари, либо подтверди осознанно`
        ),
      });
    }
  }

  // 4b. 2.1.2 F4: an unreviewed support of an INNER non-decision node used
  // to vanish from the answer — the checks above are decision-scoped and the
  // inner support_check travels only for state = changed. A fact standing on
  // an unconfirmed support must speak: unknown at any node with informed_by
  // becomes a support_unreviewed record (the checker caches, so this adds no
  // budget spend beyond the per-node check the caller makes anyway).
  for (const n of result.nodes) {
    if (n.id === rootId || n.removed || n.kind === "decision") continue;
    const check = checker.check(n.id);
    if (check && check.state === "unknown") {
      weak.push({
        type: "support_unreviewed",
        id: n.id,
        count: check.unknown_count ?? check.unknown?.length ?? 0,
        note: clampNote(
          `опоры узла "${n.id}" не подтверждены снимком (support_check: unknown) — ` +
            `проверка не считается чистотой, вызови confirm_supports после сверки`
        ),
      });
    }
  }

  // D2.4: the serialized weak_links must fit the 8 KB response cap.
  return capWeakLinks(weak);
}

/** Total order over support ids for the deterministic supports[] list (2.1.7 F1). */
function compareSupportIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 2.1.7 F1: the supports[] cap — a 20k-support star must not blow up the
 * trace response; the honest total travels in supports_count, same
 * philosophy as the capped support_check lists.
 */
const SUPPORT_DIGESTS_CAP = 50;

function rootHeader(db: KnowledgeDB, rootId: string): ProvenanceTraceOutput["root"] {
  const node = db.getNodeIncludingRemoved(rootId);
  if (!node) {
    throw new Error(`Concept "${rootId}" not found.`);
  }
  const removed = node.removed_at !== null;
  return {
    id: node.id,
    // F15: one contract for the root and every other node — a removed node's
    // attributes are hidden, and status is never invented as "active".
    name: removed ? null : node.name,
    kind: removed ? null : node.kind,
    status: removed ? null : node.status ?? null,
    epistemic_status: removed ? null : node.epistemic_status ?? null,
    ...(removed ? { removed: true } : {}),
  };
}

function completenessVerdict(
  db: KnowledgeDB,
  rootId: string,
  result: TraverseResult
): ProvenanceCompleteness {
  if (result.truncatedBy !== null) return "truncated";
  const rootLiveEdges = result.edges.filter(
    (e) => !e.removed && (e.from === rootId || e.to === rootId)
  );
  if (rootLiveEdges.length === 0) {
    // Any record at all — even a tombstone — makes `complete` unreachable
    // (plan 3 §4.2: "«связей нет» не имеет права врать").
    return db.hasAnyInformedByRecord(rootId) ? "has_hidden" : "complete";
  }
  return "complete";
}

/**
 * provenance_trace (plan 3 §4.2): "на чём стоит этот вывод" (ancestry) or
 * "кто на него опирается" (impact). Weak links first; node bodies, dates,
 * authors and histories deliberately do not travel — the answer must stay
 * within a few hundred tokens.
 *
 * Contracts (plan-3-fixes-2 §1, binding for code and tool description):
 *
 * 1. Which graph: informed_by only, live edges only (retrospective also
 *    follows tombstones); the whole answer is read in ONE transaction, so
 *    подсчёт, выдача, атрибуты и слабые звенья снимают один и тот же снимок.
 * 2. A removed node is terminal: the walk never goes through it — not when
 *    counting, not when emitting. In retrospective it is shown as a stub,
 *    but is not expanded.
 * 3. The total counts nodes within the depth limit and is called
 *    total_within_depth; the reason anything is missing travels in
 *    truncated_by: "depth" | "nodes" | "scan" | null.
 * 4. in_paths is the number of root→node paths in the SHOWN subgraph — not a
 *    confirmation count. At PATH_COUNT_CAP it is flagged in_paths_capped and
 *    any textual rendering must show "≥ 100000". A path that crosses an
 *    unresolved SCC yields in_paths = null plus a cycle weak-link with the
 *    component id — never a made-up number.
 * 5. Limits bound both the OUTPUT and the WORK: besides depth and max_nodes
 *    there is a scan budget max_scan_nodes (default 5000); when it trips,
 *    truncated_by = "scan" and total_within_depth is a lower estimate with
 *    total_exact: false. The same budget also bounds the support check of
 *    block 4 (plan-3-fixes-3 D2.2): at most max_scan_nodes supports are
 *    verified, first by id — a support_check_truncated record reports
 *    checked/total instead of silently skipping the rest.
 * 6. The weak_links payload is bounded (plan-3-fixes-3 D2.3/D2.4): no note
 *    exceeds 300 chars (long id lists become "count + первые 5 … и ещё N",
 *    with numeric count/sample fields), and the serialized weak_links array
 *    never exceeds 8 KB — when it would, records are kept by priority
 *    (plan 4 v8 §4: refuted → abandoned → cycle → support_changed →
 *    support_unreviewed → missing_support → no_support → ungrounded_support →
 *    no_rationale → markers) and one weak_links_truncated marker reports
 *    shown/total plus the per-reason counts over all produced records.
 * 7. Plan 4 v8: the root carries a support_check block (any state) whenever
 *    there is anything to check; inner nodes carry theirs when the state is
 *    `changed` (§5). `unknown`/`incomplete` are not cleanliness; the check is
 *    bounded by max_check_edges/max_check_bytes (§6) and READS NEVER WRITE a
 *    snapshot (§2.2) — confirmation is confirm_supports' job only.
 */
export function provenanceTrace(
  db: KnowledgeDB,
  input: ProvenanceTraceInput
): ProvenanceTraceOutput {
  const direction = input.direction ?? "ancestry";
  const retrospective = input.retrospective ?? false;
  const limits = validateLimits(input); // F16: integer, in bounds — before any comparison

  // F14: one reading transaction for подсчёт, выдачу, атрибуты и weak_links —
  // a concurrent write can no longer split the answer into different graphs
  // (shown > total was possible).
  return db.runInTransaction(() => {
    const root = rootHeader(db, input.node_id); // not-found throws here
    const result = traverse(db, input.node_id, direction, limits, retrospective);
    // Plan 4 v8 §6: one shared edge/byte budget for every support check of
    // this call; §2.2 — reads only compare, they never write a snapshot.
    const checker = new SupportChecker(
      db,
      new CheckBudget(limits.maxCheckEdges, limits.maxCheckBytes)
    );
    const weak = weakLinks(
      db,
      result,
      direction,
      retrospective,
      limits.maxScanNodes,
      checker,
      input.node_id
    );

    // Plan 4 v8 §4: the root's support check travels with the verdict —
    // present whenever there is anything to check (any state).
    const rootCheck = checker.check(input.node_id);

    // Plan 4 v8 §5: the check runs at every level — a fact can have its own
    // justification. A local divergence travels together with the dependency
    // path (state = changed only: clean and unreviewed nodes keep the answer
    // small; the root above carries its verdict whatever it is).
    let innerIncomplete = 0;
    for (const n of result.nodes) {
      if (n.id === input.node_id || n.removed) continue;
      const view = checker.check(n.id);
      // F11: a budget-cut inner check is a signal, not silence — it is
      // counted on the output and degrades completeness below.
      if (view && view.state === "incomplete") innerIncomplete += 1;
      if (view && view.state === "changed") n.support_check = view;
    }

    // 2.1.7 F1: the digests the agent can pass straight into confirm_supports.
    // For the root itself — the same block get_concept carries (null for a
    // removed root: a tombstone exposes no digests); for every live support —
    // the FULL claim/status/edge digests, not the 12-char previews
    // provenance_history keeps. Computed with the shared exports, never
    // re-hashed; a missing support node yields null digests — the pair is
    // reported `removed` in support_check, there is nothing to hash.
    const rootNode = db.getNodeIncludingRemoved(input.node_id);
    const removedRoot = rootNode === undefined || rootNode.removed_at !== null;
    const currentDigests: CurrentDigestsView | null =
      removedRoot || rootNode === undefined
        ? null
        : {
            claim: rootNode.claim_digest ?? claimDigestOf(rootNode.summary),
            status: statusDigestOf(rootNode.status, rootNode.epistemic_status),
            format_version: BASELINE_FORMAT_VERSION,
            source: rootNode.claim_digest !== null ? "snapshot" : "computed",
          };
    const liveEdges = removedRoot
      ? []
      : db.getInformedByEdges(input.node_id, "ancestry", false);
    // 2.1.9: the digest work is bounded by the RETURNED window (50), not by
    // the fan-out — a 20k-support star used to pay one getNode + three hashes
    // per support for a list that only ever shows the first 50. The honest
    // total travels in supports_count, computed from the id list alone.
    const supportPairs = liveEdges
      .map((e) => ({ sid: e.to_id, description: e.description }))
      .sort((a, b) => compareSupportIds(a.sid, b.sid));
    const allSupportDigests: ProvenanceSupportDigest[] = supportPairs
      .slice(0, SUPPORT_DIGESTS_CAP)
      .map(({ sid, description }) => {
        const sup = db.getNode(sid);
        return {
          support_id: sid,
          claim_digest: sup ? claimDigestOf(sup.summary) : null,
          status_digest: sup ? statusDigestOf(sup.status, sup.epistemic_status) : null,
          edge_digest: edgeDigestOf(description),
          // 2.1.9 F2: a stub support can never honestly confirm anything —
          // the quality travels next to the digests so the agent sees it
          // before confirming. A missing node is "stub" (nothing to claim).
          // 2.1.10 F1: anchors (file_ref) are claim-grade — their template
          // summary is by design, not a placeholder.
          quality:
            sup && !isStubSummary(sup.summary, sup.kind, sup.created_via)
              ? "claim"
              : "stub",
        } as ProvenanceSupportDigest;
      });
    const supportTotal = supportPairs.length;

    const completeness: ProvenanceCompleteness =
      innerIncomplete > 0 ? "truncated" : completenessVerdict(db, input.node_id, result);

    return {
      root,
      direction,
      weak_links: weak,
      nodes: result.nodes,
      edges: result.edges,
      ...(rootCheck ? { support_check: rootCheck } : {}),
      current_digests: currentDigests,
      ...(supportTotal > 0
        ? {
            supports: allSupportDigests,
            ...(supportTotal > SUPPORT_DIGESTS_CAP
              ? { supports_count: supportTotal }
              : {}),
          }
        : {}),
      ...(innerIncomplete > 0 ? { inner_nodes_incomplete: innerIncomplete } : {}),
      limits: {
        depth: limits.depth,
        max_nodes: limits.maxNodes,
        max_scan_nodes: limits.maxScanNodes,
        max_check_edges: limits.maxCheckEdges,
        max_check_bytes: limits.maxCheckBytes,
      },
      shown: result.shown,
      total_within_depth: result.totalWithinDepth,
      total_exact: result.totalExact,
      truncated: result.truncatedBy !== null, // F21: always present
      truncated_by: result.truncatedBy,
      completeness,
      params: {
        depth: limits.depth,
        max_nodes: limits.maxNodes,
        max_scan_nodes: limits.maxScanNodes,
        retrospective,
        max_check_edges: limits.maxCheckEdges,
        max_check_bytes: limits.maxCheckBytes,
      },
    };
  });
}

/**
 * provenance_audit (plan 3 §4.2): "что рассыплется, если это неверно" — the
 * impact closure with every node whose epistemic_status != validated flagged
 * at_risk. Each run is persisted (plan 3 §10, decision 7) with retention
 * (last 200 per root, 90 days).
 */
export function provenanceAudit(
  db: KnowledgeDB,
  input: ProvenanceTraceInput
): ProvenanceAuditOutput {
  const direction = input.direction ?? "impact";
  const output = provenanceTrace(db, { ...input, direction });
  for (const n of output.nodes) {
    if (n.epistemic_status !== "validated") n.at_risk = true;
  }
  const auditRunId = db.insertProvenanceAuditRun({
    root_id: input.node_id,
    direction,
    params: output.params,
    result: {
      shown: output.shown,
      total_within_depth: output.total_within_depth,
      completeness: output.completeness,
      weak_links: output.weak_links,
      nodes: output.nodes.map((n) => ({
        id: n.id,
        depth: n.depth,
        at_risk: n.at_risk ?? false,
      })),
    },
  });
  return { ...output, audit_run_id: auditRunId };
}
