// MegaMemory-managed file. Safe for megamemory install to update.
import { tool } from "@opencode-ai/plugin";

const SKILL = `
---
name: megamemory
description: Project knowledge graph — persistent memory across sessions. Use at session start, before tasks (to load context), and after tasks (to record what you built). The graph stores concepts, architecture, decisions, and relationships — written by you, for you.
allowed-tools: "megamemory:*"
---

# Megamemory — Project Knowledge Graph

Your persistent memory of the codebase. You have no implicit memory of this project between sessions, so this graph is your continuity. You write concepts as you work, and you query them before starting tasks.

## When to Use

- **Session start** → You must call \`list_roots\` before beginning work
- **Before any task** → You must call \`understand\` before reading source files for project understanding, then execute its mandatory \`next\` block
- **After any task** → You must call \`create_concept\` / \`update_concept\` / \`link\` to record what you did; decisions and patterns need evidence and confirmed support versions
- **Replacement** → Create the successor with \`supersedes: [old_id]\`; do not remove the old history
- **Refutation** → Use \`update_concept\` with \`epistemic_status: "refuted"\` and \`epistemic_reason\`
- **True removal** → Use \`remove_concept\` only when the thing is actually gone and its retained content is no longer needed

## Core Principles

1. **Query before work, update after work.** This is required, not optional.
2. **Concepts, not code.** Nodes are features, patterns, decisions — not files or symbols.
3. **Evidence, not assertion.** For a decision/pattern pass \`evidence: [{ref | node, why}]\`; \`why\` says exactly how the support justifies the conclusion.
4. **Be specific.** Include parameter names, defaults, file paths, rationale.
5. **Keep it shallow.** Max 3 levels deep. Useful beats exhaustive.

## Budget and modes

- \`understand\` defaults to \`mode:"compact"\`: summaries are trimmed to 240 chars and returned supports may be folded under decisions. \`mode:"full"\` returns verbose cards with \`why\`, children and edges. \`mode:"brief"\` returns at most 8 text lines plus \`next\`, with no cards.
- Every \`understand\` answer has a mandatory \`next\`: read every \`must_read\` ref before editing, execute \`followups\` with the supplied args, and follow \`record\` after the change. \`skip\` is currently empty; refs and summaries never prove whole-file coverage.
- \`max_tokens\` budgets the actual MCP content envelope, including \`next\` and wrapper staleness fields (\`instructions_stale\`, \`instructions_version\`, \`server_version\`) — not MCP initialize-level instructions. The call refuses a budget too small for the required envelope.
- \`list_roots\` is also token-budgeted. It returns \`roots_compact\` entries with \`child_count\` and \`valid_until\` (not children), plus \`slots\`, \`board_top\`, optional \`hint\`, \`meta\` (returned/dropped/token and per-section truncation fields), \`stats\`, and the wrapper staleness fields.

## Freshness and provenance

- Replacing a decision: pass \`supersedes: [old_id]\` to \`create_concept\`. The old node remains as \`superseded\` with \`valid_until\`.
- A state claim such as “PR open”, “merged”, or “release shipped” must carry an ISO-8601 \`valid_until\`; durable architecture and conventions stay dateless.
- Nothing found? Retry with \`include_inactive: true\` before concluding the knowledge is missing; use \`include_stale: true\` only when expired facts are relevant.
- \`file_refs\` and ordinary \`edges\` are not confirmed evidence. After reading, use \`get_concept\` and \`provenance_trace\` for current digests, then \`confirm_supports\`; compact \`understand\` carries no digests.
- \`remove_concept\` preserves a tombstone and may refuse removal when active decisions rely on the node. It is not the workflow for changed, replaced, or refuted knowledge.

## Digests

- A \`digest\` node is a derived summary of any parent with at least 5 eligible children. Read the digest first; open source siblings only when the digest is not enough.
- Do not create digests by hand — \`megamemory digest\` and the auto-builder own them.

## Concept Kinds

\`feature\` | \`module\` | \`pattern\` | \`config\` | \`decision\` | \`component\` | \`digest\` (compatibility/manual wire; normally generated) | \`task\` (stored kind created by \`task_add\`, not by \`create_concept\`)

## Relationship Types

- \`connects_to\` — A and B interact or share data
- \`depends_on\` — A requires B to function
- \`implements\` — A is the concrete implementation of B
- \`calls\` — A invokes B at runtime
- \`configured_by\` — A's behavior is controlled by B
- \`supersedes\` — A replaces B; when passed through \`create_concept.supersedes\`, B is marked superseded and leaves default answers. A standalone \`link\` records only the relationship.
- \`contradicts\` — A and B disagree; the contradiction is surfaced by \`list_conflicts\`
- \`informed_by\` — A's conclusion relies on B; a non-empty rationale is mandatory and must say what in B supports A

## MCP Tools Reference

| Tool | What it does |
|---|---|
| \`megamemory:understand\` | Search in compact/full/brief mode; always returns the mandatory, budgeted \`next\` contract |
| \`megamemory:get_concept\` | Exact-ID full context with children/edges, \`support_check\`, and current confirmation digests |
| \`megamemory:create_concept\` | Create a node; supports same-call \`evidence\`, \`supersedes\`, and \`valid_until\` |
| \`megamemory:update_concept\` | Patch fields or make a reasoned epistemic transition such as \`refuted\` |
| \`megamemory:link\` | Link existing nodes with any of the 8 relations; \`informed_by\` requires a rationale |
| \`megamemory:remove_concept\` | Soft-delete truly removed knowledge, preserving history; guarded when decisions depend on it |
| \`megamemory:list_roots\` | Budgeted \`roots_compact\`/\`child_count\` overview plus slots, board, meta, stats, and wrapper status; legacy \`roots\` stays empty |
| \`megamemory:list_conflicts\` | List unresolved merge groups, edge conflicts, and live contradictions |
| \`megamemory:resolve_conflict\` | Write verified resolved content; edge-only conflicts can select a verified side with \`prefer\` |
| \`megamemory:provenance_trace\` | Trace \`informed_by\` ancestry/impact, weak links, completeness, supports, and current digests |
| \`megamemory:provenance_audit\` | Audit what depends on a claim and journal the bounded audit run without changing the graph |
| \`megamemory:confirm_supports\` | Atomically snapshot exactly the support versions read, using expected digests |
| \`megamemory:provenance_history\` | Read revision history of confirmed decision-support pairs |
| \`megamemory:check_artifacts\` | Explicitly hash/resolve local file and git refs and record changed/missing observations |
| \`megamemory:trail_save\` | Save an ordered reasoning chain with a mandatory rationale summary and member fingerprints |
| \`megamemory:trail_get\` | Read a trail and its fresh/stale/broken verdict |
| \`megamemory:trail_refresh\` | Re-snapshot verified eligible trail members; it does not rehabilitate invalid knowledge |
| \`megamemory:trail_extend\` | Append members to a trail and fingerprint their current meaning |
| \`megamemory:slot_set\` | Assign a project's named role to one live node; the previous holder loses only the slot, and a \`supersedes\` edge records the handoff without changing its lifecycle |
| \`megamemory:slot_get\` | Read the current holder of one role |
| \`megamemory:slot_release\` | Release a role without deleting or changing its former holder |
| \`megamemory:slot_list\` | List all project roles and current holders |
| \`megamemory:task_add\` | Add an open task card with an optional due date |
| \`megamemory:task_done\` | Move a task to done and clear its due date |
| \`megamemory:board\` | Show open tasks by rot and paginated done tasks |
`;

export default tool({
  description: SKILL,
  args: {
    action: tool.schema
      .enum(["query", "record", "overview", "merge"])
      .describe(
        "Workflow action: query (before task — understand context), record (after task — create/update/link), overview (session start — list roots), merge (resolve merge conflicts)",
      ),
    query: tool.schema
      .string()
      .optional()
      .describe("Natural language query for the 'query' action"),
    concepts: tool.schema
      .string()
      .optional()
      .describe(
        "For 'record' action: brief description of what concepts to create/update/link",
      ),
  },
  async execute({ action, query, concepts }) {
    switch (action) {
      case "overview":
        return `To get a project overview, call:

1. megamemory:list_roots — Token-budgeted startup index. Read roots_compact entries (id, name, kind, child_count, valid_until), slots, board_top, optional hint, meta (returned/dropped/tokens/truncation and per-section drops), stats, and the wrapper fields instructions_stale/instructions_version/server_version. Legacy roots is an empty compatibility field; it does not return child cards.

Use this at the start of every session to orient yourself. Check meta.truncated/dropped before treating the index as complete. If instructions_stale is true, run megamemory install. If the graph is empty, proceed normally and create concepts as you work.`;

      case "query":
        if (!query) {
          return "Error: query is required for the query action. Describe what you need to understand about the project.";
        }
        return `To load context for "${query}", call:

1. megamemory:understand — query="${query}"
   Default mode is compact: token-budgeted cards with trimmed summaries, file_refs, lifecycle/epistemic qualification, optional nested supports, relations between returned nodes, meta, and next.
   - mode:"full": verbose cards with why, children, outgoing/incoming edges, and parent context
   - mode:"brief": at most 8 orientation lines plus next, no cards

2. Execute next as a contract:
   - read every must_read ref before editing
   - execute followups with the supplied args
   - follow record after the change
   - do not infer coverage from file_refs or summaries; skip is currently empty

Check meta.truncated/reason/dropped and the wrapper staleness fields. max_tokens covers this actual MCP envelope, including next and those wrapper fields, not initialize-level MCP instructions. If no live results return, inspect stale_excluded/inactive_excluded and retry with include_stale/include_inactive only when appropriate.`;

      case "record":
        return `After completing your task, update the knowledge graph:

1. **Search first** → megamemory:understand
   - Reuse/update an existing node instead of creating a near-duplicate
   - Read every next.must_read ref and execute every next.followup exactly as supplied; refs/summary do not prove coverage

2. **New concept** → megamemory:create_concept
   - name, kind, summary, why, parent_id?, file_refs?, created_by_task?
   - decision/pattern: evidence: [{ref: "file:lines", why: "what supports the conclusion"}] or [{node: "support-id", why: "what supports it"}]
   - evidence creates informed_by supports in the same call; ordinary file_refs/edges are not confirmed evidence
   - edges: [{to, relation: "connects_to|depends_on|implements|calls|configured_by|supersedes|contradicts|informed_by", description}]
   - informed_by requires a non-empty rationale
   - valid_until: ISO-8601 for time-bound state claims; omit for durable knowledge
   - replacement: supersedes: [old_id] — never remove the old history

3. **Changed or refuted concept** → megamemory:update_concept
   - changes: {summary?, why?, file_refs?, name?, kind?, valid_until?}
   - refutation: {epistemic_status: "refuted", epistemic_reason: "verified reason"}; do not remove it

4. **Relationship only** → megamemory:link
   - from, to, any of the 8 relation values above, description
   - informed_by description must explain exactly what the target supports

5. **Confirm decision supports after reading**
   - get_concept(decision id) supplies the current decision claim digest and support_check
   - provenance_trace supplies full support/edge/status digests
   - confirm_supports snapshots exactly the read versions; compact understand has no digests

6. **Truly removed knowledge only** → megamemory:remove_concept
   - id, reason; force only when intentionally breaking live supports
   - this soft-deletes with history and is not for replacements, refutations, or ordinary changes${concepts ? `\n\nContext about what to record: "${concepts}"` : ""}`;

      case "merge":
        return `To resolve merge conflicts in the knowledge graph:

1. **List conflicts** → megamemory:list_conflicts
   - Returns all unresolved conflicts grouped by merge_group
   - Each group has competing versions with summaries, file_refs, edges

2. **For each conflict:**
   a. Read both versions' summaries, file_refs, and edges
   b. Read the actual source files referenced in file_refs to determine what the code ACTUALLY does now
   c. For a concept conflict, write the correct resolved content based on the current codebase — do NOT just pick a side
   d. For an edge-only group, verify the competing edges and choose the correct source with prefer:"left" or prefer:"right"

3. **Resolve** → megamemory:resolve_conflict
   - merge_group: the UUID of the conflict
   - concept conflict: resolved: {summary, why?, file_refs?} — the verified, correct content
   - edge-only conflict: prefer: "left"|"right"; the wire still requires resolved, but ignores it for this group
   - reason: what you verified and why this resolution is correct

The goal is accuracy: the resolved concept should describe the code as it actually exists. If a former claim is disproved, preserve it as refuted with update_concept; if a new decision replaces it, create the successor with supersedes. Use remove_concept only when the retained knowledge is truly gone and no longer needed.`;

      default:
        return `Unknown action: ${action}. Use: overview (session start), query (before task), record (after task), merge (resolve conflicts).`;
    }
  },
});
