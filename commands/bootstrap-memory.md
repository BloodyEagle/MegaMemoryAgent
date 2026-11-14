<!-- MegaMemory-managed file. Safe for megamemory install to update. -->
# Bootstrap Project Knowledge Graph

RUN { git ls-files; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u | xargs wc -l 2>/dev/null | sort -rn | head -150
READ README.md

You are bootstrapping the megamemory knowledge graph for this project.

Your job is to understand the codebase and record its core concepts, architecture,
and patterns as knowledge graph nodes. The file listing above is sorted by line
count — the biggest files are where the core logic lives.

## Step 1: Check existing graph

Call `megamemory:list_roots` to see what's already recorded. This is a token-budgeted
index: inspect `roots_compact` (`id`, `name`, `kind`, `child_count`, `valid_until`),
`slots`, `board_top`, `hint`, `meta` (`returned`, `dropped`, `tokens_estimated`,
`truncated`, `dropped_slots`, `dropped_board_top`), `stats`, and wrapper fields
(`instructions_stale`, `instructions_version`, `server_version`). Legacy
`roots` is empty for compatibility; the response does not return children. If `meta.truncated` is true, do not treat the visible roots as complete.
If the graph has good coverage, report what's there and ask if I want to fill in
specific areas.

## Step 2: Identify major modules

From the file listing and README, identify the top-level systems in this project.
Think in terms of:
- What does this project DO? (features)
- What are the distinct subsystems? (modules)
- How is it structured? (patterns, decisions)

## Step 3: Read and create root concepts

For each major module, query `megamemory:understand` first. It is compact by
default; `mode:"full"` returns verbose cards and `mode:"brief"` returns at most
8 orientation lines without cards. Every mode returns a mandatory `next` block:
read all `must_read` refs before editing/recording, execute every `followup` exactly
with its supplied args, and follow `record`. `skip` is currently empty;
`file_refs` and summaries do not prove whole-file coverage.

Read the module's key files, then call `megamemory:create_concept` with a specific,
detailed summary. Include parameter names, defaults, file paths, and behavior
details — not vague descriptions. For every decision or pattern, include evidence
in the same call: `evidence: [{ref: "path:lines", why: "what supports the conclusion"}]`
or `[{node: "existing-id", why: "what supports it"}]`. A `file_refs` list or an
ordinary edge is not confirmed evidence.

## Step 4: Create children for important sub-components

For substantial modules, create child concepts for key pieces. Stay max 3 levels
deep. Focus on things a developer would need to know when working in that area.

## Step 5: Link and confirm related concepts

Connect concepts that interact across boundaries using `megamemory:link`.
The complete relation enum is:
- `connects_to` — concepts interact or share data
- `depends_on` — the source requires the target
- `implements` — the source concretely implements the target
- `calls` — the source invokes the target at runtime
- `configured_by` — the target controls source behavior
- `supersedes` — the source replaces the target
- `contradicts` — the source and target disagree
- `informed_by` — the source conclusion relies on the target; its non-empty
  description must explain exactly what in the target supports the source

For decisions, read the finished node with `megamemory:get_concept` and inspect
its `support_check`; use `megamemory:provenance_trace` to obtain the full support,
status, and edge digests, then call `megamemory:confirm_supports` with the versions
you actually read. Compact `understand` does not contain confirmation digests.

## Guidelines

- Be specific. "Handles auth" is useless. "JWT auth with RS256, tokens from
  /auth/login, validated in middleware, refresh tokens in Redis with 7d TTL" is useful.
- Focus on the top 10-15 most important concepts first. The graph grows over time.
- Don't document trivial things. If it's obvious from the file name, skip it.

- When a concept replaces an earlier decision, create the successor with
  `supersedes: [old_id]`; the old node remains as history. Mark a disproved claim
  `refuted` through `update_concept` with an `epistemic_reason`. Use
  `remove_concept` only for knowledge that is truly gone and no longer needed.
- Give time-bound state claims (`PR open`, `merged`, `release shipped`) an ISO-8601
  `valid_until`; keep durable architecture and conventions dateless.
- Do not create digest nodes manually — they are built from children automatically.
