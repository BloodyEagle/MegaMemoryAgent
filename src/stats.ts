import fs from "fs";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { errorBold } from "./cli-utils.js";
import { listRoots } from "./tools.js";
import { resolveDbPathOrExit } from "./db-path.js";
import { supportQualityBreakdown } from "./stub.js";
import { computeFunnel, formatFunnel } from "./funnel.js";

const KIND_ORDER = ["feature", "module", "component", "pattern", "config", "decision"];

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = -1;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }

  const formatted = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${units[idx]}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function printRow(label: string, value: string, detail?: string): void {
  const prefix = `    ${pc.cyan(`${label}:`.padEnd(16))}${pc.green(value)}`;
  if (detail) {
    console.log(`${prefix} ${pc.dim(detail)}`);
    return;
  }
  console.log(prefix);
}

function sortedKinds(kinds: Record<string, number>): Array<[string, number]> {
  const preferred = KIND_ORDER.filter((kind) => kinds[kind] !== undefined).map((kind) => [kind, kinds[kind]] as [string, number]);
  const extra = Object.entries(kinds)
    .filter(([kind]) => !KIND_ORDER.includes(kind))
    .sort(([a], [b]) => a.localeCompare(b));
  return [...preferred, ...extra];
}

export async function runStats(args: string[]): Promise<void> {
  const dbPath = resolveDbPathOrExit(args);

  let dbStat: fs.Stats;
  try {
    dbStat = fs.statSync(dbPath);
  } catch (err) {
    errorBold(`Failed to stat database file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // План 13 §2.3: `stats --funnel` — воронка «understand → follow-up →
  // запись» по журналу timeline. `--json` печатает ТОЛЬКО JSON-объект:
  // его парсит скрипт снятия метрик, остальной вывод stats мешал бы.
  // Скриптовый снимок не должен мутировать базу — открываем readonly,
  // если это единственное, что попросили (--prune требует записи).
  const funnelMode = args.includes("--funnel");
  const jsonMode = args.includes("--json");
  const pruneRequested = getFlag(args, "--prune") !== undefined;
  if (funnelMode && jsonMode && !pruneRequested) {
    const readonlyDb = new KnowledgeDB(dbPath, { readonly: true });
    try {
      console.log(JSON.stringify(computeFunnel(readonlyDb), null, 2));
    } finally {
      readonlyDb.close();
    }
    return;
  }

  const db = new KnowledgeDB(dbPath);
  try {
    // F5 (2.1.1): manual journal cleanup — runs the same retention rules the
    // automatic write-time prune uses, regardless of the write counter, and
    // reports exactly what it deleted.
    if (pruneRequested) {
      const { byAge, byCount } = db.pruneTimeline();
      const total = byAge + byCount;
      console.log(
        total > 0
          ? pc.green(
              `Timeline pruned: ${formatNumber(total)} entr${total === 1 ? "y" : "ies"} removed ` +
                `(${formatNumber(byAge)} by age, ${formatNumber(byCount)} over the limit).`
            )
          : pc.dim("Timeline pruned: nothing to remove (retention rules are 0 or already satisfied).")
      );
    }

    const stats = db.getStats();
    const rootCount = db.getRootNodes().length;
    const timelineCount = db.getTimelineBounds().count;
    const kinds = db.getKindsBreakdown();
    const nodes = db.getAllActiveNodes();

    const childCount = nodes.filter((node) => node.parent_id !== null).length;

    // Per-node size analysis
    let totalChars = 0;
    let totalBytes = 0;
    let totalTokens = 0;
    let largest: { name: string; tokens: number } | null = null;
    let smallest: { name: string; tokens: number } | null = null;

    for (const node of nodes) {
      const payload = JSON.stringify({
        name: node.name,
        summary: node.summary,
        why: node.why ?? "",
        file_refs: node.file_refs ?? "",
      });
      const chars = payload.length;
      const bytes = Buffer.byteLength(payload, "utf8");
      const tokens = Math.ceil(chars / 4);

      totalChars += chars;
      totalBytes += bytes;
      totalTokens += tokens;

      if (!largest || tokens > largest.tokens) {
        largest = { name: node.name, tokens };
      }
      if (!smallest || tokens < smallest.tokens) {
        smallest = { name: node.name, tokens };
      }
    }

    const avgTokens = nodes.length > 0 ? Math.ceil(totalTokens / nodes.length) : 0;

    // list_roots payload analysis (matches what MCP server actually sends)
    // 2.1.13 F3: ответ всегда компактный — счётчики из roots_compact.
    const listRootsResult = listRoots(db);
    const listRootsPayload = JSON.stringify({ ...listRootsResult, stats: db.getStats() }, null, 2);
    const listRootsChars = listRootsPayload.length;
    const listRootsTokens = Math.ceil(listRootsChars / 4);
    const listRootsNodeCount = (listRootsResult.roots_compact ?? []).reduce(
      (sum, r) => sum + 1 + r.child_count,
      0
    );
    const listRootsRootCount = (listRootsResult.roots_compact ?? []).length;

    // Print output
    console.log(pc.bold(pc.cyan("megamemory stats")));
    console.log();

    console.log(`  ${pc.bold("Database")}`);
    printRow("Path", dbPath);
    printRow("File size", formatBytes(dbStat.size), `(${formatNumber(dbStat.size)} bytes)`);
    console.log();

    console.log(`  ${pc.bold("Graph")}`);
    printRow("Nodes", formatNumber(stats.nodes), `(${formatNumber(rootCount)} root, ${formatNumber(childCount)} children)`);
    printRow("Edges", formatNumber(stats.edges));
    printRow("Removed", formatNumber(stats.removed));
    // 2.1.12 F1: активные узлы с вышедшим сроком годности — «ещё в графе,
    // но уже не знания». Superseded/deprecated не считаются: у них своя
    // строка старости (stale nodes в doctor).
    printRow(
      "Expired",
      formatNumber(db.countExpiredNodes()),
      "активные узлы с valid_until в прошлом — не отдаются understand"
    );
    printRow("Timeline", `${formatNumber(timelineCount)} entries`);
    console.log();

    console.log(`  ${pc.bold("list_roots")}`);
    printRow("Nodes", formatNumber(listRootsNodeCount), `(${listRootsRootCount} roots + ${listRootsNodeCount - listRootsRootCount} children)`);
    printRow("Response size", `~${formatNumber(listRootsTokens)} tokens`, `(${formatNumber(listRootsChars)} chars)`);
    console.log();

    console.log(`  ${pc.bold("Kinds")}`);
    for (const [kind, count] of sortedKinds(kinds)) {
      printRow(kind, formatNumber(count));
    }
    if (Object.keys(kinds).length === 0) {
      printRow("-", "0");
    }
    console.log();

    console.log(`  ${pc.bold("Size")}`);
    printRow("Total tokens", `~${formatNumber(totalTokens)}`);
    printRow("Total chars", formatNumber(totalChars), `(${formatNumber(totalBytes)} bytes)`);
    printRow("Avg node tokens", `~${formatNumber(avgTokens)}`);
    if (largest) {
      printRow("Largest", `${largest.name} (${formatNumber(largest.tokens)} tokens)`);
    } else {
      printRow("Largest", "N/A");
    }
    if (smallest) {
      printRow("Smallest", `${smallest.name} (${formatNumber(smallest.tokens)} tokens)`);
    } else {
      printRow("Smallest", "N/A");
    }

    // T8: token usage accounting.
    const usage = db.getUsageStats(7);
    if (usage.total_queries > 0) {
      console.log();
      console.log(`  ${pc.bold("Usage (7 days)")}`);
      printRow("Queries", formatNumber(usage.total_queries));
      printRow("Tokens returned", `~${formatNumber(usage.total_tokens)}`);
      printRow("Avg per answer", `~${formatNumber(usage.avg_tokens)} tokens`);
      for (const tq of usage.top_queries) {
        printRow("Top query", `"${tq.query.slice(0, 40)}"`, `${formatNumber(tq.n)}x`);
      }
    }

    // Plan 4 v8 §8: four different numbers — none of them measures reasoning
    // quality, and none may be substituted for another in reports.
    const { provenanceMetrics, CheckBudget } = await import("./support-baselines.js");
    const prov = provenanceMetrics(db, new CheckBudget(50000, 20_000_000));
    console.log();
    console.log(`  ${pc.bold("Provenance")}`);
    printRow(
      "Edges by origin",
      `agent ${formatNumber(prov.edges_by_origin.agent)}, auto ${formatNumber(prov.edges_by_origin.auto)}, unknown ${formatNumber(prov.edges_by_origin.unknown)}`
    );
    printRow("Edges accepted", formatNumber(prov.edges_accepted), "explicitly accepted auto edges");
    printRow("Decisions w/ support", formatNumber(prov.decisions_with_live_support));
    // 2.1.10 F1: the support line splits by origin — anchors (file-fact
    // nodes built by evidence: [{ref}]) are supports by design, their
    // template summary is not a defect; claims are hand-written nodes.
    const supportSplit = supportQualityBreakdown(db);
    printRow(
      "Supports",
      formatNumber(supportSplit.total),
      `(anchors ${formatNumber(supportSplit.anchors)}, claims ${formatNumber(supportSplit.claims)})`
    );
    // 2.1.9 F2 / 2.1.10 F1: stub supports read as confirmation — the count
    // sits right next to the support metric it deflates. Only hand-written
    // rows (created_via='agent') count; anchors never do.
    printRow(
      "Stubs",
      formatNumber(supportSplit.stubs),
      "ручные опоры с шаблонным/коротким саммари — утверждения нет"
    );
    printRow(
      "Decisions w/o live support",
      formatNumber(prov.no_live_supports),
      "snapshot or claim anchor kept, edges gone (F8)"
    );
    printRow(
      "Superseded supports",
      formatNumber(prov.decisions_with_superseded_supports),
      "decisions whose supports were confirmed, then acknowledged gone (F7)"
    );
    printRow(
      "Snapshot check",
      `unchanged ${formatNumber(prov.decisions_by_check_state.unchanged)}, changed ${formatNumber(prov.decisions_by_check_state.changed)}, unknown ${formatNumber(prov.decisions_by_check_state.unknown)}, incomplete ${formatNumber(prov.decisions_by_check_state.incomplete)}`
    );
    if (prov.metrics_truncated) {
      printRow("Note", "metrics truncated by budget — counts are lower estimates");
    }

    // План 13 §2.3: секция воронки в конце вывода — остальной stats не ломает.
    if (funnelMode) {
      console.log();
      for (const line of formatFunnel(computeFunnel(db))) {
        console.log(line);
      }
    }
  } finally {
    db.close();
  }
}
