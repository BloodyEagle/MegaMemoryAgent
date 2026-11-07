import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { buildNodeWithContext, currentDigestsOf, understand } from "./tools.js";
import {
  describeConsolidation,
  findDuplicates,
  mergeNodes,
  VersionConflictError,
  type MergeNodesResult,
} from "./consolidate.js";
import { renderAllMarkdown, renderNodeMarkdown } from "./export.js";
import { digestSourceChildren } from "./digest.js";
import { errorBold, askPort } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";
import {
  initializeEmbeddings,
  isModelLoaded,
  isTextOnlySearchMode,
  vectorSearchEnabled,
} from "./embeddings.js";
import { healthReport, type HealthReport } from "./doctor.js";
import { d3Source, resolveD3Src, type D3Source } from "./d3-asset.js";
import type { NodeRow } from "./types.js";

const VERSION = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version;

function resolveHtmlPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // From dist/ → ../web/index.html
  const fromDist = path.resolve(thisDir, "..", "web", "index.html");
  if (fs.existsSync(fromDist)) return fromDist;
  // From src/ → ../web/index.html
  return path.resolve(thisDir, "..", "web", "index.html");
}

/**
 * U3 metrics plus 2.1.9 F1 `d3_source` (local / cdn / env) — the explorer
 * header chip shows where the page's d3 came from, same data as doctor.
 */
export function healthPayload(db: KnowledgeDB): HealthReport & { d3_source: D3Source } {
  return { ...healthReport(db), d3_source: d3Source() };
}

// Directory holding vendored static assets (d3 etc.) shipped with web/.
function resolveWebDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "..", "web");
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  // F1 2.1.13: без Access-Control-Allow-Origin — интерфейс живёт на том же
  // origin, а чужие origin отсекаются gate-ом ниже (403 без CORS-заголовков).
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: http.ServerResponse, content: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function parseFileRefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * F1 2.1.13: белый список имён хостов для проверки заголовка Host. Сервер
 * слушает loopback, но одного bind-а мало: DNS rebinding подставляет свой
 * hostname с целевым портом, и запрос доходит. Имя из белого списка + порт
 * должны совпадать с фактическими.
 */
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostMatches(header: string | undefined, port: number): boolean {
  if (!header) return false;
  let hostname = header;
  let hostPort: string | null = null;
  if (header.startsWith("[")) {
    // IPv6-литерал: [::1]:4321
    const close = header.indexOf("]");
    if (close === -1) return false;
    hostname = header.slice(0, close + 1);
    if (header.length > close + 1) {
      if (header[close + 1] !== ":") return false;
      hostPort = header.slice(close + 2);
    }
  } else {
    const colon = header.lastIndexOf(":");
    if (colon !== -1) {
      hostname = header.slice(0, colon);
      hostPort = header.slice(colon + 1);
    }
  }
  if (!ALLOWED_HOSTNAMES.has(hostname.toLowerCase())) return false;
  // Порт в заголовке обязателен к совпадению; отсутствие порта (пустой)
  // допускаем только для дефолтного 80 — на практике браузер всегда шлёт порт.
  if (hostPort !== null && hostPort !== "" && hostPort !== String(port)) return false;
  return true;
}

/**
 * F1 2.1.13: same-origin по Origin/Referer. Фактический origin — http и уже
 * проверенный Host (gate вызывается после hostMatches). Origin есть у
 * браузерных cross-origin запросов и у fetch-POST; Referer проверяем, когда
 * Origin не пришёл. Нет ни того, ни другого (curl, Health-check) — пропускаем:
 * DNS rebinding уже закрыт проверкой Host.
 */
function sameOrigin(
  origin: string | undefined,
  referer: string | undefined,
  host: string
): boolean {
  const expected = `http://${host.toLowerCase()}`;
  if (origin !== undefined) return origin.trim().toLowerCase() === expected;
  if (referer !== undefined) {
    try {
      const ref = new URL(referer);
      return `http://${ref.host.toLowerCase()}` === expected;
    } catch {
      return false;
    }
  }
  return true;
}

function printBanner(actualAddress: string, port: number, dbPath: string): void {
  const display = actualAddress.includes(":") ? `[${actualAddress}]` : actualAddress;
  console.log();
  console.log(`  ${pc.bold(pc.cyan("megamemory"))} ${pc.green(`v${VERSION}`)} ${pc.dim("explorer")}`);
  console.log();
  console.log(`  ${pc.dim("➜")}  ${pc.bold("Local:")}   ${pc.cyan(pc.underline(`http://${display}:${port}`))}`);
  console.log(`  ${pc.dim("➜")}  ${pc.bold("DB:")}      ${pc.dim(dbPath)}`);
  console.log();
  console.log("  Local interface only — not a network service.");
  console.log("  Press Ctrl+C to stop.");
  console.log();
}

/**
 * Attempt to listen on the given host+port. If EADDRINUSE, prompt the user
 * for an alternative port and retry. Resolves with the ACTUAL bound port —
 * после retry он отличается от аргумента, и Host-gate обязан сверяться
 * с ним (план 06, W-05), иначе правильный новый адрес получал 403.
 * F1 2.1.13: host обязателен (127.0.0.1 или явный ::1) — wildcard-слушатель
 * больше не существует.
 */
function listenWithRetry(
  server: http.Server,
  port: number,
  host: string,
  dbPath: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server.removeListener("error", onError);
        try {
          const newPort = await askPort(port);
          if (newPort === null) {
            console.log(pc.dim("  Cancelled.\n"));
            process.exit(0);
          }
          // Retry with the new port
          resolve(listenWithRetry(server, newPort, host, dbPath));
        } catch (promptErr) {
          reject(promptErr);
        }
      } else if (err.code === "EACCES") {
        errorBold(`Permission denied for port ${port}. Try a port above 1024.`);
        process.exit(1);
      } else {
        reject(err);
      }
    };

    server.once("error", onError);

    server.listen(port, host, () => {
      server.removeListener("error", onError);
      // Фактический адрес и порт из socket-а, а не из аргумента: слушаем то,
      // что написали. Для 127.0.0.1 адрес — "127.0.0.1".
      const addr = server.address();
      const actual = typeof addr === "object" && addr !== null ? addr.address : host;
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      printBanner(actual, actualPort, dbPath);
      resolve(actualPort);
    });
  });
}

export async function runServe(port: number, host = "127.0.0.1"): Promise<void> {
  // serve и MCP — единственные, кому законно создавать базу: первая установка
  // ещё не имеет knowledge.db, её нельзя встречать ошибкой.
  const dbPath = resolveDbPathOrExit(process.argv.slice(3), { allowCreate: true });

  const db = new KnowledgeDB(dbPath);

  // F14: convert a legacy database on first open (same as the MCP path).
  try {
    const { autoMigrateIfNeeded, describeAutoMigration } = await import(
      "./auto-migrate.js"
    );
    const result = await autoMigrateIfNeeded(db, dbPath);
    const line = describeAutoMigration(result);
    if (line) console.log(pc.dim(`  ${line}`));
    for (const w of result.warnings) console.log(pc.yellow(`  ${w}`));
  } catch (err) {
    errorBold(`Auto-migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  let sseClients: http.ServerResponse[] = [];
  let lastKnownNodeIds = new Set<string>();
  let lastKnownNodeUpdates = new Map<string, string>(); // id → updated_at
  let lastKnownEdgeKeys = new Set<string>(); // "from|to|relation"

  function buildGraphPayload(): {
    nodes: Array<{
      id: string;
      name: string;
      kind: NodeRow["kind"];
      summary: string;
      parent_id: string | null;
      edge_count: number;
      status: string;
    }>;
    edges: Array<{
      from: string;
      to: string;
      relation: string;
      description: string | null;
    }>;
  } {
    const nodes = db.getAllActiveNodes().map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      summary: n.summary,
      parent_id: n.parent_id,
      edge_count: 0,
      status: (n as { status?: string }).status ?? "active",
    }));

    const edges = db.getAllEdges().map((e) => ({
      from: e.from_id,
      to: e.to_id,
      relation: e.relation,
      description: e.description,
    }));

    const edgeCounts = new Map<string, number>();
    for (const e of edges) {
      edgeCounts.set(e.from, (edgeCounts.get(e.from) ?? 0) + 1);
      edgeCounts.set(e.to, (edgeCounts.get(e.to) ?? 0) + 1);
    }
    for (const n of nodes) {
      n.edge_count = edgeCounts.get(n.id) ?? 0;
    }

    return { nodes, edges };
  }

  function parseBooleanParam(value: string | null): boolean {
    return value === "true" || value === "1";
  }

  function clampInt(value: string | null, defaultValue: number, min: number, max: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(max, Math.max(min, parsed));
  }

  function safeJsonParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  type TimelineEntryView = {
    seq: number;
    timestamp: string;
    tool: string;
    params?: unknown;
    result_summary: string;
    is_write: boolean;
    is_error: boolean;
    affected_ids: string[];
  };

  type TimelineQueryOptions = {
    writesOnly?: boolean;
    tool?: string;
    since?: string;
    until?: string;
    limit?: number;
  };

  function parseAffectedIds(raw: string): string[] {
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  }

  function buildNodeTimestampEntries(): TimelineEntryView[] {
    const staged: Array<{
      timestamp: string;
      tool: string;
      params?: unknown;
      result_summary: string;
      is_write: boolean;
      is_error: boolean;
      affected_ids: string[];
      order: number;
    }> = [];

    const nodes = db.getAllNodesRaw();
    for (const node of nodes) {
      if (node.created_at) {
        staged.push({
          timestamp: node.created_at,
          tool: "create_concept",
          params: { id: node.id, kind: node.kind, parent_id: node.parent_id },
          result_summary: `created ${node.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [node.id],
          order: 0,
        });
      }

      if (node.updated_at && node.updated_at !== node.created_at) {
        staged.push({
          timestamp: node.updated_at,
          tool: "update_concept",
          params: { id: node.id },
          result_summary: `updated ${node.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [node.id],
          order: 1,
        });
      }

      if (node.removed_at) {
        staged.push({
          timestamp: node.removed_at,
          tool: "remove_concept",
          params: { id: node.id },
          result_summary: `removed ${node.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [node.id],
          order: 2,
        });
      }
    }

    staged.sort((a, b) => {
      const timestampCmp = a.timestamp.localeCompare(b.timestamp);
      if (timestampCmp !== 0) return timestampCmp;
      const orderCmp = a.order - b.order;
      if (orderCmp !== 0) return orderCmp;
      return (a.affected_ids[0] ?? "").localeCompare(b.affected_ids[0] ?? "");
    });

    return staged.map((entry, index) => ({
      seq: index + 1,
      timestamp: entry.timestamp,
      tool: entry.tool,
      params: entry.params,
      result_summary: entry.result_summary,
      is_write: entry.is_write,
      is_error: entry.is_error,
      affected_ids: entry.affected_ids,
    }));
  }

  function buildMergedTimelineEntries(options: TimelineQueryOptions = {}): {
    entries: TimelineEntryView[];
    source: "merged" | "timeline" | "node_timestamps";
  } {
    const syntheticEntries = buildNodeTimestampEntries()
      .filter((entry) => !options.tool || entry.tool === options.tool)
      .filter((entry) => !options.since || entry.timestamp >= options.since)
      .filter((entry) => !options.until || entry.timestamp <= options.until);

    const bounds = db.getTimelineBounds();
    const realEntries = bounds.count > 0
      ? db.getTimelineEntries({
          writesOnly: options.writesOnly,
          tool: options.tool,
          since: options.since,
          until: options.until,
        }).map((row) => ({
          seq: row.seq,
          timestamp: row.timestamp,
          tool: row.tool,
          params: safeJsonParse(row.params),
          result_summary: row.result_summary,
          is_write: row.is_write === 1,
          is_error: row.is_error === 1,
          affected_ids: parseAffectedIds(row.affected_ids),
        }))
      : [];

    const realCreateIds = new Set<string>();
    const realUpdateIds = new Set<string>();
    const realRemoveIds = new Set<string>();
    for (const entry of realEntries) {
      if (entry.tool === "create_concept") {
        for (const id of entry.affected_ids) realCreateIds.add(id);
      } else if (entry.tool === "update_concept") {
        for (const id of entry.affected_ids) realUpdateIds.add(id);
      } else if (entry.tool === "remove_concept") {
        for (const id of entry.affected_ids) realRemoveIds.add(id);
      }
    }

    const dedupedSyntheticEntries = syntheticEntries
      .filter((entry) => !options.writesOnly || entry.is_write)
      .filter((entry) => {
        const id = entry.affected_ids[0];
        if (!id) return true;
        if (entry.tool === "create_concept") return !realCreateIds.has(id);
        if (entry.tool === "update_concept") return !realUpdateIds.has(id);
        if (entry.tool === "remove_concept") return !realRemoveIds.has(id);
        return true;
      });

    const merged = [...realEntries, ...dedupedSyntheticEntries]
      .map((entry, idx) => ({ entry, idx }))
      .sort((a, b) => {
        const timestampCmp = a.entry.timestamp.localeCompare(b.entry.timestamp);
        if (timestampCmp !== 0) return timestampCmp;
        return a.idx - b.idx;
      })
      .map(({ entry }, idx) => ({
        ...entry,
        seq: idx + 1,
      }));

    const limited = typeof options.limit === "number" ? merged.slice(0, options.limit) : merged;

    const source = realEntries.length > 0 && dedupedSyntheticEntries.length > 0
      ? "merged"
      : realEntries.length > 0
      ? "timeline"
      : "node_timestamps";

    return { entries: limited, source };
  }

  function sampleEntries<T>(entries: T[], n: number): T[] {
    if (entries.length <= n) return entries;
    if (n <= 1) return [entries[0]];

    const sampled: T[] = [];
    const maxIndex = entries.length - 1;
    const step = maxIndex / (n - 1);
    const seen = new Set<number>();

    for (let i = 0; i < n; i += 1) {
      const index = i === n - 1 ? maxIndex : Math.round(i * step);
      if (seen.has(index)) continue;
      seen.add(index);
      sampled.push(entries[index]);
    }

    return sampled;
  }

  /**
   * План 06 (W-07): статусные переходы едут в ТОЙ ЖЕ typed-форме, что и
   * остальные события оси (TimelineEntryView) — UI ждёт tool/timestamp/
   * result_summary, а DB отдаёт {node_id, from_status, to_status, reason, at}.
   * Дата нормализуется (непарсабельная остаётся как есть, но не становится
   * undefined), порядок хронологический (DB отдаёт DESC).
   */
  function statusTimelineEntries(limit: number): TimelineEntryView[] {
    const rows = db.getAllStatusHistory(limit);
    const normalized = rows.map((row, idx) => {
      const at = typeof row.at === "string" && row.at.trim() !== "" ? row.at : "";
      const transition = `${row.from_status ?? "∅"} → ${row.to_status}`;
      return {
        seq: idx + 1,
        timestamp: at,
        tool: "status",
        params: { node_id: row.node_id, from_status: row.from_status, to_status: row.to_status },
        result_summary: `${row.node_id}: ${transition}${row.reason ? ` — ${row.reason}` : ""}`,
        is_write: true,
        is_error: false,
        affected_ids: [row.node_id],
      };
    });
    // Хронологический порядок оси: DB отдаёт свежие первыми (ORDER BY id DESC).
    normalized.reverse();
    return normalized.map((entry, idx) => ({ ...entry, seq: idx + 1 }));
  }

  function initializeSseSnapshot(): void {
    const nodes = db.getAllActiveNodes();
    const edges = db.getAllEdges();

    lastKnownNodeIds = new Set(nodes.map((n) => n.id));
    lastKnownNodeUpdates = new Map(nodes.map((n) => [n.id, n.updated_at]));
    lastKnownEdgeKeys = new Set(edges.map((e) => `${e.from_id}|${e.to_id}|${e.relation}`));
  }

  function broadcast(event: { type: string; data: unknown }): void {
    const msg = `data: ${JSON.stringify(event)}\n\n`;
    sseClients = sseClients.filter((client) => {
      try {
        client.write(msg);
        return true;
      } catch {
        return false;
      }
    });
  }

  function detectChanges(): void {
    try {
      const nodes = db.getAllActiveNodes();
      const edges = db.getAllEdges();

      const currentNodeIds = new Set(nodes.map((n) => n.id));
      const currentNodeUpdates = new Map(nodes.map((n) => [n.id, n.updated_at]));
      const currentEdgeKeys = new Set(edges.map((e) => `${e.from_id}|${e.to_id}|${e.relation}`));

      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const edgeByKey = new Map(edges.map((e) => [`${e.from_id}|${e.to_id}|${e.relation}`, e]));

      const edgeCounts = new Map<string, number>();
      for (const e of edges) {
        edgeCounts.set(e.from_id, (edgeCounts.get(e.from_id) ?? 0) + 1);
        edgeCounts.set(e.to_id, (edgeCounts.get(e.to_id) ?? 0) + 1);
      }

      let hasChanges = false;

      for (const id of currentNodeIds) {
        if (!lastKnownNodeIds.has(id)) {
          const node = nodeById.get(id);
          if (!node) continue;
          broadcast({
            type: "node_added",
            data: {
              id: node.id,
              name: node.name,
              kind: node.kind,
              summary: node.summary,
              parent_id: node.parent_id,
              status: (node as { status?: string }).status ?? "active",
              edge_count: edgeCounts.get(node.id) ?? 0,
            },
          });
          hasChanges = true;
        }
      }

      for (const [id, updatedAt] of currentNodeUpdates) {
        if (!lastKnownNodeIds.has(id)) continue;
        if ((lastKnownNodeUpdates.get(id) ?? "") !== updatedAt) {
          const node = nodeById.get(id);
          if (!node) continue;
          // План 06 (W-06): update несёт ВСЕ поля модели — без status и
          // parent_id клиент после reconnect применял событие к устаревшему
          // состоянию (статус и родитель оставались прежними).
          broadcast({
            type: "node_updated",
            data: {
              id: node.id,
              name: node.name,
              kind: node.kind,
              summary: node.summary,
              parent_id: node.parent_id,
              status: (node as { status?: string }).status ?? "active",
              edge_count: edgeCounts.get(node.id) ?? 0,
            },
          });
          hasChanges = true;
        }
      }

      for (const id of lastKnownNodeIds) {
        if (!currentNodeIds.has(id)) {
          broadcast({ type: "node_removed", data: { id } });
          hasChanges = true;
        }
      }

      for (const key of currentEdgeKeys) {
        if (!lastKnownEdgeKeys.has(key)) {
          const edge = edgeByKey.get(key);
          if (!edge) continue;
          broadcast({
            type: "edge_added",
            data: {
              from: edge.from_id,
              to: edge.to_id,
              relation: edge.relation,
              description: edge.description,
            },
          });
          hasChanges = true;
        }
      }

      for (const key of lastKnownEdgeKeys) {
        if (!currentEdgeKeys.has(key)) {
          const [from, to, relation] = key.split("|");
          broadcast({
            type: "edge_removed",
            data: { from, to, relation },
          });
          hasChanges = true;
        }
      }

      lastKnownNodeIds = currentNodeIds;
      lastKnownNodeUpdates = currentNodeUpdates;
      lastKnownEdgeKeys = currentEdgeKeys;

      if (hasChanges) {
        const stats = db.getStats();
        const kinds = db.getKindsBreakdown();
        broadcast({
          type: "stats",
          data: {
            nodes: stats.nodes,
            edges: stats.edges,
            removed: stats.removed,
            kinds,
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(pc.red(`  SSE change detection failed: ${message}`));
    }
  }

  const htmlPath = resolveHtmlPath();

  if (!fs.existsSync(htmlPath)) {
    console.log();
    errorBold(`HTML file not found at ${pc.dim(htmlPath)}`);
    console.log(pc.dim(`  This may indicate an incomplete installation. Try reinstalling megamemory.\n`));
    process.exit(1);
  }

  // 2.1.9 F1: a missing vendor file degrades to the CDN with a printed note —
  // never a silent 404 in the script tag.
  const d3 = resolveD3Src();
  if (d3.note) console.log(pc.yellow(`  ${d3.note}`));
  const htmlContent = fs
    .readFileSync(htmlPath, "utf-8")
    .replaceAll("{{VERSION}}", VERSION)
    .replaceAll("{{D3_SRC}}", d3.src);

  let embeddingsReady = false;
  let embeddingInitError: string | null = null;

  // Warm the model in the background: serve must not block on a ~120 MB
  // first-run download, and there is nothing to preload at all when the
  // vector channel is disabled (model mismatch pending reembed).
  if (isTextOnlySearchMode()) {
    console.log(pc.dim("  MEGAMEMORY_SEARCH=fts — text search only, model not loaded."));
  } else if (vectorSearchEnabled(db)) {
    console.log(pc.dim("  Loading embedding model in background..."));
    void initializeEmbeddings()
      .then(() => {
        embeddingsReady = true;
        console.log(pc.dim("  Embedding model ready."));
      })
      .catch((err: unknown) => {
        embeddingInitError = err instanceof Error ? err.message : String(err);
        console.log(pc.yellow("  Warning: Embedding model failed to preload."));
        console.log(pc.dim("  Semantic search will retry on demand."));
      });
  } else {
    console.log(pc.dim("  Vector search disabled — text search only (run megamemory reembed)."));
  }

  const server = http.createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    // ---- F1 2.1.13: gate — Host и Origin до любых маршрутов ----
    // Host не из белого списка (в т.ч. чужой порт) → 403: защита от DNS
    // rebinding, одного loopback-bind недостаточно. Ответ один, без
    // CORS-заголовков.
    if (!hostMatches(req.headers.host, port)) {
      json(res, { error: "Forbidden: unknown host" }, 403);
      return;
    }
    // Чужой Origin/Referer → 403 на любом методе; POST дополнительно
    // проходит same-origin (gate общий — см. sameOrigin).
    if (!sameOrigin(req.headers.origin, req.headers.referer, req.headers.host!)) {
      json(res, { error: "Forbidden: cross-origin request" }, 403);
      return;
    }

    // ---- Routes ----

    if (pathname === "/" && req.method === "GET") {
      html(res, htmlContent);
      return;
    }

    if (pathname.startsWith("/vendor/") && req.method === "GET") {
      const webDir = resolveWebDir();
      const vendorRoot = path.join(webDir, "vendor");
      const rel = path.normalize(decodeURIComponent(pathname.slice("/vendor/".length)));
      const filePath = path.join(vendorRoot, rel);
      if (!filePath.startsWith(vendorRoot + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        notFound(res);
        return;
      }
      const types: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json" };
      const type = types[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (pathname === "/api/graph" && req.method === "GET") {
      // T4: status filter — "active" hides superseded/deprecated nodes and
      // their supersedes edges; "all" (default) shows everything.
      const statusFilter = url.searchParams.get("status") ?? "all";
      const { nodes, edges } = buildGraphPayload();
      let filteredNodes = nodes;
      let filteredEdges = edges;
      if (statusFilter === "active") {
        const allowed = new Set(
          nodes.filter((n) => (n.status ?? "active") === "active").map((n) => n.id)
        );
        filteredNodes = nodes.filter((n) => allowed.has(n.id));
        filteredEdges = edges.filter(
          (e) => allowed.has(e.from) && allowed.has(e.to)
        );
      }
      json(res, { nodes: filteredNodes, edges: filteredEdges });
      return;
    }

    if (pathname === "/api/search" && req.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      const rawTopK = Number.parseInt(url.searchParams.get("top_k") ?? "10", 10);
      const topK = Number.isFinite(rawTopK) ? Math.min(50, Math.max(1, rawTopK)) : 10;

      if (query.length === 0) {
        json(res, { matches: [] });
        return;
      }

      if (!embeddingsReady && !isTextOnlySearchMode()) {
        try {
          await initializeEmbeddings();
          embeddingsReady = true;
          embeddingInitError = null;
        } catch (err) {
          embeddingInitError = err instanceof Error ? err.message : String(err);
          json(
            res,
            {
              error: "Semantic search is temporarily unavailable",
              detail: embeddingInitError,
            },
            503,
          );
          return;
        }
      }

      const results = await understand(db, { query, top_k: topK });
      // compact mode (fork default) returns rows in `compact` with a budget
      // meta; map them back onto `matches` so the explorer keeps one shape.
      const matches =
        results.compact ??
        results.matches.map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          status: "active",
          summary: m.summary,
          file_refs: m.file_refs,
          similarity: m.similarity,
          via: m.via,
        }));
      json(res, {
        matches,
        meta: results.meta ?? null,
      });
      return;
    }

    // U5: status transitions of one node.
    if (pathname.startsWith("/api/node/") && pathname.endsWith("/history") && req.method === "GET") {
      const raw = decodeURIComponent(pathname.slice("/api/node/".length, -"/history".length));
      const id = db.getAliasTarget(raw) ?? raw;
      if (!db.getNode(id)) {
        json(res, { error: `Concept "${raw}" not found` }, 404);
        return;
      }
      json(res, { id, history: db.getStatusHistory(id, 20) });
      return;
    }

    // U2: single-node markdown download (no file writes — browser gets it).
    if (pathname.startsWith("/api/node/") && pathname.endsWith(".md") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/node/".length, -".md".length));
      const node = db.getNode(db.getAliasTarget(id) ?? id);
      if (!node) {
        json(res, { error: `Concept "${id}" not found` }, 404);
        return;
      }
      const outgoing = db.getOutgoingEdges(node.id).map((e) => ({ relation: e.relation, to_id: e.to_id }));
      const children = db.getChildren(node.id).filter((c) => c.kind !== "digest");
      const md = renderNodeMarkdown(node, outgoing, children);
      // HTTP headers must stay ASCII: provide a sanitized fallback name
      // plus an RFC 5987 filename* with the full unicode slug.
      const slug = node.id.split("/").join("-");
      const asciiName =
        slug.replace(/[^a-zA-Z0-9._-]/g, "").replace(/^-+/, "") || "node.md";
      const utf8Name = encodeURIComponent(slug + ".md");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition":
          `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      });
      res.end(md);
      return;
    }

    // U2: whole-graph export bundle (JSON map of markdown files).
    if (pathname === "/api/export.json" && req.method === "GET") {
      const files = renderAllMarkdown(db);
      const bundle = {
        generated_at: new Date().toISOString(),
        files: Object.fromEntries(files),
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="megamemory-export.json"`,
      });
      res.end(JSON.stringify(bundle, null, 2));
      return;
    }

    if (pathname.startsWith("/api/node/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/node/".length));
      // Б12: resolve ids renamed by repair-ids.
      const node = db.getNode(db.getAliasTarget(id) ?? id);
      if (!node) {
        json(res, { error: `Concept "${id}" not found` }, 404);
        return;
      }
      const ctx = buildNodeWithContext(db, node);
      // U4: digests expose their source concepts and staleness.
      if (node.kind === "digest") {
        const info = digestSourceChildren(db, node.id);
        (ctx as unknown as Record<string, unknown>).digest_children = info.children;
        (ctx as unknown as Record<string, unknown>).stale = info.stale;
      }
      // Add timestamps
      const result = {
        ...ctx,
        created_at: node.created_at,
        updated_at: node.updated_at,
        created_by_task: node.created_by_task,
      };
      // UX-01 (план 07): карточка explorer несёт дайджесты формулировки, как
      // get_concept, — подтверждённая версия видна при сравнении перед
      // слиянием (те же поля планов 04, не своя структура).
      result.current_digests = currentDigestsOf(node);
      json(res, result);
      return;
    }

    if (pathname === "/api/health" && req.method === "GET") {
      // U3: same metrics the CLI doctor prints, for the explorer header chip.
      json(res, healthPayload(db));
      return;
    }

    if (pathname === "/api/consolidate" && req.method === "GET") {
      // T5 DoD: explorer tab lists duplicate candidates without mutating.
      const threshold = Number.parseFloat(url.searchParams.get("threshold") ?? "0.95");
      const candidates = findDuplicates(db, {
        threshold: Number.isFinite(threshold) ? threshold : 0.95,
      });
      json(res, { candidates });
      return;
    }

    if (pathname === "/api/consolidate/preview" && req.method === "GET") {
      // UX-01 (план 07): read-only описание последствий слияния — тот же
      // планировщик (planConsolidation), что исполняет apply. Ни одной записи.
      const survivor = (url.searchParams.get("survivor") ?? "").trim();
      const other = (url.searchParams.get("other") ?? "").trim();
      if (!survivor || !other) {
        json(res, { error: "survivor and other query params are required" }, 400);
        return;
      }
      json(res, describeConsolidation(db, survivor, other));
      return;
    }

    if (pathname === "/api/consolidate" && req.method === "POST") {
      // F1 2.1.13: единственный мутирующий маршрут — под замком.
      // 1) Content-Type строго application/json (charset допустим);
      // 2) тело ≤ 64 КБ;
      // 3) ровно один ответ на любой исход, база меняется только после
      //    успешного разбора и валидации (mergeNodes пишет в транзакции).
      const contentType = String(req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        req.resume(); // слить тело, чтобы сокет остался пригодным
        json(res, { error: "Content-Type must be application/json" }, 415);
        return;
      }
      const MAX_BODY = 64 * 1024;
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      let responded = false;
      const respondOnce = (status: number, payload: unknown): void => {
        if (responded) return;
        responded = true;
        json(res, payload, status);
      };
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on("error", () => {
        respondOnce(400, { error: "Request stream failed; nothing was written" });
      });
      // План 06 (W-02): единый try/catch на весь callback — ни один исход
      // разбора тела не завершает процесс. JSON.parse, вернувший null/массив/
      // скаляр, отбраковывается объектной схемой до чтения полей (раньше
      // `body.survivor` на null бросал TypeError и ронял сервер).
      req.on("end", () => {
        try {
          if (tooLarge) {
            respondOnce(413, { error: `Request body exceeds the ${MAX_BODY}-byte limit` });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            respondOnce(400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            respondOnce(400, { error: "A JSON object with survivor and other is required" });
            return;
          }
          const body = parsed as { survivor?: unknown; other?: unknown; base?: unknown };
          const survivor = typeof body.survivor === "string" ? body.survivor.trim() : "";
          const other = typeof body.other === "string" ? body.other.trim() : "";
          if (!survivor || !other) {
            respondOnce(400, { error: "survivor and other are required" });
            return;
          }
          // UX-01 (план 07): версии карточек/плана, на которых пользователь
          // подтверждал preview. Необязательное поле (CLI-совместимость);
          // допустимые значения — строка или null, всё остальное отбраковка.
          let versionExpect: { survivor_updated_at?: string | null; other_updated_at?: string | null } | undefined;
          if (body.base !== undefined) {
            if (typeof body.base !== "object" || body.base === null || Array.isArray(body.base)) {
              respondOnce(400, { error: "base must be an object with updated_at tokens" });
              return;
            }
            const rawBase = body.base as { survivor_updated_at?: unknown; other_updated_at?: unknown };
            const token = (value: unknown): string | null | undefined => {
              if (value === undefined) return undefined;
              if (value === null) return null;
              return typeof value === "string" ? value : undefined;
            };
            const survivorToken = token(rawBase.survivor_updated_at);
            const otherToken = token(rawBase.other_updated_at);
            if (survivorToken === undefined || otherToken === undefined) {
              respondOnce(400, { error: "base tokens must be strings or null" });
              return;
            }
            versionExpect = {};
            if (survivorToken !== undefined) versionExpect.survivor_updated_at = survivorToken;
            if (otherToken !== undefined) versionExpect.other_updated_at = otherToken;
          }
          let result: MergeNodesResult;
          try {
            result = mergeNodes(db, survivor, other, versionExpect ? { expect: versionExpect } : undefined);
          } catch (err) {
            // Stale preview: нода изменилась/удалена между preview и confirm —
            // атомарный отказ, ни одной записи; UI перечитывает карточки.
            if (err instanceof VersionConflictError) {
              respondOnce(409, { error: "version_conflict", detail: err.message });
              return;
            }
            respondOnce(400, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
          respondOnce(200, { ok: true, ...result });
        } catch (err) {
          respondOnce(500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    if (pathname === "/api/stats" && req.method === "GET") {
      const stats = db.getStats();
      const kinds = db.getKindsBreakdown();
      // Embedding state: model, dimension, last reindex — surfaced in the
      // explorer so "which model are my vectors from" is visible at a glance.
      const embeddings = {
        model: db.getMetaValue("embed_model") ?? null,
        dim: db.getMetaValue("embed_dim")
          ? Number(db.getMetaValue("embed_dim"))
          : null,
        last_reembed: db.getMetaValue("last_reembed") ?? null,
        vector_search: vectorSearchEnabled(db),
      };
      const mem = process.memoryUsage();
      json(res, {
        ...stats,
        kinds,
        embeddings,
        usage: db.getUsageStats(7),
        memory: {
          rss_mb: Math.round(mem.rss / (1024 * 1024)),
          heap_used_mb: Math.round(mem.heapUsed / (1024 * 1024)),
          external_mb: Math.round(mem.external / (1024 * 1024)),
          model_loaded: isModelLoaded(),
        },
      });
      return;
    }

    if (pathname === "/api/events" && req.method === "GET") {
      // F1 2.1.13: без Access-Control-Allow-Origin — same-origin интерфейсу
      // SSE не нужен, чужой origin уже отсечён gate-ом.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const { nodes, edges } = buildGraphPayload();
      const stats = db.getStats();
      const kinds = db.getKindsBreakdown();
      const initPayload = {
        nodes,
        edges,
        stats: {
          nodes: stats.nodes,
          edges: stats.edges,
          removed: stats.removed,
        },
        kinds,
      };
      res.write(`data: ${JSON.stringify({ type: "init", data: initPayload })}\n\n`);

      sseClients.push(res);

      req.on("close", () => {
        sseClients = sseClients.filter((client) => client !== res);
      });
      return;
    }

    if (pathname === "/api/timeline/bounds" && req.method === "GET") {
      const merged = buildMergedTimelineEntries();
      if (merged.entries.length > 0) {
        json(res, {
          first: merged.entries[0].timestamp,
          last: merged.entries[merged.entries.length - 1].timestamp,
          count: merged.entries.length,
          source: merged.source,
        });
        return;
      }

      json(res, { first: null, last: null, count: 0, source: "none" as const });
      return;
    }

    if (pathname === "/api/timeline/ticks" && req.method === "GET") {
      const n = clampInt(url.searchParams.get("n"), 100, 1, 500);
      const merged = buildMergedTimelineEntries();
      const ticks = sampleEntries(merged.entries, n).map((row) => ({
        seq: row.seq,
        timestamp: row.timestamp,
        tool: row.tool,
        result_summary: row.result_summary,
      }));
      json(res, { ticks, source: merged.source });
      return;
    }

    // U5: status lifecycle history — kind=status, tools, or all (default).
    // План 06 (W-08): фильтры разбираются ДО kind-ветвления и применяются
    // последовательно; kind без явного параметра не отрывает запрос от
    // фильтрового обработчика (раньше дефолт "all" съедал writes_only/tool/
    // since/until молча).
    if (pathname === "/api/timeline" && req.method === "GET") {
      const kindParam = url.searchParams.get("kind");
      const kind = (kindParam ?? "all").trim();
      if (kind !== "all" && kind !== "status" && kind !== "tools") {
        json(res, { error: `Unknown timeline kind: ${kind}` }, 400);
        return;
      }
      const writesOnly = parseBooleanParam(url.searchParams.get("writes_only"));
      const tool = (url.searchParams.get("tool") ?? "").trim();
      const since = (url.searchParams.get("since") ?? "").trim();
      const until = (url.searchParams.get("until") ?? "").trim();
      const limit = clampInt(url.searchParams.get("limit"), kind === "status" ? 200 : 1000, 1, 50000);

      if (kind === "status") {
        // Статусная ось фильтров tool/writes_only/since/until не имеет —
        // неподдержанное сочетание честный 400, а не молчаливое игнорирование.
        if (tool || since || until || writesOnly) {
          json(res, { error: "kind=status supports only the limit parameter" }, 400);
          return;
        }
        json(res, { kind: "status", entries: statusTimelineEntries(limit) });
        return;
      }

      const merged = buildMergedTimelineEntries({
        writesOnly,
        tool: tool || undefined,
        since: since || undefined,
        until: until || undefined,
        limit,
      });
      if (kind === "all") {
        json(res, {
          kind: "all",
          entries: merged.entries,
          status_changes: statusTimelineEntries(limit),
          source: merged.source,
        });
        return;
      }
      json(res, { entries: merged.entries, source: merged.source });
      return;
    }

    if (pathname === "/api/graph/at" && req.method === "GET") {
      const t = (url.searchParams.get("t") ?? "").trim();
      if (!t) {
        json(res, { error: "Missing required query parameter: t" }, 400);
        return;
      }

      const nodes = db.getNodesAtTime(t).map((n) => ({
        id: n.id,
        name: n.name,
        kind: n.kind,
        summary: n.summary,
        parent_id: n.parent_id,
        edge_count: 0,
      }));

      const edges = db.getEdgesAtTime(t).map((e) => ({
        from: e.from_id,
        to: e.to_id,
        relation: e.relation,
        description: e.description,
      }));

      const edgeCounts = new Map<string, number>();
      for (const edge of edges) {
        edgeCounts.set(edge.from, (edgeCounts.get(edge.from) ?? 0) + 1);
        edgeCounts.set(edge.to, (edgeCounts.get(edge.to) ?? 0) + 1);
      }
      for (const node of nodes) {
        node.edge_count = edgeCounts.get(node.id) ?? 0;
      }

      json(res, { nodes, edges });
      return;
    }

    notFound(res);
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(pc.red(`  Web request failed: ${message}`));
      json(res, { error: "Internal server error" }, 500);
    });
  });

  initializeSseSnapshot();
  const pollInterval = setInterval(detectChanges, 1500);
  const heartbeatInterval = setInterval(() => {
    sseClients = sseClients.filter((client) => {
      try {
        client.write(": heartbeat\n\n");
        return true;
      } catch {
        return false;
      }
    });
  }, 30000);

  // План 06 (W-05): gate и URL сверяются с ФАКТИЧЕСКИМ bound-портом — после
  // retry он отличается от запрошенного. Запросы приходят только после
  // listen, так как переприсваивание до первого запроса гарантировано.
  port = await listenWithRetry(server, port, host, dbPath);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log(pc.dim("\n  Shutting down...\n"));
    clearInterval(pollInterval);
    clearInterval(heartbeatInterval);
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // noop
      }
    }
    server.close();
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(pollInterval);
    clearInterval(heartbeatInterval);
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // noop
      }
    }
    server.close();
    db.close();
    process.exit(0);
  });
}
