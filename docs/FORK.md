# MegaMemory Fork — what differs from upstream

Base: upstream [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory)
v1.6.2 (MIT). This repository publishes `@bloodyeagle/megamemory` 2.5.1.
Russian version: [docs/FORK.ru.md](./FORK.ru.md).

## Fork features

The original task labels are retained for historical traceability.

| Task | Current contract | Where it is visible |
|---|---|---|
| T0 | Unicode `makeId`: Cyrillic/CJK/Arabic/Hebrew/emoji produce usable IDs; marks are stripped only after Latin/Cyrillic/Greek/Hebrew bases, `/` becomes `-`, output is NFC, emoji-only names get a hash fallback, and collisions get `-<hash8>`. Nested legacy repair plans in the final parent namespace and preserves old IDs as aliases. | node IDs; `repair-ids` |
| T0.5 | Additive conversion from raw upstream v1.6.2: fork columns/meta, aliases, FTS/triggers, usage and ID repair, with coherent SQLite backups. A raw upstream DB has an existing `nodes` table and `PRAGMA user_version=0`; normal RW opens reject it, so it requires explicit `migrate --apply`. | `migrate`, startup diagnostics |
| T1 | `Xenova/multilingual-e5-small` by default (`MEGAMEMORY_EMBED_MODEL`), e5 `passage:`/`query:` prefixes, q8 mean pooling, normalized vectors, dimension learned from the first published row. `reembed` starts/resumes a model+preprocessing generation; only valid rows from the active generation are searchable. | `reembed`, `doctor`, `/api/stats` |
| T2 | Hybrid FTS5 + vector search fused with RRF; `via: vector/fts/both`, sanitized prefix queries, optional CJK trigram FTS, short-CJK/name-normalized LIKE fallback. Missing, stale, malformed, wrong-generation, or unavailable vector paths degrade to FTS in hybrid mode rather than mixing spaces; explicit `MEGAMEMORY_SEARCH=vector` remains strict and surfaces inference errors. | explorer badges; `MEGAMEMORY_SEARCH` |
| T2.5 | Fail-closed JSONL eval harness: recall@k by language; every nonblank/noncomment line must have valid `query`, `expected_id`, and optional string `lang`, otherwise parsing stops with a line number before DB/search work. | `megamemory eval`, CI |
| T3 | Actual MCP-wire budgeting: `understand` defaults to compact/1500 tokens, supports full and ≤8-line brief modes, and always carries `next`; `list_roots` is budgeted independently. Impossible required envelopes are refused rather than exceeded. | MCP responses; explorer budget line |
| T4 | Lifecycle (`active/superseded/deprecated`), epistemic state, `supersedes`/`contradicts`, tombstones, and optional `valid_until`. Expired active facts leave default search but remain retrievable with `include_stale`. | cards, graph, trace, stats |
| T5 | Near-duplicate candidates from embeddings (default apply threshold 0.95), grouped/ranked with bounded candidate generation; apply transfers identity, edges, and workflow state under version guards. | `consolidate`, explorer preview/apply |
| T6 | One derived digest sibling per parent after 5 eligible non-digest children; summary ≤800 chars, refs ≤10, search weight 0.8. Exact source membership and meaning versions are recorded; source siblings stay independent/searchable and a content mismatch marks the digest stale. | `digest`, digest card |
| T7 | Deterministic, contained Markdown export with frontmatter, wiki-links, informed-by rationales, and collision/path checks. `export --check` reports missing/differing/extra `.md` files and exits nonzero on drift; it **never deletes files** or owns the directory. | `export --md … [--check]` |
| T8 | Usage/token accounting for `understand`, `list_roots`, and `get_concept`; seven-day aggregates plus the ordered understand → follow-up → record funnel. | `stats`, `stats --funnel`, Tokens panel |
| T9 | Health checks for schema, FTS, vectors, IDs, orphans, digests, expiry, D3, and memory; nonzero status on problems. | `doctor`, `/api/health` |
| W | Offline agent workflow contract: the single editable full version lives in `docs/agent-workflow.md`, printed verbatim by `megamemory guide --workflow` (UTF-8, one trailing LF, no database, no network); the per-operation cost/limits registry is `docs/capabilities.md`. | `guide --workflow`, `docs/` |

Native vector search mirrors current-generation embeddings into `nodes_vec`
(`F32_BLOB`) and uses `vector_distance_cos`. If native capability or projection
parity is unavailable, the JS cosine fallback sees the same eligible current rows.
Generation switches atomically invalidate canonical blobs and the native projection;
per-node publication verifies generation plus captured name/kind/summary, so a model
switch or edit during inference cannot publish a stale vector. Interrupted `reembed`
runs resume only missing eligible rows.

## Later contracts and historical schema introductions

These version-introduced notes are historical and intentionally retained. The actual
current compatibility number is `PRAGMA user_version=14`.

| Introduced | Contract retained in 2.5.1 |
|---|---|
| schema v3 | `timeline` call journal; U5 `status_history`/timeline work was introduced in the early fork schema series. |
| schema v5 | Edge tombstones, lifecycle/epistemic axes, validation scope, and the existing `valid_until` column. |
| schema v6 | Reasoning trails, role slots, and task-board state/due dates. |
| schema v7 | `informed_by` provenance slice with rationale and cycle-safe DAG writes. |
| schema v8 | Confirmed support baselines and explicit edge origin/acceptance. |
| schema v9–v10 | Superseded-baseline history and bounded live-support traversal indexes. |
| schema v11 | Support revision journal and explicit file/git artifact observations. |
| schema v12 | `created_via` distinguishes agent claims, file anchors, imports, and server-generated nodes. |
| schema v13 | Artifact `repo_path` pinning and active fact-expiry semantics. |
| schema v14 | Validation claim/scope digests, complete carried history fields, and vector-generation identity on canonical/native rows. |

`PRAGMA user_version` and `meta.schema_version` are not interchangeable:

- **`PRAGMA user_version=14`** is the real schema compatibility guard.
- **`meta.schema_version`** is only the upstream-conversion marker used by the
  fork hygiene path (`"1"` pending, `"3"` completed). Marker `"3"` does not mean
  database schema 3.

## Explorer UI (U1–U7)

| Task | Current contract | Where |
|---|---|---|
| U1 | Per-kind filter checkboxes persisted in `localStorage`, with visible/total counts. | footer legend |
| U2 | In-memory Markdown download: `/api/export.json` bundle and `/api/node/:id.md` with safe RFC 5987 names; no server disk writes. | export button; node card |
| U3 | `healthReport(db)` and `GET /api/health`, with a status chip and remedy hints. | footer; `doctor` |
| U4 | Digest cards list eligible **siblings** in their parent module, not children of the digest. Staleness compares exact recorded source membership/meaning; focus is a view toggle. Source concepts are not hidden from the graph or permanently removed from search. | digest card |
| U5 | Status history and Timeline status-change mode. Historical graph/card routes accept full date-time snapshots, share lifetime predicates, expose tombstones as read-only saved current content (not invented text revisions), and disable consolidation while scrubbing. | Timeline; node card |
| U6 | Search budget line shows returned/dropped tokens and `saved ~Z vs full` from `estimated_full_tokens`. | search results |
| U7 | D3 is vendored at `web/vendor/d3.min.js` and served from `/vendor/*`; `MEGAMEMORY_D3_URL` overrides it. If the vendored file is missing, serve warns and falls back to jsDelivr; `/api/health` reports the source. | explorer head; health/env |

The 2.5.1 web paths also bind consolidation plan and both displayed cards to one DB
snapshot, detect same-second significant node changes by fingerprint rather than only
`updated_at`, distinguish HTTP/not-found from network failures, and recover Timeline
state after failed scrubs/SSE initialization.

## MCP surface

The server registers 25 tools: `understand`, `get_concept`, `create_concept`,
`update_concept`, `link`, `remove_concept`, `list_roots`, `list_conflicts`,
`resolve_conflict`, `provenance_trace`, `provenance_audit`, `confirm_supports`,
`provenance_history`, `check_artifacts`, `trail_save`, `trail_get`,
`trail_refresh`, `trail_extend`, `slot_set`, `slot_get`, `slot_release`,
`slot_list`, `task_add`, `task_done`, and `board`. The complete short reference is in
the repository [README](../README.md#mcp-tools).

Two commonly misread response contracts:

- `list_roots` returns an empty legacy `roots` array plus budgeted
  `roots_compact` entries (`id`, `name`, `kind`, `child_count`, `valid_until`),
  then `slots`, `board_top`, truncation `meta`, graph `stats`, and wrapper
  staleness fields.
- `provenance_audit` is rooted: required `node_id`, `impact` by default (or
  `ancestry`). It marks `at_risk` nodes and journals that bounded run; it is not a
  graph-wide audit.

## Migration, dry-run, and compatibility

```bash
megamemory migrate --dry-run --db .megamemory/knowledge.db
megamemory migrate --apply   --db .megamemory/knowledge.db
megamemory reembed           --db .megamemory/knowledge.db
megamemory doctor            --db .megamemory/knowledge.db
```

`migrate --dry-run` and `repair-ids --dry-run` run against a disposable coherent
`VACUUM INTO` snapshot and fingerprint the source main file plus `-wal` before and
after. They report `nothing written` only while that fingerprint stays stable; a
concurrent writer produces a warning. A dry-run emits no token for a later apply.
Apply recomputes current state; ID repair is atomic and fails closed on a stale target,
collision, or unresolved descendants. Full and automatic migration also refuse/roll back
rather than stamp success while unresolved descendants remain. Raw upstream requires
`migrate --apply` because ordinary RW construction rejects its `user_version=0` shape
before startup auto-migration can run.

Backups are coherent `knowledge.db.bak-<UTC timestamp>` snapshots; retention removes
only MegaMemory-named files with a valid SQLite header and keeps three newest.
Migration is additive, but old fork builds without the v14 future-version guard are
not a safe downgrade path: restore a pre-upgrade backup. Upstream data already lost to
the empty-ID primary-key collision cannot be reconstructed.

Read-only behavior is specified in [readonly.md](./readonly.md). In particular,
`MEGAMEMORY_ALLOW_AUTO_MIGRATE=1` affects only `export`, `eval`, and `conflicts`;
it does not change snapshot dry-runs, `expire` dry-run, fixture protection, or other
commands.

## Environment variables

Runtime controls (complete for MegaMemory-owned `MEGAMEMORY_*` controls):

| Variable | Default | Meaning |
|---|---|---|
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | DB fallback after `--db`, resolved from cwd. |
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Model identity; change requires `reembed`. |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid`, `fts`, or `vector` (vector degrades to FTS without a valid generation). |
| `MEGAMEMORY_FTS_TOKENIZER` | unset | Exact `trigram` requests companion CJK FTS. |
| `MEGAMEMORY_EMBED_IDLE_MS` | `300000` | Idle unload delay; `0` disables. |
| `MEGAMEMORY_EMBED_THREADS` | `1` | ONNX intra-op threads. |
| `MEGAMEMORY_AUTO_DIGEST` | on | Exact `0` disables first auto-digest. |
| `MEGAMEMORY_DEDUPE_THRESHOLD` | `0.92` | `(0,1]` duplicate cosine threshold; overrides adjacent config. |
| `MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT` | config/off | Per-call strict-decision override. |
| `MEGAMEMORY_REQUIRE_SUPPORT` | config/off | Fallback alias for the preceding variable. |
| `MEGAMEMORY_PROVENANCE_AUTO_GROUND` | config/off | Per-call auto-ground override. |
| `MEGAMEMORY_TIMELINE_RETENTION_DAYS` | `90` | Age retention; `0` disables. |
| `MEGAMEMORY_TIMELINE_MAX_ENTRIES` | `50000` | Count retention; `0` disables. |
| `MEGAMEMORY_D3_URL` | vendored path | D3 override; otherwise vendored, then warned CDN fallback. |
| `MEGAMEMORY_AUTO_MIGRATE` | on | MCP startup hygiene only; exact `0` skips full conversion/ID repair. |
| `MEGAMEMORY_ALLOW_AUTO_MIGRATE` | off | Exact `1`, only for protected opens in `export`/`eval`/`conflicts`. |
| `MEGAMEMORY_FIXTURES_DIR` | unset | Test fixture boundary that rejects RW opens. |

Installer path controls are `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `CODEX_HOME`,
and `HOME`. The adjacent `megamemory.config.json` supports
`provenance.require_support`, `provenance.auto_ground`, and `dedupe.threshold`.

The ~120 MB default model downloads on first vector use. MegaMemory does not set a
stable cache path. In the shipped Transformers.js runtime, the default filesystem
cache is `.cache` relative to that installed library, not a guaranteed home-level
Hugging Face cache.

## Install and development runtime

Runtime support is Node `>=20.10`. The repository's Vite/Vitest development gate
accepts Node 20.19+, 22.12+, or 24+; Node 21 and 23 are not supported dev runtimes.

```bash
npm install -g @bloodyeagle/megamemory
# GitHub Release asset / npm-pack name for 2.5.1:
npm install -g ./bloodyeagle-megamemory-2.5.1.tgz
```

From a checkout, `npm pack` prints the exact generated filename; do not reuse old
`1.6.3-fork.1`/`1.7.0-fork.1` placeholders.

## Syncing with upstream

```bash
git remote add upstream https://github.com/0xK3vin/MegaMemory.git
git fetch upstream
git rebase upstream/main
# resolve conflicts, then
git rebase --continue
```

### Conflicts in `src/tools.ts` and storage

1. Never take the upstream implementation wholesale. Preserve Unicode IDs,
   compact/wire-budgeted retrieval, qualification/expiry filtering, provenance,
   vector-generation guards, and atomic writes.
2. Preserve both version domains: raise `SCHEMA_VERSION`/`PRAGMA user_version` for
   structural fork migrations; do not treat the conversion marker
   `meta.schema_version` as that number.
3. New schema changes must remain additive unless a separately approved breaking
   migration says otherwise. Preserve tombstones, aliases, workflow identity,
   validation history, support snapshots/revisions, and artifact observations across
   merge/import.
4. After a rebase, run the repository's current build, typecheck, lint, and relevant
   targeted/full test gates under a supported development Node; do not rely on the
   historical three-test command from the early fork.

## Host limitations

FTS5 virtual tables require libsql local-file mode; remote Turso does not support this
layout. After an external `VACUUM`, run `megamemory migrate --apply` to rebuild FTS
because rowids are not stable. FTS5 `unicode61` does not stem Russian; vector retrieval
and prefix queries compensate.
