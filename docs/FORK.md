# MegaMemory Fork — what differs from upstream

База: upstream [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory) v1.6.2 (MIT).
Русская версия этого документа: [docs/FORK.ru.md](./FORK.ru.md).

## Fork features

| Task | What it gives | Where it is visible |
|---|---|---|
| T0 | Unicode `makeId`: Cyrillic/CJK/Arabic/Hebrew/emoji produce correct ids; diacritics stripped only after Latin/Cyrillic/Greek/Hebrew bases (katakana dakuten and Hangul jamo survive); `/` becomes `-`; NFC output; hash fallback for empty slugs; 8-hex suffix on name collisions | any node id; `repair-ids` fixes legacy databases |
| T0.5 | Migration from upstream v1.6.2: additive schema (meta, status columns, `name_norm`, aliases, FTS index, usage), backups, `migrate --dry-run/--apply`, auto-migration at MCP startup | `megamemory migrate`, startup log |
| T1 | Multilingual embeddings: `Xenova/multilingual-e5-small` by default (env `MEGAMEMORY_EMBED_MODEL`), e5 prefixes, resumable `reembed` (fills `WHERE embedding IS NULL`), vector search disabled on model mismatch | `/api/stats → embeddings`, `megamemory reembed` |
| T2 | Hybrid search: FTS5 + vector fused with RRF, per-hit `via: vector/fts/both`, per-token quoted prefix queries (`"ток"*` — safe input, morphology compensation), trigram table for CJK ≥3 chars (`MEGAMEMORY_FTS_TOKENIZER=trigram`), `name_norm` LIKE fallback for short CJK and case-insensitive Cyrillic | `via` badges in the explorer search, env `MEGAMEMORY_SEARCH` |
| T2.5 | Eval harness: `megamemory eval` measures recall@10 over `fixtures/eval.jsonl`, per language | `megamemory eval`, CI |
| T3 | Context budget: `understand` answers in `compact` mode (default) bounded by `max_tokens` (1500), summaries trimmed to 240 chars, `meta.returned/dropped/tokens_estimated`, `edges_between` for returned nodes; budgeted `list_roots` | green line «N nodes, ~X tokens, dropped M» in the explorer |
| T4 | Fact freshness: node `status` (active/superseded/deprecated), `supersedes`, `contradicts`; outdated facts hidden from answers but visible in the graph | status badge in the node card, dashed amber `supersedes` edges, «show outdated» toggle |
| T5 | Duplicate consolidation: embedding cosine ≥ 0.95, merge into the older node with edge transfer, digests excluded | `megamemory consolidate`, the «consolidate…» tab in the explorer |
| T6 | Digest nodes: one summary node per module (≥5 children), weighted 0.8 in search, its children dropped from results, auto-built after the 5th child | yellow `digest` nodes, `megamemory digest` |
| T7 | Markdown export: one file per node, frontmatter, wiki-links, deterministic order, `--check` prunes orphans | `megamemory export --md <dir> [--check]` |
| T8 | Token accounting: what and how much `understand`/`list_roots`/`get_concept` returned over 7 days, savings vs full mode | Tokens panel in the explorer, `megamemory stats` |
| T9 | Doctor: database health check, exit code 1 on problems | `megamemory doctor` |

## Explorer UI (U1-U6)

| Task | What it gives | Where |
|---|---|---|
| U1 | Per-kind filter checkboxes (persisted in localStorage), visible/total counter | legend in the footer |
| U2 | Markdown export from the explorer: `/api/export.json` bundle and per-node `/api/node/:id.md` (RFC 5987 filenames), no disk writes | «export bundle» button, «download .md» in the node card |
| U3 | `healthReport(db)` + `GET /api/health`; health chip in the explorer with remedy hints | `megamemory doctor`, footer chip |
| U4 | Digest cards list source concepts (siblings), `stale` badge, focus toggle | node card |
| U5 | `status_history` table (schema v3), timeline «status changes» mode, node history via `/api/node/:id/history` | timeline selector, node card |
| U6 | Search budget line shows «saved ~Z vs full» from `estimated_full_tokens` | search results |

Native vector search (no JS cosine loop): embeddings are mirrored into a `nodes_vec`
shadow table (`F32_BLOB`) and top-k is computed by SQLite via `vector_distance_cos`;
JS cosine remains as a fallback when the shadow table is not fully populated.

## Syncing with upstream

```bash
git remote add upstream https://github.com/0xK3vin/MegaMemory.git
git fetch upstream
git rebase upstream/main
# resolve conflicts, then
git rebase --continue
```

### Conflicts in `src/tools.ts`

Upstream touches the same functions (`understand`, `createConcept`, `makeId`). Rules:

1. Never take the upstream version wholesale: in this fork `understand` is compact-mode +
   status filter, `createConcept` has collision suffixes + `supersedes`, `makeId` is
   Unicode-aware (lookbehind diacritic stripping, NFC).
2. After a rebase run: `npm run build` and
   `npx vitest run src/__tests__/id-generation.test.ts src/__tests__/context-budget.test.ts src/__tests__/status.test.ts --reporter=dot`.
3. If upstream changed the DB schema — add an additive migration in `src/migrate-schema.ts`
   (bump `schema_version`); never alter or drop existing columns.

## Compatibility

- An upstream v1.6.2 database opens in the fork: an additive migration runs at startup
  (no data loss; `migrate --dry-run` prints the plan, including nodes lost upstream before
  the migration).
- Downgrade: upstream v1.6.2 keeps working with a migrated database — new columns have
  DEFAULTs, FTS triggers keep the index in sync for upstream inserts, `usage` self-heals.
  Backups: `knowledge.db.bak-<ts>`, the 3 most recent are kept.
- Old MCP tool calls work unchanged; new parameters (`max_tokens`, `mode`,
  `include_inactive`, `supersedes`) are optional.
- Ids renamed by `repair-ids` stay resolvable through the `aliases` table
  (in `getConcept` and `/api/node/:id`).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Embedding model (~120 MB on first use, cached in `~/.cache/huggingface`) |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid` / `fts` / `vector` |
| `MEGAMEMORY_FTS_TOKENIZER` | — | `trigram` — second FTS table for CJK |
| `MEGAMEMORY_AUTO_DIGEST` | on (`0` — off) | Auto-build digests after the 5th child |
| `MEGAMEMORY_EMBED_IDLE_MS` | `300000` | Unload the model after this idle time; `0` disables unloading |
| `MEGAMEMORY_EMBED_THREADS` | `1` | Intra-op threads of the ONNX session |
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | Database path |

**Model license.** `intfloat/multilingual-e5-small` is MIT; the ONNX export
`Xenova/multilingual-e5-small` ships under the same license. A prefix-free alternative
(no `query:`/`passage:` mechanics): `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
(Apache-2.0, ONNX export exists) — prefixes are not applied to it automatically
(its name does not contain "e5").

**Smaller model.** For Russian-only projects `cointegrated/rubert-tiny2`
(29M parameters, 312 dimensions) is 4–5× lighter and 4–6× faster than e5-small.
There may be no transformers.js ONNX export — conversion is a separate task;
prefixes are not applied to it automatically.

**Memory.** The model unloads after `MEGAMEMORY_EMBED_IDLE_MS` of idle time
(5 minutes by default), the ONNX session is created without a memory arena,
threads via `MEGAMEMORY_EMBED_THREADS`. `MEGAMEMORY_SEARCH=fts` never loads the
model at all. Current usage: `megamemory doctor` and `/api/stats → memory`.

## Host limitations

FTS5/virtual tables work in the **local** file mode of libsql (the only mode
MegaMemory uses). Remote Turso hosts disallow virtual tables — if the fork is ever
moved to remote storage, hybrid search loses its FTS half (the LIKE fallback and the
vector channel remain). Also, after any VACUUM run `megamemory migrate --apply`
(rebuilds FTS — SQLite does not guarantee rowid stability).

## Install

Primary: `npm install -g @bloodyeagle/megamemory` (see README). From a tarball:

```bash
npm run build && npm pack   # bloodyeagle-megamemory-<version>.tgz
npx ./bloodyeagle-megamemory-1.6.3-fork.1.tgz migrate --apply   # in a project with .megamemory
npx ./bloodyeagle-megamemory-1.6.3-fork.1.tgz reembed   # after changing the model
npx ./bloodyeagle-megamemory-1.6.3-fork.1.tgz doctor    # health check
```
