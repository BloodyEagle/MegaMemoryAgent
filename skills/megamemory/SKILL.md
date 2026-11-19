---
name: megamemory
description: Use the megamemory knowledge graph before coding tasks and after verified findings or decisions. Preserve evidence, granular nodes and the next.record workflow even during short sessions.
---

# megamemory

<!-- MegaMemory-managed file. Safe for megamemory install to update. -->

1. Before analysing a task, call `understand` with a short relevant query. Memory is context, not proof of current source code: read the referenced source and respect stale, refuted, unknown and incomplete qualifications.
2. An empty result does not mean there is no knowledge. Distinguish `reason=empty_base|no_match|budget`; refine the query or budget when appropriate, without inventing stored facts.
3. After verifying a reusable finding or decision, use `create_concept` with a meaningful `kind` and `evidence: [{ref: "file:lines", why: "what supports the claim"}]`. Update existing nodes instead of duplicating them; use `link` for explicit relationships.
4. Keep one node per module, feature or decision. Put narrower findings under `parent_id` instead of accumulating a giant root summary. IDs use Latin characters.
5. Before finishing, follow `next.record` from the latest response using the actual public tool schema, then list created or updated nodes. If there is no verified reusable conclusion, say so; do not fabricate a memory just to satisfy a nudge.

For the full workflow contract, run `megamemory guide --workflow` (`docs/agent-workflow.md` is shipped with the package). Server MCP `instructions` is only a short safety net, not a replacement for this contract.
