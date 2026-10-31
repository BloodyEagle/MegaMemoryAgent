# Changelog

## Fork (1.6.3-fork.1)

### Behaviour changes (Б11)

- `understand` по умолчанию отвечает в **compact**-режиме: без `why`, summary обрезан до
  240 символов, дети/рёбра — только у первых трёх узлов, выдача ограничена `max_tokens`.
  Это сознательный разрыв формата ответа ради экономии токенов; прежний формат —
  `mode: "full"`. Список вызовов инструментов не менялся.
- `makeId` (v1.1): `a/b` теперь даёт `a-b` (а не `ab`); катакана с дакутэном и хангыль
  сохраняются точно (А1); суффикс коллизий — 8 hex.
- `estimateTokens` (v1.1) считает UTF-8-байты — оценки выросли для не-латиницы (А6).
- `repair-ids` (v1.1) переименовывает и потомков переименованных узлов (каскад), старые id
  разрешаются через таблицу `aliases` (Б12).
- `reembed` (v1.1) при смене модели обнуляет старые векторы и заполняет
  `WHERE embedding IS NULL` (М6).

Fork of upstream v1.6.2 — multilingual, token-economical, visible-in-UI.

- **T0 — Unicode ids**: `makeId` keeps letters of any script (Cyrillic, CJK, Arabic,
  Hebrew), strips diacritics, hash fallback for emoji/punct names, `-<hash4>` collision
  suffix; `megamemory repair-ids` fixes legacy empty/trailing-slash ids (backup first).
- **T0.5 — upstream migration**: additive-only schema upgrade (meta table, status columns,
  FTS index + sync triggers, usage table) with `migrate --dry-run/--apply`, `.bak-<ts>`
  backups (keep 3), automatic at MCP server start; upstream v1.6.2 keeps working with a
  migrated db (downgrade-safe).
- **T1 — multilingual embeddings**: default model `Xenova/multilingual-e5-small`
  (`MEGAMEMORY_EMBED_MODEL`), e5 `passage:`/`query:` prefixes, dimension no longer
  hardcoded, vector search disabled on model mismatch until `megamemory reembed`
  (resumable, batched).
- **T2 — hybrid search**: FTS5 + vector fused with RRF (`MEGAMEMORY_SEARCH=hybrid`),
  per-hit `via` badge in the explorer, optional trigram table for CJK
  (`MEGAMEMORY_FTS_TOKENIZER=trigram`), LIKE fallback for short CJK queries.
- **T3 — context budget**: `understand` defaults to compact mode bounded by
  `max_tokens` (1500) with `meta.returned/dropped/tokens_estimated`; summaries trimmed
  to 240 chars at word boundaries; budgeted `list_roots` overview.
- **T4 — fact freshness**: node `status` (active/superseded/deprecated), `supersedes`
  edges with automatic status flip, `contradicts` surfaced in `list_concepts` conflicts;
  status badges, muted outdated nodes and "show outdated" toggle in the explorer.
- **T5 — consolidation**: embedding-similarity duplicate finder
  (`megamemory consolidate`), merge into the older node with edge transfer; explorer tab.
- **T6 — digest nodes**: per-module compression of ≥5 children into one `digest` node
  (summary ≤800 chars, file_refs ≤10), 0.8 search weight, auto-built after the 5th child,
  `megamemory digest`.
- **T7 — markdown export**: one file per node with frontmatter and wiki-links,
  deterministic order, `megamemory export --md <dir> [--check]` (exit 1 on drift, CI-ready).
- **T8 — token accounting**: every `understand`/`list_roots`/`get_concept` answer is
  measured; 7-day aggregates in `megamemory stats`, `/api/stats` and a Tokens panel
  in the explorer.
- **T9 — doctor**: `megamemory doctor` health-check (schema, model, FTS, ids, vectors,
  orphans, digests) with exit code 1 for CI.

Migration from upstream v1.6.2: run `megamemory migrate --dry-run`, then `--apply`;
data-changing id repair happens with a backup. See `docs/FORK.md`.

## 1.0.0 — Initial Release

### Features

- **MCP server** with 6 tools: `understand`, `create_concept`, `update_concept`, `link`, `remove_concept`, `list_roots`
- **Semantic search** via in-process embeddings (all-MiniLM-L6-v2, 384 dimensions) — no external API calls
- **SQLite persistence** with soft-delete, schema migrations, and WAL mode
- **Web explorer** — browser-based graph visualization with Cytoscape.js at `megamemory serve`
- **CLI** with colored output, graceful error handling, and interactive port conflict resolution
- **`megamemory init`** — one-command setup for opencode (MCP config, AGENTS.md, skill plugin, bootstrap command)
- **Concept kinds**: feature, module, pattern, config, decision, component
- **Relationship types**: connects_to, depends_on, implements, calls, configured_by
- **Knowledge graph** designed for LLM agents — concepts in natural language, not code symbols
