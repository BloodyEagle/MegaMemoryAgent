<!-- MegaMemory-managed file. Safe for megamemory install to update. -->
# Save Session Knowledge

You are saving what you learned this session into the megamemory knowledge graph.
This is YOUR memory — record anything valuable for future sessions: what you
understood about the project, what you built, decisions that were made, patterns
you noticed, or intent the user shared.

## Step 1: Load existing graph

Call `megamemory:list_roots` to see what's already recorded. Read the budgeted
`roots_compact` index (`id`, `name`, `kind`, `child_count`, `valid_until`) plus
`slots`, `board_top`, `hint`, `meta` (`returned`, `dropped`, `tokens_estimated`,
`truncated`, `dropped_slots`, `dropped_board_top`), `stats`, and wrapper fields
(`instructions_stale`, `instructions_version`, `server_version`). Legacy
`roots` is empty for compatibility; the response does not return children. If `meta.truncated` is true, the visible list is not complete.
Understanding the current state prevents duplicates and helps you decide what
to update vs create.

## Step 2: Reflect on this session

Think about what happened this session. Consider:
- What did you learn about the project's purpose or intent?
- What features, modules, or components did you build or change?
- What design decisions were made and why?
- What patterns or conventions did you discover?
- What architectural understanding do you have now that isn't in the graph?
- Did anything get removed, replaced, or deprecated?

## Step 3: Search for overlap

Before creating anything new, call `megamemory:understand` with queries based on
what you worked on this session. Compact is the default; use `mode:"full"` for
verbose cards or `mode:"brief"` for at most 8 orientation lines without cards.
Every answer includes a mandatory `next`: read every `must_read` ref (mandatory
sources, not proof of whole-file coverage) and execute every `followup` exactly
with its supplied args. `record` is the ready-made write form — use it for
genuinely new or corrected knowledge; pure reading lawfully records nothing.
`skip` is currently empty; `file_refs` and summaries do not prove whole-file coverage.
For each area you touched, search to see if concepts already exist that should
be updated rather than duplicated.

For example, if you worked on authentication, call:
  megamemory:understand — query="authentication"

Do this for each distinct area. Existing concepts that are stale or incomplete
should be updated — don't create a new node when an update will do.

## Step 4: Write to the knowledge graph

For each thing worth remembering:

**New understanding** → `megamemory:create_concept`
  - name: human-readable name
  - kind: use `decision` for intent/rationale, `feature` for capabilities,
    `module` for subsystems, `pattern` for conventions, `config` for setup,
    `component` for distinct pieces of a system
  - summary: be specific — include parameter names, defaults, file paths,
    behavior details, and the WHY behind things
  - why: the rationale — this is often the most valuable part
  - file_refs: relevant files if applicable; these are locators, not proof
  - decision/pattern evidence: `[{ref: "path:lines", why: "what supports it"}]`
    or `[{node: "support-id", why: "what supports it"}]`; this creates
    `informed_by` support in the same call
  - edges: connect to existing concepts where relationships exist
    `[{to: "concept-id", relation: "connects_to|depends_on|implements|calls|configured_by|supersedes|contradicts|informed_by", description: "why"}]`
  - `informed_by` requires a non-empty rationale explaining what in the target
    supports the source
  - valid_until: ISO-8601 for time-bound state claims; omit for durable knowledge
  - created_by_task: brief description of what you were doing this session

**Updated understanding** → `megamemory:update_concept`
  - id: the concept slug
  - changes: `{summary?, why?, file_refs?, name?, kind?, valid_until?}`
  If an existing concept is now stale or incomplete based on what you learned,
  update it. This is often more valuable than creating new nodes.

**Refuted understanding** → `megamemory:update_concept`
  - id: the disproved concept
  - changes: `{epistemic_status: "refuted", epistemic_reason: "verified reason"}`
  Preserve antiknowledge and its reason; do not delete a disproved claim.

**New connections** → `megamemory:link`
  - from, to: concept IDs
  - relation: `connects_to | depends_on | implements | calls | configured_by |
    supersedes | contradicts | informed_by`
  - description: why this relationship exists; mandatory and specific for
    `informed_by`
  If you discovered how existing concepts relate to each other.

**Replacement** → `megamemory:create_concept`
  - create the successor with `supersedes: [old_id]`
  The old node remains as superseded history with `valid_until`; do not remove it.

**Truly removed thing** → `megamemory:remove_concept`
  - id: concept whose subject is actually gone
  - reason: why it was removed
  Use only when retained content is no longer needed. The operation soft-deletes
  with history and may refuse while active decisions rely on the node; `force`
  intentionally breaks those supports and is not a shortcut for replacement or
  refutation.

## Step 5: Confirm supports and verify

For every saved decision, call `megamemory:get_concept` after creation/update and
inspect `support_check`. Then call `megamemory:provenance_trace` to read complete
support, status, edge, and artifact digests, and pass those versions to
`megamemory:confirm_supports`. Do not compute digests yourself; compact
`understand` has none. `unknown`/`incomplete` is not confirmation, and a changed
support must be reread before confirming again.

Call `megamemory:list_roots` again. Confirm the budgeted index reflects your
current understanding, accounting for `meta.truncated`. Report what you saved.

## Guidelines

- Record what a future you (with no memory of this session) would need to know.
- Intent and rationale ("why") are more valuable than implementation details.
- Update existing concepts before creating new ones — keep the graph lean.
- Don't record trivial things. If it's obvious from the code, skip it.
- Reading without a meaningful new conclusion is a complete outcome — do not
  create nodes for pure reading or successful reuse. Full workflow contract:
  `megamemory guide --workflow` (docs/agent-workflow.md).
- After code changes, targeted freshness re-verification of saved conclusions is
  the explicit `check_freshness` call (related records via the reverse index, not
  the whole graph; read-only — it never confirms supports or raises reuse trust).
- Max 3 levels of nesting. Flat is better than deep.
- Connect concepts — isolated nodes are less useful than a connected graph.
- Give state claims such as `PR open`, `merged`, or `release shipped` an
  ISO-8601 `valid_until`; keep durable architecture and conventions dateless.
- Be specific. "Handles auth" is useless. "JWT auth with RS256, validated in
  middleware at src/middleware/auth.ts, refresh tokens in Redis with 7d TTL" is useful.
