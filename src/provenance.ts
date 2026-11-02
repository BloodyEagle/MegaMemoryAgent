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
  /** auto-derive supports from why + file_refs (default true). */
  auto_ground: boolean;
}

const DEFAULTS: ProvenanceConfig = { require_support: false, auto_ground: true };

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

// ---- Traversal core (plan 3 §4.2) ----

const DEFAULT_DEPTH = 6;
const DEFAULT_MAX_NODES = 200;
const RATIONALE_TRIM = 80;
/** Cap for the DFS path counting — the memo keeps it polynomial anyway. */
const PATH_COUNT_CAP = 100000;

function trimRationale(text: string | null): string | null {
  if (!text) return null;
  if (text.length <= RATIONALE_TRIM) return text;
  return text.slice(0, RATIONALE_TRIM - 1).trimEnd() + "…";
}

interface TraverseResult {
  nodes: ProvenanceNodeView[];
  edges: ProvenanceEdgeView[];
  shown: number;
  total: number;
  truncated: boolean;
}

/**
 * BFS over ONE relation (informed_by) in ONE direction (plan 3 §2, invariant 5:
 * a single projection per walk — supersedes/contradicts/parent_id never leak
 * in). Live mode follows only live edges between live nodes. Retrospective
 * mode follows tombstoned edges too; a filtered endpoint comes back as a
 * stub counted against max_nodes, so no dangling edge can appear (plan 3 §1.3).
 */
function traverse(
  db: KnowledgeDB,
  rootId: string,
  direction: "ancestry" | "impact",
  depthLimit: number,
  maxNodes: number,
  retrospective: boolean
): TraverseResult {
  type Row = { other_id: string; description: string | null; removed_at: string | null };
  const fetch = (id: string): Row[] =>
    db
      .getInformedByEdges(id, direction, retrospective)
      .map((e) => ({
        other_id: e.other_id,
        description: e.description,
        removed_at: e.removed_at ?? null,
      }));

  const nodeById = new Map<string, ProvenanceNodeView>();
  const edgeViews: ProvenanceEdgeView[] = [];
  const emittedEdgeKeys = new Set<string>();
  let truncated = false;

  // Full-closure size first (ignores the node cap) — completeness and the
  // K из N report must not lie.
  const seenTotal = new Set<string>([rootId]);
  const totalQueue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  while (totalQueue.length > 0) {
    const { id, depth } = totalQueue.shift()!;
    if (depth >= depthLimit) continue;
    for (const r of fetch(id)) {
      if (!seenTotal.has(r.other_id)) {
        seenTotal.add(r.other_id);
        if (depth + 1 > depthLimit) truncated = true;
        else totalQueue.push({ id: r.other_id, depth: depth + 1 });
      }
    }
  }
  const total = seenTotal.size;

  // Emission BFS: level order, deterministic by id, honoring both limits.
  const rootNode = db.getNodeIncludingRemoved(rootId)!;
  nodeById.set(rootId, {
    id: rootId,
    name: rootNode?.name ?? null,
    kind: rootNode?.kind ?? null,
    status: rootNode?.status ?? null,
    epistemic_status: rootNode?.epistemic_status ?? null,
    depth: 0,
    in_paths: 1,
    ...(rootNode?.removed_at ? { removed: true } : {}),
  });
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const visited = new Set<string>([rootId]);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    const rows = fetch(id).sort((a, b) => (a.other_id < b.other_id ? -1 : 1));
    for (const r of rows) {
      const key = `${id}|${r.other_id}`;
      if (!emittedEdgeKeys.has(key)) {
        emittedEdgeKeys.add(key);
        edgeViews.push({
          from: direction === "ancestry" ? id : r.other_id,
          to: direction === "ancestry" ? r.other_id : id,
          rationale: trimRationale(r.description),
          ...(r.removed_at !== null ? { removed: true } : {}),
        });
      }
      if (visited.has(r.other_id)) continue;
      if (nodeById.size >= maxNodes || depth + 1 > depthLimit) {
        truncated = true;
        continue;
      }
      const other = db.getNodeIncludingRemoved(r.other_id);
      const isRemoved = !other || other.removed_at !== null;
      nodeById.set(r.other_id, {
        id: r.other_id,
        name: isRemoved ? null : other!.name,
        kind: isRemoved ? null : other!.kind,
        status: isRemoved ? null : other!.status ?? null,
        epistemic_status: isRemoved ? null : other!.epistemic_status ?? null,
        depth: depth + 1,
        in_paths: 0,
        ...(isRemoved ? { removed: true } : {}),
      });
      visited.add(r.other_id);
      if (!isRemoved) queue.push({ id: r.other_id, depth: depth + 1 });
    }
  }

  // No dangling edges may survive (plan 3 §1.3 / §6 test): drop any edge
  // whose endpoints are not both in the emitted node list.
  const liveEdges = edgeViews.filter(
    (e) => nodeById.has(e.from) && nodeById.has(e.to)
  );

  // Path counts (plan 3 §4.2: repeated DAG nodes once, "входит в N путей").
  // Memoized DFS over the emitted subgraph; on-stack hits (a leftover cycle)
  // contribute 0 and surface as weak links instead of inflating the count.
  const children = new Map<string, string[]>();
  for (const e of liveEdges) {
    const parent = direction === "ancestry" ? e.from : e.to;
    const child = direction === "ancestry" ? e.to : e.from;
    if (!children.has(child)) children.set(child, []);
    children.get(child)!.push(parent);
  }
  const memo = new Map<string, number>();
  const countPaths = (id: string, onStack: Set<string>): number => {
    if (id === rootId) return 1;
    if (onStack.has(id)) return 0; // cycle — do not inflate
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    let sum = 0;
    for (const p of children.get(id) ?? []) sum += countPaths(p, onStack);
    if (sum > PATH_COUNT_CAP) sum = PATH_COUNT_CAP;
    memo.set(id, sum);
    return sum;
  };
  for (const id of nodeById.keys()) {
    if (id === rootId) continue;
    nodeById.get(id)!.in_paths = countPaths(id, new Set());
    memo.clear();
  }

  const nodes = [...nodeById.values()].sort(
    (a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1)
  );

  return { nodes, edges: liveEdges, shown: nodes.length, total, truncated };
}

function weakLinks(
  db: KnowledgeDB,
  result: TraverseResult,
  direction: "ancestry" | "impact",
  cycleNodes: Set<string>
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

  // 2. unresolved cycles (needs_merge leftovers).
  for (const n of result.nodes) {
    if (cycleNodes.has(n.id)) {
      weak.push({
        type: "cycle",
        id: n.id,
        note: `узел "${n.id}" внутри неразрешённого цикла informed_by (needs_merge)`,
      });
    }
  }

  // 3. edges without a rationale (legacy rows can predate the check).
  for (const e of result.edges) {
    if (!e.rationale || e.rationale.trim().length === 0) {
      weak.push({
        type: "no_rationale",
        from: e.from,
        to: e.to,
        note: `ребро ${e.from} -> ${e.to} без рационала — связь нечитаема`,
      });
    }
  }

  // 4. decisions whose every support is ungrounded (ancestry only: the
  // impact direction does not carry the supports of the affected nodes).
  if (direction === "ancestry") {
    for (const n of result.nodes) {
      if (n.removed) continue;
      const row = db.getNode(n.id);
      if (!row || row.kind !== "decision") continue;
      const supports = db
        .getInformedByEdges(n.id, "ancestry", false)
        .map((e) => e.other_id);
      if (supports.length === 0) continue;
      const allUngrounded = supports.every((sid) => {
        const s = db.getNode(sid);
        return !s || isUngrounded(db, s);
      });
      if (allUngrounded) {
        weak.push({
          type: "ungrounded_support",
          id: n.id,
          note: `решение "${n.id}" опирается только на ungrounded-узлы (${supports.join(", ")})`,
        });
      }
    }
  }

  return weak;
}

function rootHeader(
  db: KnowledgeDB,
  rootId: string,
  direction: "ancestry" | "impact"
): ProvenanceTraceOutput["root"] {
  const node = db.getNode(rootId);
  if (!node) {
    throw new Error(`Concept "${rootId}" not found.`);
  }
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    status: node.status ?? "active",
    epistemic_status: node.epistemic_status ?? null,
  };
}

function completenessVerdict(
  db: KnowledgeDB,
  rootId: string,
  result: TraverseResult
): ProvenanceCompleteness {
  if (result.truncated) return "truncated";
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
 */
export function provenanceTrace(
  db: KnowledgeDB,
  input: ProvenanceTraceInput
): ProvenanceTraceOutput {
  const direction = input.direction ?? "ancestry";
  const depth = Math.max(1, input.depth ?? DEFAULT_DEPTH);
  const maxNodes = Math.max(1, input.max_nodes ?? DEFAULT_MAX_NODES);
  const retrospective = input.retrospective ?? false;

  const root = rootHeader(db, input.node_id, direction); // not-found throws here
  const result = traverse(db, input.node_id, direction, depth, maxNodes, retrospective);
  const cycleNodes = db.informedByCycleNodeSet();
  const weak = weakLinks(db, result, direction, cycleNodes);
  const completeness = completenessVerdict(db, input.node_id, result);

  return {
    root,
    direction,
    weak_links: weak,
    nodes: result.nodes,
    edges: result.edges,
    limits: { depth, max_nodes: maxNodes },
    shown: result.shown,
    total_reachable: result.total,
    completeness,
    params: { depth, max_nodes: maxNodes, retrospective },
  };
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
      total_reachable: output.total_reachable,
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
