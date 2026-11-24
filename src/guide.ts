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
 * План 31 (2.12.3): блок вернулся к роли «ядро + указатель» — триггеры
 * «когда → что сделать», не мануал. Все операционные подробности (режимы,
 * бюджеты, стартовая форма list_roots, reembed, enum связей, примеры узлов,
 * bench) живут в docs/agent-workflow.md и печатаются
 * `megamemory guide --workflow`. Ни одно нормативное правило не удалено:
 * сокращение держится тестом «ядро на месте».
 *
 * Volume cap: ≤ 3000 символов и ≤ 35 строк; считаем символы, потому что
 * строки обходились длиной абзаца (2 955 и 4 557 символов внутри «60 строк»).
 * Guarded by a test.
 *
 * План 20+21 v3 (W1): пункты workflow согласованы с полным договором
 * docs/agent-workflow.md: память даёт проверенные решения, структурный
 * инструмент и исходники — актуальное поведение; чистое чтение и успешный
 * reuse не обязаны ничего записывать.
 */
export const AGENTS_MD_SNIPPET = `
${AGENTS_MD_STAMP}
## Project Knowledge Graph

You have no memory of this project between sessions: this graph is your continuity. A decision recorded without supports is, a month later, indistinguishable from a guess.

**Before a task:** one short relevant \`understand\` for what you are about to change, then qualify the answer (\`support_check.state\`, \`valid_until\`, \`refuted_reason\`, status/scope). \`list_roots\` is an on-demand overview, not a mandatory ritual. Memory unavailable: work as usual, never invent remembered facts or retry in a loop.

**When reading code:** verify with the structural skill and fresh sources — small files whole, large ones by outline then exact ranges. Run every \`next.must_read\` and \`next.followup\`; refs and summaries are not whole-file coverage. \`stale_refs\` marks a cited file newer than the node — re-read the ref before relying on it.

**When memory and code disagree:** investigate scope, versions and rationale first. Current code is the fact of implementation, not an automatic refutation of the decision.

**After verified work:** record only new knowledge, a fix of an old node, or needed history — pure reading and successful reuse lawfully record nothing. One idea — one node, at most 3 levels. Replacement is \`supersedes\`, never deletion. Empty search: 2–3 exact terms or an id, then \`include_inactive: true\`. Commit and PR memory: \`memory: <id>\` or \`memory: нечего — <причина>\` (docs/commits.md).

**Claims resting on code:** pass \`evidence: [{node | ref, why}]\` in the call that creates the node; \`why\` names what exactly backs it — e.g. \`evidence: [{ref: "src/x.ts:120-180", why}]\`. A file ref is an anchor (a file-named node with a template summary) — a support, not
a new node and not a stub: create a support node only for a thought a link cannot express. \`file_refs\` alone are not supports; supports derived by \`auto_ground\` are a draft, not a check. Git refs work too: \`evidence: [{ref: "git:tag:v2.1.11", why}]\`, \`git:commit:<sha>\`.

**After reading a support:** \`confirm_supports(decision_id, expected_claim_digest, items: [{support_id, expected_claim_digest, expected_status_digest, expected_edge_digest}])\` with the digests the server returned (\`current_digests\`, \`provenance_trace.supports[]\`) — never computed by hand. \`unknown\` and \`incomplete\` are NOT "all good"; on \`changed\` re-read and confirm, or mark the decision \`refuted\`.

**State claims expire:** "merged", "PR open", "shipped" need \`valid_until\`; otherwise \`state_claim_without_expiry\` warns — a warning, not a refusal. After a restart, compaction or project switch, change \`context_epoch\` and clear \`known_versions\`.

**Stale instructions:** \`instructions_stale: true\` means this block is older than the running server — run \`megamemory install\`, then restart the client.

Full contract, every flag and rare procedure: \`megamemory guide --workflow\`.
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
