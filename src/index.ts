#!/usr/bin/env node

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { errorBold, validatePort } from "./cli-utils.js";
import { createTimelineLogger } from "./timeline.js";
import { instructionsStatus } from "./instructions.js";

// ---- CLI routing ----

const VERSION = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version;

const HELP = `
${pc.bold(pc.cyan("megamemory"))} ${pc.green(`v${VERSION}`)} ${pc.dim("— persistent project knowledge graph for coding agents")}

${pc.bold("Commands:")}
  ${pc.cyan("(no command)")}    Start the MCP stdio server ${pc.dim("(invoked by your editor)")}
  ${pc.cyan("install")}         Configure editor/agent integration (interactive)
  ${pc.cyan("serve")}           Start the web graph explorer
  ${pc.cyan("stats")}           Show knowledge graph statistics
  ${pc.cyan("merge")}           Merge two knowledge.db files
  ${pc.cyan("conflicts")}       List unresolved merge conflicts
  ${pc.cyan("resolve")}         Resolve a merge conflict
  ${pc.cyan("repair-ids")}      Fix legacy empty/trailing-slash node ids ${pc.dim("(default: dry-run)")}
  ${pc.cyan("migrate")}         Upgrade an upstream v1.6.2 database to the fork schema ${pc.dim("(default: dry-run)")}
  ${pc.cyan("reembed")}         Reindex node embeddings with the current model ${pc.dim("(--batch N)")}
  ${pc.cyan("consolidate")}     Find and merge near-duplicate nodes ${pc.dim("(default: dry-run)")}
  ${pc.cyan("digest")}          Rebuild module digest nodes ${pc.dim("(default: dry-run)")}
  ${pc.cyan("export --md <dir>")} Export the graph to markdown files ${pc.dim("(--check for CI)")}
  ${pc.cyan("doctor")}          Health check of the current database ${pc.dim("(exit 1 on problems)")}
  ${pc.cyan("eval")}            Measure search recall@k on the eval set ${pc.dim("(fixtures/eval.jsonl)")}

${pc.bold("Options:")}
  ${pc.cyan("--target")} ${pc.dim("NAME")}    Install target (opencode, claudecode, antigravity, codex)
  ${pc.cyan("--port")} ${pc.dim("PORT")}     Port for the web explorer ${pc.dim("(default: 4321)")}
  ${pc.cyan("--into")} ${pc.dim("FILE")}     Output path for merge ${pc.dim("(default: overwrites file1)")}
  ${pc.cyan("--left-label")}    Label for left side in merge ${pc.dim("(default: left)")}
  ${pc.cyan("--right-label")}   Label for right side in merge ${pc.dim("(default: right)")}
  ${pc.cyan("--keep")}          Resolution strategy: left, right, or both
  ${pc.cyan("--json")}          Machine-readable output for conflicts
  ${pc.cyan("--db")} ${pc.dim("PATH")}       Database path for stats/conflicts/resolve
  ${pc.cyan("--help, -h")}      Show this help
  ${pc.cyan("--version, -v")}   Show version

${pc.bold("Examples:")}
  ${pc.dim("$")} megamemory install                                   ${pc.dim("Interactive editor integration setup")}
  ${pc.dim("$")} megamemory install --target claudecode              ${pc.dim("Non-interactive Claude Code setup")}
  ${pc.dim("$")} megamemory serve                                     ${pc.dim(`Open graph explorer at ${pc.underline("http://localhost:4321")}`)}
  ${pc.dim("$")} megamemory serve --port 8080                         ${pc.dim("Custom port")}
  ${pc.dim("$")} megamemory merge main.db feature.db --into merged.db ${pc.dim("Merge two knowledge DBs")}
  ${pc.dim("$")} megamemory conflicts                                 ${pc.dim("View unresolved conflicts")}
  ${pc.dim("$")} megamemory resolve <group-id> --keep left            ${pc.dim("Resolve a conflict")}
  ${pc.dim("$")} megamemory repair-ids --apply                        ${pc.dim("Rename broken ids after backup")}
`.trim();

const KNOWN_COMMANDS = new Set(["install", "serve", "stats", "merge", "conflicts", "resolve", "repair-ids", "migrate", "reembed", "consolidate", "digest", "export", "doctor", "eval", "--help", "-h", "--version", "-v"]);

function parseFlags(args: string[]): { port?: number; rawPort?: string } {
  const portIdx = args.indexOf("--port");
  const rawPort = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : undefined;
  const port = rawPort ? parseInt(rawPort, 10) : undefined;
  return { port, rawPort };
}

const cmd = process.argv[2];

switch (cmd) {
  case "install": {
    const { runInstall } = await import("./install.js");
    await runInstall(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "serve": {
    const flags = parseFlags(process.argv.slice(3));
    const port = flags.port ?? 4321;

    const portError = validatePort(port, flags.rawPort);
    if (portError) {
      errorBold(portError);
      process.exit(1);
    }

    const { runServe } = await import("./web.js");
    await runServe(port);
    break;
  }

  case "stats": {
    const { runStats } = await import("./stats.js");
    await runStats(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "merge": {
    const { runMerge } = await import("./merge-cli.js");
    await runMerge(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "conflicts": {
    const { runConflicts } = await import("./merge-cli.js");
    await runConflicts(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "resolve": {
    const { runResolve } = await import("./merge-cli.js");
    await runResolve(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "repair-ids": {
    const { runRepairIds } = await import("./migrate-cli.js");
    await runRepairIds(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "migrate": {
    const { runMigrate } = await import("./migrate-cli.js");
    await runMigrate(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "eval": {
    const { runEvalCli } = await import("./eval-cli.js");
    await runEvalCli(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "doctor": {
    const { runDoctorCli } = await import("./doctor-cli.js");
    await runDoctorCli(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "export": {
    const { runExport } = await import("./export-cli.js");
    await runExport(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "digest": {
    const { runDigest } = await import("./digest-cli.js");
    await runDigest(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "consolidate": {
    const { runConsolidate } = await import("./consolidate-cli.js");
    await runConsolidate(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "reembed": {
    const { runReembed } = await import("./reembed-cli.js");
    await runReembed(process.argv.slice(3));
    process.exit(0);
    break;
  }

  case "--help":
  case "-h":
    console.log(HELP);
    process.exit(0);
    break;

  case "--version":
  case "-v":
    console.log(`${pc.bold("megamemory")} ${pc.green(`v${VERSION}`)}`);
    process.exit(0);
    break;

  default:
    if (cmd && !KNOWN_COMMANDS.has(cmd)) {
      // User typed an unknown command — don't silently start MCP
      errorBold(`Unknown command '${cmd}'.`);
      console.log(pc.dim(`  Run ${pc.cyan("megamemory --help")} for usage.\n`));
      process.exit(1);
    }
    // No command → start MCP server (normal invocation by editor)
    try {
      await startMcpServer();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`MEGAMEMORY_ERROR: ${errorMsg}`);
      process.exit(1);
    }
    break;
}

// ---- MCP Server ----

async function startMcpServer() {
  const { McpServer } = await import(
    "@modelcontextprotocol/sdk/server/mcp.js"
  );
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { z } = await import("zod");
  const path = await import("path");
  const { KnowledgeDB } = await import("./db.js");
  const { understand, getConcept, createConcept, updateConcept, link, removeConcept, listRoots, listConflicts, resolveConflict, formatError, trailSave, trailGet, trailRefresh, trailExtend, slotSet, slotGet, slotRelease, slotList, taskAdd, taskDone, board } =
    await import("./tools.js");
  const { provenanceTrace, provenanceAudit } = await import("./provenance.js");
  const { confirmSupports } = await import("./support-baselines.js");

  type NodeKind = import("./types.js").NodeKind;
  type RelationType = import("./types.js").RelationType;

  // ---- Configuration ----
  const DB_PATH =
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db");

  const db = new KnowledgeDB(DB_PATH);

  // F14: a legacy database converts itself on first open (backup, schema,
  // id repair with aliases, FTS rebuild, name_norm, embed meta) and is
  // verified before serving. MEGAMEMORY_AUTO_MIGRATE=0 opts out — then
  // only the additive schema steps run and id repair stays manual.
  try {
    const { autoMigrateIfNeeded, describeAutoMigration } = await import(
      "./auto-migrate.js"
    );
    if (process.env.MEGAMEMORY_AUTO_MIGRATE === "0") {
      const { ensureSchema, emptyReport } = await import("./migrate-schema.js");
      ensureSchema(db, emptyReport());
    } else {
      const result = await autoMigrateIfNeeded(db, DB_PATH);
      const line = describeAutoMigration(result);
      if (line) console.error(`megamemory: ${line}`);
      if (result.report_file) {
        console.error(`megamemory: migration report ${result.report_file}`);
      }
      for (const w of result.warnings) {
        console.error(`megamemory: ${w}`);
      }
    }
  } catch (err) {
    console.error(
      `MEGAMEMORY_ERROR: startup migration failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exit(1);
  }

  const timeline = createTimelineLogger(db);

  let dbClosed = false;
  function shutdown() {
    if (dbClosed) return;
    dbClosed = true;
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  const server = new McpServer({
    name: "megamemory",
    version: VERSION,
  });

  // ---- Zod schemas ----
  const NodeKindEnum = z.enum([
    "feature", "module", "pattern", "config", "decision", "component", "digest",
  ]);
  const RelationEnum = z.enum([
    "connects_to", "depends_on", "implements", "calls", "configured_by", "supersedes", "contradicts", "informed_by",
  ]);

  // ---- Register tools ----

  server.tool(
    "understand",
    "Query the project knowledge graph. Call this before starting any task to load relevant context about concepts, features, and architecture. Returns matched concepts in a token-budgeted compact form (id, name, kind, summary trimmed to 240 chars, file_refs); pass mode:'full' for the legacy verbose output with why/children/edges on every node.",
    {
      query: z.string().describe("Natural language query describing what you want to understand about the project"),
      top_k: z.number().int().min(1).max(50).optional().describe("Number of top results to return (default: 10)"),
      max_tokens: z.number().int().min(100).max(20000).optional().describe("Token budget for the answer (default: 1500)"),
      mode: z.enum(["compact", "full"]).optional().describe("compact (default) trims each node to essentials under the budget; full returns legacy verbose output"),
      include_inactive: z.boolean().optional().describe("Include superseded/deprecated nodes (default: false)"),
    },
    async (params) => {
      try {
        const result = await understand(db, {
          query: params.query,
          top_k: params.top_k,
          max_tokens: params.max_tokens,
          mode: params.mode,
          include_inactive: params.include_inactive,
        });
        const returned = result.meta?.returned ?? result.matches.length;
        const ids = result.compact
          ? result.compact.map((m) => m.id)
          : result.matches.map((match) => match.id);
        timeline.log({
          tool: "understand",
          params: { query: params.query, top_k: params.top_k },
          result_summary: `${returned} matches`,
          is_write: false,
          is_error: false,
          affected_ids: ids,
        });
        // Plan 3 step 7.3: staleness travels in the response the agent
        // already reads — it cannot see stderr.
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...result, ...instructionsStatus(VERSION) }, null, 2) },
          ],
        };
      } catch (err) {
        timeline.log({
          tool: "understand",
          params: { query: params.query, top_k: params.top_k },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "get_concept",
    "Look up a concept by its exact ID. Returns the concept with its full context including children, edges, incoming edges, and parent. Unlike 'understand' which uses semantic search, this does exact ID matching. Use this when you know the specific concept ID.",
    {
      id: z.string().describe("Exact concept ID to look up (e.g., 'auth-module' or 'database-config')"),
    },
    async (params) => {
      try {
        const result = getConcept(db, { id: params.id });
        timeline.log({
          tool: "get_concept",
          params: { id: params.id },
          result_summary: `found ${result.id}`,
          is_write: false,
          is_error: false,
          affected_ids: [result.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "get_concept",
          params: { id: params.id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "create_concept",
    "Add a new concept to the knowledge graph. Call this after completing a task to record new features, components, patterns, or decisions you built. Include specific details: parameter names, defaults, file locations, and rationale. У decision/pattern передавай evidence — список {ref | node, why}: файл или уже существующий узел, на котором держится вывод, плюс рационал. Опоры создаются в том же вызове, отдельный link потом не нужен. Если evidence нет, а file_refs и why заполнены — опоры будут выведены автоматически по файлам. Факт без informed_by на источник (файл, тест, лог, диалог) помечается ungrounded и выпадает из замыкания провенанса. Если включён строгий режим (provenance.require_support), decision без опоры отклоняется — передавай evidence в том же вызове.",
    {
      name: z.string().describe("Human-readable name for the concept"),
      kind: NodeKindEnum.describe("Type of concept: feature, module, pattern, config, decision, component"),
      summary: z.string().describe("What this concept is. Be specific: include parameter names, defaults, file paths, behavior details."),
      why: z.string().optional().describe("Why this exists or was built this way"),
      parent_id: z.string().optional().describe("Parent concept ID for nesting; empty string is treated as omitted"),
      file_refs: z.array(z.string()).optional().describe("Relevant file paths + optional line ranges"),
      supersedes: z.array(z.string()).optional().describe("Concept IDs this one replaces — creates supersedes edges and marks the old nodes superseded (T4)"),
      evidence: z.array(z.object({
        ref: z.string().optional().describe("Файл (+ строка), на котором держится вывод; узел-факт создастся, если файл ещё никто не цитирует"),
        node: z.string().optional().describe("Существующий узел-опора"),
        why: z.string().describe("Рационал: что именно в этой опоре поддерживает вывод — обязателен"),
      })).optional().describe("Опоры для decision/pattern — {ref | node, why}: файл или существующий узел плюс рационал. Создаются в том же вызове; ровно одно из ref/node на элемент"),
      edges: z.array(z.object({
        to: z.string().describe("Target concept ID"),
        relation: RelationEnum.describe("Relationship type"),
        description: z.string().optional().describe("Why this relationship exists. Обязателен (непуст) для informed_by: что именно в узле-to поддерживает from — ребро без рационала будет отклонено вместе со всем батчем."),
      })).optional().describe("Relationships to other existing concepts"),
      created_by_task: z.string().optional().describe("Description of the task that created this concept"),
      epistemic_status: z.enum(["open", "validated", "refuted", "abandoned"]).optional().describe("Initial epistemic state (default: open). 'validated' requires status_scope with an artifact"),
      status_scope: z.record(z.unknown()).optional().describe("Scope of a 'validated' claim, JSON: {env?, version?, dataset?, artifact?} — artifact (test/run id) is mandatory for validated"),
    },
    async (params) => {
      try {
        const result = await createConcept(db, {
          name: params.name,
          kind: params.kind as NodeKind,
          summary: params.summary,
          why: params.why,
          parent_id: params.parent_id,
          file_refs: params.file_refs,
          edges: params.edges?.map((e) => ({ ...e, relation: e.relation as RelationType })),
          evidence: params.evidence,
          supersedes: params.supersedes,
          created_by_task: params.created_by_task,
          epistemic_status: params.epistemic_status,
          status_scope: params.status_scope,
        });
        // T6: auto-digest the parent when it gained its 5th+ child.
        let digestNote = "";
        try {
          const { maybeAutoDigest } = await import("./digest.js");
          const digest = await maybeAutoDigest(db, params.parent_id ?? null);
          if (digest) digestNote = ` Digest built: ${digest.digestId}`;
        } catch {
          // digest building must never fail the create
        }

        timeline.log({
          tool: "create_concept",
          params: { name: params.name, kind: params.kind, parent_id: params.parent_id },
          result_summary: `created ${result.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [result.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, message: result.message + digestNote }, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "create_concept",
          params: { name: params.name, kind: params.kind, parent_id: params.parent_id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "update_concept",
    "Update an existing concept in the knowledge graph. Call this after completing a task that changed existing features or components. Only include fields that changed.",
    {
      id: z.string().describe("The concept ID to update"),
      changes: z.object({
        name: z.string().optional().describe("New name"),
        kind: NodeKindEnum.optional().describe("New kind"),
        summary: z.string().optional().describe("Updated summary"),
        why: z.string().optional().describe("Updated rationale"),
        file_refs: z.array(z.string()).optional().describe("Updated file references"),
        epistemic_status: z.enum(["open", "validated", "refuted", "abandoned"]).optional().describe("Epistemic verdict transition; epistemic_reason is mandatory with it. Valid moves: open->validated/refuted/abandoned, validated->refuted/abandoned, refuted->open, abandoned->open"),
        epistemic_reason: z.string().optional().describe("Why this epistemic transition — recorded in status_history, required with epistemic_status"),
        status_scope: z.record(z.unknown()).optional().describe("Scope for 'validated': {env?, version?, dataset?, artifact?}; artifact (test/run id) is mandatory"),
      }),
    },
    async (params) => {
      try {
        const result = await updateConcept(db, {
          id: params.id,
          changes: { ...params.changes, kind: params.changes.kind as NodeKind | undefined },
        });
        timeline.log({
          tool: "update_concept",
          params: { id: params.id, changed_fields: Object.keys(params.changes) },
          result_summary: `updated ${params.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [params.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "update_concept",
          params: { id: params.id, changed_fields: Object.keys(params.changes) },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "link",
    "Create a relationship between two existing concepts. Для informed_by рационал обязателен: «из from следует to, потому что <конкретно>». Связь без рационала нечитаема и потому бесполезна.",
    {
      from: z.string().describe("Source concept ID"),
      to: z.string().describe("Target concept ID"),
      relation: RelationEnum.describe("Relationship type"),
      description: z.string().optional().describe("Why this relationship exists. Обязателен (непуст) для informed_by: что именно в узле-to поддерживает from."),
    },
    async (params) => {
      try {
        const result = link(db, {
          from: params.from, to: params.to,
          relation: params.relation as RelationType,
          description: params.description,
        });
        timeline.log({
          tool: "link",
          params: { from: params.from, to: params.to, relation: params.relation },
          result_summary: `linked ${params.from} -> ${params.to}`,
          is_write: true,
          is_error: false,
          affected_ids: [params.from, params.to],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "link",
          params: { from: params.from, to: params.to, relation: params.relation },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "remove_concept",
    "Soft-delete a concept from the knowledge graph. The concept and its removal reason are preserved in history. На узле, на котором держатся активные решения (входящие informed_by), удаление отклоняется — в отказе три шага на выбор: замена через преемника, опровержение (update → refuted) или force: true. Цепочки с участием узла помечаются stale с указанием причины.",
    {
      id: z.string().describe("The concept ID to remove"),
      reason: z.string().describe("Why this concept is being removed"),
      force: z.boolean().optional().describe("Разорвать опору и удалить: рёбра надгробятся, решения останутся без опоры (ungrounded в отчётах). Только когда данные на узле больше не нужны"),
    },
    async (params) => {
      try {
        const result = removeConcept(db, { id: params.id, reason: params.reason, force: params.force });
        timeline.log({
          tool: "remove_concept",
          params: { id: params.id },
          result_summary: `removed ${params.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [params.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "remove_concept",
          params: { id: params.id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "list_roots",
    "List all top-level concepts in the knowledge graph. Budgeted overview: id, name, kind and child count per root (roots_compact), no summaries — pass max_tokens to control the budget.",
    {
      max_tokens: z.number().int().min(100).max(20000).optional().describe("Token budget for the overview (default: 1500)"),
    },
    async (params) => {
      try {
        const result = listRoots(db, { max_tokens: params.max_tokens });
        const returned = result.meta?.returned ?? result.roots.length;
        timeline.log({
          tool: "list_roots",
          params: {},
          result_summary: `${returned} roots`,
          is_write: false,
          is_error: false,
          affected_ids: [],
        });
        // Plan 3 step 7.3: same staleness fields as understand — both are
        // startup/diagnostic calls the agent reads before working.
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, ...instructionsStatus(VERSION), stats: db.getStats() }, null, 2),
            },
          ],
        };
      } catch (err) {
        timeline.log({
          tool: "list_roots",
          params: {},
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "list_conflicts",
    "List all unresolved merge conflicts in the knowledge graph, grouped by merge_group. Each group contains competing versions with full data. Call this when the user runs /merge to begin AI-assisted conflict resolution.",
    {},
    async () => {
      try {
        const result = listConflicts(db);
        timeline.log({
          tool: "list_conflicts",
          params: {},
          result_summary: `${result.conflicts.length} conflict groups`,
          is_write: false,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "list_conflicts",
          params: {},
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "resolve_conflict",
    "Resolve a merge conflict by providing the correct resolved content. Read both conflict versions, verify against the current codebase, then provide the accurate resolved summary. Do NOT just pick a side — write the truth.",
    {
      merge_group: z.string().describe("The merge_group UUID of the conflict to resolve"),
      resolved: z.object({
        summary: z.string().describe("The correct, resolved summary for this concept — verified against the current codebase"),
        why: z.string().optional().describe("Updated rationale"),
        file_refs: z.array(z.string()).optional().describe("Updated file references"),
      }).describe("The resolved content to write — must reflect current codebase truth"),
      reason: z.string().describe("Explanation of what you verified and why this resolution is correct"),
    },
    async (params) => {
      try {
        const result = await resolveConflict(db, {
          merge_group: params.merge_group,
          resolved: params.resolved,
          reason: params.reason,
        });
        timeline.log({
          tool: "resolve_conflict",
          params: { merge_group: params.merge_group },
          result_summary: `resolved ${params.merge_group}`,
          is_write: true,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "resolve_conflict",
          params: { merge_group: params.merge_group },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  // ---- Provenance tools (plan 3 §4.2) ----

  server.tool(
    "provenance_trace",
    "Прежде чем отвечать на вопрос «почему/на каком основании», вызови provenance_trace. Ответ на «почему» без трассировки считается необоснованным. Обход по informed_by в одну сторону: ancestry — «на чём стоит этот вывод», impact — «кто на него опирается». Контракты: (1) обход идёт только по informed_by, по живым рёбрам (retrospective добавляет надгробия), весь ответ — один снапшот БД; (2) удалённый узел терминален — сквозь него не считают и не разворачивают, в ретроспективе он виден заглушкой; (3) total_within_depth считает узлы в пределах глубины, причина неполноты — truncated_by: depth | nodes | scan | null; (4) in_paths — число путей от корня до узла в показанном подграфе, а не число подтверждений; при потолке помечается in_paths_capped (текстово «≥ 100000»), путь через неразрешённый цикл даёт in_paths: null и запись в weak_links с id компоненты — число не выдумывается; (5) лимиты ограничивают и выдачу, и работу: depth (0–20), max_nodes (корень не занимает слот) и бюджет сканирования max_scan_nodes (по умолчанию 5000) — при его срабатывании truncated_by = «scan» и total_within_depth — нижняя оценка (total_exact: false); тот же бюджет ограничивает проверку опор решений — проверяются первые по id, запись support_check_truncated сообщает checked/total. Слабые звенья идут первыми: refuted/abandoned, циклы (по компонентам: id, ребро-свидетель, needs_merge, «компонента закрыта для записи»), рёбра без рационала, решения без опор (no_support), с отсутствующими (missing_support) или только ungrounded-опорами — такие записи несут числовые count и sample (первые ≤5 id), note не длиннее 300 символов. weak_links целиком не превышают 8 КБ: при превышении записи режутся по приоритету и добавляется маркер weak_links_truncated (shown/total). completeness различает «связей нет» (complete) и «связи скрыты» (has_hidden), усечённый обход помечается truncated. Снимок обоснования: решение несёт блок support_check — сверку живых опор с подтверждённым снимком; состояния unchanged/changed (причины per опоры: summary|status|rationale|removed)/unknown/incomplete, unknown и incomplete чистотой не считаются; изменение опоры не стирается добавлением новых рёбер. Подтверждение — отдельный вызов confirm_supports с digest'ами прочитанных формулировок; ни одна мутация (link/update/merge) снимок не пишет и не обновляет.",
    {
      node_id: z.string().describe("Узел, с которого начинается обход"),
      direction: z.enum(["ancestry", "impact"]).optional().describe("ancestry (по умолчанию) — что поддерживает узел; impact — что на него опирается"),
      depth: z.number().int().min(1).max(20).optional().describe("Глубина обхода (по умолчанию 6)"),
      max_nodes: z.number().int().min(1).max(2000).optional().describe("Лимит узлов сверх корня (по умолчанию 200)"),
      max_scan_nodes: z.number().int().min(1).max(100000).optional().describe("Бюджет сканирования — сколько узлов разворачивать (по умолчанию 5000); при срабатывании total_exact: false"),
      max_check_edges: z.number().int().min(1).max(1000000).optional().describe("Бюджет проверки снимка опор — сколько пар «решение—опора» сверять за вызов (по умолчанию 5000); при исчерпании support_check.state = incomplete, а не unchanged"),
      max_check_bytes: z.number().int().min(1).max(20000000).optional().describe("Байтовый бюджет проверки снимка (по умолчанию 2 МБ)"),
      retrospective: z.boolean().optional().describe("Вернуть и надгробия — «как думали раньше»; удалённые эндпоинты приходят заглушками и считаются в лимит max_nodes"),
    },
    async (params) => {
      try {
        const result = provenanceTrace(db, {
          node_id: params.node_id,
          direction: params.direction,
          depth: params.depth,
          max_nodes: params.max_nodes,
          max_scan_nodes: params.max_scan_nodes,
          max_check_edges: params.max_check_edges,
          max_check_bytes: params.max_check_bytes,
          retrospective: params.retrospective,
        });
        timeline.log({
          tool: "provenance_trace",
          params: { node_id: params.node_id, direction: result.direction },
          result_summary: `${result.shown}/${result.total_within_depth} nodes, ${result.completeness}, weak: ${result.weak_links.length}`,
          is_write: false,
          is_error: false,
          affected_ids: result.nodes.map((n) => n.id),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "provenance_trace",
          params: { node_id: params.node_id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "provenance_audit",
    "«Что рассыплется, если это неверно»: обратный обход (impact) по informed_by с подсветкой узлов, у которых epistemic_status != validated (поле at_risk). Каждый прогон пишется в provenance_audit_runs с ретеншном — последние 200 на узел, не старше 90 дней, чтобы ретроспектива «что мы знали тогда» не врала после того, как граф уехал.",
    {
      node_id: z.string().describe("Узел, корректность которого проверяется"),
      direction: z.enum(["ancestry", "impact"]).optional().describe("impact (по умолчанию) — что рассыплется; ancestry — на чём стоит"),
      depth: z.number().int().min(1).max(20).optional().describe("Глубина обхода (по умолчанию 6)"),
      max_nodes: z.number().int().min(1).max(2000).optional().describe("Лимит узлов (по умолчанию 200)"),
      max_scan_nodes: z.number().int().min(1).max(100000).optional().describe("Бюджет сканирования (по умолчанию 5000); при срабатывании total_exact: false"),
      max_check_edges: z.number().int().min(1).max(1000000).optional().describe("Бюджет проверки снимка опор (по умолчанию 5000)"),
      max_check_bytes: z.number().int().min(1).max(20000000).optional().describe("Байтовый бюджет проверки снимка (по умолчанию 2 МБ)"),
      retrospective: z.boolean().optional().describe("Вернуть и надгробия"),
    },
    async (params) => {
      try {
        const result = provenanceAudit(db, {
          node_id: params.node_id,
          direction: params.direction,
          depth: params.depth,
          max_nodes: params.max_nodes,
          max_scan_nodes: params.max_scan_nodes,
          max_check_edges: params.max_check_edges,
          max_check_bytes: params.max_check_bytes,
          retrospective: params.retrospective,
        });
        timeline.log({
          tool: "provenance_audit",
          params: { node_id: params.node_id, direction: result.direction },
          result_summary: `run #${result.audit_run_id}: ${result.shown}/${result.total_within_depth} nodes, at_risk ${result.nodes.filter((n) => n.at_risk).length}`,
          is_write: false,
          is_error: false,
          affected_ids: result.nodes.map((n) => n.id),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "provenance_audit",
          params: { node_id: params.node_id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  // ---- Support baseline confirmation (plan 4 v8) ----

  server.tool(
    "confirm_supports",
    "Записать снимок обоснования решения: сверить digest'ы формулировок, которые агент прочитал, с текущими и атомарно записать опоры. items подтверждает ровно перечисленные опоры — живые опоры вне списка остаются unknown, «подтверждены по умолчанию» не бывают; ПУСТОЙ список = «подтверждаю, что опор нет» (валидное состояние, отличное от «не проверялось»). Любое расхождение ожидаемого с текущим — отказ version_conflict, ничего не записывается: перечитай опоры через provenance_trace/get_concept и повтори с актуальными digest'ами. Ни link, ни update_concept, ни merge снимок не пишут — подтверждение только этим вызовом (единственное исключение: create_concept с evidence подтверждает переданные в том же вызове версии). Автоматические рёбра при подтверждении получают accepted_at, created_via не переписывается.",
    {
      decision_id: z.string().describe("ID решения, снимок которого записывается"),
      expected_claim_digest: z.string().describe("claim_digest формулировки решения, которую агент видел (get_concept/provenance_trace отдают текущий)"),
      items: z.array(z.object({
        support_id: z.string().describe("ID узла-опоры"),
        expected_claim_digest: z.string().describe("claim_digest саммари опоры, который агент читал"),
        expected_edge_digest: z.string().describe("edge_digest рационала ребра, который агент читал"),
      })).describe("Подтверждаемые опоры с ожидаемыми digest'ами; пустой массив = «опор нет»"),
      note: z.string().optional().describe("Произвольная пометка агента (попадает в timeline)"),
    },
    async (params) => {
      try {
        const result = confirmSupports(db, {
          decision_id: params.decision_id,
          expected_claim_digest: params.expected_claim_digest,
          items: params.items,
          note: params.note,
        });
        timeline.log({
          tool: "confirm_supports",
          params: { decision_id: params.decision_id, note: params.note },
          result_summary: `confirmed ${result.confirmed} support(s)`,
          is_write: true,
          is_error: false,
          affected_ids: [params.decision_id, ...params.items.map((i) => i.support_id)],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "confirm_supports",
          params: { decision_id: params.decision_id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  // ---- Workflow tools (plan 2, schema v6) ----

  server.tool(
    "trail_save",
    "Save a reasoning chain: an ordered list of concept ids plus a mandatory author summary of WHY the conclusion follows. Member meaning is fingerprinted at save time; reads compare against the current state and mark the chain stale/broken when the ground shifted. Use after a non-trivial decision.",
    {
      node_ids: z.array(z.string()).min(1).describe("Ordered chain members: premises first, conclusion last"),
      summary: z.string().describe("Author summary of the reasoning — why this conclusion follows from these nodes"),
      name: z.string().optional().describe("Human-readable chain name (default: auto-generated)"),
    },
    async (params) => {
      try {
        const result = trailSave(db, params);
        timeline.log({
          tool: "trail_save",
          params: { name: params.name },
          result_summary: `saved ${result.id}`,
          is_write: true,
          is_error: false,
          affected_ids: params.node_ids,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "trail_save",
          params: { name: params.name },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "trail_get",
    "Read a reasoning chain with its freshness verdict: fresh (member meaning unchanged), stale (a member's summary/epistemic status/informed_by changed or was removed), broken (a member was hard-deleted). Stale members carry a per-member reason.",
    {
      id: z.string().describe("Trail id, as returned by trail_save"),
    },
    async (params) => {
      try {
        const result = trailGet(db, params.id);
        timeline.log({
          tool: "trail_get",
          params: { id: params.id },
          result_summary: `state ${result.state}`,
          is_write: false,
          is_error: false,
          affected_ids: result.members.map((m) => m.node_id),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "trail_get",
          params: { id: params.id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "trail_refresh",
    "Re-snapshot the fingerprints of every chain member after you verified the chain still holds. Refuses on a broken chain (a member was hard-deleted) — rebuild it instead.",
    {
      id: z.string().describe("Trail id"),
    },
    async (params) => {
      try {
        const result = trailRefresh(db, params.id);
        timeline.log({
          tool: "trail_refresh",
          params: { id: params.id },
          result_summary: result.message,
          is_write: true,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "trail_refresh",
          params: { id: params.id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "trail_extend",
    "Append new members to the end of an existing reasoning chain; their current meaning is fingerprinted at append time.",
    {
      id: z.string().describe("Trail id"),
      node_ids: z.array(z.string()).min(1).describe("Node ids to append, in order"),
    },
    async (params) => {
      try {
        const result = trailExtend(db, params.id, params.node_ids);
        timeline.log({
          tool: "trail_extend",
          params: { id: params.id },
          result_summary: result.message,
          is_write: true,
          is_error: false,
          affected_ids: params.node_ids,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "trail_extend",
          params: { id: params.id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "slot_set",
    "Take a named role slot (handoff, entrypoint, queue, ...) with a node — the role's single live pointer. Taking a role held by another node writes a supersedes edge and demotes the previous holder; re-taking by the same node is a no-op. Slots are scoped per project.",
    {
      role: z.string().describe("Role name, e.g. 'handoff', 'entrypoint'"),
      node_id: z.string().describe("Concept id that now holds the role"),
    },
    async (params) => {
      try {
        const result = slotSet(db, params.role, params.node_id);
        timeline.log({
          tool: "slot_set",
          params: { role: params.role, node_id: params.node_id },
          result_summary: result.message,
          is_write: true,
          is_error: false,
          affected_ids: [params.node_id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "slot_set",
          params: { role: params.role, node_id: params.node_id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "slot_get",
    "Read who currently holds a role slot.",
    { role: z.string().describe("Role name") },
    async (params) => {
      try {
        const result = slotGet(db, params.role);
        timeline.log({
          tool: "slot_get",
          params: { role: params.role },
          result_summary: result.message,
          is_write: false,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "slot_get",
          params: { role: params.role },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "slot_release",
    "Release a role slot. The previous holder node is NOT touched — releasing a role never revokes or deletes the handoff history.",
    { role: z.string().describe("Role name") },
    async (params) => {
      try {
        const result = slotRelease(db, params.role);
        timeline.log({
          tool: "slot_release",
          params: { role: params.role },
          result_summary: result.message,
          is_write: true,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "slot_release",
          params: { role: params.role },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "slot_list",
    "List all role slots of the project with their current holders.",
    {},
    async () => {
      try {
        const result = slotList(db);
        timeline.log({
          tool: "slot_list",
          params: {},
          result_summary: `${result.slots.length} slots`,
          is_write: false,
          is_error: false,
          affected_ids: result.slots.map((s) => s.node_id),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "slot_list",
          params: {},
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "task_add",
    "Add a task card to the board. Tasks live in the open column and rot over time: rot = age + isolation penalty + overdue penalty — the board surfaces what is burning, not what is fresh.",
    {
      name: z.string().describe("Task name (becomes the concept name)"),
      due: z.string().optional().describe("Due date, e.g. '2026-11-15'"),
    },
    async (params) => {
      try {
        const result = taskAdd(db, params.name, params.due);
        timeline.log({
          tool: "task_add",
          params: { name: params.name, due: params.due },
          result_summary: `created ${result.id}`,
          is_write: true,
          is_error: false,
          affected_ids: [result.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "task_add",
          params: { name: params.name, due: params.due },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "task_done",
    "Close a task: it moves to the terminal done column and its due date is cleared — a closed task never hangs overdue.",
    { id: z.string().describe("Task concept id") },
    async (params) => {
      try {
        const result = taskDone(db, params.id);
        timeline.log({
          tool: "task_done",
          params: { id: params.id },
          result_summary: result.message,
          is_write: true,
          is_error: false,
          affected_ids: [params.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "task_done",
          params: { id: params.id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  server.tool(
    "board",
    "Show the task board: the open column sorted by rot (overdue > isolated > oldest) and the terminal done column fresh-first. Call this instead of guessing what to work on next.",
    {},
    async () => {
      try {
        const result = board(db);
        timeline.log({
          tool: "board",
          params: {},
          result_summary: result.summary,
          is_write: false,
          is_error: false,
          affected_ids: [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "board",
          params: {},
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  // ---- Start ----
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`megamemory MCP server started (db: ${DB_PATH})`);
}
