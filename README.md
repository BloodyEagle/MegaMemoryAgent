<p align="center">
  <h1 align="center">MegaMemory <sub><sup>fork</sup></sub></h1>
</p>
<p align="center">Persistent project knowledge graph for coding agents — multilingual, token-economical, visible in the UI.</p>

<p align="center">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="version" src="https://img.shields.io/badge/version-2.1.5-orange?style=flat-square" />
</p>

<p align="center">
  <img src="./assets/preview.png" alt="MegaMemory web explorer" width="800" />
</p>

> **Fork of [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory) v1.6.2 (MIT).**
> Fork of the npm package [`megamemory`](https://www.npmjs.com/package/megamemory), published as `@bloodyeagle/megamemory`.
> Upstream keeps the concept, this fork fixes multilingual IDs, adds hybrid search,
> a context budget, fact freshness, digests, export and token accounting.
> Русская версия: [README.ru.md](./README.ru.md).

An [MCP](https://modelcontextprotocol.io/) server that lets your coding agent build and query a
graph of concepts, architecture, and decisions — so it **remembers across sessions**.

The LLM is the indexer. No AST parsing, no static analysis: the agent reads code, writes concepts
in its own words, and queries them before future tasks. The graph stores **concepts** — features,
modules, patterns, decisions — not code symbols. Everything persists in a per-project SQLite
database at `.megamemory/knowledge.db`.

---

## What this fork changes

| Area | Upstream 1.6.2 | This fork |
|---|---|---|
| Node IDs | slug strips everything outside `[a-z0-9-]`; Cyrillic, CJK, Greek, emoji names collapse to `""` and the second such node is lost | Unicode-safe slug: letters of any script, diacritics stripped only after Latin/Cyrillic/Greek/Hebrew bases (katakana dakuten and Hangul jamo are preserved), `/` becomes `-`, NFC output, hash fallback for emoji-only names, `-<hash8>` on collisions |
| Embeddings | `all-MiniLM-L6-v2`, English-only, dimension hardcoded | `Xenova/multilingual-e5-small` by default (`MEGAMEMORY_EMBED_MODEL`), e5 `passage:`/`query:` prefixes, dimension read from the model, vector search disabled on model mismatch until `megamemory reembed` |
| Search | cosine similarity only | hybrid: FTS5 + vector fused with RRF, per-hit `via: vector \| fts \| both`, query sanitization for `MATCH`, short-CJK routing, optional trigram index, `name_norm` LIKE fallback |
| Context | `understand` returns everything it found | `mode: "compact"` by default, bounded by `max_tokens` (1500), summaries trimmed to 240 chars, edges between returned nodes only, `meta.returned / dropped / tokens_estimated` |
| Freshness | delete or nothing | node `status` (`active`/`superseded`/`deprecated`), `supersedes` and `contradicts` edges, outdated nodes hidden from answers but visible in the graph |
| Duplicates | manual merge | `megamemory consolidate` finds embedding-similar pairs (≥ 0.95) and merges them with edge transfer |
| Long modules | every child read separately | `digest` nodes: one per module, rebuilt after the 5th child, lower search weight |
| Portability | DB only | `megamemory export --md <dir>` writes one markdown file per node (frontmatter + wiki-links), `--check` for CI |
| Cost visibility | none | every `understand` / `list_roots` / `get_concept` is measured; 7-day aggregates in `megamemory stats`, `/api/stats` and the explorer's **Tokens** panel |
| Migration | — | `megamemory migrate --dry-run/--apply` upgrades an upstream database in place, additively, with backups and a downgrade-safe schema |

---

## The loop

`understand → work → update`

1. **Session start** — the agent calls `list_roots` (budgeted) to orient itself.
2. **Before a task** — `understand` with a natural-language query, or `get_concept` for an exact ID.
3. **After a task** — `create_concept` / `update_concept`, then `link` for relationships.

---

## Provenance

Decisions are only as good as their sources. The graph keeps that linkage
explicit and machine-checkable.

**Supports (`informed_by`)** — "from materially rests on to": a decision points
at the fact, test, log or conversation it was drawn from. The rationale is
mandatory: an `informed_by` edge without a non-empty `description` is rejected,
in `link` and in batched `create_concept` alike. The support graph stays a
strict DAG — an edge that would close a cycle is refused. Cycles imported by a
merge are quarantined: the component is closed for writes, shows up in
`weak_links` with `needs_merge: true`, and `in_paths` through it honestly
reports `null` instead of a made-up number.

**`evidence` shortcut** — supports are declared in the same `create_concept`
call, no follow-up `link` needed:

```json
{ "evidence": [
    { "ref": "src/auth/session.ts#L42", "why": "timeout read from the code" },
    { "node": "req-session-ttl", "why": "the requirement fixed the TTL" }
] }
```

Each item takes exactly one of `ref` (a file; the node already citing it is
reused, otherwise a file-fact node is created) or `node` (an existing concept),
plus a mandatory `why`. Auto-deriving supports from `why` + `file_refs` exists
but is **off by default** (`provenance.auto_ground` in `megamemory.config.json`
next to the database) — server-invented supports must not masquerade as
agent-declared provenance.

**Strict mode** — `provenance.require_support: true` refuses a `decision` with
zero supports: no `evidence`, no `informed_by` edge, and (when auto-derivation
is on) nothing derived. The refusal says to pass `evidence` in the same call —
"add support later" is rejected on purpose, because the source of the
conclusion is lost by the next call. The flag is read fresh on every call
(`megamemory.config.json` next to the db; env overrides
`MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT` / `MEGAMEMORY_REQUIRE_SUPPORT`, `1|0`).
Other kinds, `link` and reads are unaffected.

**`provenance_trace` / `provenance_audit`** — walk `informed_by` in one
direction: `ancestry` ("what does this rest on") or `impact` ("what rests on
it"). The completeness contract is honest about what it did not show:
`total_within_depth` counts nodes within `depth`; the reason for stopping is
`truncated_by: depth | nodes | scan | null`; `in_paths` is the number of paths
in the shown subgraph, capped and flagged (`in_paths_capped`) rather than
exaggerated; the scan budget `max_scan_nodes` (default 5000) bounds both output
and work (`total_exact: false` when it fires). Weak links come first —
refuted/abandoned nodes, cycle components, edges without rationale, decisions
with `no_support` / `missing_support` / only-`ungrounded` supports (numeric
`count` plus `sample`, the first ≤ 5 ids) — and the whole `weak_links` block is
capped at 8 KB with a `weak_links_truncated` marker.

**Removal hygiene** — removing a node that other nodes rest on is refused with
a hint naming the dependents; `force` overrides it. Removals leave tombstones,
and in a merge an edge tombstone wins over a live copy — a severed link does
not resurrect because the other branch never knew.

---

## Measuring the benefit

Is the memory actually useful? Don't argue — measure: `megamemory bench` tells you in
numbers whether **orientation via the graph is cheaper than the alternative**, and how
often it points at the right nodes. Three baselines, one flag:

```bash
# vs reading the file_refs files of the found nodes (default)
megamemory bench --db .megamemory/knowledge.db --questions q.jsonl --baseline files

# vs an external structural tool (symbol graph, outline): {query} is substituted escaped
megamemory bench --db .megamemory/knowledge.db --questions q.jsonl --baseline te \
  --te-cmd "node ~/agent-skills/graph.js path {query}"

# both ratios side by side: where memory wins, where the structural tool is the right call
megamemory bench --db .megamemory/knowledge.db --questions q.jsonl --baseline both
```

Mixed-language repositories: the right structural tool depends on the language of the
module, so `te_cmd` and `lang` are set **per question**, and the report breaks the median
ratio down per language:

```json
{"id": "q7", "query": "where is apply_catalog called", "lang": "python",
 "te_cmd": "python ~/agent-skills/graph.py rdeps {query}"}
```

`ratio = baseline_tokens / graph_tokens` — but never read it without `hit_rate` (did the
expected nodes surface in the top-10): a cheap but wrong answer is not savings.
Questions where the graph lost (`ratio < 1`) are printed, not hidden. And the honest
caveat the command itself prints: **bench measures the cost of orientation, not the
quality of the answer — fewer tokens with worse quality is not a saving.** For a live
agent A/B comparison, see [docs/bench-protocol.md](docs/bench-protocol.md).

### How to read the numbers

- **`hit_rate` vs `hit_rate@1`.** `hit_rate` counts a question as a hit when any expected
  node surfaced anywhere in the top-10; `hit_rate@1` counts only when the best expected
  node ranked **first** (the `rank` column shows that position). `hit_rate@1 ≤ hit_rate`
  always — a rank-6 "hit" is a much weaker answer than a rank-1 one, and reading only
  the top-10 number overstates the graph.
- **`r(files)` vs `r(files-top)`.** `r(files)` compares the graph answer against **all**
  `file_refs` of every found node — that reaches tens of thousands of tokens and
  produces ×50 ratios no live agent would ever pay, because a live agent reads two or
  three files, not seventy. Run with `--files-top 3` and read `r(files-top)`: the
  baseline over the first three unique files in the output order (the order of found
  nodes, not the alphabet). `r(files-top) ≤ r(files)` always; when `N` exceeds the
  number of unique files they coincide.
- **`refs: resolved N/M (roots: …)`** — how many of the `M` unique `file_refs` pointed at
  files that actually exist. Refs with line suffixes (`src/db.ts:9`, `src/db.ts:605-643`)
  resolve to the same file as `src/db.ts`; a ref is tried against the question's
  `ref_roots`, then `--ref-root PATH` (repeatable), then the git root, then the cwd —
  the first hit wins. A high `missing:N` in the notes means the roots don't match how
  the refs were written; add a `--ref-root` instead of ignoring the misses.
- **`unknown_supports`** — found **decisions** with no confirmed support snapshot: the
  graph points at a decision, but nobody has verified yet that its justification still
  holds (per-question `unk:N` note, ids in the summary). It is a to-confirm queue, not
  an error; `stale_hits` (`st:N`) is the same for decisions whose confirmed support has
  since drifted.
- **`cold-start`** — the first question paid the embedding model load (its time is far
  above the median of the rest). The summary prints `warmup: …s (model load, excluded
  from median time)` next to the median without it; neither number is hidden.

---

## Install

Requires Node.js >= 18. For Russian-only projects a much smaller model (`cointegrated/rubert-tiny2`, 312-dim) works after an ONNX conversion; the model unloads after 5 minutes idle (`MEGAMEMORY_EMBED_IDLE_MS=0` disables that), and `MEGAMEMORY_SEARCH=fts` avoids loading it at all. The embedding model (~120 MB, multilingual) downloads on first use and is
cached in `~/.cache/huggingface`.

Install globally from npm:

```bash
npm install -g @bloodyeagle/megamemory
```


Or download the tarball from GitHub Releases (no build needed):

```bash
npm install -g ./megamemory-1.7.0-fork.1.tgz
```
Or build from a checkout (for development):

```bash
git clone https://github.com/BloodyEagle/MegaMemoryAgent.git
cd MegaMemoryAgent
npm ci
npm run build
npm pack                      # bloodyeagle-megamemory-1.7.0-fork.1.tgz
npm install -g ./bloodyeagle-megamemory-1.7.0-fork.1.tgz
```

Then either run the installer or register the MCP server by hand:

```bash
megamemory install            # interactive: opencode / [CC] / Codex / Antigravity
```

```json
{
  "megamemory": {
    "type": "local",
    "command": ["megamemory"],
    "enabled": true
  }
}
```

The server reads `.megamemory/knowledge.db` relative to the working directory; override with
`MEGAMEMORY_DB_PATH`.

**Keeping prompts fresh.** `install` stamps every file it generates with
`<!-- megamemory:instructions vX.Y.Z -->`. The server compares that stamp with
its own version on every `list_roots` / `understand` call and returns
`instructions_stale` / `instructions_version` / `server_version` right in the
response — after `npm update -g`, re-run `megamemory install` when the flag
comes back `true` (an agent cannot see stderr, so the signal travels in the
payload it already reads).

### Upgrading an existing upstream database

```bash
megamemory migrate --dry-run    # prints the plan, changes nothing
megamemory migrate --apply      # backs up knowledge.db.bak-<ts>, applies the additive schema
megamemory reembed              # only needed if the embedding model changed
megamemory doctor               # health check, exit code 1 on problems
```

The migration never drops or renames a column, so upstream v1.6.2 still opens a migrated database.
Nodes lost upstream to the empty-ID bug cannot be recovered; `--dry-run` reports them explicitly.

---

## MCP tools

| Tool | Description |
|---|---|
| `understand` | Hybrid search over the graph. `top_k`, `max_tokens`, `mode: "compact" \| "full"`, `include_inactive`. |
| `get_concept` | Exact-ID lookup with children, edges, incoming edges, parent. |
| `create_concept` | Add a concept with edges, file refs and `supersedes`. |
| `update_concept` | Update fields; embeddings are regenerated. |
| `link` | Typed relationship between concepts. |
| `remove_concept` | Soft-delete with a reason; history kept, status set to `deprecated`. |
| `list_roots` | Top-level concepts with direct children (budgeted). |
| `list_conflicts` | Unresolved merge conflicts, plus `contradicts` pairs. |
| `resolve_conflict` | Resolve a conflict with verified content. |
| `provenance_trace` | Walk `informed_by` (`ancestry` / `impact`) with honest completeness and weak links first. |
| `provenance_audit` | Graph-wide provenance audit: weak links, ungrounded decisions, retention of past audits. |

**Kinds:** `feature` · `module` · `pattern` · `config` · `decision` · `component` · `digest`

**Relations:** `connects_to` · `depends_on` · `implements` · `calls` · `configured_by` · `supersedes` · `contradicts` · `informed_by`

---

## CLI

| Command | What it does |
|---|---|
| `megamemory install` | Configure an MCP client |
| `megamemory serve [--port N]` | Web explorer (graph, search, node cards, Tokens panel, consolidate tab) |
| `megamemory migrate [--dry-run\|--apply]` | Upgrade an upstream database |
| `megamemory repair-ids [--apply]` | Rebuild empty / trailing-slash IDs from names |
| `megamemory reembed` | Recompute embeddings (resumable, batched) |
| `megamemory doctor` | Health check: schema, model, FTS, IDs, vectors, orphans, digests |
| `megamemory stats` | Graph and token statistics |
| `megamemory eval` | recall@10 over `fixtures/eval.jsonl` |
| `megamemory guide` | Print the agent onboarding text (what install writes to AGENTS.md, plus a session example) |
| `megamemory bench --questions q.jsonl` | Orientation savings in tokens: graph vs `--baseline files\|te\|both` |
| `megamemory consolidate [--dry-run\|--apply]` | Find and merge near-duplicate nodes |
| `megamemory digest [--apply]` | Build or rebuild digest nodes |
| `megamemory export --md <dir> [--check]` | Markdown export, CI-friendly drift check |
| `megamemory merge`, `conflicts`, `resolve` | Two-way merge of graphs across branches |

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | Database location |
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Embedding model (any transformers.js ONNX model) |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid` / `fts` / `vector` |
| `MEGAMEMORY_FTS_TOKENIZER` | — | `trigram` adds a second index for CJK |
| `MEGAMEMORY_AUTO_DIGEST` | on | `0` disables auto-digest after the 5th child |
| `MEGAMEMORY_D3_URL` | `/vendor/d3.min.js` | D3 source for the explorer UI; set to a CDN URL to load it remotely instead of the bundled copy |

---

## Web explorer

```bash
megamemory serve --port 8080
```

- nodes colored by kind, sized by edge count; `digest` nodes and outdated (`superseded`) nodes are visually distinct
- `supersedes` edges drawn dashed, status badges in the node card, "show outdated" toggle
- search hits carry a `via` badge (vector / fts / both) and a budget line: `N nodes, ~X tokens, dropped M · saved ~Z vs full`
- **Tokens** panel: average answer size and saved tokens over 7 days
- **Consolidate** tab: duplicate candidates with apply
- per-kind filter checkboxes (persisted), visible/total counter, **export bundle** button and per-node `download .md`
- **Health** chip: vectors, FTS sync, digests, empty ids, orphans, memory — with remedy hints
- digest cards list source concepts with a `stale` badge and a **focus** toggle
- timeline **status changes** mode; node cards show recent status transitions with reasons

---

## Tests

```bash
npm run build
npx vitest run src/__tests__/id-generation.test.ts --reporter=dot     # targeted
npx vitest run                                                       # full suite (slow: model download)
```

`fixtures/demo.db` is a ready-made graph (ru/en/zh/emoji, one `superseded`, one `digest`, one
duplicate pair) for manual checks in the explorer.

---

## Compatibility and limits

- Upstream v1.6.2 keeps working against a migrated database: new columns have defaults, FTS
  triggers maintain the index for upstream inserts. Backups `knowledge.db.bak-<ts>`, last 3 kept.
- FTS5 requires libsql's local file mode — MegaMemory is local-only; remote Turso forbids virtual tables.
- After any `VACUUM`, run `megamemory migrate --apply` to rebuild the FTS index (rowids are not stable).
- Russian text is not stemmed by FTS5's `unicode61`; the vector channel compensates, prefix queries help.

---

## Credits and license

Based on [MegaMemory](https://github.com/0xK3vin/MegaMemory) by 0xK3vin (MIT).
Fork maintained by [BloodyEagle](https://github.com/BloodyEagle). MIT, see [LICENSE](./LICENSE).
Differences and sync instructions: [docs/FORK.md](./docs/FORK.md).