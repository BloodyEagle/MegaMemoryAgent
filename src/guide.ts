import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { instructionsStamp } from "./instructions.js";

// ---- One source of agent-facing text (plan 2.1.5 F1/F2/F5) ----
//
// AGENTS_MD_SNIPPET used to live in install.ts; `megamemory guide` (F2) needs
// to print the very same text, and the docs tests (F5) need to check it.
// One constant, two consumers: install writes it into AGENTS.md, guide prints
// it — they cannot drift apart.

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8"
  )
).version as string;

export const AGENTS_MD_STAMP = instructionsStamp(PACKAGE_VERSION);
export const AGENTS_MD_END = "<!-- /megamemory-snippet -->";

/**
 * The onboarding block `megamemory install` writes into AGENTS.md / CLAUDE.md.
 *
 * 2.1.5: besides the basic loop this now teaches provenance (F1) — supports on
 * write, version confirmation, support_check states, stale instructions — and
 * points at `megamemory bench` (F5.3), so the agent knows "does this memory
 * help" is a question answered by a number, not an argument.
 *
 * Volume cap: the whole block must stay <= 60 lines (it lives in the context
 * of every session; a bloated block gets ignored). Guarded by a test.
 *
 * План 20+21 v3 (W1): пункты workflow согласованы с полным договором
 * docs/agent-workflow.md (печатается `megamemory guide --workflow`): память
 * даёт проверенные решения, структурный инструмент и исходники — актуальное
 * поведение; чистое чтение и успешный reuse не обязаны ничего записывать.
 */
export const AGENTS_MD_SNIPPET = `
${AGENTS_MD_STAMP}
## Project Knowledge Graph

You have access to a project knowledge graph via the \`megamemory\` MCP server and skill tool. You have no implicit memory of this project between sessions, so this graph is your only continuity for concepts, architecture, decisions, and relationships. A decision recorded without supports is, a month later, indistinguishable from a guess — record the evidence with it.

**Workflow: one relevant query → structural reading → verified record. Full contract: \`megamemory guide --workflow\`.**

1. **Available memory:** start with one short relevant \`understand\` (action \`query\`) for the task; qualify it — supports/\`support_check\`, \`valid_until\`/expired, \`refuted_reason\`, status/scope. \`list_roots\` is an on-demand graph overview, not a mandatory ritual. If MegaMemory is unavailable, continue with your usual navigation — never invent remembered facts or retry connecting in a loop.
2. **Current code:** verify structure and behavior with the structural skill and fresh sources; read small files whole, large files by outline then exact ranges — an analysis is not one line around a hit. Don't run the same search through both tools as a ritual. \`compact\` is default, \`full\` is verbose, \`brief\` is ≤8 lines. \`next\`: read every \`must_read\` (mandatory sources, not whole-file coverage), run every \`followup\` exactly; \`skip\` is empty; refs/summaries never prove coverage. Opt-in noise control: \`collapse_ref_anchors: true\` demotes template ref-anchors to compact locators (with their dependents and rationale) — direct id/path lookups and provenance still resolve them.
3. **After work:** record only new verified knowledge, a fix of an old node, or needed history (action \`record\`); pure reading and successful reuse lawfully record nothing — \`record\` is an action form, not a must-create. Reuse of saved analysis (passport via \`trail_save\` + \`understand.reuse\`) answers with an explicit qualification (covered/gaps) — never silent trust, and a delta \`unchanged\` is not code coverage. After compaction/restart/project switch, change \`context_epoch\` AND clear \`known_versions\`: a new epoch alone does not invalidate old versions on the stateless server. After code changes, targeted re-verification is the explicit \`check_freshness\` call (related conclusions/passports via a reverse index, not the whole graph; file/blob SHA-256 versus git-ref commit SHA in \`expected_versions[].sha256\` to re-check before editing) — it writes no knowledge, observations or confirmations and never raises reuse trust; it may write the derived freshness index cache, and MCP writes service call telemetry. On code/memory divergence investigate first (scope, versions, rationale): current code is the fact of implementation, not an automatic refutation of the decision.

Be specific in summaries: parameters, defaults, files, rationale. One idea — one node; update instead of duplicating. Replacement = new \`create_concept\` with \`supersedes: [old_id]\`; disproved = \`update_concept\` → \`refuted\`; \`remove_concept\` = truly gone and no longer needed. Max 3 levels.

Good node: \`auth-token-refresh\` (decision) — "Silent refresh 30 s before token expiry, because 401s on /expired broke long jobs; lives in src/auth/refresh.ts."
Bad node: \`auth\` — "Everything about auth." — a vague label no query can retrieve.

4. **Budget:** \`max_tokens\` bounds actual MCP content: retrieval, mandatory \`next\`, and wrapper staleness fields (\`instructions_stale\`/\`instructions_version\`/\`server_version\`) — not initialize-level instructions. Too-small required envelopes are refused.
5. **Startup shape:** \`list_roots\` has \`roots_compact\` (\`child_count\`/\`valid_until\`), \`slots\`, \`board_top\`, optional \`hint\`, \`meta\` truncation/drop fields, \`stats\`, and wrapper staleness fields; legacy \`roots\` is empty. Check \`meta.truncated\`.
6. **Freshness:** when a decision replaces an older one, pass \`supersedes: [old_id]\` to
   \`create_concept\` instead of deleting. If a search finds nothing, retry with
   \`include_inactive: true\` — the concept may be marked superseded.
7. **Digests:** \`digest\` nodes summarize any parent with 5+ eligible children — read the digest first, siblings second; generation is automatic/CLI, manual digest is compatibility-only.
8. **Embedding model changed?** Run \`megamemory reembed\`: vector search starts with the first valid current-generation row; FTS covers nodes not published yet.
9. **Supports:** for any claim resting on code — decision, solution or fact — pass \`evidence: [{node | ref, why}]\` in the same call
   that creates it; \`why\` names what exactly in the support backs the conclusion — not a
   retelling. A support on a file is a ref — \`evidence: [{ref: "src/x.ts:120-180", why}]\` — not
   a new node: create a support node only for a thought a link cannot express. The ref creates
   an anchor (a file-named node with a template summary) — that is a support, not a stub.
   \`file_refs\` alone are not supports: the server derives them only with auto_ground
   enabled (off by default). Auto-derived supports are not confirmed evidence — a draft, not a check.
   A git object is a ref too: \`evidence: [{ref: "git:tag:v2.1.11", why}]\` (also \`git:commit:<sha>\`,
   \`git:branch:<name>\`) — the anchor resolves to a commit sha with LOCAL git; a moved tag flips
   \`check_artifacts\` to \`changed\`.
   Relations (full enum): \`connects_to | depends_on | implements | calls | configured_by | supersedes | contradicts | informed_by\`; \`informed_by\` requires a rationale saying what in the target supports the source. Recommendation: do not use \`journal\` as decision evidence; the server currently permits it (not a technical ban).
10. **Confirm versions:** after reading a support, confirm it: \`confirm_supports(decision_id,
    expected_claim_digest, items:[{support_id, expected_claim_digest, expected_status_digest,
    expected_edge_digest}])\` — digests travel in server answers (\`get_concept.current_digests\`,
    \`provenance_trace.supports[]\`; compact \`understand\` adds them only with \`include_evidence: true\`,
    which also lists every live support with its full wording) — never computed by hand.
    \`support_check.state\`: \`unchanged\` = same as you confirmed
    (it does NOT mean the file was just read back — only an explicit \`check_artifacts\` reads
    artifacts; \`unchanged\` compares observations against the confirmed snapshot);
    \`changed\` = diverged (see \`reasons\`); \`unknown\` = never checked; \`incomplete\` = the check hit
    its budget. \`unknown\` and \`incomplete\` are NOT "all good". On \`changed\`: re-read the support,
    confirm again, or mark the decision \`refuted\` via \`update_concept\` / replace it via
    \`create_concept.supersedes\` — never leave it hanging. \`truncated_by: depth|nodes|scan\` in a
    trace means the traversal was partial — never conclude "no more supports exist".
11. **Stale instructions:** if \`list_roots\`/\`understand\` returns \`instructions_stale: true\`, run
    \`megamemory install\` (it refreshes this block) and treat in-project instructions as possibly outdated.
12. **Asked "does this memory help?"** — don't argue, measure: \`megamemory bench\` (\`--baseline files\`/\`te\`/\`both\`);
    read \`ratio\` with \`hit_rate\` — cheap but wrong is not savings. Rare procedures: \`megamemory guide --workflow\`, \`docs/capabilities.md\`.
13. **State claims expire:** a statement about the world AS IT WAS ("merged", "PR open",
    "release shipped") MUST carry \`valid_until\` (ISO date) — it drops out of answers after
    that date (\`include_stale: true\` returns it marked \`expired\`). Architecture and
    conventions stay dateless; \`journal\` alone gets a configured default term when
    \`valid_until\` is omitted on create. A state-claim summary without a date gets a
    \`state_claim_without_expiry\` warning in the response — a warning, not a refusal: set the date or reword it as durable knowledge.
${AGENTS_MD_END}
`;

/**
 * F2: a worked session example (start → query → work → record with evidence
 * → confirm), printed by `megamemory guide` after the snippet.
 */
export const SESSION_EXAMPLE = `
## Example session

\`\`\`
# 1. Start: what does the graph already know?
list_roots() -> 4 roots: build-pipeline, catalog-import, auth-model, ci-cache
# 2. Before the task: query the graph instead of reading the repo
understand("how does catalog import resolve module paths") -> compact: catalog-import-entry (0.83), catalog-path-resolution (0.76)
  -> next.must_read: read src/catalog/import.ts before editing
# 3. Read exact card: get_concept("catalog-import-entry") # support_check lives here, not in understand
  -> support_check: changed -> re-read that support first
#    Budget: profile="evidence" (full wording + confirm digests) / "orientation" (short card); max_tokens bounds the answer, meta.dropped+continuation mark what did not fit (version-pinned); ids:[...] batches 25 cards.
# 4. Record the decision WITH its evidence, in the same call
create_concept(
  name: "catalog-import-cache", kind: "decision",
  summary: "Import cache keyed by (path, mtime); invalidated on tsconfig change.",
  evidence: [{ node: "catalog-import-entry",
               why: "its loader graph is exactly what the cache wraps" }])
  -> created catalog-import-cache, informed_by -> catalog-import-entry
# 5. Confirm the versions you actually read (digests from the responses)
confirm_supports("catalog-import-cache", expected_claim_digest,
  items: [{ support_id: "catalog-import-entry", expected_claim_digest,
            expected_status_digest, expected_edge_digest }])
  -> snapshot written; next session starts from confirmed ground.
\`\`\`
`;

/**
 * F5.4: the "measuring the benefit" section for the printed guide — the same
 * three baselines as the bench paragraph in the snippet, with a little more
 * room to explain what the numbers mean.
 */
const MEASURING_SECTION = `
## Measuring the benefit

\`megamemory bench --db <db> --questions questions.jsonl\` tells you in numbers whether the
graph saves orientation time — three baselines, one flag:

- \`--baseline files\` — versus reading the \`file_refs\` files of the found nodes;
- \`--baseline te --te-exec <node> --te-arg <code-searcher.js> --te-arg "query={query}" --te-arg "root=."\`
  — versus token-economy-ts 1.1.0 text search, from the analyzed project's cwd;
  executable/script paths are absolute, and \`{query}\` stays one literal argv value;
- \`--baseline both\` — both raw retrieval ratios side by side.

\`lang\` groups results, not skills. Precedence: preset → structured runner → question
shell → global shell; \`te_used_preset\` is not live. Shell templates are trusted advanced
input (Windows expansion is lossy). Graph path needs \`from\` and \`to\`, not a question.
\`graph_metric=retrieval_wire_without_instructions\` estimates the MCP content wrapper
around retrieval, including \`next\`, but excludes the wrapper staleness fields
\`instructions_stale\`, \`instructions_version\`, and \`server_version\`. It is not
exactly the default MCP response or whole-task cost; \`economy_status=not_measured\`.
Use dataset \`expected_outcome\`, \`expect_nodes\`, \`quality_contract\` and TE oracles:
only complete correct live results enter \`quality_ratio_te\`; raw ratios are separate.
A valid expected no-match passes quality. Error/unknown/truncation/preset is not eligible.

\`ratio = baseline_tokens / graph_tokens\`; read it only together with \`hit_rate\` — a cheap
but wrong answer is not savings. \`ratio > 1\` means the graph is cheaper;
\`ratio < 1\` means the baseline is cheaper. Examples: 200 / 100 = 2;
100 / 200 = 0.5. Questions where the graph loses are printed, not hidden.

For an honest number run with \`--files-top 3\` — a live agent reads two or three files, not
every \`file_refs\` of every found node — and read \`hit_rate@1\` (expected node ranked first)
next to \`hit_rate\` (anywhere in the top-10): a rank-6 hit is a much weaker answer.
`;

/**
 * План 18 (2.4.0): which commands open the database read-only and what they
 * print on an outdated schema. Mirrors the "Which commands never write to
 * the database" section of both READMEs — same facts, guide wording is its
 * own single source here (README ×2 are kept in sync by hand).
 */
const READONLY_SECTION = `
## Read-only commands

\`megamemory export\`, \`eval\` and \`conflicts\` open the database READ-ONLY: they never
write, never migrate, and leave the file byte-identical (so do the scripted
\`stats --funnel --json\` and \`stats --health --json\` snapshots, \`expire\` without \`--apply\`,
\`repair-ids --dry-run\`, and \`migrate --dry-run\`). Expire dry-run reads the original directly; repair/migrate
compute their plans on a coherent temporary snapshot and fingerprint the original before/after,
so a concurrent change is reported instead of claiming “nothing written”. On an outdated schema
the direct read-only commands fail with a ready-made fix —
\`megamemory migrate --apply --db "<path>"\` — instead of migrating silently.

\`MEGAMEMORY_ALLOW_AUTO_MIGRATE=1\` is an escape hatch only for \`export\`, \`eval\`, and
\`conflicts\`: it restores their old read-write open and possible auto-migration for one
invocation. It does not change expire dry-run or the repair/migrate snapshot semantics.

\`stats\`, \`bench\` and \`doctor\` still open the database for writing, on purpose
(except the JSON-only funnel/health snapshots without \`--prune\` listed above):
the read paths of ordinary \`stats\`/\`bench\` record usage telemetry, \`stats --prune\` writes
by design, and \`doctor\` migrates in place. \`serve\` and the MCP server write too.
Combined \`stats --funnel --health --json\` is also read-only without \`--prune\` and
prints one \`{funnel, health}\` object. \`expire --scan --json\` prints exactly one report
JSON on stdout; review/apply instructions go to stderr (\`--scan --apply\` is refused).
`;

/**
 * W2 (план 20+21 v3): полный договор workflow поставляется файлом
 * docs/agent-workflow.md внутри пакета (каталог docs уже в files package.json).
 * Путь считается от каталога модуля, а не от cwd: работает и из checkout, и из
 * установленного пакета вне него. Отсутствие файла — явная ошибка упаковки,
 * а не повод подставить старый текст.
 */
export class WorkflowDocError extends Error {}

const WORKFLOW_DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "agent-workflow.md"
);

/**
 * W1/W2: текст полного workflow-договора. Читается свежим на каждый вызов,
 * UTF-8; печатается CLI как есть — документ заканчивается ровно одним LF
 * (закреплено в .gitattributes и проверено тестом «байт в байт»).
 */
export function buildWorkflowText(): string {
  let text: string;
  try {
    text = fs.readFileSync(WORKFLOW_DOC_PATH, "utf-8");
  } catch {
    throw new WorkflowDocError(
      `Документ workflow отсутствует в пакете: ${WORKFLOW_DOC_PATH}. Это ошибка упаковки: docs/agent-workflow.md должен поставляться с пакетом (files в package.json).`
    );
  }
  return text;
}

/**
 * W2: разбор аргументов `megamemory guide`. Поддержан единственный флаг
 * `--workflow`; любой другой аргумент и повтор флага — явная ошибка, не
 * молчаливое игнорирование. Обычный `guide` без аргументов сохраняет прежний
 * смысл.
 */
export type GuideMode = "guide" | "workflow";

export function resolveGuideMode(args: string[]): GuideMode {
  const unexpected: string[] = [];
  let workflow = false;
  for (const token of args) {
    if (token === "--workflow" && !workflow) {
      workflow = true;
    } else {
      unexpected.push(token);
    }
  }
  if (unexpected.length > 0) {
    throw new WorkflowDocError(
      `Неизвестные аргументы команды guide: ${unexpected.join(", ")}. Поддержан только флаг --workflow; обычный guide вызывается без аргументов.`
    );
  }
  return workflow ? "workflow" : "guide";
}

/**
 * F2: the full `megamemory guide` text — exactly the snippet that install
 * writes (one source), plus the session example, the measuring section and
 * the read-only commands note.
 */
export function buildGuideText(): string {
  return [
    AGENTS_MD_SNIPPET.trimStart(),
    SESSION_EXAMPLE.trimStart(),
    MEASURING_SECTION.trimStart(),
    READONLY_SECTION.trimStart(),
  ].join("\n");
}
