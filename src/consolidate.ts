import type { KnowledgeDB } from "./db.js";
import type { NodeRow } from "./types.js";

/**
 * Duplicate consolidation (plan T5): find near-identical active nodes by
 * embedding cosine similarity and merge them — older node survives, summary
 * and file_refs combine, edges move to the survivor.
 */

export interface DuplicateCandidate {
  a: string;
  b: string;
  similarity: number;
  name_similarity: number;
  same_parent: boolean;
  /** The older node — survives the merge. */
  older: string;
}

export interface FindDuplicatesOptions {
  /** Minimum embedding cosine to count as a duplicate (default 0.95). */
  threshold?: number;
  /** Max candidates returned (default 100). */
  limit?: number;
}

function toVector(raw: Buffer | ArrayBuffer | null): Float32Array | null {
  if (!raw) return null;
  const buf = raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
  if (buf.length === 0 || buf.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.length / Float32Array.BYTES_PER_ELEMENT
  );
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Dice coefficient over character bigrams — simple, language-agnostic. */
export function nameSimilarity(a: string, b: string): number {
  const sa = a.toLowerCase();
  const sb = b.toLowerCase();
  if (sa === sb) return 1;
  if (sa.length < 2 || sb.length < 2) return sa === sb ? 1 : 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < sa.length - 1; i++) {
    const g = sa.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < sb.length - 1; i++) {
    const g = sb.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hits += 1;
      grams.set(g, n - 1);
    }
  }
  return (2 * hits) / (sa.length - 1 + sb.length - 1);
}

/** Near-duplicate candidates among active nodes, grouped by parent. */
export function findDuplicates(
  db: KnowledgeDB,
  opts: FindDuplicatesOptions = {}
): DuplicateCandidate[] {
  const threshold = opts.threshold ?? 0.95;
  const limit = opts.limit ?? 100;

  // М7: digest nodes are derived summaries — never consolidation candidates
  // (merging two digests would corrupt the derived payload).
  const rows = db
    .getAllNodesRaw()
    .filter((n) => n.removed_at === null && n.kind !== "digest");
  const groups = new Map<string, NodeRow[]>();
  for (const row of rows) {
    const key = row.parent_id ?? "__root__";
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const candidates: DuplicateCandidate[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const va = toVector(group[i].embedding);
        const vb = toVector(group[j].embedding);
        if (!va || !vb) continue; // consolidation needs vectors on both sides
        const sim = cosine(va, vb);
        if (sim < threshold) continue;
        const older =
          (group[i].created_at ?? "") <= (group[j].created_at ?? "")
            ? group[i].id
            : group[j].id;
        candidates.push({
          a: group[i].id,
          b: group[j].id,
          similarity: sim,
          name_similarity: nameSimilarity(group[i].name, group[j].name),
          same_parent: group[i].parent_id === group[j].parent_id,
          older,
        });
        if (candidates.length >= limit) {
          return candidates;
        }
      }
    }
  }
  return candidates;
}

export interface MergeNodesResult {
  survivor: string;
  removed: string;
}

/**
 * F-03 (план 03, S-08): self-consolidation and dead participants are rejected
 * BEFORE the transaction — `mergeNodes(db, 'only', 'only')` used to pass both
 * lookups, "merge" the node into itself and then hard-delete it.
 */
function assertConsolidatable(
  db: KnowledgeDB,
  survivorId: string,
  otherId: string
): void {
  if (survivorId === otherId) {
    throw new Error(
      `Cannot consolidate "${survivorId}" into itself — survivor and duplicate must be distinct live nodes.`
    );
  }
  const survivor = db.getNode(survivorId);
  const other = db.getNodeIncludingRemoved(otherId);
  if (!survivor || !other) {
    throw new Error(`Cannot merge: node not found (${survivorId} / ${otherId}).`);
  }
  if (survivor.removed_at !== null || other.removed_at !== null) {
    const state = (n: NodeRow) => (n.removed_at !== null ? "removed" : "live");
    throw new Error(
      `Cannot merge: both nodes must be alive ` +
        `(${survivorId}: ${state(survivor)}, ${otherId}: ${state(other)}).`
    );
  }
}

/**
 * F-03 (план 03): перенос workflow-состояния удаляемого узла на выжившего.
 * Дети, слоты, участники сохранённых цепочек, артефакты, снимки опор и
 * алиасы не должны исчезать молча вместе с узлом (FK обнулил бы детей,
 * слот и членство в цепочке потеряли бы исполнителя). Рёбра не трогаются:
 * их переносит вызывающая сторона, которая знает, живут ли копии.
 *
 * Снимки опор (support_baselines) без OR IGNORE-коллизии переезжают на
 * выжившего; несместившиеся строки остаются с id удалённого узла как явное
 * свидетельство утраты — таблица без FK и существует именно для этого.
 * Задача: состояние выжившего приоритетно, дубликат заполняет только пустое.
 */
export function transferNodeIdentity(
  db: KnowledgeDB,
  fromId: string,
  toId: string
): void {
  // Survivor inside the removed node's subtree would turn the subtree into a
  // parent cycle — refuse the whole operation instead of corrupting the hierarchy.
  let cursor: NodeRow | undefined = db.getNodeIncludingRemoved(toId);
  const seen = new Set<string>();
  while (cursor?.parent_id) {
    if (cursor.parent_id === fromId || seen.has(cursor.parent_id)) {
      throw new Error(
        `Cannot merge "${fromId}" into "${toId}": the survivor lies inside the removed node's subtree — the hierarchy would become a cycle.`
      );
    }
    seen.add(cursor.parent_id);
    cursor = db.getNodeIncludingRemoved(cursor.parent_id);
  }

  db.execSqlRun(
    "UPDATE nodes SET parent_id = ?, updated_at = datetime('now') WHERE parent_id = ? AND id != ?",
    toId,
    fromId,
    toId
  );
  db.execSqlRun(
    "UPDATE slots SET node_id = ?, updated_at = datetime('now') WHERE node_id = ?",
    toId,
    fromId
  );
  // Fingerprints travel verbatim: the saved reasoning stays as saved; the
  // staleness check is trail_refresh's explicit job, not a silent rewrite.
  db.execSqlRun(
    "UPDATE trail_members SET node_id = ? WHERE node_id = ?",
    toId,
    fromId
  );
  // OR IGNORE: a colliding observation (node_id, kind, ref) means the survivor
  // already tracks that artifact — the duplicate row is the same observation,
  // the leftover is removed with the node.
  db.execSqlRun(
    "UPDATE OR IGNORE node_artifacts SET node_id = ? WHERE node_id = ?",
    toId,
    fromId
  );
  db.execSqlRun("DELETE FROM node_artifacts WHERE node_id = ?", fromId);
  db.execSqlRun(
    "UPDATE OR IGNORE support_baselines SET decision_id = ? WHERE decision_id = ?",
    toId,
    fromId
  );
  db.execSqlRun(
    "UPDATE OR IGNORE support_baselines SET support_id = ? WHERE support_id = ?",
    toId,
    fromId
  );
  db.execSqlRun(
    "UPDATE aliases SET new_id = ? WHERE new_id = ?",
    toId,
    fromId
  );

  const survivor = db.getNode(toId);
  const from = db.getNodeIncludingRemoved(fromId);
  if (
    survivor &&
    from &&
    (survivor.task_state ?? null) === null &&
    (from.task_state ?? null) !== null
  ) {
    db.execSqlRun(
      "UPDATE nodes SET task_state = ?, due_at = ?, updated_at = datetime('now') WHERE id = ?",
      from.task_state,
      from.due_at,
      toId
    );
  }
}

/**
 * F-03 (план 03, S-06): перенос рёбер удаляемого варианта на выжившего
 * identity — живые и надгробия, вербатим (created_via/accepted_at/removed_at),
 * чтобы утраченная опора не исчезала из провенанса и «связей нет» не
 * превращалось в ложный complete. Дедуп полагается на уникальный индекс
 * (from_id, to_id, relation): пара, уже стоящая у выжившего, не создаётся
 * второй раз — копия варианта уходит вместе с ним; надгробие выжившего при
 * этом не воскрешается (та же политика, что и в merge, F20).
 * Возвращает число фактически перенесённых строк.
 */
export function moveNodeEdges(
  db: KnowledgeDB,
  fromId: string,
  toId: string
): number {
  const edges = db
    .getAllEdgesRaw()
    .filter((e) => e.from_id === fromId || e.to_id === fromId);
  let moved = 0;
  for (const e of edges) {
    const from = e.from_id === fromId ? toId : e.from_id;
    const to = e.to_id === fromId ? toId : e.to_id;
    if (from === to) continue; // самопетля после ремапа — не свидетельство
    const res = db.insertEdgeRaw({
      from_id: from,
      to_id: to,
      relation: e.relation,
      description: e.description,
      created_at: e.created_at,
      merge_group: e.merge_group,
      needs_merge: e.needs_merge,
      source_branch: e.source_branch,
      merge_timestamp: e.merge_timestamp,
      removed_at: e.removed_at,
      created_via: e.created_via ?? "unknown",
      accepted_at: e.accepted_at ?? null,
    });
    if (res.inserted) moved++;
  }
  return moved;
}

export interface ConsolidationPreview {
  survivor: string;
  other: string;
  /** Контент дубля войдёт в саммари выжившего. */
  summaryCombines: boolean;
  /** Сколько file_refs дубля добавится к выжившему. */
  refsAdded: number;
  /** Сколько рёбер переедет на выжившего (живые и надгробия, минус дедуп). */
  edgesToMove: number;
  children: number;
  slots: Array<{ project: string; role: string }>;
  trailMembers: number;
  artifacts: number;
  baselines: number;
  /** Состояние задачи дубля переедет (у выжившего пусто). */
  taskCarries: boolean;
  /** Отказ и его причина — до транзакции, ничего не пишется. */
  rejection?: string;
}

/**
 * F-03.6 (план 03): read-only описание последствий слияния для preview
 * плана 07. Валидация — та же, что в apply (assertConsolidatable + та же
 * проверка цикла по поддереву), подсчёты — теми же запросами, которыми
 * apply переносит строки. Ни граф, ни снимки, ни история не пишутся.
 */
export function describeConsolidation(
  db: KnowledgeDB,
  survivorId: string,
  otherId: string
): ConsolidationPreview {
  let rejection: string | undefined;
  try {
    assertConsolidatable(db, survivorId, otherId);
    // Цикл по поддереву — та же проверка, что в transferNodeIdentity.
    let cursor = db.getNodeIncludingRemoved(survivorId);
    const seen = new Set<string>();
    while (cursor?.parent_id) {
      if (cursor.parent_id === otherId || seen.has(cursor.parent_id)) {
        throw new Error(
          `Cannot merge "${otherId}" into "${survivorId}": the survivor lies inside the removed node's subtree — the hierarchy would become a cycle.`
        );
      }
      seen.add(cursor.parent_id);
      cursor = db.getNodeIncludingRemoved(cursor.parent_id);
    }
  } catch (err) {
    rejection = err instanceof Error ? err.message : String(err);
    return {
      survivor: survivorId,
      other: otherId,
      summaryCombines: false,
      refsAdded: 0,
      edgesToMove: 0,
      children: 0,
      slots: [],
      trailMembers: 0,
      artifacts: 0,
      baselines: 0,
      taskCarries: false,
      rejection,
    };
  }

  const survivor = db.getNode(survivorId)!;
  const other = db.getNodeIncludingRemoved(otherId)!;
  const summaryCombines =
    !!other.summary &&
    !survivor.summary.includes(other.summary) &&
    other.summary !== survivor.summary;

  const parseRefs = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  const survivorRefs = new Set(parseRefs(survivor.file_refs));
  const refsAdded = parseRefs(other.file_refs).filter((r) => !survivorRefs.has(r)).length;

  const existingEdges = new Set(
    [...db.getOutgoingEdges(survivorId), ...db.getIncomingEdges(survivorId)].map(
      (e) => `${e.from_id}|${e.to_id}|${e.relation}`
    )
  );
  const rawEdges = db
    .getAllEdgesRaw()
    .filter((e) => e.from_id === otherId || e.to_id === otherId);
  const edgesToMove = rawEdges.filter((e) => {
    const from = e.from_id === otherId ? survivorId : e.from_id;
    const to = e.to_id === otherId ? survivorId : e.to_id;
    return from !== to && !existingEdges.has(`${from}|${to}|${e.relation}`);
  }).length;

  const childrenRow = db.execSqlFirst(
    "SELECT COUNT(*) AS n FROM nodes WHERE parent_id = ? AND id != ?",
    otherId,
    survivorId
  ) as { n: number };
  const slots = (
    db.execSqlAll("SELECT project, role FROM slots WHERE node_id = ?", otherId) as Array<{
      project: string;
      role: string;
    }>
  ).map((s) => ({ ...s }));
  const trailMembersRow = db.execSqlFirst(
    "SELECT COUNT(*) AS n FROM trail_members WHERE node_id = ?",
    otherId
  ) as { n: number };
  const artifactsRow = db.execSqlFirst(
    "SELECT COUNT(*) AS n FROM node_artifacts WHERE node_id = ?",
    otherId
  ) as { n: number };
  const baselinesRow = db.execSqlFirst(
    "SELECT COUNT(*) AS n FROM support_baselines WHERE decision_id = ? OR support_id = ?",
    otherId,
    otherId
  ) as { n: number };

  return {
    survivor: survivorId,
    other: otherId,
    summaryCombines,
    refsAdded,
    edgesToMove,
    children: childrenRow.n,
    slots,
    trailMembers: trailMembersRow.n,
    artifacts: artifactsRow.n,
    baselines: baselinesRow.n,
    taskCarries:
      (survivor.task_state ?? null) === null && (other.task_state ?? null) !== null,
  };
}

/**
 * Merge node `other` into `survivor`: combine summary/why/file_refs, move
 * edges, hard-delete the other node. Caller decides which one survives —
 * findDuplicates marks the older one.
 */
export function mergeNodes(
  db: KnowledgeDB,
  survivorId: string,
  otherId: string
): MergeNodesResult {
  // S-08: до транзакции — самослияние и мёртвые участники отвергаются без
  // единой записи; повторный запрос по уже удалённому узлу тоже сюда попадает.
  assertConsolidatable(db, survivorId, otherId);
  const survivor = db.getNode(survivorId)!;
  const other = db.getNodeIncludingRemoved(otherId)!;

  db.runInTransaction(() => {
    // Combine summary (skip when identical or already contained).
    let summary = survivor.summary;
    if (
      other.summary &&
      !summary.includes(other.summary) &&
      other.summary !== survivor.summary
    ) {
      summary = `${summary}\n\n${other.summary}`;
    }

    // Union of file_refs, order-preserving.
    const parse = (raw: string | null): string[] => {
      if (!raw) return [];
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.map(String) : [];
      } catch {
        return [];
      }
    };
    const refs = [...new Set([...parse(survivor.file_refs), ...parse(other.file_refs)])];

    const why = survivor.why ?? other.why;

    db.updateNode(survivorId, {
      summary,
      why: why ?? undefined,
      file_refs: refs.length > 0 ? refs : undefined,
    });

    // Move edges from the other node to the survivor. Skip self-loops and
    // edges that would duplicate an existing survivor edge.
    const existing = new Set(
      [...db.getOutgoingEdges(survivorId), ...db.getIncomingEdges(survivorId)].map(
        (e) => `${e.from_id}|${e.to_id}|${e.relation}`
      )
    );
    const otherEdges = [
      ...db.getOutgoingEdges(otherId).map((e) => ({ from: otherId, to: e.to_id, relation: e.relation, description: e.description })),
      ...db.getIncomingEdges(otherId).map((e) => ({ from: e.from_id, to: otherId, relation: e.relation, description: e.description })),
    ];
    const movedKeys = new Set<string>();
    for (const edge of otherEdges) {
      const from = edge.from === otherId ? survivorId : edge.from;
      const to = edge.to === otherId ? survivorId : edge.to;
      if (from === to) continue; // self-loop
      const key = `${from}|${to}|${edge.relation}`;
      if (existing.has(key) || movedKeys.has(key)) continue;
      movedKeys.add(key);
      db.insertEdge({
        from_id: from,
        to_id: to,
        relation: edge.relation,
        description: edge.description,
        // Plan 4 v8 §1.3: a server-side re-creation during consolidation —
        // the original row's origin is gone with it, so the new row is
        // honestly 'unknown', not laundered into 'agent'.
        via: "unknown",
      });
    }

    // F-03: дети, слоты, цепочки, артефакты, снимки и алиасы следуют за
    // выжившим — участники не теряются молча вместе с дублем.
    transferNodeIdentity(db, otherId, survivorId);

    // hardDeleteNode removes remaining edges of the other node.
    db.hardDeleteNode(otherId);
  });

  return { survivor: survivorId, removed: otherId };
}
