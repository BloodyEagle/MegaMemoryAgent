<p align="center">
  <h1 align="center">MegaMemory <sub><sup>fork</sup></sub></h1>
</p>
<p align="center">Persistent project knowledge graph for coding agents — multilingual, token-economical, visible in the UI.</p>

<p align="center">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20.10-brightgreen?style=flat-square" />
  <img alt="version" src="https://img.shields.io/badge/version-2.5.1-orange?style=flat-square" />
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
| Embeddings | `all-MiniLM-L6-v2`, English-only, dimension hardcoded | `Xenova/multilingual-e5-small` by default (`MEGAMEMORY_EMBED_MODEL`), e5 `passage:`/`query:` prefixes, dimension learned from the first vector in an explicit, resumable `megamemory reembed` generation; only matching current-generation rows are searchable |
| Search | cosine similarity only | hybrid by default: FTS5 + vector fused with RRF, per-hit `via: vector \| fts \| both`, query sanitization for `MATCH`, short-CJK routing, optional trigram index, `name_norm` LIKE fallback; unavailable/mismatched vectors and hybrid vector-inference failures degrade to FTS. Explicit `MEGAMEMORY_SEARCH=vector` remains strict and reports inference errors. |
| Context | `understand` returns everything it found | `mode: "compact"` by default, bounded by `max_tokens` (1500), summaries trimmed to 240 chars, edges between returned nodes only, `meta.returned / dropped / tokens_estimated`; the answer ends with a `next` action block (`must_read` / `skip` / `followups` / `record`) |
| Freshness | delete or nothing | node `status` (`active`/`superseded`/`deprecated`), `supersedes` and `contradicts` edges, outdated nodes hidden from answers but visible in the graph; facts expire: `valid_until` drops state claims out of answers after their date |
| Duplicates | manual merge | `megamemory consolidate` finds embedding-similar pairs (≥ 0.95) and merges them with edge transfer |
| Long parent groups | every child read separately | `digest` nodes: one derived sibling for any parent after the 5th eligible child, search weight 0.8; source siblings remain independently searchable, and content-based staleness says when `megamemory digest --apply` must refresh the digest |
| Portability | DB only | `megamemory export --md <dir>` writes one markdown file per node (frontmatter + wiki-links); `--check` reports missing/differing/extra markdown for CI and never deletes files |
| Cost visibility | none | every `understand` / `list_roots` / `get_concept` is measured; 7-day aggregates in `megamemory stats`, `/api/stats` and the explorer's **Tokens** panel; `megamemory stats --funnel` measures the understand → follow-up → record funnel over the `timeline` journal (`--json` for scripts); `megamemory stats --health` reports honest state/activity metrics for a window (`--window 7d\|30d\|all`) — absence of writes is data, never a failure |
| Migration | — | explicit `megamemory migrate --apply` upgrades raw upstream v1.6.2 in place, additively, with coherent backups; dry-run executes the migration on a temporary SQLite snapshot and leaves the source untouched |

---

## The loop

`understand → work → update`

1. **Session start** — the agent calls `list_roots` (budgeted) to orient itself.
2. **Before a task** — `understand` with a natural-language query, or `get_concept` for an exact ID.
3. **Follow relevant `next` instructions** — read `must_read` refs, run ready-made `followups`, and record per `record` after the change. Refs and a brief without the claim do not prove whole-file coverage; `skip` does not replace checking current code. All modes use the actual MCP wire budget and refuse an impossible required envelope.
4. **After a task** — `create_concept` / `update_concept`, then `link` for relationships.
5. **Full contract** — the complete agent workflow lives in `docs/agent-workflow.md` (`megamemory guide --workflow` prints it verbatim); the per-operation cost and limits registry is `docs/capabilities.md`.

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
    { "node": "req-session-ttl", "why": "the requirement fixed the TTL" },
    { "ref": "git:tag:v2.1.11", "why": "shipped in that release" }
] }
```

Each item takes exactly one of `ref` (a file, a git object, or any other
identifier; the node already citing it is reused, otherwise a file-fact node is
created) or `node` (an existing concept), plus a mandatory `why`.

**Git evidence (2.1.12)** — "merged to main", "shipped in 2.1.11" are checked
against git objects, not files: `git:tag:<name>`, `git:commit:<sha>` (full or
7+ chars) and `git:branch:<name>` resolve to a commit sha via the LOCAL git
binary — no network calls, GitHub API is never touched. `check_artifacts` on
such an anchor reports the resolved sha; the tag moved or the branch advanced
→ `changed` with both shas in `weak_links`; the ref vanished → `missing`. Use
`git:branch:` only for "has moved" checks, never as proof of "merged". The
repository is `--repo PATH` at server start (default: the database directory).
Start MCP without a subcommand: `megamemory --db PATH --repo REPO`;
`--db=PATH` and `--repo=REPO` are equivalent, missing or repeated values fail
before opening the database. CLI subcommands may follow these global flags.
The startup `--repo` is passed explicitly on every MCP `check_artifacts` call and
therefore repins git refs if the server is restarted with a different repository.
Direct internal checks that omit `repo` reuse `node_artifacts.repo_path`; relative file
and git-blob refs likewise reuse their pinned root unless an explicit `cwd` overrides it.
Auto-deriving supports from
`why` + `file_refs` exists
but is **off by default** (`provenance.auto_ground` in `megamemory.config.json`
next to the database) — server-invented supports must not masquerade as
agent-declared provenance.

**File refs with locators (2.1.13)** — a ref may carry a line locator:
`path`, `path:12`, `path:12-30`, `path#L12`, `path#L12-L30`. The filesystem
receives only the path (Windows drive letters `C:\`, UNC `\\server\share`,
colons and `#` inside names are preserved); the locator is kept next to the
row for display and audit. **The digest is over the whole file** — the locator
limits the citation scope, not the hash scope: a change on line 500 still
flips a ref written as `path:12`. Git schemes are recognized first and are
never cut (`git:tag:2026` is a tag named "2026", not a path with a locator).
`bench` and `check_artifacts` share one parser (`src/refs.ts`) — a ref means
the same thing to both.

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

**Anchors vs claims (2.1.10)** — a support created by `evidence: [{ref}]` is an
*anchor*: a small node named after the file (`path:start-end`, or the whole file `plans/report.md`) with a template
summary ("File-fact node for … — created as a provenance support."). That
template is **by design** — the anchor exists to carry the link and its
digests, not to state a thought. Since schema v12 every node carries
`created_via` (`agent` | `file_ref` | `import` | `auto`), and only hand-written
nodes (`agent`) are ever counted as stubs: `stats` splits the support line into
`Supports: N (anchors a, claims c)` plus a `Stubs` counter, and `weak_links`
raises `stub_support` only for manual placeholder summaries. An anchor is never
a stub, and a hand-written template summary is still
rejected — the difference is the origin, not the text. Near-duplicates are
refused at creation: `create_concept` compares the normalized name (case,
spaces, punctuation, ё/е) and the summary vector (top-3, cosine threshold
`dedupe.threshold` in `megamemory.config.json`, default 0.92, env
`MEGAMEMORY_DEDUPE_THRESHOLD`) and returns `duplicate_of` instead of writing a
second copy — `force: true` overrides consciously. Digests and server-built
anchors are never deduplicated.

## Facts expire

A journal entry is not knowledge: "PR #3 not opened yet" was true on the day it
was written and is a lie a day later. Such nodes have no supports, so
`support_check` never flags them — nothing it tracks has changed. Schema v13
gives every node an optional `valid_until` (ISO-8601, UTC):

- **When to set it** — any statement about the world as it was: "merged",
  "release shipped", "PR open", "migration not started". Architecture,
  conventions and behavior facts stay dateless. The server never invents an
  expiry — `create_concept` / `update_concept` accept `valid_until`, and
  leaving it out means the fact is permanent.
- **What happens on expiry** — the node drops out of `understand` answers
  (`meta.stale_excluded` counts how many were hidden);
  `include_stale: true` returns them marked `expired: true`. Nothing is
  deleted: the node stays in the graph, in `get_concept`, in history — it
  just stops masquerading as current knowledge.
- **How it surfaces** — `provenance_trace` does not cut the chain at an
  expired predecessor: it is still traversed and counted, but marked
  `expired` and reported as a weak link. `stats` shows an `Expired` line;
  `doctor` warns when more than 10% of active nodes are past their date.
- **Superseded is not expired** — the `valid_until` written by `supersedes`
  is a replacement marker on a node that already left the answers through its
  own status; the expiry filters only apply to active nodes.
- **The server warns, never blocks (2.1.13)** — a summary that looks like a
  state claim (merged/released/pending, a PR number, a semver, a date) without
  `valid_until` gets a `state_claim_without_expiry` warning in the tool
  response; an expiry already in the past gets `expired_on_create`. The node
  is still written — setting the date is the agent's call, the server does not
  invent one. `kind=digest` is exempt.
- **Manual expiry (2.1.13)** — `megamemory expire --ids a,b --until 2027-01-01
  [--apply]` (or `--until past` = yesterday) sets `valid_until` on existing
  nodes; dry-run by default, one unknown id refuses the whole batch, every
  application writes a `timeline` entry. Cleanup candidates on a live base:
  run it on a copy, keep useful content by rewriting it instead of expiring.

---

## Measuring the benefit

Is the memory actually useful? Don't argue — measure: `megamemory bench` tells you in
numbers whether **orientation via the graph is cheaper than the alternative**, and how
often it points at the right nodes. Three baselines, one flag:

```bash
# vs reading the file_refs files of the found nodes (default)
megamemory bench --db .megamemory/knowledge.db --questions q.jsonl --baseline files

# vs token-economy-ts 1.1.0 text search: run from the analyzed project's root
# Replace the executable/script paths below with their absolute local paths.
megamemory bench --db "<owned-copy.db>" --questions q.jsonl --baseline te \
  --te-exec "C:/Program Files/nodejs/node.exe" \
  --te-arg "C:/p/agent-skills/skills/token-economy-ts/scripts/code-searcher.js" \
  --te-arg "query={query}" --te-arg "root=." --te-arg "ext=.ts,.tsx,.js,.jsx,.mjs,.cjs"

# both ratios side by side: where memory wins, where the structural tool is the right call
megamemory bench --db .megamemory/knowledge.db --questions q.jsonl --baseline both
```

`lang` groups results; it does not dispatch a skill. `root`/`--ref-root` resolve
file references and do not change runner cwd. Preset token counts bypass the runner;
precedence is preset → structured runner → per-question shell → global shell.
Shell templates are trusted advanced input, especially on Windows.

Graph path requires two endpoints, not a natural-language query:

```text
node "C:/p/agent-skills/skills/token-economy-ts/scripts/graph-tool.js" op=path from=src/a.ts to=src/b.ts root=.
python -I "C:/p/agent-skills/skills/token-economy-py/scripts/te.py" search "apply_catalog" --root "<project-root>"
node "C:/p/agent-skills/skills/token-economy-har/har.js" search "AbsentNeedle" --file "<own-artificial.har>" --json
```

PY search returns UTF-8 text, not JSON. HAR complete no-match returns its JSON
payload with exit1 and empty stderr; parse/regex/read errors exit2 instead.

TS 1.1.0 / PY 1.2.1 / HAR 1.0.1 use separate CLI/output contracts; use the
script from the source/staging package or an explicitly updated installation.
A complete expected no-match is valid; errors, absent payloads and truncation are
not proof of quality or a measurable advantage.

`graph_metric=retrieval_wire_without_instructions` estimates the actual retrieval
MCP content envelope: pretty JSON inside `{content:[{type:"text",text:...}]}` and
`next`. The bench path calls `understand` directly, so it **excludes the runtime
wrapper staleness fields** `instructions_stale`, `instructions_version`, and
`server_version` that the MCP handler adds; these are ordinary response payload
fields, not protocol initialization data. It is therefore not exactly the default
MCP response and not whole-task telemetry (`economy_status=not_measured`).
No fixed token correction is applied. `ratio > 1` means the graph is cheaper;
`ratio < 1` means the baseline is cheaper: 200 / 100 = 2, 100 / 200 = 0.5.

For quality-gated TE comparisons, add `expected_outcome`, `expect_nodes`,
`quality_contract` and `expected_te_refs`/`expected_te_symbols`/`expected_te_edges`
to the dataset; see [the explicit adapter schemas](docs/bench-protocol.md#quality-and-completeness).
`quality_ratio_te` and its median include only correct complete live pairs;
legacy `ratio_te`/token totals are **raw retrieval costs**, not evidence of benefit.
Preset counts are not live; malformed/error/absent payloads (even exit0) are never
eligible. A complete valid expected negative passes quality and can be compared
when both costs are positive. The report counts failures/unknowns over all questions.
The runner captures at most 16 MiB of stdout/stderr each, counts all emitted bytes,
and marks truncation; a partial prefix has no exact token cost or ratio.

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
- **Why `hit_rate@1` can drop after you add knowledge.** Supports (the `informed_by`
  facts behind a decision) contain the query terms verbatim — "EBUSY", "two-batch race" —
  and compete with the decision itself in search, pushing it off rank 1: the agent asks
  "why" and gets a fact fragment instead of the decision the fact belongs to. Since 2.1.7
  such **nested supports** leave the top level and fold under their decision (the
  `supports` field on the node, depth 1), so adding knowledge no longer sinks
  `hit_rate@1`; in bench a nested support counts as found at its decision's rank, and
  `meta.supports_inlined` reports how many nodes were folded. When the decision did not
  make the output, its support stays a standalone fact on the top level — knowledge is
  regrouped, never hidden.
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

Requires Node.js >= 20.10 (raised from 18: sharp, pulled in by the embedding pipeline, uses `import ... with { type: "json" }`, which Node 20.9 cannot parse). Building or testing a checkout uses the Vite/Vitest development toolchain and the repository gate accepts **Node 20.19+, 22.12+, or 24+** (Node 21 and 23 are not supported dev runtimes).
 For Russian-only projects a much smaller model (`cointegrated/rubert-tiny2`, 312-dim) works after an ONNX conversion; the model unloads after 5 minutes idle (`MEGAMEMORY_EMBED_IDLE_MS=0` disables that), and `MEGAMEMORY_SEARCH=fts` avoids loading it at all. The embedding model (~120 MB, multilingual) downloads on first use. With the shipped `@huggingface/transformers` runtime, its default filesystem cache is the package's own `.cache` directory; MegaMemory does not configure a stable user cache path, so inspect/configure the Transformers.js environment for nonstandard deployments rather than assuming a home-level Hugging Face cache.

Install globally from npm:

```bash
npm install -g @bloodyeagle/megamemory
```

Or download the package asset from the matching GitHub Release (npm names a scoped
package tarball `bloodyeagle-megamemory-<version>.tgz`; for this release):

```bash
npm install -g ./bloodyeagle-megamemory-2.5.1.tgz
```

Or build from a checkout (for development):

```bash
git clone https://github.com/BloodyEagle/MegaMemoryAgent.git
cd MegaMemoryAgent
npm ci
npm run build
npm pack                      # prints the exact generated .tgz filename
npm install -g ./bloodyeagle-megamemory-2.5.1.tgz
```

Register the integration with the installer:

```bash
megamemory install
# Non-interactive; comma-separated targets are also accepted:
megamemory install --target opencode
megamemory install --target claudecode
megamemory install --target antigravity
megamemory install --target codex
```

There is deliberately no universal manual JSON snippet: the clients use different
schemas. OpenCode stores a `type: "local"` entry whose `command` is an argv array;
Claude Code uses `mcpServers` with `type: "stdio"`, `command`, and `args`;
Antigravity uses a workspace `mcp_config.json` entry with `command` and `args`;
Codex uses `[mcp_servers.megamemory]` TOML. `install` writes the correct form and the
client-specific workflow files. If configuring by hand, register the stdio command
`megamemory` **without a subcommand**, translate argv into that client's form, and
manage its workflow instructions separately.

The server resolves `.megamemory/knowledge.db` from the MCP process working directory;
`--db PATH` / `--db=PATH` in server argv takes precedence over
`MEGAMEMORY_DB_PATH`. For Codex, `install` writes `config.toml` and `AGENTS.md` to a
non-empty `CODEX_HOME`, otherwise to `~/.codex`; OpenCode and Claude Code use their
client-specific profile paths shown in the installer output.

**Workflow-wrapper freshness.** `install` puts
`<!-- megamemory:instructions vX.Y.Z -->` on the managed block in `AGENTS.md` or
`CLAUDE.md` and on installed command markdown. It does not stamp MCP config or the
OpenCode plugin. On every `list_roots` and `understand`, the server freshly scans the
first stamped/legacy managed **instruction file** in this order: project `AGENTS.md`,
project `CLAUDE.md`, OpenCode `AGENTS.md`, `~/.claude/CLAUDE.md`, then
`~/.codex/AGENTS.md`. Command files are stamped for ownership/update but are not part
of this scan; in 2.5.1 a custom `CODEX_HOME` is installed correctly but is not an
additional scan candidate. The response carries the runtime wrapper staleness fields
`instructions_stale`, `instructions_version`, and `server_version`. No managed
instruction file means `false / null`; a version mismatch means re-run `install` for
the relevant target after updating the package.

### Upgrading an existing upstream database

A raw upstream v1.6.2 database has `PRAGMA user_version = 0` and an existing `nodes`
table. Normal MCP, `serve`, and ordinary RW command opens reject that shape with
`UPSTREAM_SCHEMA_V0`; they cannot reach startup auto-migration. Upgrade it explicitly:

```bash
megamemory migrate --dry-run    # migrate a temporary coherent snapshot; source is unchanged
megamemory migrate --apply      # coherent backup, then additive migration of the source
megamemory reembed              # establish/rebuild the current vector generation
megamemory doctor               # health check, exit code 1 on problems
```

`migrate --dry-run` is the default without `--apply`. It takes a coherent SQLite
`VACUUM INTO` snapshot (including committed WAL frames), runs the real apply path on
that disposable copy, and fingerprints the source main file plus `-wal` before and
after. It reports “nothing written” only if that fingerprint stayed stable; a
concurrent source change gets a warning. `repair-ids` has the same temporary-snapshot
and fingerprint semantics. A dry-run plan is advisory: neither command emits a token
that a later invocation consumes. `migrate --apply` recomputes against current state;
`repair-ids --apply` recomputes its plan and applies it atomically, failing closed if a
target became occupied, a rename became stale, or descendants still cannot be resolved.
Full and automatic migration likewise refuse/roll back instead of stamping success while
unresolved descendants remain. Backups are coherent snapshots named
`knowledge.db.bak-<UTC timestamp>`; only the three newest files matching MegaMemory's
strict name and SQLite-header checks are retained.

Schema numbers have two separate meanings. **`PRAGMA user_version = 14` is the actual
current database schema and compatibility guard.** `meta.schema_version` is only the
fork-conversion marker used by the upstream hygiene path (`"1"` while conversion is
pending, `"3"` after it ran); it is not schema 3 and must not be used to decide whether
a v14 database is current. Migration is additive and does not drop or rename upstream
columns, but older fork builds that predate the v14 future-version guard are not a safe
downgrade path—restore the pre-upgrade backup instead.

Migration and ordinary schema upgrades never run the embedding model. `reembed`
starts (or resumes) an explicit vector generation identified by model, preprocessing
profile, learned dimension, and generation number. Switching generation atomically
invalidates both the node blobs and native `nodes_vec` projection; each eligible
active, non-expired, non-refuted/non-abandoned node is then published to both
projections with generation and node-input checks. An interrupted run resumes missing
rows. Once the first valid row establishes the dimension, search may use only rows
already published in that current generation while FTS covers the rest; old, NULL,
wrong-dimension, or wrong-generation vectors never become hits. Run `reembed` after a
model/preprocessing change and after migrating vectors of unknown origin.

The exporter owns no directory: `export --check` only reports differing, missing and
extra `.md` files and exits nonzero on drift; it never deletes them. Remove confirmed
extras manually.

---

## MCP tools

| Tool | Description |
|---|---|
| `understand` | Budgeted hybrid retrieval in `compact` (default), `full`, or `brief`; filters inactive/expired facts and always returns the `next` action contract. |
| `get_concept` | Exact-ID full context: parent, children, edges, trails/slots, support check, and current digests for confirmation. |
| `create_concept` | Atomically create a node and optional edges/evidence; supports `supersedes`, `valid_until`, duplicate refusal, and same-call evidence snapshots. |
| `update_concept` | Patch content or expiry and perform reasoned epistemic transitions; relevant text changes republish a current-generation vector or invalidate the old one. |
| `link` | Add one of the eight typed relationships; `informed_by` requires a non-empty rationale and cannot close a provenance cycle. |
| `remove_concept` | Soft-delete with a reason and tombstones; refuses live dependents unless `force` is explicit. |
| `list_roots` | Budgeted startup payload: `roots_compact` rows (`id`, `name`, `kind`, `child_count`, `valid_until`), `slots`, `board_top`, truncation `meta`, graph `stats`, and wrapper staleness fields; legacy `roots` is empty. |
| `list_conflicts` | List unresolved concept/edge merge groups and live `contradicts` pairs. |
| `resolve_conflict` | Write verified resolved concept content, or explicitly choose a verified side for an edge-only conflict. |
| `provenance_trace` | Rooted `informed_by` traversal from `node_id` in `ancestry` or `impact` direction, with completeness, weak links, support checks, and current digests. |
| `provenance_audit` | Rooted audit from required `node_id` (`impact` by default): marks `at_risk` nodes and stores one bounded audit-run record; it is not a graph-wide scan. |
| `confirm_supports` | Atomically snapshot exactly the listed support versions after expected decision/support/status/edge digests pass; an empty list explicitly confirms no supports. |
| `provenance_history` | Read the revision chain of confirmed decision–support pairs, optionally for one support. |
| `check_artifacts` | Explicitly hash local file refs or resolve local `git:tag/commit/branch` refs and record current/changed/missing observations; no network or URL checks. |
| `trail_save` | Save an ordered reasoning chain with a mandatory rationale summary and fingerprints of member meaning. |
| `trail_get` | Read a trail and its per-member and aggregate `fresh` / `stale` / `broken` verdict. |
| `trail_refresh` | Re-snapshot eligible members after verification; broken or epistemically/temporally invalid members are not rehabilitated. |
| `trail_extend` | Append members to an existing trail and fingerprint their current meaning. |
| `slot_set` | Point one project role at a live node; reassignment adds a `supersedes` handoff edge, same-node retry is a no-op. |
| `slot_get` | Read the current live holder of one named role. |
| `slot_release` | Remove a role pointer without changing or deleting the former holder. |
| `slot_list` | List all project roles and their current live holders. |
| `task_add` | Create an open task concept with an optional parseable due date. |
| `task_done` | Move a task to terminal `done` and clear its due date. |
| `board` | Return open tasks sorted by rot and the done column with `count`, `returned`, `has_more`, and keyset `next_cursor` pagination. |

**Stored kinds:** `feature` · `module` · `pattern` · `config` · `decision` · `component` · `digest` · `task`

`create_concept` accepts the first seven values (`digest` remains for compatibility but is normally generated); `task` is created only by `task_add`.

**Relations:** `connects_to` · `depends_on` · `implements` · `calls` · `configured_by` · `supersedes` · `contradicts` · `informed_by`

---

## CLI

| Command | What it does |
|---|---|
| `megamemory install` | Configure an MCP client |
| `megamemory serve [--port N]` | Web explorer (graph, search, node cards, Tokens panel, consolidate tab). **Loopback only** (`127.0.0.1`, IPv6: `--host ::1`) — a local tool for a human, not a network service; earlier releases listened on all interfaces — behavior changed |
| `megamemory migrate [--dry-run\|--apply]` | Upgrade raw upstream v1.6.2 or repair fork migration objects; dry-run uses a disposable coherent snapshot, apply backs up and writes |
| `megamemory repair-ids [--dry-run\|--apply]` | Rebuild empty/trailing-slash and affected descendant IDs; dry-run uses a disposable snapshot, apply is atomic |
| `megamemory reembed [--batch N]` | Start/resume a model+preprocessing vector generation and republish eligible nodes into canonical/native projections |
| `megamemory doctor` | Health check: schema, model, FTS, IDs, vectors, orphans, digests |
| `megamemory stats` | Graph and token statistics |
| `megamemory eval` | recall@10 over `fixtures/eval.jsonl` |
| `megamemory guide` | Print the agent onboarding text (what install writes to AGENTS.md, plus a session example); `guide --workflow` prints the full workflow contract (`docs/agent-workflow.md`) verbatim — UTF-8, no database, no network |
| `megamemory bench --questions q.jsonl` | Orientation savings in tokens: graph vs `--baseline files\|te\|both` |
| `megamemory consolidate [--dry-run\|--apply]` | Find and merge near-duplicate nodes |
| `megamemory digest [--apply]` | Build or rebuild digest nodes |
| `megamemory export --md <dir> [--check]` | Markdown export; `--check` reports drift for CI and never deletes files |
| `megamemory expire --ids a,b --until <DATE\|past> [--apply]` | Set/replace `valid_until` atomically (dry-run by default; `DATE` is any nonempty value accepted by `Date.parse`, `past` means yesterday); `--report <json>` is the alternate ID source |
| `megamemory merge`, `conflicts`, `resolve` | Two-way merge of graphs across branches |

### Which commands never write to the database

`export`, `eval` and `conflicts` are the three direct protected read-only commands;
additional non-writing paths and snapshot dry-runs are listed below.

| Command/path | Source-database mode | Notes |
|---|---|---|
| `export` (including `--check`) | read-only | No WAL or migration; `--check` also never deletes export files. |
| `eval` | read-only | Parses/validates JSONL before opening the database. |
| `conflicts` | read-only | Inspection only; `merge` and `resolve` are separate writing commands. |
| `stats --funnel --json` / `stats --health --json` without `--prune` | read-only | The exact scripted snapshots only (combined `--funnel --health --json` too); plain `stats`, non-JSON funnel/health, and any `--prune` path are RW. |
| `expire` without `--apply` | read-only | Dry-run validates IDs and reports the replacement expiry; `--apply` is atomic RW. |
| `migrate --dry-run` | unchanged source | Runs the actual migration on a disposable coherent snapshot and fingerprints source main+WAL. |
| `repair-ids --dry-run` | unchanged source | Plans against the same kind of disposable snapshot and fingerprints source main+WAL. |
| test access under `MEGAMEMORY_FIXTURES_DIR` | read-only only | A test guard rejects RW opens of pinned fixtures. |

`MEGAMEMORY_ALLOW_AUTO_MIGRATE=1` has a deliberately narrow scope: it changes only
the `openReadonlyOrExplain` paths used by **`export`, `eval`, and `conflicts`** into an
ordinary RW open for that process. It does not affect `stats --funnel --json`,
`stats --health --json`,
`expire` dry-run, either snapshot dry-run, fixtures, or any other command. On a
read-only schema mismatch, an older database reports
`SCHEMA_TOO_OLD_READONLY` with `megamemory migrate --apply --db "<path>"`; a newer
one reports `SCHEMA_TOO_NEW_READONLY` with its `PRAGMA user_version` and an
upgrade-package hint. Missing and corrupt files have distinct errors; corruption is
not given a migration hint.

Every other database command is RW even when its high-level operation sounds like a
plan: `stats`, `bench` and `doctor` open the database for writing; plain `stats` and
`bench` write usage telemetry, `stats --prune` writes by design, and `doctor` may
migrate an old fork schema. `consolidate` and `digest` dry-runs also construct RW
design; `doctor` migrates on open; `consolidate` and `digest` dry-runs currently use an
RW `KnowledgeDB`; `serve` and MCP write usage/timeline and may perform startup hygiene.
`merge`, `resolve`, all apply modes, and write tools mutate their documented targets.
Therefore copy `fixtures/demo.db` before using it outside the guarded read-only paths.

---

## Environment

Runtime controls read by MegaMemory itself:

| Variable | Default | Meaning |
|---|---|---|
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | Database fallback after `--db`; resolved from the process cwd. |
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Transformers.js ONNX model identity; changing it requires `reembed`. |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid`, `fts`, or `vector`; vector mode falls back to FTS when no valid current generation exists. |
| `MEGAMEMORY_FTS_TOKENIZER` | unset | Exact value `trigram` requests the companion CJK FTS table/triggers. |
| `MEGAMEMORY_EMBED_IDLE_MS` | `300000` | Idle milliseconds before unloading the model; `0` disables unload. Read when the module starts. |
| `MEGAMEMORY_EMBED_THREADS` | `1` | ONNX intra-op thread count; inter-op remains 1. Read when the module starts. |
| `MEGAMEMORY_AUTO_DIGEST` | on | Exact value `0` disables automatic first digest creation after the 5th eligible child. |
| `MEGAMEMORY_DEDUPE_THRESHOLD` | `0.92` | Valid `(0,1]` cosine threshold for semantic duplicate refusal; overrides `dedupe.threshold` in the adjacent config. |
| `MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT` | config / off | Per-call strict-decision override; boolean forms `1/0`, `true/false`, `on/off`, `yes/no`. |
| `MEGAMEMORY_REQUIRE_SUPPORT` | config / off | Short fallback alias for the preceding variable. |
| `MEGAMEMORY_PROVENANCE_AUTO_GROUND` | config / off | Per-call override for deriving decision supports from `why` + `file_refs`; same boolean forms. |
| `MEGAMEMORY_TIMELINE_RETENTION_DAYS` | `90` | Timeline age retention; integer `0` disables the age rule. |
| `MEGAMEMORY_TIMELINE_MAX_ENTRIES` | `50000` | Timeline count retention; integer `0` disables the count rule. |
| `MEGAMEMORY_D3_URL` | `/vendor/d3.min.js` | Explorer D3 source override. Without it, the vendored file is used; if missing, serve warns and falls back to jsDelivr. |
| `MEGAMEMORY_AUTO_MIGRATE` | on | MCP-startup hygiene only: exact `0` skips the full upstream conversion/ID-repair path and runs additive schema setup instead. It is not the read-only-command escape hatch and `serve` does not consult it. |
| `MEGAMEMORY_ALLOW_AUTO_MIGRATE` | off | Only `export`, `eval`, and `conflicts`: exact `1` replaces their protected readonly open with ordinary RW opening for that process. |
| `MEGAMEMORY_FIXTURES_DIR` | unset | Test/fixture safety boundary: RW opens below this directory are rejected. Not normally set in production. |

Installer/profile location controls are `OPENCODE_CONFIG_DIR` (otherwise
`XDG_CONFIG_HOME/opencode`, with `~/.config` as the XDG fallback), `CODEX_HOME`
(otherwise `~/.codex`), and `HOME`. These choose files written by `install`; they do
not change the graph runtime. The adjacent `megamemory.config.json` additionally
supports `provenance.require_support`, `provenance.auto_ground`, and
`dedupe.threshold`.

---

## Web explorer

```bash
megamemory serve --port 8080
```

- **local by construction (2.1.13)**: listens on `127.0.0.1` only (`--host ::1` for IPv6, wildcard refused); foreign `Host` (DNS rebinding guard) and foreign `Origin`/`Referer` requests are refused with 403; the mutating `POST /api/consolidate` requires same-origin, `Content-Type: application/json` and a body under 64 KB. It is a tool for a human at the machine — do not expose it as a network service
- nodes colored by kind, sized by edge count; `digest` nodes and outdated (`superseded`) nodes are visually distinct
- `supersedes` edges drawn dashed, status badges in the node card, "show outdated" toggle
- search hits carry a `via` badge (vector / fts / both) and a budget line: `N nodes, ~X tokens, dropped M · saved ~Z vs full`
- **Tokens** panel: average answer size and saved tokens over 7 days
- **Consolidate** tab: duplicate candidates with apply
- per-kind filter checkboxes (persisted), visible/total counter, **export bundle** button and per-node `download .md`
- **Health** chip: vectors, FTS sync, digests, empty ids, orphans, memory — with remedy hints
- digest cards list the digest's eligible source **siblings** in the parent module (not children of the digest), with a content-derived `stale` badge and a **focus** toggle
- timeline **status changes** mode; node cards show recent status transitions with reasons
- d3 ships with the package (`web/vendor/d3.min.js`) — the explorer renders offline; a missing file falls back to the jsDelivr CDN with a printed note, `MEGAMEMORY_D3_URL` overrides both, `/api/health` reports `d3_source`

---

## Tests

```bash
npm run build
npx vitest run src/__tests__/id-generation.test.ts --reporter=dot     # targeted
npx vitest run                                                       # full suite (slow: model download)
```

`fixtures/demo.db` is a ready-made graph (ru/en/zh/emoji, one `superseded`, one `digest`, one
duplicate pair). Copy it before opening in the explorer: `serve` records the call journal into
the database it serves, and the repository guard (`fixtures/sha256sums.txt`) requires fixtures
to stay byte-identical.

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