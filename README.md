<p align="center">
  <h1 align="center">MegaMemory <sub><sup>fork</sup></sub></h1>
</p>
<p align="center">Persistent project knowledge graph for coding agents — multilingual, token-economical, visible in the UI.</p>

<p align="center">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="version" src="https://img.shields.io/badge/version-1.6.3--fork.3-orange?style=flat-square" />
</p>

<p align="center">
  <img src="./assets/preview.png" alt="MegaMemory web explorer" width="800" />
</p>

> **Fork of [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory) v1.6.2 (MIT).**
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

## Install

Requires Node.js >= 18. For Russian-only projects a much smaller model (`cointegrated/rubert-tiny2`, 312-dim) works after an ONNX conversion; the model unloads after 5 minutes idle (`MEGAMEMORY_EMBED_IDLE_MS=0` disables that), and `MEGAMEMORY_SEARCH=fts` avoids loading it at all. The embedding model (~120 MB, multilingual) downloads on first use and is
cached in `~/.cache/huggingface`.

Install globally from npm:

```bash
npm install -g @bloodyeagle/megamemory
```

Or build from a checkout (for development):

```bash
git clone https://github.com/BloodyEagle/MegaMemoryAgent.git
cd MegaMemoryAgent
npm ci
npm run build
npm pack                      # megamemory-1.6.3-fork.1.tgz
npm install -g ./megamemory-1.6.3-fork.1.tgz
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

**Kinds:** `feature` · `module` · `pattern` · `config` · `decision` · `component` · `digest`

**Relations:** `connects_to` · `depends_on` · `implements` · `calls` · `configured_by` · `supersedes` · `contradicts`

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