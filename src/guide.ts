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
 */
export const AGENTS_MD_SNIPPET = `
${AGENTS_MD_STAMP}
## Project Knowledge Graph

You have access to a project knowledge graph via the \`megamemory\` MCP server and skill tool. You have no implicit memory of this project between sessions, so this graph is your only continuity for concepts, architecture, decisions, and relationships. A decision recorded without supports is, a month later, indistinguishable from a guess — record the evidence with it.

**Workflow: understand → work → update**

1. **Session start:** You must call \`megamemory\` with action \`overview\` (or \`megamemory:list_roots\` directly) before you begin work.
2. **Before each task:** You must call \`megamemory\` with action \`query\` (or \`megamemory:understand\` directly) before reading source files for project understanding.
3. **After each task:** You must call \`megamemory\` with action \`record\` to create/update/link concepts for what you built.

Be specific in summaries: parameter names, defaults, file locations, rationale. One idea — one node; update an existing node instead of creating a near-duplicate; when a decision dies, mark it superseded — do not delete. Keep concepts max 3 levels deep.

Good node: \`auth-token-refresh\` (decision) — "Silent refresh 30 s before token expiry, because 401s on /expired broke long jobs; lives in src/auth/refresh.ts."
Bad node: \`auth\` — "Everything about auth." — a vague label no query can retrieve.

4. **Budget:** \`understand\` is compact by default and bounded by \`max_tokens\` (1500).
   Use \`mode:"full"\` only when you need \`why\` and full children/edges.
5. **Freshness:** when a decision replaces an older one, pass \`supersedes: [old_id]\` to
   \`create_concept\` instead of deleting. If a search finds nothing, retry with
   \`include_inactive: true\` — the concept may be marked superseded.
6. **Digests:** \`digest\` nodes are per-module summaries rebuilt from children. Read the digest
   first, children second. Never create digests by hand.
7. **After changing the embedding model:** run \`megamemory reembed\`. Until it finishes, vector
   search is off and results are FTS-only.
8. **Supports:** for a decision/solution pass \`evidence: [{node | ref, why}]\` in the same call
   that creates it; \`why\` names what exactly in the support backs the conclusion — not a
   retelling. A support on a file is a ref — \`evidence: [{ref: "src/x.ts:120-180", why}]\` — not
   a new node: create a support node only for a thought a link cannot express. The ref creates
   an anchor (a file-named node with a template summary) — that is a support, not a stub.
   \`file_refs\` alone are not supports: the server derives them only with auto_ground
   enabled (off by default). Auto-derived supports are not confirmed evidence — a draft, not a check.
9. **Confirm versions:** after reading a support, confirm it: \`confirm_supports(decision_id,
   expected_claim_digest, items:[{support_id, expected_claim_digest, expected_status_digest,
   expected_edge_digest}])\` — the decision's digest is \`get_concept.current_digests.claim\`, the
   supports' digests travel in \`provenance_trace.supports[]\` — never computed by hand, and
   compact \`understand\` carries no digests. \`support_check.state\`: \`unchanged\` = same as you confirmed;
   \`changed\` = diverged (see \`reasons\`); \`unknown\` = never checked; \`incomplete\` = the check hit
   its budget. \`unknown\` and \`incomplete\` are NOT "all good". On \`changed\`: re-read the support,
   confirm again, or mark the decision \`refuted\`/\`superseded\` via \`update\` — never leave it
   hanging. \`truncated_by: depth|nodes|scan\` in a trace means the traversal was partial — never
   conclude "no more supports exist".
10. **Stale instructions:** if \`list_roots\`/\`understand\` returns \`instructions_stale: true\`, run
    \`megamemory install\` (it refreshes this block) and treat in-project instructions as possibly outdated.
11. **Asked "does this memory help?"** — don't argue, measure: \`megamemory bench\`
    (\`--baseline files\` vs reading files, \`te\` vs an external structural tool, \`both\`).
    Read \`ratio\` together with \`hit_rate\`: a cheap but wrong answer is not savings.
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
list_roots()
  -> 4 roots: build-pipeline, catalog-import, auth-model, ci-cache
# 2. Before the task: query the graph instead of reading the repo
understand("how does catalog import resolve module paths")
  -> compact: catalog-import-entry (0.83), catalog-path-resolution (0.76)
  -> support_check on catalog-import-entry: changed -> re-read that support first
# 3. Record the decision WITH its evidence, in the same call
create_concept(
  name: "catalog-import-cache", kind: "decision",
  summary: "Import cache keyed by (path, mtime); invalidated on tsconfig change.",
  evidence: [{ node: "catalog-import-entry",
               why: "its loader graph is exactly what the cache wraps" }])
  -> created catalog-import-cache, informed_by -> catalog-import-entry
# 4. Confirm the versions you actually read (digests from the responses)
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
- \`--baseline te --te-cmd "tool path {query}"\` — versus an external structural tool
  (symbol graph / outline); \`{query}\` is substituted escaped, stdout counts as tokens;
- \`--baseline both\` — both ratios side by side: where memory wins and where the
  structural tool is the right call.

\`ratio = baseline_tokens / graph_tokens\`; read it only together with \`hit_rate\` — a cheap
but wrong answer is not savings. Questions with fewer tokens than the baseline
(\`ratio < 1\`) are printed, not hidden.

For an honest number run with \`--files-top 3\` — a live agent reads two or three files, not
every \`file_refs\` of every found node — and read \`hit_rate@1\` (expected node ranked first)
next to \`hit_rate\` (anywhere in the top-10): a rank-6 hit is a much weaker answer.
`;

/**
 * F2: the full `megamemory guide` text — exactly the snippet that install
 * writes (one source), plus the session example and the measuring section.
 */
export function buildGuideText(): string {
  return [
    AGENTS_MD_SNIPPET.trimStart(),
    SESSION_EXAMPLE.trimStart(),
    MEASURING_SECTION.trimStart(),
  ].join("\n");
}
