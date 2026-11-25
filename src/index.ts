#!/usr/bin/env node

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { errorBold, validatePort } from "./cli-utils.js";
import { resolveDbPathOrExit, resolveRepoPath } from "./db-path.js";
import { buildHelp } from "./help.js";
import { createTimelineLogger } from "./timeline.js";
import { createTelemetryLogger, telemetryPathFromEnv, wrapToolHandler } from "./telemetry.js";
import { instructionsStatus } from "./instructions.js";
import { commandIndex } from "./cli-flags.js";
import { NODE_KINDS } from "./types.js";
import { parseToolSurface } from "./tool-surface.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

// ---- CLI routing ----

const VERSION = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version;

const MCP_INSTRUCTIONS = `MegaMemory ${VERSION}: перед задачей вызови understand. Нужен код — include_source: true; stale_warning = файл менялся после записи, перечитай ref. После работы сохрани проверенный вывод через create_concept с evidence (ref/node, why), связи — link с description. Перед завершением выполни next.record и перечисли созданные/обновлённые узлы.`;

const HELP = buildHelp(VERSION);

const KNOWN_COMMANDS = new Set(["install", "hooks", "serve", "stats", "merge", "conflicts", "resolve", "repair-ids", "migrate", "reembed", "consolidate", "digest", "export", "doctor", "eval", "guide", "bench", "expire", "telemetry-report", "--help", "-h", "--version", "-v"]);

function parseFlags(args: string[]): { port?: number; rawPort?: string; host?: string } {
  const portIdx = args.indexOf("--port");
  const rawPort = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : undefined;
  const port = rawPort ? parseInt(rawPort, 10) : undefined;
  const hostIdx = args.indexOf("--host");
  const host = hostIdx !== -1 && args[hostIdx + 1] ? args[hostIdx + 1] : undefined;
  return { port, rawPort, host };
}

const argv = process.argv.slice(2);
let cmdIndex: number;
try {
  cmdIndex = commandIndex(argv);
} catch (err) {
  errorBold(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const cmd = argv[cmdIndex];
const commandArgs = [...argv.slice(0, cmdIndex), ...argv.slice(cmdIndex + 1)];

switch (cmd) {
  case "install": {
    const { runInstall } = await import("./install.js");
    // План 06 (C-01): провал критического шага настройки — неуспех процесса,
    // а не exit(0): CI и скрипты обязаны видеть, что установка не прошла.
    const outcome = await runInstall(commandArgs);
    process.exit(outcome.ok ? 0 : 1);
    break;
  }

  case "hooks": {
    try {
      const { runHooks } = await import("./hooks.js");
      runHooks(commandArgs);
      process.exit(0);
    } catch (err) {
      errorBold(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "serve": {
    const flags = parseFlags(commandArgs);
    const port = flags.port ?? 4321;
    // F1 2.1.13: интерфейс локальный по построению — 127.0.0.1 по умолчанию,
    // ::1 явным флагом. Wildcard (0.0.0.0/::) и имена хостов не принимаются:
    // serve — инструмент для человека за машиной, не сетевой сервис.
    const host = flags.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") {
      errorBold(
        `--host поддерживает только 127.0.0.1 (по умолчанию) и ::1 — обозреватель слушает loopback и сетевым сервисом не является.`
      );
      process.exit(1);
    }

    const portError = validatePort(port, flags.rawPort);
    if (portError) {
      errorBold(portError);
      process.exit(1);
    }

    const { runServe } = await import("./web.js");
    await runServe(port, host);
    break;
  }

  case "stats": {
    const { runStats } = await import("./stats.js");
    await runStats(commandArgs);
    process.exit(0);
    break;
  }

  case "merge": {
    const { runMerge } = await import("./merge-cli.js");
    await runMerge(commandArgs);
    process.exit(0);
    break;
  }

  case "conflicts": {
    const { runConflicts } = await import("./merge-cli.js");
    await runConflicts(commandArgs);
    process.exit(0);
    break;
  }

  case "resolve": {
    const { runResolve } = await import("./merge-cli.js");
    await runResolve(commandArgs);
    process.exit(0);
    break;
  }

  case "repair-ids": {
    const { runRepairIds } = await import("./migrate-cli.js");
    await runRepairIds(commandArgs);
    process.exit(0);
    break;
  }

  case "migrate": {
    const { runMigrate } = await import("./migrate-cli.js");
    await runMigrate(commandArgs);
    process.exit(0);
    break;
  }

  case "eval": {
    const { runEvalCli } = await import("./eval-cli.js");
    await runEvalCli(commandArgs);
    process.exit(0);
    break;
  }

  case "doctor": {
    const { runDoctorCli } = await import("./doctor-cli.js");
    await runDoctorCli(commandArgs);
    process.exit(0);
    break;
  }

  case "export": {
    const { runExport } = await import("./export-cli.js");
    await runExport(commandArgs);
    process.exit(0);
    break;
  }

  case "digest": {
    const { runDigest } = await import("./digest-cli.js");
    await runDigest(commandArgs);
    process.exit(0);
    break;
  }

  case "consolidate": {
    const { runConsolidate } = await import("./consolidate-cli.js");
    await runConsolidate(commandArgs);
    process.exit(0);
    break;
  }

  case "reembed": {
    const { runReembed } = await import("./reembed-cli.js");
    await runReembed(commandArgs);
    process.exit(0);
    break;
  }

  case "guide": {
    // F2 (2.1.5): print the agent-facing text — the same snippet install
    // writes, plus a worked session example and the bench section.
    // W2 (план 20+21 v3): `guide --workflow` печатает поставляемый документ
    // docs/agent-workflow.md байт в байт (ровно один завершающий LF), без
    // баннеров, без открытия базы, без сети. Ошибки флагов и упаковки —
    // явный неуспех процесса, не молчаливое игнорирование.
    const guide = await import("./guide.js");
    try {
      const mode = guide.resolveGuideMode(commandArgs);
      if (mode === "workflow") {
        process.stdout.write(guide.buildWorkflowText());
      } else {
        console.log(guide.buildGuideText());
      }
      process.exit(0);
    } catch (err) {
      errorBold(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "bench": {
    const { runBenchCli } = await import("./bench-cli.js");
    await runBenchCli(commandArgs);
    process.exit(0);
    break;
  }

  case "telemetry-report": {
    // J1 (план 20+21 v3 §15): локальный агрегатор J0-телеметрии. Только
    // локальный JSONL-файл: БД не открывается, сеть не нужна.
    const { runTelemetryReport } = await import("./telemetry-report-cli.js");
    await runTelemetryReport(commandArgs);
    process.exit(0);
    break;
  }

  case "expire": {
    // 2.1.13 F5: ручное проставление valid_until. Ошибки разбора флагов и
    // неизвестные id — отказ без записи; process.exit(1) здесь, чтобы ядро
    // expire-cli оставалось тестируемым (бросает, а не умирает).
    try {
      const { runExpire } = await import("./expire-cli.js");
      await runExpire(commandArgs);
      process.exit(0);
    } catch (err) {
      errorBold(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
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
  const { openStartupDatabase, autoMigrateIfNeeded, describeAutoMigration, describeSchemaRepair } = await import("./auto-migrate.js");
  const { understand, getConcept, createConcept, updateConcept, link, removeConcept, listRoots, listConflicts, resolveConflict, formatError, measureMcpPayload, trailSave, trailSaveWithPassport, trailGet, trailRefresh, trailExtend, slotSet, slotGet, slotRelease, slotList, taskAdd, taskDone, board } =
    await import("./tools.js");
  const { provenanceTrace, provenanceAudit } = await import("./provenance.js");
  const { branchConceptToolArgs, getConceptBatch, getConceptProfile, MAX_CONTEXT_EPOCH_LENGTH, ORIENTATION_DEFAULT_TOKENS, EVIDENCE_DEFAULT_TOKENS, BATCH_DEFAULT_TOKENS } = await import(
    "./concept-profile.js"
  );
  const { confirmSupports, provenanceHistory } = await import("./support-baselines.js");
  const { checkArtifacts } = await import("./artifacts.js");
  const { checkFreshness } = await import("./freshness.js");
  const { scheduleFirstGeneration } = await import("./auto-reembed.js");

  type NodeKind = import("./types.js").NodeKind;
  type RelationType = import("./types.js").RelationType;
  type ConceptReadOutput = import("./types.js").NodeWithContext | import("./types.js").ConceptProfileOutput | import("./types.js").ConceptDeltaOutput | import("./types.js").ConceptBatchOutput;
  const conceptRecordHint = {
    record: "Узел уже есть — уточняй его через update_concept, а не создавай второй; опоры к решению — evidence в том же вызове.",
  };
  const rootsRecordHint = {
    record: "Это обзор; итог работы по конкретной ветке — отдельный узел, а не правка корня.",
  };

  // Подсказка — только MCP-поле: ядро карточки и HTTP-форма остаются прежними.
  // Бюджет (2.14.1/35 T4): отказ мерит ответ без hint; когда ответ влезает,
  // а hint нет — ответ уходит без hint, а не отказом.
  function conceptReadPayload(result: ConceptReadOutput, maxTokens?: number): ConceptReadOutput & { hint?: typeof conceptRecordHint } {
    const nonempty = "batch" in result ? result.batch.some(item => item.status === "ok") : !("unchanged" in result && result.unchanged);
    const profile = "meta" in result ? result.meta.profile : "profile" in result ? result.profile : "full";
    const target = maxTokens ?? ("batch" in result ? BATCH_DEFAULT_TOKENS : profile === "orientation" ? ORIENTATION_DEFAULT_TOKENS : profile === "evidence" ? EVIDENCE_DEFAULT_TOKENS : undefined);
    const baseTokens = measureMcpPayload(result);
    if (target !== undefined && baseTokens > target) {
      throw Object.assign(new Error(`get_concept: max_tokens=${target} cannot fit the required response (budget refusal, minimum ${baseTokens}).`), { meta: { reason: "budget" } });
    }
    const withHint = nonempty ? { ...result, hint: conceptRecordHint } : result;
    const tokens = measureMcpPayload(withHint);
    const fits = target === undefined || tokens <= target;
    const payload = fits ? withHint : result;
    if ("meta" in payload) payload.meta.tokens_estimated = fits ? tokens : baseTokens;
    return payload;
  }

  // ---- Configuration ----
  // MCP-режим, как и serve, законно создаёт базу при первой установке.
  const DB_PATH = resolveDbPathOrExit(process.argv.slice(2), { allowCreate: true });
  // 2.1.12 F2: репозиторий для разрешения git:tag/commit/branch-опор
  // (--repo PATH; по умолчанию — каталог базы). MCP передаёт его как явный
  // repo в каждый check_artifacts: смена startup-пути перезакрепляет git-ref.
  const REPO_PATH = resolveRepoPath(process.argv.slice(2), DB_PATH);

  let db: import("./db.js").KnowledgeDB;

  // F14: a legacy database converts itself on first open (backup, schema,
  // id repair with aliases, FTS rebuild, name_norm, embed meta) and is
  // verified before serving. MEGAMEMORY_AUTO_MIGRATE=0 opts out — then
  // only the additive schema steps run and id repair stays manual.
  try {
    const opened = openStartupDatabase(DB_PATH);
    db = opened.db;
    if (process.env.MEGAMEMORY_AUTO_MIGRATE === "0") {
      const { ensureSchema, emptyReport } = await import("./migrate-schema.js");
      ensureSchema(db, emptyReport());
    } else {
      const result = await autoMigrateIfNeeded(db, DB_PATH, { backupPath: opened.backupPath });
      const line = describeAutoMigration(result);
      if (line) console.error(`megamemory: ${line}`);
      // 2.3.2 (plan 16): incomplete schema on a non-legacy db (the 2.3.1
      // regression) is repaired on open — say so, in its own wording.
      const repairLine = describeSchemaRepair(result);
      if (repairLine) console.error(`megamemory: ${repairLine}`);
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

  void scheduleFirstGeneration(db);
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
  }, { instructions: MCP_INSTRUCTIONS });

  // ---- J0 (план 20+21 v3 §15): локальная телеметрия на уровне ----
  // диспетчеризации инструментов. Opt-in через MEGAMEMORY_TELEMETRY_PATH —
  // локальный append-only JSONL, БД не трогает. Выключена по умолчанию:
  // регистрация остаётся нетронутой, ноль накладных на каждый вызов.
  // docs/telemetry.md — что собирается, срок хранения, как отключить.
  const telemetry = createTelemetryLogger({ path: telemetryPathFromEnv() });
  if (telemetry.enabled) {
    const rawTool = server.tool.bind(server) as unknown as (...args: unknown[]) => unknown;
    (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
      ...args: unknown[]
    ) => {
      // Обработчик — последний функциональный аргумент регистрации; имя
      // инструмента — всегда первый.
      for (let i = args.length - 1; i >= 0; i -= 1) {
        if (typeof args[i] === "function") {
          args[i] = wrapToolHandler(
            String(args[0]),
            args[i] as (...a: unknown[]) => Promise<unknown>,
            telemetry
          );
          break;
        }
      }
      return rawTool(...args);
    };
  }

  // ---- MEGAMEMORY_TOOLS: поверхность из 26 инструментов (план 26 §1) ----
  // Фильтр ДО регистрации: состав tools/list честно отражает поверхность,
  // динамической регистрации нет. Дефолт не меняется: без переменной — все 26.
  const surface = parseToolSurface(process.env.MEGAMEMORY_TOOLS);
  const tool = <Args extends ZodRawShapeCompat>(
    name: string,
    desc: string,
    shape: Args,
    handler: ToolCallback<Args>
  ): void => {
    if (!surface.enabled.has(name)) return;
    server.tool(name, desc, shape, handler);
  };

  // ---- Zod schemas ----
  const NodeKindEnum = z.enum(NODE_KINDS);
  const RelationEnum = z.enum([
    "connects_to", "depends_on", "implements", "calls", "configured_by", "supersedes", "contradicts", "informed_by",
  ]);
  const EvidenceExpectSchema = z.object({
    claim_digest: z.string().optional(),
    status_digest: z.string().optional(),
    artifacts_digest: z.string().nullable().optional(),
  });
  const EvidenceWhySchema = z.string().trim().min(1).describe(
    "Рационал: что именно в этой опоре поддерживает вывод — непустая строка обязательна"
  );
  const EvidenceItemSchema = z.union([
    z.object({
      ref: z.string().describe("Файл (+ строка), на котором держится вывод; узел-факт создастся, если файл ещё никто не цитирует"),
      node: z.never().optional(),
      why: EvidenceWhySchema,
      expect: EvidenceExpectSchema.optional().describe("Прочитанные claim/status/artifacts digest переиспользуемой опоры; без них связь создаётся без подтверждения"),
    }),
    z.object({
      ref: z.never().optional(),
      node: z.string().describe("Существующий узел-опора"),
      why: EvidenceWhySchema,
      expect: EvidenceExpectSchema.optional().describe("Прочитанные claim/status/artifacts digest переиспользуемой опоры; без них связь создаётся без подтверждения"),
    }),
  ]);

  // ---- Register tools ----

  tool(
    "understand",
    "Query the project knowledge graph. Call this before starting any task to load relevant context about concepts, features, and architecture. Default max_tokens is 4000; explicit budgets are respected. mode:'compact' returns candidates representing all search/filter survivors in a bounded retrieval pool (default 20), subject to the list budget, plus up to 3 fully qualified compact cards only when they fit; matches/compact remain available. Candidate entries carry exact untrimmed id (use get_concept to expand), name is tail-shortened from 60 down to a 12-char floor; id is never shortened; under a tight budget an entry is dropped rather than shown nameless, and meta.truncated marks it. Entries also carry kind, via, score, and optional summary_short <=80 chars. Soft target 40, hard cap 90 estimated tokens per entry: drop summary_short before further shortening name; never shorten id. The candidate list uses at most 25% of max_tokens. After the mandatory envelope, budget priority is the first fully qualified compact card, candidates, then the second/third cards. meta.returned counts visible candidates; meta.cards counts compact cards; meta.dropped counts wholly hidden matches, not candidate-only entries. If dropped > 0, budgeted text says 'Показано N совпадений из M (K скрыто бюджетом) — уточни запрос или подними max_tokens.' (N=returned, K=dropped, M=N+K). If no minimal qualified card fits, meta.reason is budget, not no_match; no cards are guaranteed independently of budget. The UI displays only cards (up to 3), not candidates; candidate display/expansion is a separate plan. mode:'full' keeps the legacy form with why/children/edges on every node and no candidates. Every result mode carries next: execute must_read (up to 3 file refs) before editing; git: refs are not listed there — they arrive as a check_artifacts followup. Treat skip as an empty legacy field, run followups with the supplied args, and use record after the work; refs and summaries never prove whole-file coverage. mode:'brief' returns up to 8 text lines plus the same next contract, without cards. Opt-in (default off): include_evidence attaches confirm-ready versions to each compact card — current_digests (claim is the CURRENT wording for expected_claim_digest; confirmed_claim/confirmed_at document the snapshot separately) plus support_evidence listing ALL live supports (even ones the query missed) with untrimmed wording, edge rationale and claim/status/edge/artifacts digests the server computed — a digest never replaces reading the full wording before confirming; a card and its evidence are placed atomically or omitted, without counting candidate-only entries as dropped. collapse_ref_anchors defaults to true in compact (false supported): demotes technical ref-anchors from the top level (origin AND structure predicate; a meaningful edited card is not treated as a template anchor), folded compactly next to their dependent conclusion with rationale, or as collapsed locators in anchors with dependents; meta.anchor_collapsed counts them. Path-like names are demoted unless the query is an exact full path; they remain in candidates, id/path resolution and provenance keep working, and anchors-only results are never empty no-match. The MCP wrapper also adds the top-level staleness fields instructions_stale, instructions_version, and server_version; they are included in max_tokens. Opt-in task (P3, default off) embeds a task_context section into THIS answer — no extra mandatory call: deterministic rules pick mandatory source categories for the explicit task kind (decisions, supports, refuted, tests, dependents), boost decisions/tests citing the explicit file scope (score 0 — explicit scope pick, not similarity), drop semantic duplicates WITHOUT dropping refuted reasons/contradictions/incompleteness, include hidden supports of placed decisions, list uncovered mandatory sources with a next step when the budget cannot fit them, and estimate the approximate TOTAL cost (cards + followups + required reading, heuristic bytes/3 — not provider tokens). task_context never replaces must_read, never fills next.skip, never claims whole-file coverage; context_epoch is explicit client state (in-memory, per process) that only collapses already-served non-mandatory cards. Always-on in compact: stale_refs lists returned cards whose file_refs have an mtime NEWER than the node's own update — a divergence signal, not a verdict (git checkout and archive unpacking also bump mtime; the content axis is check_freshness) — next.stale_warning says to re-read the ref before relying on it; stale_refs shows the first 3 of stale_refs_total on returned cards; hidden stale entries are total minus shown; stale_refs_missing counts refs of returned cards whose file is absent from disk — a separate axis, not a change; an answer without divergences stays byte-identical.",
    {
      query: z.string().describe("Short query for the task. Keyword matching requires every word by default; semantic matching needs vector search. `via` on each result names the channel that found it: `vector`, `fts`, `both`."),
      match: z.enum(["all", "any"]).optional().describe("Keyword matching: all requires every query word (default); any explicitly expands with OR. Vector matching is unchanged; meta.match records an explicit choice."),
      top_k: z.number().int().min(1).max(50).optional().describe("Number of top results to return (default: 10)"),
      max_tokens: z.number().int().min(100).max(20000).optional().describe("Token budget for the actual MCP content envelope, including next and wrapper staleness fields instructions_stale/instructions_version/server_version (default: 4000; explicit budgets respected). In compact, candidates use <=25% of the budget; priority after the mandatory envelope: first fully qualified compact card, candidates, second/third cards (at most 3, only if they fit). If no minimal qualified card fits, meta.reason is budget, not no_match; refuses when the required envelope cannot fit"),
      mode: z.enum(["compact", "full", "brief"]).optional().describe("compact (default) trims each node to essentials under the budget; full returns legacy verbose output; brief returns up to 8 lines of text plus the next block, no cards"),
      include_inactive: z.boolean().optional().describe("Include superseded/deprecated nodes (default: false)"),
      include_stale: z.boolean().optional().describe("Вернуть и просроченные факты (valid_until в прошлом) — с пометкой expired: true (по умолчанию исключены, meta.stale_excluded считает исключённых)"),
      include_evidence: z.boolean().optional().describe("E3, opt-in (по умолчанию выключено): каждый компактный матч несёт current_digests (claim — текущая формулировка для expected_claim_digest; confirmed_claim/confirmed_at — документация снимка, отдельно) и support_evidence — ВСЕ живые опоры, включая не найденные поиском: полная формулировка (не обрезается), rationale ребра и готовые дайджесты confirm_supports (claim/status/edge/artifacts, полные hex — общие экспорты сервера, считать хеши самому не нужно). Полный digest не заменяет чтение полной формулировки и rationale перед подтверждением. Матч с доказательствами размещается целиком или не размещается (meta.dropped/truncated честные); счётчики — meta.evidence_matches/evidence_supports. Поддержан только в mode=compact"),
      collapse_ref_anchors: z.boolean().optional().describe("В mode=compact по умолчанию true, явный false поддержан: уменьшает долю технических ref-якорей на верхнем уровне. Технический якорь — по происхождению И текущей структуре (created_via='file_ref' + шаблонное саммари + имя = file_refs[0]); отредактированная осмысленная карточка не считается шаблонным якорем. Якорь с найденным зависимым выводом показывается компактно вместе с rationale и состоянием опоры (вложение или секция anchors с informed_by_incoming); без зависимых — компактный локатор. Имена-пути понижаются в ранжировании, кроме запроса по точному полному пути; из candidates узлы не удаляются, id остаётся точным. Если найдены только якоря, это не пустой no_match. Счётчик — meta.anchor_collapsed; хранение не меняется: get_concept по id/пути и provenance_trace разрешают опору во всех режимах. Поддержан только в mode=compact; форма full не меняется"),
      include_source: z.boolean().optional().describe("Опция (по умолчанию выключено — прежний ответ байт-в-байт): компактная карточка несёт verbatim-исходник по первому читаемому file_ref с локатором — один вызов вместо отдельного Read. Диапазон режется только хвостом (truncated: true), середина не вырезается; файл >1 МиБ, не UTF-8, без диапазона или вне корня — исходника нет (meta.source_skipped с причиной). Стоимость источника вычитается из max_tokens до раскладки карточек: не влезло — карточка отдаётся без source, source_cards считает размещённые. Поддержан только в mode=compact; с full/brief — явная ошибка"),
      source_max_lines: z.number().int().min(1).max(200).optional().describe("Потолок строк verbatim-исходника на карточку при include_source: true (по умолчанию 60, максимум 200); хвост диапазона режется с truncated: true"),
      reuse: z.object({
        task_type: z.string().min(1).describe("Явный тип задачи — тот же, что в passport у trail_save; reuse ищется по нему, не по похожести запроса"),
        files: z.array(z.string()).optional().describe("Запрошенная область (файлы/ссылки) — сверяется с областью паспорта: хеши целых файлов, новые файлы в области дают gap"),
        trail_id: z.string().optional().describe("Проверить конкретный паспорт"),
        repo_root: z.string().optional().describe("Корень repo/worktree (default: cwd сервера)"),
        max_candidates: z.number().int().min(1).max(5).optional().describe("Лимит кандидатов в ответе (default 2)"),
        negative: z.object({
          query: z.string().min(1).describe("Точный запрос повторного поиска — сверяется с манифестом negative-паспорта; расхождение инвалидирует reuse"),
          tool: z.string().optional().describe("Инструмент/режим обследования — сверяется с записанным"),
          options: z.record(z.string()).optional().describe("Опции обследования (включение тестов, исключения) — сверяются с записанными"),
        }).optional().describe("P4.2: для task_type='negative_search' — сверка манифеста ограниченного отрицательного результата; reusable означает «не найдено в обследованной области», НЕ «не существует»"),
      }).optional().describe("P1.3, opt-in (по умолчанию выключено): квалификация переиспользования проверенных разборов (паспортов trail_save). Ответ — секция passport_reuse с кандидатами {qualification: reusable|candidate|stale_input|incomplete|unknown|expired|refuted_support|broken|wrong_repo, covered[], gaps[], notes, route?, negative?}: каждое состояние — явный статус, ни один случай не повышает доверие молча. reusable НЕ является покрытием кода и не заполняет next.skip — перед правкой читай текущий участок. Локаторы маршрута (P4.1) резолвятся проверкой файла/символа, не сырым номером строки. Проверка только читает: не подтверждает опоры. Поддержан только в mode=compact"),
      task: z.object({
        goal: z.string().min(1).describe("Явная цель: что делает агент (найти определение, объяснить решение, подготовить правку, оценить последствия)"),
        kind: z.enum(["find_definition", "explain_decision", "prepare_edit", "assess_impact"]).describe("Тип задачи — детерминированное правило обязательных категорий источников (решения, опоры/инварианты, refuted, тесты, зависимые)"),
        files: z.array(z.string()).optional().describe("Явная область (файлы/refs): решения и тесты по области добавляются в выдачу даже без похожести запроса; обязательные для типа задачи поднимаются в размещение"),
        context_epoch: z.string().optional().describe("Явное состояние клиента (эпоха контекста): карточки, уже выданные в этой эпохе с тем же смыслом, едут компактной формой served_earlier. Решения/refuted/противоречия не сворачиваются. Без epoch — прежний ответ"),
      }).optional().describe("P3, opt-in (по умолчанию выключено): контекст под задачу и минимальный план чтения. Ответ — секция task_context: coverage обязательных категорий (covered/uncovered с причиной), supports_included (живые опоры размещённых решений, включая не найденные поиском — скрытые зависимости), reading_plan (обязательные источники вне выдачи), cost_estimate (оценочная ПОЛНАЯ цена: карточки + followups + чтение; эвристика bytes/3, не токены провайдера), notes. Детерминированные правила, без LLM-reranker; бюджет не покрывает обязательное — список непокрытого и продолжение. task_context не подменяет must_read, next.skip остаётся пустым, покрытие кода не утверждается. Встраивается в этот же ответ — отдельного обязательного вызова «за планом» нет. Поддержан только в mode=compact"),
    },
    async (params) => {
      try {
        // План 06 (K-03): instructions_status едет в budget как extra_payload —
        // оценка функции считается по тому же wire-ответу, который обработчик
        // реально отправляет (см. сериализатор в understand).
        const instructions = instructionsStatus(VERSION);
        const result = await understand(db, {
          query: params.query,
          match: params.match,
          top_k: params.top_k,
          max_tokens: params.max_tokens,
          mode: params.mode,
          include_inactive: params.include_inactive,
          include_evidence: params.include_evidence,
          collapse_ref_anchors: params.collapse_ref_anchors,
          reuse: params.reuse,
          task: params.task,
          include_stale: params.include_stale,
          extra_payload: { ...instructions },
        });
        const returned = result.meta?.returned ?? result.matches.length;
        // План 13: must_read едет в timeline — воронка (stats --funnel) считает
        // «выдано/открыто» по этим полям. refs — для чтения человеком, node_ids —
        // для сверки с последующими get_concept.
        const mustRead = result.next?.must_read ?? [];
        const ids = result.compact
          ? result.compact.map((m) => m.id)
          : result.matches.length > 0
            ? result.matches.map((match) => match.id)
            : mustRead.map((m) => m.node_id);
        timeline.log({
          tool: "understand",
          params: {
            query: params.query,
            top_k: params.top_k,
            ...(mustRead.length > 0
              ? {
                  must_read: mustRead.map((m) => m.ref),
                  must_read_ids: mustRead.map((m) => m.node_id),
                }
              : {}),
          },
          result_summary: `${returned} matches`,
          is_write: false,
          is_error: false,
          affected_ids: ids,
        });
        // Plan 3 step 7.3: staleness travels in the response the agent
        // already reads — it cannot see stderr.
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...result, ...instructions }, null, 2) },
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

  tool(
    "get_concept",
    "Look up a concept by its exact ID. Returns the concept with its full context including children, edges, incoming edges, and parent. Unlike 'understand' which uses semantic search, this does exact ID matching. Use this when you know the specific concept ID. The answer carries current_digests — the node's digests ready to pass into confirm_supports (claim: ВСЕГДА текущий дайджест живой формулировки — после правки перечитай и подтверждай новым значением; confirmed_claim/confirmed_at — какая версия была подтверждена ранее, это документация снимка, а не подтверждаемое значение; status: always current). Compact understand answers carry no digests by default; include_evidence: true attaches current_digests and support_evidence (all live supports, confirm-ready) per match. Read-only: get_concept writes nothing to the graph or snapshots; service call telemetry (timeline) is recorded separately and does not affect provenance (plan-4-fixes-6 F12). E1/E2: a plain single-id call returns the same card as before. profile=evidence returns full wording, rationales and confirm_supports-ready digests (never a trimmed claim — what did not fit is marked incomplete with the next step); profile=orientation returns identity, qualification and pointers under the budget; profile=full is the legacy card. max_tokens bounds the final serialized MCP content envelope in ESTIMATED tokens, including all metadata, continuation tokens and delta/unchanged fields; if the required minimum cannot fit, the call explicitly refuses with meta.reason=budget. tokens_estimated is the estimator result, not a provider-token guarantee; neighbor disclosure is capped (max_neighbors) with continuation tokens; a continuation pins the sample version — changed data yields version_conflict and a full re-read. Batch: pass ids (up to 25) for one call with ONE shared budget — per-id status/error/incompleteness are always visible, an unresolved id never disappears silently, budget_skipped items list the continuation. E4 delta (opt-in only): pass context_epoch + known_versions {id: version from meta.version} — ONLY if the client still holds that exact text in its context; a version match of the REQUESTED PROJECTION (all substantial state: status, expiry, refs, rationale, supports, artifacts, selected neighbors, format — never just the summary) returns a compact {unchanged, version, epoch, qualification-minimum} answer; a mismatch returns the full card with meta.version. Nothing (or a new epoch) means full issuance. unchanged is NOT code coverage: read the current source section before editing. Old single-id calls without new parameters keep the same card; successful nonempty MCP reads add hint.record, absent for unchanged and budget refusals.",
    {
      id: z.string().optional().describe("Exact concept ID to look up (e.g., 'auth-module' or 'database-config'). Обязателен для одиночного вызова; с ids/continuation не смешивается"),
      ids: z.array(z.string()).max(25).optional().describe("Пакетное чтение (E2): до 25 id одним вызовом с ОДНИМ общим бюджетом max_tokens; каждый элемент несёт статус ok/error/budget_skipped и свою ошибку/неполноту — неразрешённый id не исчезает молча, ошибка одного не маскирует соседей. Продолжение — meta.continuation (передай только continuation без ids)"),
      profile: z.enum(["orientation", "evidence", "full"]).optional().describe("Проекция карточки (E1): orientation — идентичность + квалификация + краткий summary + указатели; evidence — полные формулировки, rationale и готовые дайджесты confirm_supports (не заставляет считать хеши; непоместившиеся доказательства — явная неполнота, не обрезка); full — прежняя полная карточка. Без параметра — full"),
      max_tokens: z.number().int().min(100).max(200000).optional().describe("Бюджет ФИНАЛЬНОГО MCP-конверта, включая все metadata/continuation/delta/unchanged, в оценочных токенах (tokens_estimated — оценка estimator'а ~байты/3, не гарантия токенов провайдера). Минимум конверта и обязательное ядро (идентичность, квалификация, expiry, причины refuted, weak_support) не режутся: ниже минимума — явный отказ meta.reason=budget"),
      max_neighbors: z.number().int().min(0).max(200).optional().describe("Лимит раскрытых соседей на список (дети, рёбра, опоры, трейлы; по умолчанию 20). Остаток виден в meta.dropped с токеном continuation"),
      continuation: z.string().optional().describe("Opaque-токен get_concept из meta.continuations (список опор/соседей) или meta.continuation (остаток пакета). Передай только continuation без ids; для пакета также без id — вид токена маршрутизируется автоматически. Повреждённый/неизвестный токен даёт явную ошибку. Продолжение фиксирует версию выборки: если состав или состояния изменились — version_conflict и повторное чтение целиком, а не склейка страниц разных состояний"),
      context_epoch: z.string().max(MAX_CONTEXT_EPOCH_LENGTH).optional().describe("E4, opt-in: идентификатор ТЕКУЩЕЙ эпохи контекста клиента (не длиннее 256 символов). После compaction/restart/смены проекта/восстановления БД используй НОВУЮ эпоху или не передавай параметры вовсе — это возвращает полную выдачу. Delta работает только парой с known_versions"),
      known_versions: z.record(z.string()).optional().describe("E4, opt-in: подтверждённые клиентом версии проекций {id: version} из meta.version предыдущего ответа — передавай, только если текст той версии реально ЕСТЬ в твоём контексте. Совпадение версии запрошенной проекции (сравнивается всё существенное состояние: статус, срок, ссылки, rationale, опоры, артефакты, соседи, формат — не только summary) — компактный unchanged-ответ с квалификацией-минимумом; расхождение — полная выдача. unchanged НЕ является покрытием кода: чтение исходника перед правкой не отменяется. Без context_epoch — явная ошибка"),
    },
    async (params) => {
      try {
        const mode = branchConceptToolArgs(params);
        if (mode.mode === "batch") {
          const result = getConceptBatch(db, mode.input);
          const payload = conceptReadPayload(result, mode.input.max_tokens);
          const okIds = result.batch.filter((i) => i.status === "ok").map((i) => i.resolved_id ?? i.id);
          timeline.log({
            tool: "get_concept",
            params: { ids: mode.input.ids },
            result_summary: `batch ${result.meta.ok} ok / ${result.meta.failed} failed / ${result.meta.budget_skipped} budget_skipped`,
            is_write: false,
            is_error: false,
            affected_ids: okIds,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
        }
        if (mode.mode === "profile") {
          const result = getConceptProfile(db, mode.input);
          const payload = conceptReadPayload(result, mode.input.max_tokens);
          const resolvedId =
            "id" in result ? result.id : mode.input.id;
          const deltaUnchanged =
            "unchanged" in result && (result as { unchanged?: boolean }).unchanged === true;
          timeline.log({
            tool: "get_concept",
            params: { id: mode.input.id, profile: mode.input.profile, delta: deltaUnchanged || undefined },
            result_summary: deltaUnchanged
              ? `delta unchanged of ${resolvedId}`
              : "meta" in result
                ? `profile ${(result as { meta?: { profile?: string; truncated?: boolean } }).meta?.profile} of ${resolvedId}${(result as { meta?: { truncated?: boolean } }).meta?.truncated ? " (truncated)" : ""}`
                : `full card of ${resolvedId}`,
            is_write: false,
            is_error: false,
            affected_ids: resolvedId ? [resolvedId] : [],
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
        }
        const result = getConcept(db, { id: mode.id });
        const payload = conceptReadPayload(result);
        timeline.log({
          tool: "get_concept",
          params: { id: mode.id },
          result_summary: `found ${result.id}`,
          is_write: false,
          is_error: false,
          affected_ids: [result.id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "get_concept",
          params: { id: params.id, ids: params.ids },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        const formatted = formatError(err);
        const meta = (err as { meta?: { reason?: string } } | null)?.meta;
        return meta?.reason === "budget" ? { ...formatted, meta: { reason: "budget" } } : formatted;
      }
    }
  );

  tool(
    "create_concept",
    "Add an agent-authored concept to the knowledge graph. The usual agent-authored kinds are feature, module, pattern, config, decision, and component; journal is the explicit kind for volatile state notes (\"PR open now\") and gets an automatic expiry (MEGAMEMORY_EXPIRY_JOURNAL_DAYS / config expiry.journal_days, default 90 days) when valid_until is omitted — pass valid_until explicitly for a deliberate date, or null to forbid auto-expiry (a journal without a term still carries a warning and is never presented as safe); digest remains accepted for compatibility but is normally generated by the digest command, while task nodes are created by task_add. journal is not a decision substitute: a decision keeps its mandatory supports. Call this after completing work and include parameter names, defaults, file locations, and rationale. For any claim that rests on code — decision, pattern or feature — pass evidence items with exactly one of ref or node and a non-empty why; file_refs alone creates no link; supports and their informed_by edges are created atomically, while input.edges never confirms a support snapshot. Reused evidence is confirmed only when expect supplies the versions actually read (claim_digest and status_digest; artifacts_digest may also be pinned); a newly created ref anchor can be confirmed immediately. Automatic grounding applies only to kind=decision, only when provenance.auto_ground is explicitly enabled (default off), and only from non-empty why + file_refs when neither evidence nor an informed_by input edge was supplied; auto-derived supports are not confirmed. A node is ungrounded exactly when it has no live outgoing informed_by edge, no non-empty file_refs array, and no current validated status_scope with an artifact. With provenance.require_support enabled, an unsupported decision is rejected.",
    {
      name: z.string().describe("Human-readable name for the concept"),
      kind: NodeKindEnum.describe("Concept kind. feature, module, pattern, config, decision, and component are the usual agent-authored values; journal marks a volatile state note and gets an automatic expiry when valid_until is omitted; digest is accepted for compatibility but normally generated by the digest command. Tasks are created with task_add."),
      summary: z.string().describe("What this concept is. Be specific: include parameter names, defaults, file paths, behavior details."),
      why: z.string().optional().describe("Why this exists or was built this way"),
      parent_id: z.string().optional().describe("Parent concept ID for nesting; empty string is treated as omitted"),
      file_refs: z.array(z.string()).optional().describe("Relevant file paths + optional line ranges"),
      supersedes: z.array(z.string()).optional().describe("Concept IDs this one replaces — creates supersedes edges and marks the old nodes superseded (T4)"),
      evidence: z.array(EvidenceItemSchema).optional().describe("Опоры утверждения — для любого kind, включая feature/module: решение, паттерн и факт одинаково нуждаются в опоре. Каждый элемент содержит ровно одно из ref/node и непустой why; в том же вызове создаётся informed_by-ребро. file_refs связей не создаёт."),
      edges: z.array(z.object({
        to: z.string().describe("Target concept ID"),
        relation: RelationEnum.describe("Relationship type"),
        description: z.string().optional().describe("Why this relationship exists. Обязателен (непуст) для informed_by: что именно в узле-to поддерживает from — ребро без рационала будет отклонено вместе со всем батчем."),
      })).optional().describe("Relationships to other existing concepts"),
      created_by_task: z.string().optional().describe("Description of the task that created this concept"),
      epistemic_status: z.enum(["open", "validated", "refuted", "abandoned"]).optional().describe("Initial epistemic state (default: open). 'validated' requires status_scope with an artifact"),
      status_scope: z.record(z.unknown()).optional().describe("Scope of a 'validated' claim, JSON: {env?, version?, dataset?, artifact?} — artifact (test/run id) is mandatory for validated"),
      allow_stub: z.boolean().optional().describe('Осознанный обход запрета опор-заглушек: узел с шаблонным/коротким саммари запишется с epistemic_status = "stub" и останется слабым звеном в weak_links. Для обычных узлов не передавай — саммари с утверждением не требует обхода'),
      force: z.boolean().optional().describe("Создать узел, несмотря на найденный дубликат по имени или смыслу (2.1.10): без force близкий узел возвращает duplicate_of вместо создания — обнови существующий узел или передай force осознанно"),
      valid_until: z.string().nullable().optional().describe("Срок годности факта (ISO-8601, напр. \"2026-12-31\"). Обязателен для утверждений о состоянии («смержено», «PR открыт», «релиз вышел») — после даты узел выпадает из выдачи (include_stale возвращает с пометкой). Не передавай для вечных знаний (архитектура, соглашения). Для kind=journal опущенное поле означает автопростановку по политике (env MEGAMEMORY_EXPIRY_JOURNAL_DAYS / конфиг expiry.journal_days, fallback 90 дней); явный null отказывается от автопростановки (предупреждение о записи без срока остаётся)"),
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
          allow_stub: params.allow_stub,
          force: params.force,
          valid_until: params.valid_until,
        });
        // T6: auto-digest the parent when it gained its 5th+ child (nothing
        // was created on a duplicate refusal — nothing to digest for).
        let digestNote = "";
        if (!result.duplicate_of) {
          try {
            const { maybeAutoDigest } = await import("./digest.js");
            const digest = await maybeAutoDigest(db, params.parent_id ?? null);
            if (digest) digestNote = ` Digest built: ${digest.digestId}`;
          } catch {
            // digest building must never fail the create
          }
        }

        timeline.log({
          tool: "create_concept",
          params: { name: params.name, kind: params.kind, parent_id: params.parent_id },
          result_summary: result.duplicate_of
            ? `duplicate_of ${result.duplicate_of}`
            : `created ${result.id}`,
          is_write: !result.duplicate_of,
          is_error: false,
          affected_ids: result.id ? [result.id] : [],
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

  tool(
    "update_concept",
    "Update an existing concept in the knowledge graph. Call this after completing a task that changed existing features or components. Only include fields that changed.",
    {
      id: z.string().describe("The concept ID to update"),
      changes: z.object({
        name: z.string().optional().describe("New name"),
        kind: NodeKindEnum.optional().describe("New kind. Смена на journal применяет default-срок политики expiry, если у узла нет срока и поле valid_until не передано; ранее заданный срок сохраняется при любой смене вида"),
        summary: z.string().optional().describe("Updated summary"),
        why: z.string().optional().describe("Updated rationale"),
        file_refs: z.array(z.string()).optional().describe("Updated file references"),
        epistemic_status: z.enum(["open", "validated", "refuted", "abandoned"]).optional().describe("Epistemic verdict transition; epistemic_reason is mandatory with it. Valid moves: open->validated/refuted/abandoned, validated->refuted/abandoned, refuted->open, abandoned->open"),
        epistemic_reason: z.string().optional().describe("Why this epistemic transition — recorded in status_history, required with epistemic_status"),
        status_scope: z.record(z.unknown()).optional().describe("Scope for 'validated': {env?, version?, dataset?, artifact?}; artifact (test/run id) is mandatory"),
        valid_until: z.string().nullable().optional().describe("Срок годности факта (ISO-8601); null снимает срок, отсутствие поля оставляет как есть (в том числе истёкший — скользящего продления нет). Явная смена kind на journal при отсутствии срока и непереданном поле применяет default политики expiry"),
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

  tool(
    "link",
    "Вызывай, когда связь двух узлов не выражена `evidence` в `create_concept`; для `informed_by` нужен rationale. Create a relationship between two existing concepts. Для informed_by рационал обязателен: «из from следует to, потому что <конкретно>». Связь без рационала нечитаема и потому бесполезна.",
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

  tool(
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

  tool(
    "list_roots",
    "Call for a one-screen orientation when you have no specific query yet (new project, new session) or when you need the board and slots — not a mandatory start ritual. Return the budgeted startup overview. The payload is always compact: roots is an empty compatibility field; roots_compact contains id/name/kind/child_count/valid_until, slots contains current role holders, and board_top contains up to five open tasks by rot. Under max_tokens the priority is slots, then board_top, then roots; meta reports returned/dropped roots and every truncated section. Unlike understand, this tool has no next block. The MCP wrapper adds stats plus the top-level staleness fields instructions_stale, instructions_version, and server_version, and all of them count toward max_tokens.",
    {
      max_tokens: z.number().int().min(100).max(20000).optional().describe("Token budget for the overview (default: 1500)"),
    },
    async (params) => {
      try {
        // 2.1.13 F3: бюджет считается по сериализованному ответу вместе с
        // тем, что обработчик добавляет сам (instructions_status, stats) —
        // оценка listRoots и фактическая выдача MCP не расходятся.
        const stats = db.getStats();
        const extra = { ...instructionsStatus(VERSION), stats, ...(stats.nodes > 0 ? { hint: rootsRecordHint } : {}) };
        const result = listRoots(db, { max_tokens: params.max_tokens, extra_payload: extra });
        const nonempty = !!(result.roots_compact?.length || result.slots?.length || result.board_top?.length);
        const hinted = nonempty ? { ...result, ...extra } : { ...result, ...instructionsStatus(VERSION), stats };
        const tokens = measureMcpPayload(hinted);
        const target = params.max_tokens ?? 1500;
        if (tokens > target) {
          throw new Error(`list_roots: max_tokens=${target} cannot fit the required response (budget refusal, minimum ${tokens}).`);
        }
        const payload = { ...hinted, meta: { ...hinted.meta, tokens_estimated: tokens } };
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
              text: JSON.stringify(payload, null, 2),
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

  tool(
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

  tool(
    "resolve_conflict",
    "Resolve a merge conflict after verifying it against the current codebase. The resolved object is required by the wire schema. For concept conflicts its summary/why/file_refs are written; for edge-only groups resolved is ignored and prefer=left|right is required. Do not blindly pick a concept side: resolved content must state the verified current truth.",
    {
      merge_group: z.string().describe("The merge_group UUID of the conflict to resolve"),
      resolved: z.object({
        summary: z.string().describe("The correct, resolved summary for this concept — verified against the current codebase"),
        why: z.string().optional().describe("Updated rationale"),
        file_refs: z.array(z.string()).optional().describe("Updated file references"),
      }).describe("The resolved content to write — must reflect current codebase truth"),
      reason: z.string().describe("Explanation of what you verified and why this resolution is correct"),
      prefer: z.enum(["left", "right"]).optional().describe("Explicit side selection for a verified edge-only conflict"),
    },
    async (params) => {
      try {
        const result = await resolveConflict(db, {
          merge_group: params.merge_group,
          resolved: params.resolved,
          reason: params.reason,
          prefer: params.prefer,
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

  tool(
    "provenance_trace",
    "Прежде чем отвечать на вопрос «почему/на каком основании», вызови provenance_trace. Ответ на «почему» без трассировки считается необоснованным. Обход по informed_by в одну сторону: ancestry — «на чём стоит этот вывод», impact — «кто на него опирается». Контракты: (1) обход идёт только по informed_by, по живым рёбрам (retrospective добавляет надгробия), весь ответ — один снапшот БД; (2) удалённый узел терминален — сквозь него не считают и не разворачивают, в ретроспективе он виден заглушкой; (3) depth=0 возвращает только корень, допустимый диапазон 0–20; total_within_depth считает узлы в пределах глубины, причина неполноты — truncated_by: depth | nodes | scan | null; (4) in_paths — число путей от корня до узла в показанном подграфе, а не число подтверждений; при потолке помечается in_paths_capped (текстово «≥ 100000»), путь через неразрешённый цикл даёт in_paths: null и запись в weak_links с id компоненты — число не выдумывается; (5) лимиты ограничивают и выдачу, и работу: max_nodes (корень не занимает слот) и бюджет сканирования max_scan_nodes (по умолчанию 5000) — при его срабатывании truncated_by = «scan» и total_within_depth — нижняя оценка (total_exact: false); тот же бюджет ограничивает проверку опор решений — проверяются первые по id, запись support_check_truncated сообщает checked/total. Слабые звенья идут первыми: refuted/abandoned, циклы (по компонентам: id, ребро-свидетель, needs_merge, «компонента закрыта для записи»), рёбра без рационала, решения без опор (no_support), с отсутствующими (missing_support) или только ungrounded-опорами — такие записи несут числовые count и sample (первые ≤5 id), note не длиннее 300 символов. weak_links целиком не превышают 8 КБ: при превышении записи режутся по приоритету и добавляется маркер weak_links_truncated (shown/total). completeness различает «связей нет» (complete) и «связи скрыты» (has_hidden), усечённый обход помечается truncated. Снимок обоснования: решение несёт блок support_check — сверку живых опор с подтверждённым снимком; состояния unchanged/changed (причины per опоры: summary|status|rationale|removed; отдельный сигнал artifact_changed — наблюдённое состояние внешних артефактов опоры, записанное check_artifacts, разошлось с подтверждённым снимком: саммари могло остаться прежним, изменился источник; снимается повторным подтверждением после проверки)/unknown/incomplete, unknown и incomplete чистотой не считаются; изменение опоры не стирается добавлением новых рёбер; цепочка версий подтверждённых опор — provenance_history. Подтверждение — отдельный вызов confirm_supports с digest'ами прочитанных формулировок: трассировка несёт их сама — current_digests у корня (claim решения — всегда ТЕКУЩАЯ формулировка: после правки перечитай и подтверждай новым digest'ом, подтверждённая ранее версия видна в confirmed_claim) и supports[] (полные claim/status/edge digest'ы живых опор, максимум 50; supports_count при усечении — полное число опор); в компактном understand дайджестов по умолчанию нет — include_evidence: true добавляет current_digests решения и support_evidence всех живых опор. Ни одна мутация (link/update/merge) снимок не пишет и не обновляет. Контракт «чтение не пишет» (plan-4-fixes-6 F12): provenance_trace и get_concept не пишут ничего в граф и снимки; служебная телеметрия вызовов (timeline) ведётся отдельно и на провенанс не влияет; проверка опор ограничена бюджетом max_check_edges/max_check_bytes, inner-узлы с оборванной проверкой видны в inner_nodes_incomplete, а completeness деградирует до truncated.",
    {
      node_id: z.string().describe("Узел, с которого начинается обход"),
      direction: z.enum(["ancestry", "impact"]).optional().describe("ancestry (по умолчанию) — что поддерживает узел; impact — что на него опирается"),
      depth: z.number().int().min(0).max(20).optional().describe("Глубина обхода 0–20 (по умолчанию 6); 0 возвращает только корень"),
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

  tool(
    "provenance_audit",
    "«Что рассыплется, если это неверно»: обратный обход (impact) по informed_by с подсветкой узлов, у которых epistemic_status != validated (поле at_risk). depth допускает 0–20; 0 возвращает только корень. Каждый прогон пишется в provenance_audit_runs с ретеншном — последние 200 на узел, не старше 90 дней, чтобы ретроспектива «что мы знали тогда» не врала после того, как граф уехал. Контракт записи: этот журнал — единственное, что audit пишет; граф, узлы и снимки опор он не трогает (plan-4-fixes-6 F12).",
    {
      node_id: z.string().describe("Узел, корректность которого проверяется"),
      direction: z.enum(["ancestry", "impact"]).optional().describe("impact (по умолчанию) — что рассыплется; ancestry — на чём стоит"),
      depth: z.number().int().min(0).max(20).optional().describe("Глубина обхода 0–20 (по умолчанию 6); 0 возвращает только корень"),
      max_nodes: z.number().int().min(1).max(2000).optional().describe("Лимит узлов сверх корня (по умолчанию 200)"),
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

  tool(
    "confirm_supports",
    "Вызывай после того, как опора прочитана и ты фиксируешь, что прочитанная версия подтверждает решение; никогда — автоматически. Записать снимок обоснования решения: сверить digest'ы формулировок, которые агент прочитал, с текущими и атомарно записать опоры. Дайджесты НЕ нужно считать руками: get_concept несёт current_digests (дайджест решения), provenance_trace несёт current_digests и supports[] — полные claim/status/edge digest'ы каждой живой опоры; в компактном understand дайджестов по умолчанию нет — include_evidence: true добавляет current_digests решения и support_evidence всех живых опор. items подтверждает ровно перечисленные опоры — живые опоры вне списка остаются unknown, «подтверждены по умолчанию» не бывают. Для каждой опоры обязателен expected_status_digest (status_digest опоры, который агент читал): подтверждение без него и с несовпадающим — отказ; агент не подтверждает статус, который не видел. ПУСТОЙ список = «подтверждаю, что опор нет» (валидное состояние, отличное от «не проверялось»): прежние строки снимка не стираются, а помечаются superseded — «была подтверждена, потом снята» остаётся отличимым от «опор никогда не было» (признак had_supports в support_check). Любое расхождение ожидаемого с текущим — отказ version_conflict, ничего не записывается: перечитай опоры через provenance_trace/get_concept и повтори с актуальными digest'ами. Ни link, ни update_concept, ни merge снимок не пишут — подтверждение только этим вызовом (единственное исключение: create_concept с evidence подтверждает переданные в том же вызове версии; рёбра из edges снимок не создают). Автоматические рёбра при подтверждении получают accepted_at, created_via не переписывается.",
    {
      decision_id: z.string().describe("ID решения, снимок которого записывается"),
      expected_claim_digest: z.string().describe("claim_digest формулировки решения, которую агент видел (отдаются в get_concept.current_digests и provenance_trace — current_digests для решения, supports[] для опор; в компактном understand дайджестов по умолчанию нет — include_evidence: true добавляет current_digests решения и support_evidence всех живых опор)"),
      items: z.array(z.object({
        support_id: z.string().describe("ID узла-опоры"),
        expected_claim_digest: z.string().describe("claim_digest саммари опоры, который агент читал (provenance_trace.supports[] отдаёт его целиком)"),
        expected_status_digest: z.string().describe("status_digest опоры (оси статуса), который агент читал; обязателен, несовпадение даёт version_conflict"),
        expected_edge_digest: z.string().describe("edge_digest рационала ребра, который агент читал"),
        expected_edge_key: z.string().optional().describe("Точный edge_key прочитанного экземпляра связи"),
        expected_artifacts_digest: z.string().nullable().optional().describe("combined digest активных наблюдений артефактов опоры, который агент читал (provenance_trace.supports[].artifacts_digest); при передаче расхождение — version_conflict: чужой check_artifacts между чтением и подтверждением не подтверждает непрочитанную версию"),
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

  // ---- Support revision history (2.1.3 F1) ----

  tool(
    "provenance_history",
    "Цепочка версий подтверждённых опор решения: какую версию агент подтверждал, какая была до неё, какая после — для разбора инцидента задним числом. По каждой паре «решение—опора»: confirmed_at, source (agent — первое подтверждение / import — перенос при merge / superseded — версия вытеснена повторным подтверждением или удалением), reason (confirmed/reconfirmed/removed/edge_relinked), превью digest'ов (12 символов) и признак «это текущая версия». Без support_id возвращается максимум 50 пар в детерминированном порядке; pairs_truncated=true означает, что пары за пределом скрыты. limit ограничивает ревизии отдельно для каждой пары (по умолчанию 20, максимум 100), revisions_truncated помечает усечение. Тел узлов нет — только версии. Чтение не пишет ничего.",
    {
      decision_id: z.string().describe("ID решения, чья история версий запрашивается"),
      support_id: z.string().optional().describe("Опора — вернуть цепочку только этой пары; без неё — по всем парам решения"),
      limit: z.number().int().min(1).max(100).optional().describe("Сколько ревизий на пару возвращать (по умолчанию 20)"),
    },
    async (params) => {
      try {
        const result = provenanceHistory(db, {
          decision_id: params.decision_id,
          support_id: params.support_id,
          limit: params.limit,
        });
        timeline.log({
          tool: "provenance_history",
          params: { decision_id: params.decision_id, support_id: params.support_id },
          result_summary: `${result.pairs.length} pair(s)`,
          is_write: false,
          is_error: false,
          affected_ids: [params.decision_id],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "provenance_history",
          params: { decision_id: params.decision_id },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: false,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  // ---- Artifact digests (2.1.3 F2) ----

  tool(
    "check_artifacts",
    "Вызывай явно, когда `support_check` равен `unknown` или `changed` либо снимок старше 7 дней: узнать, менялся ли файл или git-объект опоры. Сам ничего не читает. Проверить внешние артефакты узлов (файлы, git-blob'ы и git:-ссылки из file_refs): посчитать sha256 содержимого или разрешить git:tag|commit|branch в sha коммита и записать наблюдение. MCP-вызов не принимает cwd/repo на каждый call. Относительные file/git-blob refs сначала разрешаются от закреплённого repo_path наблюдения, иначе от cwd запущенного сервера. Для git:-refs startup --repo (по умолчанию каталог базы) передаётся как явный корень на каждом MCP-вызове, поэтому он имеет приоритет над сохранённым pin и записывается обратно в repo_path. ЯВНЫЙ вызов — ничего не читается и не хешируется само: ни чтение узла, ни трассировка файлы не трогают. Расхождение «наблюдение vs подтверждённый снимок» всплывает в support_check как artifact_changed и в weak_links отдельным типом — это НЕ support_changed: саммари опоры могло остаться прежним, изменился источник. ВАЖНО: unchanged в support_check означает «совпадает с подтверждённым снимком», а не «файл только что прочитан» — файлы читает только явный check_artifacts. Порядок работы для снимка: check_artifacts по опорам → прочитать digest'ы → confirm_supports (он сохранит текущее состояние артефактов в снимок; передача expected_artifacts_digest из supports[] защищает от чужого check_artifacts между чтением и подтверждением — расхождение даст version_conflict). Отсутствующий файл или неразрешившийся ref — запись missing, не падение. Ссылки, снятые с узла (file_refs), из digest'а выпадают как история — состав наблюдений часть версии. kind=url не поддерживается: сетевые запросы из MCP-сервера — отдельное решение.",
    {
      node_ids: z.array(z.string()).min(1).describe("Узлы, чьи артефакты проверить (refs берутся из file_refs)"),
      max_files: z.number().int().min(1).max(10000).optional().describe("Лимит пар «узел—ref» за вызов (по умолчанию 50); лишние — truncated: true"),
    },
    async (params) => {
      try {
        const result = await checkArtifacts(db, {
          node_ids: params.node_ids,
          max_files: params.max_files,
          repo: REPO_PATH,
        });
        timeline.log({
          tool: "check_artifacts",
          params: { node_ids: params.node_ids, max_files: params.max_files },
          result_summary: `checked ${result.checked}, changed ${result.changed.length}, missing ${result.missing.length}${result.truncated ? ", truncated" : ""}`,
          is_write: true,
          is_error: false,
          affected_ids: params.node_ids,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "check_artifacts",
          params: { node_ids: params.node_ids },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  // ---- P2 (план 20+21 v3 §11): адресная перепроверка свежести ----
  //
  // ЯВНОЕ opt-in действие проверки: обычный поиск его не запускает. Только
  // чтение: НЕ пишет наблюдения (это check_artifacts), НЕ подтверждает опоры
  // (это confirm_supports), НЕ меняет граф. Отчёт несёт затронутое/проверенное/
  // неизвестное, причины неполноты и expected_versions.
  tool(
    "check_freshness",
    "Вызывай после правок кода и перед следующей правкой — для файлов, которые затронешь: отчёт покажет, какие записи зависят от изменившихся источников. Знаний не пишет. Адресная перепроверка свежести: по изменившимся (или подозрительным) источникам — файлам, git-blob'ам, git:-ссылкам — проверить СВЯЗАННЫЕ записи через восстановимый обратный индекс (узлы с file_refs, наблюдения артефактов, паспорта trail_save), а не весь граф. Сравнение по sha256 содержимого с записанными версиями (наблюдения check_artifacts, хеши областей паспортов); mtime/size не являются доказательством; git-состояние working tree (staged/unstaged/untracked/rename) и HEAD едут в отчёте как наблюдение — прежний HEAD не доказывает неизменность working tree. Один физический источник хешируется один раз за проверку; источники, менявшиеся ВО ВРЕМЯ проверки, получают статус unstable — стабильный снимок не объявляется. Отчёт: sources (unchanged/changed/missing/unobserved/unstable/skipped/other_repo), records (fresh/stale_input/partial/unknown — префикс не выдаётся за весь граф), summary (affected/checked/unknown/truncated + limitations), expected_versions — сверь их повторно перед применением правки. НЕ пишет в БД и не подтверждает опоры: reuse-квалификация не поднимается. Опционально (P2.2, пилот): symbols — разрешение определений через adapter token-economy-ts (конфиг: adapter.graph_tool или env MEGAMEMORY_CODE_ADAPTER); неоднозначное/пропавшее определение даёт явный ambiguous/missing и требует чтения; with_dependencies — обход import-графа изменённых источников через adapter (ограничен max_deps, static scope объявлен явно).",
    {
      sources: z.array(z.string()).optional().describe("Источники для проверки: пути/refs (src/foo.ts, src/foo.ts:1-40, HEAD:src/foo.ts, git:tag:name)"),
      node_ids: z.array(z.string()).optional().describe("Проверить записи конкретных узлов (их file_refs и наблюдения)"),
      trail_ids: z.array(z.string()).optional().describe("Проверить области паспортов конкретных trail"),
      repo_root: z.string().optional().describe("Корень repo/worktree (default: startup --repo или cwd); закрепления наблюдений не переписываются"),
      max_files: z.number().int().min(1).max(10000).optional().describe("Бюджет проверки: максимум источников (default 50); лишние — skipped + truncated"),
      max_deps: z.number().int().min(1).max(1000).optional().describe("Бюджет обхода зависимостей (default 20)"),
      with_dependencies: z.boolean().optional().describe("Обойти import-граф изменённых источников через adapter (opt-in; без adapter — явное ограничение, не «зависимостей нет»)"),
      symbols: z.array(z.object({
        name: z.string().min(1).describe("Имя символа (функция/класс/метод)"),
        in: z.string().optional().describe("Владелец для уточнения (класс/интерфейс)"),
        file: z.string().optional().describe("Файл для проверки однозначности локатора"),
      })).optional().describe("P2.2 (пилот): разрешить символы через adapter; номера строк — текущий результат разрешения, не идентичность"),
      adapter: z.object({
        graph_tool: z.string().min(1).describe("Путь к каталогу scripts скилла token-economy-ts или к graph-tool.js"),
      }).optional().describe("Конфиг adapter (P2.2); без него — файловый режим явно. Альтернатива: env MEGAMEMORY_CODE_ADAPTER"),
    },
    async (params) => {
      try {
        const result = await checkFreshness(db, {
          ...(params.sources !== undefined ? { sources: params.sources } : {}),
          ...(params.node_ids !== undefined ? { node_ids: params.node_ids } : {}),
          ...(params.trail_ids !== undefined ? { trail_ids: params.trail_ids } : {}),
          ...(params.repo_root !== undefined ? { repo_root: params.repo_root } : { repo_root: REPO_PATH }),
          ...(params.max_files !== undefined ? { max_files: params.max_files } : {}),
          ...(params.max_deps !== undefined ? { max_deps: params.max_deps } : {}),
          ...(params.with_dependencies !== undefined ? { with_dependencies: params.with_dependencies } : {}),
          ...(params.symbols !== undefined ? { symbols: params.symbols } : {}),
          ...(params.adapter !== undefined ? { adapter: params.adapter } : {}),
        });
        timeline.log({
          tool: "check_freshness",
          params: {
            ...(params.sources !== undefined ? { sources: params.sources } : {}),
            ...(params.node_ids !== undefined ? { node_ids: params.node_ids } : {}),
            ...(params.trail_ids !== undefined ? { trail_ids: params.trail_ids } : {}),
          },
          result_summary: `checked ${result.summary.checked}, affected ${result.summary.affected}, unknown ${result.summary.unknown}${result.summary.truncated ? ", truncated" : ""}`,
          is_write: false,
          is_error: false,
          affected_ids: params.node_ids ?? [],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "check_freshness",
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

  // ---- Workflow tools (plan 2, schema v6) ----

  tool(
    "trail_save",
    "Save a reasoning chain: an ordered list of concept ids plus a mandatory author summary of WHY the conclusion follows. Member meaning is fingerprinted at save time; reads compare against the current state and mark the chain stale/broken when the ground shifted. Use after a non-trivial decision. P1 passport (opt-in): pass passport (task_type, goal, scope_files, checks, completeness) to record a versioned analysis passport alongside the chain — the durable core is the trail itself (member fingerprints + WHY), the versioned body is journaled with the save event; reuse later matches passports by EXPLICIT task_type and verified scope (never by query similarity). A passport is not code coverage: reuse answers carry covered[]/gaps[]/qualification and the agent still reads current code sections.",
    {
      node_ids: z.array(z.string()).min(1).describe("Ordered chain members: premises first, conclusion last"),
      summary: z.string().describe("Author summary of the reasoning — why this conclusion follows from these nodes"),
      name: z.string().optional().describe("Human-readable chain name (default: auto-generated)"),
      passport: z.object({
        task_type: z.string().min(1).describe("Явный тип задачи (пилот: implementation_analysis) — reuse ищется по нему, не по похожести запроса"),
        goal: z.string().min(1).describe("Цель разбора одним-двумя предложениями (не стенограмма рассуждений)"),
        scope_files: z.array(z.string()).min(1).describe("Область применимости: файлы/ссылки; хешируются ЦЕЛИКОМ при сохранении (консервативная актуальность)"),
        sources: z.array(z.object({ ref: z.string(), role: z.string() })).optional().describe("Источники с ролями (implementation/config/tests/docs)"),
        checks_performed: z.array(z.object({ what: z.string().min(1), result_ref: z.string().nullish() })).optional().describe("Реально выполненные проверки; result_ref — ссылка на результат (узел/артефакт)"),
        checks_omitted: z.array(z.object({ what: z.string().min(1), reason: z.string().min(1) })).optional().describe("Невыполненные проверки — явно, с причиной"),
        completeness_degree: z.enum(["full", "partial"]).optional().describe("Степень полноты обследования (default full)"),
        completeness_gaps: z.array(z.string()).optional().describe("Непроверенные участки"),
        completeness_limitations: z.array(z.string()).optional().describe("Известные ограничения"),
        valid_until: z.string().nullish().describe("Срок применимости паспорта (ISO); после даты reuse запрещён без новой проверки"),
        tools: z.record(z.string()).optional().describe("Версии инструментов/настроек обследования"),
        route: z.object({
          entry: z.string().optional().describe("Точка входа маршрута"),
          invariants: z.array(z.string()).optional().describe("Инварианты, которые маршрут сохраняет"),
          locators: z.array(z.object({ ref: z.string().min(1), what: z.string().optional() })).optional().describe("Актуальные локаторы (рецепт — данные, не команда; номера строк резолвятся проверкой свежести, не идентичность)"),
          verification: z.array(z.object({ what: z.string().min(1), test_refs: z.array(z.string()).optional(), note: z.string().optional() })).optional().describe("Проверочные действия; связи с тестами — начальный набор, не доказательство, что остальное можно пропустить"),
          rejected: z.array(z.object({ approach: z.string().min(1), reason: z.string().min(1), date: z.string().optional(), evidence: z.string().optional() })).optional().describe("Краткие причины ранее отвергнутых подходов"),
          platform_notes: z.array(z.object({ constraint: z.string().min(1), repro: z.string().optional() })).optional().describe("Известные платформенные ограничения и способы воспроизведения"),
        }).optional().describe("P4.1: маршрут повторяющейся задачи (точка входа → инварианты → локаторы → проверочные действия). Не копируй исходники; команды из памяти — данные для проверки"),
        negative: z.object({
          query: z.string().min(1).describe("Точный запрос поиска, как он был задан"),
          tool: z.string().min(1).describe("Инструмент и режим (например 'understand mode=compact top_k=10')"),
          options: z.record(z.string()).optional().describe("Расширения, исключения, включение тестов"),
          truncated: z.boolean().optional().describe("Усечение выдачи: true ЗАПРЕЩАЕТ запись «не найдено»"),
          errored: z.boolean().optional().describe("Ошибка поиска: true ЗАПРЕЩАЕТ запись «не найдено»"),
          force_duplicate: z.boolean().optional().describe("Повторная проверка той же области — записать второе наблюдение явно"),
        }).optional().describe("P4.2: ограниченный отрицательный результат (только с task_type='negative_search'). Манифест + хеши области сохраняются вместе; ошибка/усечение не являются no-match. Это семейство паспортов, НЕ новый kind узла"),
      }).optional().describe("P1: паспорт проверенного разбора (opt-in). Без него вызов прежний. P4.1 route — маршрут повторяющейся задачи; P4.2 negative — ограниченный отрицательный результат"),
    },
    async (params) => {
      try {
        const result = params.passport !== undefined
          ? await trailSaveWithPassport(db, params as typeof params & { passport: NonNullable<typeof params.passport> })
          : trailSave(db, params);
        // Запись с паспортом уже журналирована атомарно в trailSaveWithPassport
        // (тело — данные reuse в params события trail_save), дубль здесь не нужен.
        if (!("passport" in result)) {
          timeline.log({
            tool: "trail_save",
            params: { name: params.name },
            result_summary: `saved ${result.id}`,
            is_write: true,
            is_error: false,
            affected_ids: params.node_ids,
          });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        timeline.log({
          tool: "trail_save",
          params: { name: params.name, passport: params.passport !== undefined },
          result_summary: err instanceof Error ? err.message : String(err),
          is_write: true,
          is_error: true,
          affected_ids: [],
        });
        return formatError(err);
      }
    }
  );

  tool(
    "trail_get",
    "Read a reasoning chain with its freshness verdict: fresh (member meaning unchanged), stale (a member's summary/epistemic status/informed_by changed or was removed), broken (a member was hard-deleted). Stale members carry a per-member reason. include_passport: true (P1, opt-in) also returns the versioned analysis passport body recorded at trail_save (or null when the journal entry was pruned by retention — qualification then honestly degrades to unknown).",
    {
      id: z.string().describe("Trail id, as returned by trail_save"),
      include_passport: z.boolean().optional().describe("P1, opt-in: вернуть тело паспорта (или null, если запись вытеснена ретеншном журнала)"),
    },
    async (params) => {
      try {
        const result = trailGet(db, params.id, params.include_passport ? { include_passport: true } : undefined);
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

  tool(
    "trail_refresh",
    "Re-snapshot the fingerprints of every chain member after you verified the chain still holds. Refuses on a broken chain (a member was hard-deleted) — rebuild it instead. Plan 04 K-09: refresh не оживляет непригодных участников — опровергнутый, заброшенный, просроченный или удалённый член цепочки не переснимается, и цепочка остаётся stale; refresh обновляет только снимок годных членов, пригодность рассуждения он не «чинит».",
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

  tool(
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

  tool(
    "slot_set",
    "Take a named role slot (handoff, entrypoint, queue, ...) with a node — the role's single live pointer. If another node held it, that old holder loses only the slot and a new-holder → old-holder supersedes edge records the handoff; the old node's lifecycle/status is not changed. Re-taking by the same node is a no-op. Slots are scoped per project.",
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

  tool(
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

  tool(
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

  tool(
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

  tool(
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

  tool(
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

  tool(
    "board",
    "Show the task board: the open column sorted by rot (overdue > isolated > oldest) and the terminal done column fresh-first, paginated by done_cursor/done_limit. Done count is the total; returned, has_more and next_cursor describe the current page. Call this instead of guessing what to work on next.",
    {
      done_cursor: z.string().optional().describe("Keyset continuation from the done column's next_cursor"),
      done_limit: z.number().int().min(1).max(100).optional().describe("Done cards per page (default: 20)"),
    },
    async (params) => {
      try {
        const result = board(db, params);
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
