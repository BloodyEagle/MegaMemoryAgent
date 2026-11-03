import fs from "fs";
import path from "path";
import type { KnowledgeDB } from "./db.js";
import type { NodeRow } from "./types.js";
import type {
  ProvenanceTraceInput,
  ProvenanceTraceOutput,
  ProvenanceAuditOutput,
  ProvenanceCompleteness,
  ProvenanceNodeView,
  ProvenanceEdgeView,
  ProvenanceWeakLink,
} from "./types.js";

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
  const envRequire = envFlag("MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT");
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
  if (db.getInformedByEdges(node.id, "ancestry", false).length > 0) return false;
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
const RATIONALE_TRIM = 80;
/** Cap for the path counting — capped values are flagged, not silent (F7). */
const PATH_COUNT_CAP = 100000;

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
  };
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
    ...(rootRemoved ? { removed: true } : {}),
  });

  const seen = new Set<string>([rootId]);
  const edgeViews: ProvenanceEdgeView[] = [];
  const emittedEdgeKeys = new Set<string>(); // JSON keys — pipe-safe (F11)
  let total = 1;
  let frontier: string[] = [rootId];
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

function weakLinks(
  db: KnowledgeDB,
  result: TraverseResult,
  direction: "ancestry" | "impact",
  retrospective: boolean
): ProvenanceWeakLink[] {
  const weak: ProvenanceWeakLink[] = [];

  // 1. refuted / abandoned inside the closure — antiknowledge on the path.
  for (const n of result.nodes) {
    if (n.epistemic_status === "refuted") {
      weak.push({
        type: "refuted",
        id: n.id,
        note: `узел "${n.id}" опровергнут — не использовать как факт`,
      });
    } else if (n.epistemic_status === "abandoned") {
      weak.push({
        type: "abandoned",
        id: n.id,
        note: `узел "${n.id}" заброшен — вывод может устареть`,
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
      `цикл informed_by: ${comp.join(", ")}`,
      witness ? `свидетель ${witness.from} -> ${witness.to}` : null,
      needsMerge.length > 0 ? `needs_merge: ${needsMerge.join(", ")}` : null,
      "компонента закрыта для записи (needs_merge)",
    ].filter(Boolean);
    weak.push({
      type: "cycle",
      id: componentId,
      note: `${parts.join("; ")}`,
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
        note: `ребро ${e.from} -> ${e.to} без рационала — связь нечитаема`,
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
  for (const n of result.nodes) {
    if (n.removed) continue;
    const row = db.getNode(n.id);
    if (!row || row.kind !== "decision") continue;
    const supports = db
      .getInformedByEdges(n.id, "ancestry", retrospective)
      .map((e) => e.other_id);
    if (supports.length === 0) {
      weak.push({
        type: "no_support",
        id: n.id,
        note: `решение "${n.id}" не имеет ни одной опоры`,
      });
      continue;
    }
    const missing: string[] = [];
    const ungrounded: string[] = [];
    for (const sid of supports) {
      const s = db.getNode(sid);
      if (!s) missing.push(sid);
      else if (isUngrounded(db, s)) ungrounded.push(sid);
    }
    if (missing.length + ungrounded.length === supports.length) {
      if (missing.length > 0) {
        weak.push({
          type: "missing_support",
          id: n.id,
          note: `решение "${n.id}" ссылается на отсутствующие узлы (${missing.join(", ")})`,
        });
      }
      if (ungrounded.length > 0) {
        weak.push({
          type: "ungrounded_support",
          id: n.id,
          note: `решение "${n.id}" опирается только на ungrounded-узлы (${ungrounded.join(", ")})`,
        });
      }
    }
  }

  return weak;
}

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
 *    total_exact: false.
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
    const weak = weakLinks(db, result, direction, retrospective);
    const completeness = completenessVerdict(db, input.node_id, result);

    return {
      root,
      direction,
      weak_links: weak,
      nodes: result.nodes,
      edges: result.edges,
      limits: {
        depth: limits.depth,
        max_nodes: limits.maxNodes,
        max_scan_nodes: limits.maxScanNodes,
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
