<p align="center">
  <h1 align="center">MegaMemory <sub><sup>fork</sup></sub></h1>
</p>
<p align="center">A persistent memory for coding agents — a knowledge graph of your project, in any language, visible in the UI.</p>

<p align="center">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20.10-brightgreen?style=flat-square" />
  <img alt="version" src="https://img.shields.io/badge/version-2.14.2-orange?style=flat-square" />
</p>

<p align="center">
  <img src="./assets/preview.png" alt="MegaMemory web explorer" width="800" />
</p>

> **Fork of [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory) v1.6.2 (MIT)**, published as the npm package `@bloodyeagle/megamemory`.
> Upstream owns the concept. This fork fixes multilingual IDs and adds hybrid search,
> a context budget, fact freshness, digests, export and token accounting.
> Русская версия: [README.ru.md](./README.ru.md).

## What is this

A coding agent is brilliant and forgetful at the same time. Every new session it
re-explores the same codebase, re-asks the same questions and re-pays the same
tokens — because yesterday's conclusions died with yesterday's context window.

MegaMemory is an [MCP](https://modelcontextprotocol.io/) server that fixes this.
It gives the agent a **persistent knowledge graph of the project**: features,
modules, patterns, decisions — with links between them and with their sources.
The agent queries it before a task, and the graph answers in a budgeted,
compact form instead of the agent re-reading half the repository.

The agent itself is the indexer. No AST parsing, no static analysis: the agent
reads code, writes concepts **in its own words**, and queries them before future
tasks. The graph stores *concepts*, not code symbols. Everything lives in a
per-project SQLite database at `.megamemory/knowledge.db` — local, portable, yours.

## Contents

- [Why it helps](#why-it-helps)
- [How an agent uses it: the loop](#how-an-agent-uses-it-the-loop)
- [What this fork changes](#what-this-fork-changes)
- [Installation](#installation)
  - [Kilo installation](#kilo-installation)
  - [Upgrading an existing upstream database](#upgrading-an-existing-upstream-database)
- [Provenance: decisions cite their sources](#provenance-decisions-cite-their-sources)
- [Facts expire](#facts-expire)
- [Measuring the benefit](#measuring-the-benefit)
  - [How to read the numbers](#how-to-read-the-numbers)
- [MCP tools](#mcp-tools)
  - [`understand`: compact recall and budget](#understand-compact-recall-and-budget)
- [CLI](#cli)
  - [Git hooks](#git-hooks)
  - [Which commands never write to the database](#which-commands-never-write-to-the-database)
- [Environment](#environment)
- [Web explorer](#web-explorer)
- [Tests](#tests)
- [Documentation map](#documentation-map)
- [Compatibility and limits](#compatibility-and-limits)
- [Credits and license](#credits-and-license)
- [Commit and PR templates](./docs/commits.md)

## Why it helps

- **Continuity between sessions.** Architecture, decisions and their
  justifications survive the context window. The next session starts by asking
  the graph, not by re-exploring the code.
- **Cheaper orientation.** Answers are budgeted: `understand` returns a compact,
  token-capped selection instead of the agent reading file after file.
  `megamemory bench` measures the actual savings against real baselines.
- **Any language.** Node IDs work with Cyrillic, CJK, Greek, Hebrew and emoji
  names; embeddings are multilingual by default; the UI renders it all.
- **Knowledge you can trust.** Every decision cites its sources (`informed_by`),
  facts can carry an expiry date, and superseded knowledge is hidden from
  answers — but stays visible in the graph.
- **Human-visible.** `megamemory serve` opens a local web explorer: the graph,
  search with cost badges, health, and 7-day token statistics.
- **Local by construction.** A SQLite file in the project, a loopback-only web
  server, no cloud, no network calls; telemetry is opt-in and local.

## How an agent uses it: the loop

`understand → work → record`

1. **Session start** — the agent calls `list_roots` (budgeted) to orient itself.
2. **Before a task** — `understand` with a natural-language query, or
   `get_concept` for an exact ID.
3. **Follow the `next` instructions** — read `must_read` refs, run ready-made
   `followups`, and record per `record` after the change. `record` carries the
   evidence form (`[{ref|node, why}]` → `informed_by`); `file_refs` alone creates
   no link. Refs and a brief without a claim do not prove whole-file coverage;
   `skip` does not replace checking current code.
4. **After a task** — `create_concept` / `update_concept`, then `link` for
   relationships.
5. **Full contract** — the complete agent workflow lives in
   [docs/agent-workflow.md](docs/agent-workflow.md) (`megamemory guide --workflow`
   prints it verbatim); the per-operation cost and limits registry is
   [docs/capabilities.md](docs/capabilities.md).

All read modes use the actual MCP wire budget and refuse an impossible required
envelope instead of silently trimming.

---

## What this fork changes

| Area | Upstream 1.6.2 | This fork |
|---|---|---|
| Node IDs | slug strips everything outside `[a-z0-9-]`; Cyrillic, CJK, Greek, emoji names collapse to `""` and the second such node is lost | Unicode-safe slug: letters of any script, diacritics stripped only after Latin/Cyrillic/Greek/Hebrew bases (katakana dakuten and Hangul jamo are preserved), `/` becomes `-`, NFC output, hash fallback for emoji-only names, `-<hash8>` on collisions |
| Embeddings | `all-MiniLM-L6-v2`, English-only, dimension hardcoded | `Xenova/multilingual-e5-small` by default (`MEGAMEMORY_EMBED_MODEL`), e5 `passage:`/`query:` prefixes, dimension learned from the first vector in an explicit, resumable `megamemory reembed` generation; only matching current-generation rows are searchable |
| Search | cosine similarity only | hybrid by default: FTS5 + vector fused with RRF, per-hit `via: vector \| fts \| both`, query sanitization for `MATCH`, short-CJK routing, optional trigram index, `name_norm` LIKE fallback; unavailable/mismatched vectors and hybrid vector-inference failures degrade to FTS. Explicit `MEGAMEMORY_SEARCH=vector` remains strict and reports inference errors. |
| Context | `understand` returns everything it found | `mode: "compact"` by default, bounded by `max_tokens`, summaries trimmed, edges between returned nodes only, honest `meta.returned / dropped / tokens_estimated`; the answer ends with a `next` action block (`must_read` / `skip` / `followups` / `record`) |
| Freshness | delete or nothing | node `status` (`active`/`superseded`/`deprecated`), `supersedes` and `contradicts` edges, outdated nodes hidden from answers but visible in the graph; facts expire: `valid_until` drops state claims out of answers after their date |
| Duplicates | manual merge | `megamemory consolidate` finds embedding-similar pairs (≥ 0.95) and merges them with edge transfer |
| Long parent groups | every child read separately | derived `digest` sibling for any parent after the 5th eligible child, search weight 0.8; source siblings remain independently searchable, and content-based staleness says when `megamemory digest --apply` must refresh the digest |
| Portability | DB only | `megamemory export --md <dir>` writes one markdown file per node (frontmatter + wiki-links); `--check` reports missing/differing/extra markdown for CI and never deletes files |
| Cost visibility | none | every `understand` / `list_roots` / `get_concept` is measured; 7-day aggregates in `megamemory stats`, `/api/stats` and the explorer's **Tokens** panel; `megamemory stats --funnel` measures the understand → follow-up → record funnel over the `timeline` journal (`--json` for scripts); `megamemory stats --health` reports honest state/activity metrics for a window (`--window 7d\|30d\|all`) — absence of writes is data, never a failure |
| Migration | — | explicit `megamemory migrate --apply` upgrades raw upstream v1.6.2 in place, additively, with coherent backups; dry-run executes the migration on a temporary SQLite snapshot and leaves the source untouched |

---

## Installation

### Requirements

- **Node.js ≥ 20.10** at runtime (raised from 18: `sharp`, pulled in by the
  embedding pipeline, uses `import ... with { type: "json" }`, which Node 20.9
  cannot parse). Building or testing a checkout uses the Vite/Vitest toolchain
  and the repository gate accepts **Node 20.19+, 22.12+, or 24+** (Node 21 and
  23 are not supported dev runtimes).
- The multilingual embedding model (**~120 MB**) downloads on first use and
  unloads after 5 minutes of idleness (`MEGAMEMORY_EMBED_IDLE_MS=0` disables
  the unload). `MEGAMEMORY_SEARCH=fts` avoids loading it at all. For
  Russian-only projects a much smaller model (`cointegrated/rubert-tiny2`,
  312-dim) works after an ONNX conversion. With the shipped
  `@huggingface/transformers` runtime, the model cache defaults to the
  package's own `.cache` directory — for nonstandard deployments configure the
  Transformers.js environment instead of assuming a home-level Hugging Face cache.

### Install and register

Install globally from npm:

```bash
npm install -g @bloodyeagle/megamemory
```

Or download the package asset from the matching GitHub Release (npm names a
scoped package tarball `bloodyeagle-megamemory-<version>.tgz`):

```bash
npm install -g ./bloodyeagle-megamemory-2.6.3.tgz
```

Or build from a checkout (for development):

```bash
git clone https://github.com/BloodyEagle/MegaMemoryAgent.git
cd MegaMemoryAgent
npm ci
npm run build
npm pack                      # prints the exact generated .tgz filename
npm install -g ./bloodyeagle-megamemory-2.6.3.tgz
```

Register the integration with the installer:

```bash
megamemory install
# Non-interactive; comma-separated targets are also accepted:
megamemory install --target opencode
megamemory install --target claudecode
megamemory install --target antigravity
megamemory install --target codex
megamemory install --target kilo
megamemory install --target zcode
```

**First semantic setup is automatic by default.** A fresh base without a vector
generation (including one without an `embed_model` stamp) is normal, not broken:
until vectors are ready, keyword search uses `match: "all"` by default.
Successful node writes and MCP startup schedule a missing first generation in the
background when eligible nodes exist. This also covers a generation with no
vectors yet and a partial index: the active generation is kept and only the
missing node vectors are rebuilt; model mismatches are not repaired.

Set `MEGAMEMORY_AUTO_REEMBED=0` to disable only this automatic initialization.
The first use of the embedding model may download it (about 120 MB); subsequent
uses load it from the local cache. Background work does not delay the tool's
response. Failure is reported to stderr and the timeline; the cooldown after a
failed attempt doubles from 10 up to 60 minutes, and after three failed attempts
the automation pauses for this process with a stderr note — manual `megamemory
reembed` remains the way forward. There is no automatic retry timer.

Manual setup or recovery remains available in the project directory (or pass
`--db PATH` for another base):

```bash
megamemory reembed
```

On an empty base it creates a generation with `dim = 0`; the first published node
vector fixes the dimension. New nodes then receive vectors as they are written.
`megamemory doctor` reports whether vector search is on, off, or partial; resume
`reembed` for model changes, explicitly disabled initialization, or when the
automatic catch-up is paused after repeated failures.

There is deliberately **no universal manual JSON snippet**: the clients use
different schemas. `install` writes the correct form and the client-specific
workflow files; if configuring by hand, register the stdio command
`megamemory` **without a subcommand** and translate argv into that client's form.

| Client | Config form |
|---|---|
| OpenCode | a `type: "local"` entry whose `command` is an argv array |
| Claude Code | `mcpServers` with `type: "stdio"`, `command`, `args` |
| Antigravity | a workspace `mcp_config.json` entry with `command` and `args` |
| Codex | a `[mcp_servers.megamemory]` TOML table |
| Kilo | new JSONC `mcp.megamemory` or legacy `mcpServers` (see below) |
| ZCode | `~/.zcode/cli/config.json` → `mcp.servers` with `type: "stdio"`, `command`, `args` (global only) |

The server resolves `.megamemory/knowledge.db` from the MCP process working
directory; `--db PATH` / `--db=PATH` in server argv takes precedence over
`MEGAMEMORY_DB_PATH`. For Codex, `install` writes `config.toml` and `AGENTS.md`
to a non-empty `CODEX_HOME`, otherwise to `~/.codex`, and the freshness scan
below reads the same path (with `~/.codex/AGENTS.md` kept as a fallback
candidate); OpenCode and Claude Code
use their client-specific profile paths shown in the installer output.

**Universal MCP instructions.** At initialization, the server also sends a
versioned protocol of at most 400 characters: call `understand` (with
`include_source: true` when code is needed; on `stale_warning` re-read the
ref), record verified conclusions with `create_concept` + `evidence`, use
`link`, and follow `next.record`. Clients supporting MCP `instructions` can
use it without installer rule files; it is a short safety net, not a
replacement for the full workflow or proof that the agent received or
followed it.

**Workflow-wrapper freshness.** `install` stamps its managed blocks with
`<!-- megamemory:instructions vX.Y.Z -->` in `AGENTS.md` / `CLAUDE.md` and on
installed command markdown (not on MCP config or the OpenCode plugin); Kilo
rule files carry the snippet marker `<!-- megamemory-snippet vX.Y.Z -->`,
whose version is compared the same way (2.12.1). On every `list_roots` and
`understand`, the server scans the first managed **instruction file** with a
version in this order: project `AGENTS.md`, project `CLAUDE.md`, OpenCode
`AGENTS.md`, `~/.claude/CLAUDE.md`, the active `$CODEX_HOME/AGENTS.md` (since
2.12.2; `~/.codex/AGENTS.md` stays a fallback candidate for blocks left over
from installs made before the variable existed),
global Kilo `~/.config/kilo/AGENTS.md`, global ZCode `~/.zcode/AGENTS.md`,
`~/.agents/AGENTS.md` (deduplicated against its symlink target by real path),
then the Kilo rule files `.kilo/rules/megamemory.md` and
`~/.config/kilo/rules/megamemory.md`. The response carries
`instructions_stale`, `instructions_version` and `server_version`; no managed
instruction file means `false / null`. The flag fires only when the found
block is **older** than the running server (2.12.4): update the package,
re-run `install` for the relevant target, then restart the client — the
server in an open session keeps its build until the restart. A block
**newer** than the server (the client was updated first) is not stale:
restart the client instead of re-running `install`. A stamp version that
does not parse is conservatively reported as stale, and a managed block
without a comparable version (marker without a version, legacy
`megamemory-snippet:` form) is reported as stale with `version: null`.

### Kilo installation

`megamemory install --target kilo` edits **only the first existing MCP config**
in this strict order (the root file wins over `.kilo/kilo.jsonc`):

1. `./kilo.jsonc`, then `./.kilo/kilo.jsonc` — project, new JSONC format.
2. `~/.config/kilo/kilo.jsonc` — global, new JSONC format.
3. `./.kilocode/mcp.json` — project, legacy format.
4. `~/.kilocode/**/mcp_settings.json` — global legacy search, at most three
   directory levels deep; the first match wins.

Other discovered configs are reported as skipped and left untouched. If none is
found, install warns, prints a new-format fragment for `./kilo.jsonc`, exits 0
and creates **no files**, including rules, skills and AGENTS.md — add the
fragment manually and re-run.

The new format uses `mcp.megamemory` with `type: "local"` and a
runtime-derived `command` argv array. One `KILO_APPROVAL_KEYS` map selects
`permission` for the new format and `alwaysAllow` for legacy; `permission` sets
these eight keys to `"allow"`:

```json
{
  "megamemory_understand": "allow",
  "megamemory_list_roots": "allow",
  "megamemory_get_concept": "allow",
  "megamemory_create_concept": "allow",
  "megamemory_update_concept": "allow",
  "megamemory_link": "allow",
  "megamemory_check_freshness": "allow",
  "megamemory_provenance_trace": "allow"
}
```

Legacy configs keep `mcpServers.megamemory`, `command`/`args`, and an
`alwaysAllow` array of the same eight **unprefixed** tool names. No wildcard
permission is added; `remove_concept`, `resolve_conflict`, `merge`,
`slot_release` and `expire` are never auto-approved. Existing unrelated
servers, server options and user settings are retained. **T0 is accepted as
empirically unconfirmed**; manual acceptance in Kilo with a `create_concept`
call without an approval dialog remains mandatory.

Rule scope follows the **selected config**, independently of `--global`:

- Project new-format configs keep the relative `instructions` entry
  `.kilo/rules/megamemory.md`; the full workflow is written to that project file.
- Global new-format `~/.config/kilo/kilo.jsonc` gets an **absolute**
  `instructions` entry pointing to `~/.config/kilo/rules/megamemory.md`, and the
  full workflow is written there.
- Legacy is unchanged: the full workflow stays in project
  `.kilocode/rules/megamemory.md`; no `instructions` entry is added.

Rules and skills use managed blocks (`<!-- megamemory-snippet vX.Y.Z -->` …
`<!-- /megamemory-snippet -->`); re-running install replaces only that block,
an existing file without markers gets an appended block and a warning. JSONC
edits use `jsonc-parser`: comments, trailing commas and formatting outside
changed nodes are preserved; a syntax error reports the path and position
without changing the config. Before modifying an existing file, install saves a
byte-for-byte `<file>.bak-<timestamp>-<uuid>` backup; unchanged files are
skipped.

```bash
megamemory install --target kilo --dry-run    # print planned paths and sizes, write nothing
megamemory install --target kilo --global     # skill + pointer to the home directories
megamemory install --target kilo --link       # print the exact ln -s command
```

`--dry-run`, `--global` and `--link` are **Kilo-only**; combining them with
another target is refused before writes. By default the short skill goes to
`.agents/skills/megamemory/SKILL.md` and the root `AGENTS.md` gets a managed
three-line pointer; an existing skill without the MegaMemory-managed marker is
left untouched with a warning. With `--global` the skill goes to
`~/.agents/skills/megamemory/SKILL.md`, the pointer to native
`~/.config/kilo/AGENTS.md`, plus `~/.codex/AGENTS.md` **only if it already
exists**; the flag changes skill and pointer placement, not the config selection
order or rule scope. `.agents/AGENTS.md` is not a native instruction entry
point. `--link` runs `ln -s` only on Linux/macOS without replacing an existing
destination; on Windows (including Git Bash) and in dry-run it only prints the
command with a warning.

### ZCode installation

`megamemory install --target zcode` writes one **global** config,
`~/.zcode/cli/config.json` — ZCode has no workspace-level MCP file. The schema
was confirmed against a live working config (plan 28 T0): `mcp.servers` with
`{ "type": "stdio", "command", "args", "timeoutMs" }`. An existing
`megamemory` record belongs to the user: only missing fields are filled in,
foreign servers, comments and key order are preserved; a broken JSONC file
refuses with the path and position and stays untouched. Before the first
modification install saves a byte-for-byte `config.json.bak-<timestamp>-<uuid>`
backup.

The install also adds a `UserPromptSubmit` hook — a one-line context reminder
on every prompt (configuration-file hooks require `hooks.enabled: true`) — and
needs a **ZCode restart** afterwards. `install --target zcode --uninstall`
removes **only that hook** (foreign hooks, comments and the MCP server stay;
the config restores byte-identically when the megamemory record pre-existed;
without `--target zcode` the flag is refused). Rules go to the managed
versioned block in the project `AGENTS.md` (`--global` moves them to
`~/.zcode/AGENTS.md`; a global file without a megamemory block gets a warning,
since ZCode reads both files), the skill to
`~/.zcode/skills/megamemory/SKILL.md` (frontmatter `description` stays within
the 1024-character limit, otherwise ZCode silently hides the skill).
`--dry-run` prints the planned paths and writes nothing; no tool allowlist is
written (no confirmed permissions schema). Hook injection relies on the
documented hooks schema and still requires live acceptance on a real machine.

**Kilo freshness scope.** The short Kilo `AGENTS.md` block starts with the
`megamemory:instructions` stamp and is recognized by the scanner normally.
Since 2.12.1 the global `~/.config/kilo/AGENTS.md`, both Kilo rule files
(`.kilo/rules/megamemory.md` and `~/.config/kilo/rules/megamemory.md`) and the
canonical `~/.agents/AGENTS.md` are scan candidates too: the rule files are
recognized by their `megamemory-snippet` marker, whose version is compared
like the stamp. The legacy rule file `.kilocode/rules/megamemory.md`,
`SKILL.md` and the installed `commands/*.md` stay outside the scan — the
skill carries no version, and the stamped commands and the legacy rules path
are not scan candidates. A marker without a
version is reported as stale with `version: null`.

### Upgrading an existing upstream database

A raw upstream v1.6.2 database has `PRAGMA user_version = 0` and an existing
`nodes` table. Normal MCP, `serve`, and ordinary RW command opens reject that
shape with `UPSTREAM_SCHEMA_V0` — upgrade it explicitly:

```bash
megamemory migrate --dry-run    # migrate a temporary coherent snapshot; source is unchanged
megamemory migrate --apply      # coherent backup, then additive migration of the source
megamemory reembed              # establish/rebuild the current vector generation
megamemory doctor               # health check, exit code 1 on problems
```

- `migrate --dry-run` (the default without `--apply`) takes a coherent SQLite
  `VACUUM INTO` snapshot (including committed WAL frames), runs the real apply
  path on that disposable copy, and fingerprints the source main file plus
  `-wal` before and after; "nothing written" is reported only if the fingerprint
  stayed stable. `repair-ids` has the same snapshot semantics. A dry-run plan is
  advisory — neither command emits a token that a later invocation consumes.
- `migrate --apply` recomputes against current state; `repair-ids --apply`
  applies atomically and fails closed if a target became occupied, a rename
  became stale, or descendants still cannot be resolved. Backups are coherent
  snapshots named `knowledge.db.bak-<UTC timestamp>`; only the three newest
  valid ones are retained.
- Schema numbers have two separate meanings: **`PRAGMA user_version = 14` is the
  actual current schema and compatibility guard**, while `meta.schema_version`
  (`"1"`/`"3"`) is only the fork-conversion marker. Migration is additive (no
  upstream columns dropped or renamed), but older fork builds are not a safe
  downgrade path — restore the pre-upgrade backup instead.
- Migration and schema upgrades never run the embedding model. `reembed` starts
  (or resumes) an explicit vector generation; switching generations atomically
  invalidates node blobs and the native `nodes_vec` projection, then republishes
  every eligible node. Only rows already published in the current generation
  become vector hits; unpublished nodes are keyword-only, where the default
  `match: "all"` requires every query word. Run `reembed` after a
  model/preprocessing change and after migrating vectors of unknown origin.
- The exporter owns no directory: `export --check` only reports differing,
  missing and extra `.md` files and exits nonzero on drift; it never deletes
  them.

---

## Provenance: decisions cite their sources

A decision is only as good as its source, so the graph keeps that link explicit
and machine-checkable.

**Supports (`informed_by`)** — a decision points at the fact, test, log or
conversation it was drawn from, and every edge carries a mandatory rationale:
an `informed_by` edge with an empty description is rejected, in `link` and in
batched `create_concept` alike. The support graph stays a strict DAG — an edge
that would close a cycle is refused. Cycles imported by a merge are quarantined:
the component is closed for writes, shows up in `weak_links` with
`needs_merge: true`, and `in_paths` through it honestly reports `null` instead
of a made-up number.

**The `evidence` shortcut** — supports are declared in the same
`create_concept` call, no follow-up `link` needed:

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

**Git evidence** — "merged to main" or "shipped in 2.1.11" is checked against
git objects, not files: `git:tag:<name>`, `git:commit:<sha>` (full or 7+ chars)
and `git:branch:<name>` resolve to a commit sha via the **local** git binary —
no network calls, the GitHub API is never touched. A moved tag or an advanced
branch reports `changed` with both shas in `weak_links`; a vanished ref reports
`missing`. Use `git:branch:` only for "has moved" checks, never as proof of
"merged". The repository is `--repo PATH` at server start (default: the
database directory). Start MCP without a subcommand:
`megamemory --db PATH --repo REPO`; `--db=PATH` and `--repo=REPO` are
equivalent, missing or repeated values fail before opening the database, CLI
subcommands may follow the global flags. The startup `--repo` is passed
explicitly on every MCP `check_artifacts` call, so restarting with a different
repository repins git refs; internal checks that omit `repo` reuse the pinned
root.

**Locators** — a ref may carry a line locator: `path`, `path:12`, `path:12-30`,
`path#L12`, `path#L12-L30`. The filesystem receives only the path (Windows
drive letters `C:\`, UNC `\\server\share`, colons and `#` inside names are
preserved); the locator is kept for display and audit. **The digest is over the
whole file** — the locator limits the citation scope, not the hash scope: a
change on line 500 still flips a ref written as `path:12`. Git schemes are
recognized first and are never cut (`git:tag:2026` is a tag named "2026", not a
path with a locator). `bench` and `check_artifacts` share one parser
(`src/refs.ts`) — a ref means the same thing to both.

**Strict mode** — `provenance.require_support: true` refuses a `decision` with
zero supports: no `evidence`, no `informed_by` edge, nothing. The refusal says
to pass `evidence` in the same call — "add support later" is rejected on
purpose, because the source of the conclusion is lost by the next call. The
flag is read fresh on every call (`megamemory.config.json` next to the db; env
overrides `MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT` / `MEGAMEMORY_REQUIRE_SUPPORT`,
`1|0`). Other kinds, `link` and reads are unaffected. Auto-deriving supports
from `why` + `file_refs` exists but is **off by default**
(`provenance.auto_ground`) — server-invented supports must not masquerade as
agent-declared provenance.

**Tracing and audits** — `provenance_trace` walks `informed_by` in one
direction: `ancestry` ("what does this rest on") or `impact` ("what rests on
it"). The completeness contract is honest about what it did not show:
`total_within_depth` counts nodes within `depth`, the stop reason is
`truncated_by: depth | nodes | scan | null`, path counts are capped and flagged
(`in_paths_capped`) rather than exaggerated, and the scan budget
`max_scan_nodes` (default 5000) bounds both output and work. Weak links come
first — refuted/abandoned nodes, cycle components, edges without rationale,
decisions with `no_support` / `missing_support` / only-ungrounded supports —
and the whole `weak_links` block is capped at 8 KB with a truncation marker.
`provenance_audit` additionally marks `at_risk` nodes and records one bounded
audit-run.

**Anchors vs claims** — a support created via `evidence: [{ref}]` is an
*anchor*: a small node named after the file with a template summary
("File-fact node for … — created as a provenance support."). That template is
**by design** — the anchor exists to carry the link and its digests, not to
state a thought. Every node carries `created_via`
(`agent | file_ref | import | auto`), and only hand-written nodes (`agent`) are
ever counted as stubs: `stats` prints `Supports: N (anchors a, claims c)` and
keeps a separate `Stubs` counter, and `weak_links` raises `stub_support` only for
manual placeholder summaries. An anchor is never a stub, and a hand-written
template summary is still rejected — the difference is the origin, not the text.

**Duplicates and removal** — `create_concept` refuses near-duplicates: it
compares the normalized name (case, spaces, punctuation, ё/е) and the summary
vector (top-3, cosine threshold `dedupe.threshold` in `megamemory.config.json`,
default 0.92, env `MEGAMEMORY_DEDUPE_THRESHOLD`) and returns `duplicate_of`
instead of writing a second copy — `force: true` overrides consciously.
Digests and server-built anchors are never deduplicated. Removing a node that
other nodes rest on is refused with a hint naming the dependents; `force`
overrides it. Removals leave tombstones, and in a merge an edge tombstone wins
over a live copy — a severed link does not resurrect because the other branch
never knew.

## Facts expire

A journal entry is not knowledge: "PR #3 not opened yet" was true on the day it
was written and is a lie a day later. Every node can carry an optional
`valid_until` (ISO-8601, UTC):

- **When to set it** — any statement about the world as it was: "merged",
  "release shipped", "PR open", "migration not started". Architecture,
  conventions and behavior facts stay dateless. The server never invents an
  expiry — pass `valid_until` explicitly, or the fact is permanent.
- **What happens on expiry** — the node drops out of `understand` answers
  (`meta.stale_excluded` counts how many were hidden); `include_stale: true`
  returns them marked `expired: true`. Nothing is deleted: the node stays in
  the graph, in `get_concept`, in history — it just stops masquerading as
  current knowledge.
- **How it surfaces** — `provenance_trace` traverses past an expired
  predecessor but marks it `expired` and reports it as a weak link; `stats`
  shows an `Expired` line; `doctor` warns when more than 10% of active nodes
  are past their date. Superseded is not expired: the `valid_until` written by
  `supersedes` marks a node that already left the answers through its own
  status.
- **The server warns, never blocks** — a summary that looks like a state claim
  (merged/released/pending, a PR number, a semver, a date) without
  `valid_until` gets a `state_claim_without_expiry` warning; an expiry already
  in the past gets `expired_on_create`. The node is still written — setting
  the date is the agent's call. `kind=digest` is exempt.
- **The `journal` kind** — an explicit kind for volatile state notes
  ("PR #N open now"). Recommendation: do not use journals as decision supports
  — a workflow rule, not a technical prohibition. When `valid_until` is
  omitted on create, a default term applies: env
  `MEGAMEMORY_EXPIRY_JOURNAL_DAYS` → `expiry.journal_days` in the adjacent
  `megamemory.config.json` → **90 days**. An explicit date wins; an explicit
  `null` forbids auto-expiry, and the note still carries the warning — a
  journal without a term is never presented as safe; `journal_days: 0` turns
  auto-expiry off. Updates never refresh a term (no sliding TTL), a kind
  change to `journal` applies the default only when no term exists, and
  import/merge never recompute or rejuvenate stored terms.
- **Manual expiry** — `megamemory expire --ids a,b --until 2027-01-01 [--apply]`
  (or `--until past` = yesterday) sets `valid_until` on existing nodes;
  dry-run by default, one unknown id refuses the whole batch, every application
  writes a `timeline` entry. Cleanup candidates on a live base: run it on a
  copy, keep useful content by rewriting it instead of expiring it.
- **`expire --scan`** — a read-only candidate review; `--json` prints a
  versioned report. `--scan --apply` is refused: apply only explicitly chosen
  ids (`--ids`) or a reviewed report (`--report`), which is re-checked
  field-by-field inside one transaction — any drift or vanished member cancels
  the whole batch with `version_conflict`. A date, version or tag in a claim is
  a candidate sign only; an existing git tag never proves a specific PR was
  merged.

---

## Measuring the benefit

Is the memory actually useful? Don't argue — measure: `megamemory bench` tells
you in numbers whether **orientation via the graph is cheaper than the
alternative**, and how often it points at the right nodes. Three baselines, one
flag:

```bash
# vs reading the file_refs files of the found nodes (default)
megamemory bench --db .megamemory/knowledge.db --questions q.jsonl --baseline files

# vs token-economy-ts 1.1.0 text search: run from the analyzed project's root.
# Replace the executable/script paths with their absolute local paths.
megamemory bench --db "<owned-copy.db>" --questions q.jsonl --baseline te \
  --te-exec "C:/Program Files/nodejs/node.exe" \
  --te-arg "C:/p/agent-skills/skills/token-economy-ts/scripts/code-searcher.js" \
  --te-arg "query={query}" --te-arg "root=." --te-arg "ext=.ts,.tsx,.js,.jsx,.mjs,.cjs"

# both ratios side by side: where memory wins, where the structural tool is the right call
megamemory bench --db .megamemory/knowledge.db --questions q.jsonl --baseline both
```

- `lang` groups results; it does not dispatch a skill. `root`/`--ref-root`
  resolve file references and do not change runner cwd. Preset token counts
  bypass the runner; precedence is preset → structured runner → per-question
  shell → global shell. Shell templates are trusted advanced input, especially
  on Windows.
- The structural baseline compares **graph navigation, not natural-language
  questions** — it requires two endpoints:

```text
node "C:/p/agent-skills/skills/token-economy-ts/scripts/graph-tool.js" op=path from=src/a.ts to=src/b.ts root=.
python -I "C:/p/agent-skills/skills/token-economy-py/scripts/te.py" search "apply_catalog" --root "<project-root>"
node "C:/p/agent-skills/skills/token-economy-har/har.js" search "AbsentNeedle" --file "<own-artificial.har>" --json
```

PY search returns UTF-8 text, not JSON. A complete HAR no-match returns its
JSON payload with exit 1 and empty stderr; parse/regex/read errors exit 2.
TS 1.1.0 / PY 1.2.1 / HAR 1.0.1 use separate CLI/output contracts — point
bench at the verified source package or an explicitly updated installation.
- `graph_metric=retrieval_wire_without_instructions` estimates the actual
  retrieval MCP content envelope. The bench path calls `understand` directly,
  so it **excludes** the runtime wrapper staleness fields
  (`instructions_stale`, `instructions_version`, `server_version`); it is
  therefore not exactly the default MCP response and not whole-task telemetry
  (`economy_status=not_measured`). `ratio > 1` means the graph is cheaper;
  `ratio < 1` means the baseline is cheaper.
- Quality gates for TE comparisons: add `expected_outcome`, `expect_nodes`,
  `quality_contract` and `expected_te_refs`/`expected_te_symbols`/
  `expected_te_edges` to the dataset — see
  [docs/bench-protocol.md](docs/bench-protocol.md#quality-and-completeness).
  `quality_ratio_te` counts only correct complete live pairs; legacy
  `ratio_te` and token totals are **raw retrieval costs**, not evidence of
  benefit. Preset counts are not live; malformed/erroring/absent payloads (even
  exit 0) are never eligible — a complete valid expected no-match is. The
  runner captures at most 16 MiB of stdout/stderr each and marks truncation; a
  partial prefix has no exact token cost or ratio.

`ratio = baseline_tokens / graph_tokens` — but never read it without
`hit_rate` (did the expected nodes surface in the top-10): a cheap but wrong
answer is not savings. Questions where the graph lost (`ratio < 1`) are
printed, not hidden. And the honest caveat the command itself prints: **bench
measures the cost of orientation, not the quality of the answer — fewer tokens
with worse quality is not a saving.** For a live agent A/B comparison, see
[docs/bench-protocol.md](docs/bench-protocol.md).

### How to read the numbers

- **`hit_rate` vs `hit_rate@1`.** `hit_rate` counts a question as a hit when
  any expected node surfaced anywhere in the top-10; `hit_rate@1` counts only
  when the best expected node ranked **first** (the `rank` column shows that
  position). `hit_rate@1 ≤ hit_rate` always — a rank-6 "hit" is a much weaker
  answer than a rank-1 one, and reading only the top-10 number overstates the
  graph.
- **Why `hit_rate@1` can dip after you add knowledge.** Supports contain the
  query terms verbatim ("EBUSY", "two-batch race") and compete with their
  decision in search. Since 2.1.7 such **nested supports** leave the top level
  and fold under their decision (depth 1), so adding knowledge no longer sinks
  `hit_rate@1`; in bench a nested support counts as found at its decision's
  rank, and `meta.supports_inlined` reports how many folded. When the decision
  did not make the output, its support stays a standalone fact — knowledge is
  regrouped, never hidden.
- **`r(files)` vs `r(files-top)`.** `r(files)` compares the graph answer
  against **all** `file_refs` of every found node — tens of thousands of
  tokens and ×50 ratios no live agent would ever pay. Run with `--files-top 3`
  and read `r(files-top)`: the baseline over the first three unique files in
  the output order. `r(files-top) ≤ r(files)` always.
- **`answer` / `answer/resident` — a proxy, not the model window.** The
  `answer` column (next to `files(top)`) is the cost of the graph's own
  serialized reply — the same number `graph` shows. With `--files-top N` the
  header is marked `resident: proxy` and the summary prints
  `answer/resident` and `resident_ratio` =
  sum(answers) / sum(files-top baselines): how much of the honest baseline the
  answer itself occupies in the session. It is computed over serialized
  answers and never claims to measure the model's live context window; `null`
  when the denominator is zero (`--baseline te`, no `--files-top`, or no
  resolvable files) — never `Infinity`. A small resident_ratio with a poor
  `hit_rate` is still not a saving.
- **`refs: resolved N/M (roots: …)`** — how many of the `M` unique `file_refs`
  pointed at files that actually exist. Refs with line suffixes resolve to the
  same file; a ref is tried against the question's `ref_roots`, then
  `--ref-root PATH` (repeatable), then the git root, then the cwd. A high
  `missing:N` means the roots don't match how the refs were written — add a
  `--ref-root` instead of ignoring the misses.
- **`unknown_supports`** — found **decisions** with no confirmed support
  snapshot: a to-confirm queue, not an error (per-question `unk:N` note, ids in
  the summary). `stale_hits` (`st:N`) is the same for decisions whose confirmed
  support has since drifted.
- **`cold-start`** — the first question paid the embedding model load. The
  summary prints `warmup: …s (model load, excluded from median time)` next to
  the median without it; neither number is hidden.

---

## MCP tools

| Tool | Description |
|---|---|
| `understand` | Budgeted hybrid retrieval in `compact` (default, `max_tokens: 4000`), `full`, or `brief`. Always returns the `next` action contract (`must_read` / `skip` / `followups` / `record`; `record` carries the evidence form `[{ref\|node, why}]` → `informed_by`). Filters superseded/expired facts, counts reads since the last write (`next.unrecorded`, `next.previous_session`), distinguishes empty reasons `empty_base` / `no_match` / `budget`, collapses template ref-anchors in compact, and supports opt-in `include_evidence`, `reuse` (analysis passports) and `task` (task context) profiles. Details below; per-operation registry in [docs/capabilities.md](docs/capabilities.md). |
| `check_freshness` | Targeted freshness verification (explicit opt-in, read-only): hashes suspect sources by sha256 — files, `HEAD:sha:path` blobs, `git:tag/commit/branch` refs — and reports which related records are `fresh` / `stale_input` / `partial` / `unknown`. Never trusts mtime/size; sources changed mid-check report `unstable`; the report carries `sources`, `records`, `summary.limitations` and `expected_versions` to re-verify before applying an edit. Never writes to the database and never confirms supports. Optional pilot: symbol resolution and an import-graph walk through the token-economy-ts adapter (`adapter.graph_tool` / `MEGAMEMORY_CODE_ADAPTER`). |
| `get_concept` | Exact-ID full context: parent, children, edges, trails/slots, support check, and current digests for confirmation. Budgeted profiles (`orientation`/`evidence`/`full`), batch `ids` (up to 25, one shared budget), capped neighbor disclosure with `continuation`. Opt-in E4 delta: `context_epoch` + `known_versions` — a version match returns a compact `unchanged` answer, a mismatch returns the full card. Successful nonempty reads may add the optional `hint.record`. |
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
| `trail_save` | Save an ordered reasoning chain with a mandatory rationale summary and fingerprints of member meaning. Optional `passport` records a versioned analysis passport: explicit `task_type`, goal, whole-file scope hashes, performed/omitted checks, completeness, optional `valid_until`. A passport may carry a repeat-task `route` (entry point → invariants → locators → verification steps; commands are data to verify, not executables) or a bounded negative result (`task_type='negative_search'`: "not found in the examined area", exact query/tool/scope; truncated or errored searches are refused). |
| `trail_get` | Read a trail and its per-member and aggregate `fresh` / `stale` / `broken` verdict; `include_passport: true` also returns the versioned passport body (or an explicit `null` when pruned by retention). |
| `trail_refresh` | Re-snapshot eligible members after verification; broken or epistemically/temporally invalid members are not rehabilitated. |
| `trail_extend` | Append members to an existing trail and fingerprint their current meaning. |
| `slot_set` | Point one project role at a live node; reassignment adds a `supersedes` handoff edge, same-node retry is a no-op. |
| `slot_get` | Read the current live holder of one named role. |
| `slot_release` | Remove a role pointer without changing or deleting the former holder. |
| `slot_list` | List all project roles and their current live holders. |
| `task_add` | Create an open task concept with an optional parseable due date. |
| `task_done` | Move a task to terminal `done` and clear its due date. |
| `board` | Return open tasks sorted by rot and the done column with `count`, `returned`, `has_more`, and keyset `next_cursor` pagination. |

All 26 tools register by default. The `MEGAMEMORY_TOOLS` environment variable
narrows the surface at registration time — the `tools/list` result reflects the
filter honestly, there is no dynamic registration: unset or `all` keeps all 26
(the default does not change); `core` keeps the eight tools of the
read → write → link → confirm → verify loop (`understand`, `get_concept`,
`create_concept`, `update_concept`, `link`, `confirm_supports`,
`check_freshness`, `provenance_trace`); a comma-separated list keeps exactly
the named tools (`understand,link`). Unknown names warn on stderr and are
skipped, never fatal. The rest (`trail_*`, `slot_*`, `task_*`, `board`,
`list_*`, `resolve_conflict`, `remove_concept`, `provenance_audit`/
`provenance_history`, `check_artifacts`) are available in `all` or an explicit
list. `megamemory install` does not write this variable into MCP entries — new
installs keep every tool.

### `understand`: compact recall and budget

`max_tokens` defaults to **4000**; an explicit budget is respected. Compact
`candidates` represent all search/filter survivors from the bounded retrieval
pool (20 by default), subject to the list budget — not every node in the graph.
Each entry carries an exact, untrimmed `id` for `get_concept`, plus `name`
(≤ 60 characters, shortened from the left to retain the identifying tail),
`kind`, `via`, `score`, and optional `summary_short` (≤ 80 characters). The
soft target is 40 estimated tokens per candidate, with a hard cap of 90;
`summary_short` is dropped before further shortening the name. IDs are never
shortened. The entire candidate list uses at most 25% of `max_tokens`.

After the mandatory envelope, budget priority is: the first fully qualified
compact card → the candidate list → the second and third cards. At most 3
complete compact cards are placed, and only when they fit; `include_evidence`
keeps ALL support wording and rationales untrimmed and places each card with
its evidence atomically. `meta.returned` counts visible candidate entries,
`meta.cards` counts compact cards, and `meta.dropped` counts wholly hidden
matches. When `dropped > 0`, the budgeted text says exactly:
«Показано N совпадений из M (K скрыто бюджетом) — уточни запрос или подними
max_tokens.» (N = `returned`, K = `dropped`, M = N + K); candidate-only entries
do not trigger it.

In compact, `collapse_ref_anchors` defaults to `true` (explicit `false` is
supported): template ref-anchors fold with rationale or show as collapsed
locators with dependents (`meta.anchor_collapsed`). Path-like names are
demoted for ordinary queries, not removed; an exact full-path query bypasses
the demotion. The UI displays only the cards (up to 3), not `candidates`;
`mode: "full"` keeps its previous response form.

**Write nudges.** `understand` counts completed read calls since the last
logged write. At ≥ 2 reads, `next.unrecorded` appears and `next.record` gains,
once, the exact sentence: «С последней записи N чтений — если это законченный
вывод, запиши его.» (absent below 2, after any logged write including
deletion, and for `empty_base`). A separate cross-session signal examines at
most the last 200 `timeline` rows: a gap **greater than 30 minutes** separates
sessions. When the previous session had a successful `understand` and no
successful write, `next.record` also adds once: «В прошлой сессии после
understand не было ни одной записи — если сейчас есть вывод, запиши его.» An
incomplete sample cannot establish the previous session. Emitting the text
proves neither that the agent saw it nor that it wrote knowledge.

**Empty results** carry `meta.reason`: `empty_base` means no live nodes;
`no_match` means live nodes exist but none pass the search/filters; `budget`
means matches exist but no minimal qualified card fits — never interpret it as
`no_match`. When `meta.reason` is `no_match` or `budget` and the vector channel is
`off` or `partial`, the answer carries `next.search_warning`. With `off` (no vector
generation or usable vectors, another model, or `MEGAMEMORY_SEARCH=fts`), search is
keyword-only: `match: "all"` requires every query word by default. With `partial`,
vectors cover only some eligible nodes (`missing`/`total`); the rest are keyword-only.
For `no_match`, retry with 2–3 exact terms or an id; keyword-only warnings also
suggest explicit `match: "any"` when intentional OR expansion is appropriate. This changes
only keyword matching, not vector matching. `meta.match` is present only when
`match` was explicitly supplied (including `"all"`); omission keeps the all-word
default without a tag. Follow the channel's next step; for `budget`, first raise
`max_tokens` — this is a budget limit, not evidence
of missing knowledge. Successful results, `empty_base`, and a fully working `on`
channel carry no such field; in `brief` the warning is a separate line below the
empty-result message. In `compact`, `full`, and `brief`, the first explanatory sentence
and the full `next.record` contract are mandatory and never trimmed; if the
required envelope cannot fit, the request is refused with an explicit error
asking for a larger budget. The record line rendered in `brief` has its own
`RECORD_MAX = 400`; other lines keep `LINE_MAX = 240`. The full `next.record`
is not clipped.

**Source in the card (opt-in).** With `include_source: true` (compact only)
each placed card can carry a verbatim `source` taken from its first readable
`file_ref` with a line range — one call instead of a separate Read. The range
is cut tail-only (`truncated: true`), never mid-file; a ref without a range, a
path outside the server root, a missing file, a file over 1 MiB and non-UTF-8
content yield no source — `meta.source_skipped` names the reason. The source
budget is subtracted from `max_tokens` before card placement: what does not
fit leaves the card without `source`, and `meta.source_cards` counts the
placed ones. Default is off — verbatim sources enlarge the resident context;
ask for it when you would read that exact range anyway.

**`stale_refs`: divergence between the record and the file.** Always-on in
compact: every returned card's `file_refs` get a lazy `stat`, and a ref whose
file mtime is **newer than the node's own `updated_at`** lands in
`stale_refs` (`ref`, `node_id`, `recorded_at`, `file_mtime`; at most 3 entries,
the full count in `meta.stale_refs_total`), the card carries its `updated_at`,
and `next.stale_warning` says: «файл менялся после записи: перечитай ref,
прежде чем опираться». This is a signal, not a verdict — mtime lies after
`git checkout` and archive unpacking, and a missing file counts separately in
`meta.stale_refs_missing` instead of pretending the file changed. The content
axis stays `check_freshness` with digests. An answer without divergences has
no section at all.

### MCP record hints

Successful nonempty `get_concept` and `list_roots` responses may carry an
additive `hint.record` with fixed text; empty results, `unchanged` and budget
refusals carry no record hint (an empty `list_roots` preserves its legacy
string hint). The hint counts toward the final `max_tokens` cap; a too-tight
budget can be refused. `get_concept.hint.record` reads: «Узел уже есть —
уточняй его через update_concept, а не создавай второй; опоры к решению —
evidence в том же вызове.» The `list_roots` hint instead reminds the agent
that this is an overview: record the result for a specific branch as a
separate node, not by editing the root. A hint is not an automatic write or a
requirement to invent new knowledge. `list_roots` also has an independent,
optional top-level `hint_search` about vector-channel readiness and the next
step. It does not change `hint` into another shape or add `hint.search`, and is
included in the same final `max_tokens` budget.

**Stored kinds:** `feature` · `module` · `pattern` · `config` · `decision` · `component` · `digest` · `task` · `journal`

`create_concept` accepts the agent-authored values (`digest` remains for
compatibility but is normally generated; `journal` is the explicit
volatile-state kind with the default-term policy above); `task` is created
only by `task_add`.

**Relations:** `connects_to` · `depends_on` · `implements` · `calls` · `configured_by` · `supersedes` · `contradicts` · `informed_by`

---

## CLI

| Command | What it does |
|---|---|
| `megamemory install [--target kilo\|zcode]` | Configure an MCP client; Kilo: new JSONC/legacy configs with `--dry-run`/`--global`/`--link`; ZCode: global `config.json` + prompt hook with `--dry-run`/`--global`, `--uninstall` removes the hook only |
| `megamemory hooks install\|uninstall\|status [--repo PATH]` | Manage an optional local `commit-msg` gate for the `memory:` line; current directory by default, no database or network |
| `megamemory serve [--port N]` | Web explorer (graph, search, node cards, Tokens panel, consolidate tab). **Loopback only** (`127.0.0.1`, IPv6: `--host ::1`) — a local tool for a human, not a network service |
| `megamemory migrate [--dry-run\|--apply]` | Upgrade raw upstream v1.6.2 or repair fork migration objects; dry-run uses a disposable coherent snapshot, apply backs up and writes |
| `megamemory repair-ids [--dry-run\|--apply]` | Rebuild empty/trailing-slash and affected descendant IDs; dry-run uses a disposable snapshot, apply is atomic |
| `megamemory reembed [--batch N]` | Start/resume a model+preprocessing vector generation and republish eligible nodes into canonical/native projections |
| `megamemory doctor` | Health check: schema, model, FTS, IDs, vectors, orphans, digests; non-failing warning after ≥3 understand sessions and 0 writes in 14 days (silent on an empty base) |
| `megamemory stats` | Graph and token statistics |
| `megamemory eval` | recall@10 over `fixtures/eval.jsonl` |
| `megamemory guide` | Print the agent onboarding text (what install writes to AGENTS.md, plus a session example); `guide --workflow` prints the full workflow contract (`docs/agent-workflow.md`) verbatim — UTF-8, no database, no network |
| `megamemory bench --questions q.jsonl` | Orientation savings in tokens: graph vs `--baseline files\|te\|both` |
| `megamemory consolidate [--dry-run\|--apply]` | Find and merge near-duplicate nodes |
| `megamemory digest [--apply]` | Build or rebuild digest nodes; `--by-use` orders the queue by explicit usefulness (stale first, then used/opened from journal events), `--limit N` bounds the queue and lists the remainder as queued — never silently dropped |
| `megamemory export --md <dir> [--check]` | Markdown export; `--check` reports drift for CI and never deletes files |
| `megamemory expire --ids a,b --until <DATE\|past> [--apply]` | Set/replace `valid_until` atomically (dry-run by default; `past` means yesterday); `--report <json>` is the alternate ID source |
| `megamemory expire --scan [--json] [--repo PATH]` | Read-only review of expiry candidates; `--json` prints the versioned report for the `--report` apply path; `--scan --apply` is refused |
| `megamemory telemetry-report [--file PATH] [--tariff-version VER] [--json]` | Offline aggregate of the local J0 telemetry JSONL (no database, no network): calls/outcomes, latency p50/p95, memory-write categories. Provider tokens and money appear only from actually supplied client usage — otherwise explicit `unavailable` (never zeros); see [docs/telemetry.md](docs/telemetry.md) |
| `megamemory merge`, `conflicts`, `resolve` | Two-way merge of graphs across branches |

### Memory recording warning

On a nonempty base, `megamemory doctor` warns when the last **14 days** contain
**at least 3 sessions with a successful `understand` and zero successful
writes**. It points to `megamemory install --target kilo` and `next.record`.
The warning does not add a problem or change the exit code; an empty base,
fewer sessions or any successful write in the window suppress it. This is an
activity signal, not proof of an installation failure or a guarantee that the
agent saw a reminder.

### Git hooks

Optional, explicit owner installation — separate from MCP-client
`megamemory install`:

```bash
megamemory hooks install [--repo PATH]     # default: current directory
megamemory hooks status [--repo PATH]
megamemory hooks uninstall [--repo PATH]
```

- `install` adds one managed block (`# >>> megamemory:commit-msg` …
  `# <<< megamemory:commit-msg`) to the repository's `commit-msg` hook; repeated
  installation does not duplicate it. Existing foreign hook code is preserved
  (the block is appended with a warning), and `uninstall` removes only the
  managed block. `core.hooksPath` is honored, including creating the target
  directory when needed; `status` reports the path, override and installation
  state.
- The managed script uses LF line endings and POSIX sh, including Git for
  Windows. Appending to a foreign hook is accepted only with a recognized POSIX
  sh shebang and LF; a BOM, CRLF shebang, different interpreter, symlink or
  altered managed block causes an explicit refusal rather than an unsafe
  rewrite.
- For staged code files, the hook rejects a commit without a `memory:` line.
  Use `memory: <id>` for real nodes created or updated by the work, or
  `memory: нечего — <причина>` when there is legitimately no new verified
  knowledge. Pure reading and successful reuse need no invented record.
  Documentation-only commits do not require the line. Copy the same line into
  the PR description using the
  [commit and PR templates](./docs/commits.md); templates are installed
  manually, not written into other repositories automatically.
- This is a local message check: no database, model calls, network or automatic
  memory writes, and no proof that an ID is real or its evidence valid. It does
  not validate PRs. `git commit --no-verify` bypasses it, and an early exit in
  a foreign hook before the appended block can bypass it too. This is a
  reminder, not a guarantee of recorded work.

### Which commands never write to the database

`export`, `eval` and `conflicts` are the three direct protected read-only
commands; additional non-writing paths and snapshot dry-runs are listed below.
The full access matrix lives in [docs/readonly.md](docs/readonly.md).

| Command/path | Source-database mode | Notes |
|---|---|---|
| `export` (including `--check`) | read-only | No WAL or migration; `--check` also never deletes export files. |
| `eval` | read-only | Parses/validates JSONL before opening the database. |
| `conflicts` | read-only | Inspection only; `merge` and `resolve` are separate writing commands. |
| `telemetry-report` | no database at all | Reads the local telemetry JSONL file only (no DB open, no network). |
| `stats --funnel --json` / `stats --health --json` without `--prune` | read-only | The exact scripted snapshots only (combined `--funnel --health --json` too); plain `stats`, non-JSON funnel/health, and any `--prune` path are RW. |
| `expire` without `--apply` | read-only | Dry-run validates IDs and reports the replacement expiry; `--apply` is atomic RW. |
| `migrate --dry-run` / `repair-ids --dry-run` | unchanged source | Run the real operation on a disposable coherent snapshot and fingerprint source main+WAL. |
| test access under `MEGAMEMORY_FIXTURES_DIR` | read-only only | A test guard rejects RW opens of pinned fixtures. |

`MEGAMEMORY_ALLOW_AUTO_MIGRATE=1` has a deliberately narrow scope: it changes
only the protected readonly opens used by **`export`, `eval`, and `conflicts`**
into an ordinary RW open for that process. On a read-only schema mismatch, an
older database reports `SCHEMA_TOO_OLD_READONLY` with
`megamemory migrate --apply --db "<path>"`; a newer one reports
`SCHEMA_TOO_NEW_READONLY` with its `PRAGMA user_version` and an upgrade-package
hint. Missing and corrupt files have distinct errors; corruption is not given a
migration hint.

Every other database command is RW even when its high-level operation sounds
like a plan: `stats`, `bench` and `doctor` open the database for writing (plain
`stats` and `bench` write usage telemetry, `doctor` may migrate an old fork
schema); `consolidate` and `digest` dry-runs construct an RW `KnowledgeDB`;
`serve` and MCP write usage/timeline and may perform startup hygiene; `merge`,
`resolve`, all apply modes, and write tools mutate their documented targets.
Therefore copy `fixtures/demo.db` before using it outside the guarded
read-only paths.

---

## Environment

Runtime controls read by MegaMemory itself:

| Variable | Default | Meaning |
|---|---|---|
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | Database fallback after `--db`; resolved from the process cwd. |
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Transformers.js ONNX model identity; changing it requires `reembed`. |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid`, `fts`, or `vector`; vector mode falls back to FTS when no valid current generation exists. |
| `MEGAMEMORY_AUTO_REEMBED` | enabled | Exact value `0` disables automatic first-generation setup on node writes/MCP startup; manual `reembed` and an existing generation are unchanged. A partial index is caught up automatically; model mismatches are never repaired automatically, and after three failed attempts the automation pauses for the process. |
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
| `MEGAMEMORY_EXPIRY_JOURNAL_DAYS` | config / `90` | Default term in days for a `journal` node created without `valid_until`; decimal digits only, `0` disables auto-expiry (the `state_claim_without_expiry` warning stays). Overrides `expiry.journal_days` in the config next to the database. |
| `MEGAMEMORY_TELEMETRY_PATH` | unset | Opt-in local JSONL telemetry of MCP tool calls (outcome/latency/response size, no payloads, secrets redacted, never sent anywhere). Unset = off; file grows, owner cleans it — see [docs/telemetry.md](docs/telemetry.md). |
| `MEGAMEMORY_D3_URL` | `/vendor/d3.min.js` | Explorer D3 source override. Without it, the vendored file is used; if missing, serve warns and falls back to jsDelivr. |
| `MEGAMEMORY_AUTO_MIGRATE` | on | MCP-startup hygiene only: exact `0` skips the full upstream conversion/ID-repair path and runs additive schema setup instead. It is not the read-only-command escape hatch and `serve` does not consult it. |
| `MEGAMEMORY_ALLOW_AUTO_MIGRATE` | off | Only `export`, `eval`, and `conflicts`: exact `1` replaces their protected readonly open with ordinary RW opening for that process. |
| `MEGAMEMORY_FIXTURES_DIR` | unset | Test/fixture safety boundary: RW opens below this directory are rejected. Not normally set in production. |

Installer/profile location controls are `OPENCODE_CONFIG_DIR` (otherwise
`XDG_CONFIG_HOME/opencode`, with `~/.config` as the XDG fallback), `CODEX_HOME`
(otherwise `~/.codex`), and `HOME`. These choose the files written by `install`
and read by the instructions-staleness scan; they do not change the graph
runtime. The adjacent `megamemory.config.json`
additionally supports `provenance.require_support`, `provenance.auto_ground`,
and `dedupe.threshold`.

---

## Web explorer

```bash
megamemory serve --port 8080
```

- **local by construction**: listens on `127.0.0.1` only (`--host ::1` for
  IPv6, wildcard refused); foreign `Host` (DNS rebinding guard) and foreign
  `Origin`/`Referer` requests are refused with 403; the mutating
  `POST /api/consolidate` requires same-origin, `Content-Type: application/json`
  and a body under 64 KB. It is a tool for a human at the machine — do not
  expose it as a network service
- nodes colored by kind, sized by edge count; `digest` nodes and outdated
  (`superseded`) nodes are visually distinct
- `supersedes` edges drawn dashed, status badges in the node card, "show
  outdated" toggle
- search hits carry a `via` badge (vector / fts / both) and a budget line:
  `N nodes, ~X tokens, dropped M · saved ~Z vs full`
- **Tokens** panel: average answer size and saved tokens over 7 days
- **Consolidate** tab: duplicate candidates with apply
- per-kind filter checkboxes (persisted), visible/total counter, **export
  bundle** button and per-node `download .md`
- **Health** chip: vectors, FTS sync, digests, empty ids, orphans, memory —
  with remedy hints
- digest cards list the digest's eligible source **siblings** in the parent
  module, with a content-derived `stale` badge and a **focus** toggle
- timeline **status changes** mode; node cards show recent status transitions
  with reasons
- d3 ships with the package (`web/vendor/d3.min.js`) — the explorer renders
  offline; a missing file falls back to the jsDelivr CDN with a printed note,
  `MEGAMEMORY_D3_URL` overrides both, `/api/health` reports `d3_source`

---

## Tests

```bash
npm run build
npx vitest run src/__tests__/id-generation.test.ts --reporter=dot     # targeted
npx vitest run                                                       # full suite (slow: model download)
```

`fixtures/demo.db` is a ready-made graph. Copy it before opening in the
explorer: `serve` records the call journal into the database it serves, and the
repository guard (`fixtures/sha256sums.txt`) requires fixtures to stay
byte-identical.

---

## Documentation map

| Document | What's inside |
|---|---|
| [docs/agent-workflow.md](docs/agent-workflow.md) | The full agent workflow contract (`megamemory guide --workflow` prints it verbatim) |
| [docs/capabilities.md](docs/capabilities.md) | Per-operation registry: what each memory/navigation operation costs, where a model or network may run, budgets and fallbacks |
| [docs/bench-protocol.md](docs/bench-protocol.md) | Bench datasets and quality gates; the manual A/B protocol for live agents |
| [docs/readonly.md](docs/readonly.md) | Which commands protect the source database; snapshot dry-runs vs read-only opens; schema-mismatch errors |
| [docs/telemetry.md](docs/telemetry.md) | Opt-in local telemetry: what is recorded, retention, offline reports |
| [docs/commits.md](docs/commits.md) | Commit and PR templates with the `memory:` line |
| [docs/FORK.md](docs/FORK.md) (рус.: [FORK.ru.md](docs/FORK.ru.md)) | Fork features by task label; upstream sync instructions |

---

## Compatibility and limits

- Upstream v1.6.2 keeps working against a migrated database: new columns have
  defaults, FTS triggers maintain the index for upstream inserts. Backups
  `knowledge.db.bak-<ts>`, last 3 kept.
- FTS5 requires libsql's local file mode — MegaMemory is local-only; remote
  Turso forbids virtual tables.
- After any `VACUUM`, run `megamemory migrate --apply` to rebuild the FTS index
  (rowids are not stable).
- Russian text is not stemmed by FTS5's `unicode61`; the vector channel
  compensates, prefix queries help.

---

## Credits and license

Based on [MegaMemory](https://github.com/0xK3vin/MegaMemory) by 0xK3vin (MIT).
Fork maintained by [BloodyEagle](https://github.com/BloodyEagle). MIT, see
[LICENSE](./LICENSE).
Differences and sync instructions: [docs/FORK.md](./docs/FORK.md)
(русская версия: [docs/FORK.ru.md](./docs/FORK.ru.md)).
