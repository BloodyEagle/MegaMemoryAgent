# Changelog

## Fork (1.8.0-fork.1)

### Workflow: reasoning trails, role slots, task board (plan 2, schema v6)

- **Цепочки рассуждений (trails):** упорядоченный список узлов + обязательная
  авторская сводка «почему решили так». Отпечаток смысла участника —
  `sha1(summary + epistemic_status + sorted(outgoing informed_by с рационалами))`;
  `name`, `parent_id`, timestamps сознательно исключены (переименование и
  merge не протухают цепочки). При чтении сравниваются с текущим состоянием:
  расхождение → `stale` (можно перечитать и пересобрать), участник удалён
  физически → `broken` (восстанавливать нечего). Откат текста к исходному
  честно возвращает «свежая».
- Инструменты: `trail_save` (сводка обязательна), `trail_get` (по-членно
  state + reason), `trail_refresh` (переснимок после проверки; на broken —
  отказ), `trail_extend`. В карточке узла — блок «участвует в цепочках»
  со state.
- **Новая связь `informed_by`** — провенанс вывода («вывод опирается на факт»),
  входит в отпечаток цепочки.
- Удаление участника цепочки никогда не молчаливо: `remove_concept` помечает
  цепочки устаревшими и перечисляет их в ответе с причиной (аудит B5).
- **Слоты ролей:** у роли ровно один живой держатель. Взятие новым узлом
  пишет ребро `supersedes` старому (старый не отзывается — вчерашняя передача
  смены остаётся правдивым документом); повтор тем же узлом — no-op;
  `release` освобождает роль, узел не трогает; скоуп — проект.
  Гарантия единственности — от сериализованного upsert в одной транзакции.
  Инструменты: `slot_set`, `slot_get`, `slot_release`, `slot_list`.
- **Доска задач:** колонки `task_state` (`open`/`done`) и `due_at` на узлах —
  отдельная ось, не пересекается с жизненным циклом (`status`) и
  эпистемикой (`epistemic_status`). Сортировка по «гниению»:
  `rot = возраст_дней + (изолирован ? 45 : 0) + (просрочена ? 400 : 0)`
  (константы kaeru, не менять без причины). `done` снимает `due_at`.
  Инструменты: `task_add`, `task_done`, `board`.
- Стартовая сводка (`list_roots` compact): слоты идут первыми, затем
  верхушка доски (5 карточек по rot).
- Схема: `PRAGMA user_version` 5 → 6 (таблицы `trails`, `trail_members`,
  `slots`; колонки `nodes.task_state`, `nodes.due_at` с частичными
  индексами). Свежие базы получают колонки сразу в `CREATE TABLE` — паритет
  с мигрированными. Идемпотентна.
- Версия пакета: 1.8.0-fork.1.

## Fork (1.7.0-fork.1)

### Edge tombstones + epistemic status (plan 1, schema v5)

- **Багфикс:** soft-delete узла больше не удаляет его рёбра физически — они
  получают `removed_at` (надгробие) и восстанавливаются вместе с узлом.
  `deleteEdge` (unlink) тоже ставит надгробие вместо стирания истории связи.
- Повторный `link` той же пары после надгробия **оживляет** ту же строку
  (оживление вместо частичного индекса — история одна, дублей нет).
- Все чтения рёбер фильтруют надгробия; `getAllEdgesRaw` остаётся сырым
  (merge/бэкап). `getStats` отдаёт `edges_removed` отдельно. Merge переносит
  `removed_at` и не оживляет надгробия.
- Схема: `PRAGMA user_version` 4 → 5 (`edges.removed_at`,
  `nodes.epistemic_status`, `nodes.status_scope`, `status_history.field`).
  Свежие базы получают все колонки сразу в `CREATE TABLE` — паритет с
  мигрированными. `meta.schema_version` не тронут (это другой штамп).
- **Эпистемическая ось** узлов: `open / validated / refuted / abandoned`
  отдельно от жизненного цикла `active / superseded / deprecated`.
  `validated` требует `status_scope` (JSON с обязательным `artifact` —
  id прогона теста/замера). Переходы валидируются только на границе
  MCP-инструмента (`update_concept`: `epistemic_status` + `epistemic_reason`
  обязательны вместе); внутренние вызовы (soft-delete, merge) идут мимо.
- `refuted` узлы **всегда** видны в `understand` — отдельным блоком `refuted`
  с причиной, мимо фильтра `include_inactive` (антизнание не прячется).
- `create_concept`: опциональные `epistemic_status` (по умолчанию `open`) и
  `status_scope`.
- `doctor`: новая проверка `user_version` против `SCHEMA_VERSION`; счётчик
  надгробий (+ пометка «между живыми узлами»); рассинхрон «живое ребро у
  удалённого узла»; распределение обеих осей статуса; `validated` без
  `status_scope.artifact`; эпистемические переходы без `reason`.
- Версия пакета: 1.7.0-fork.1.
## Fork (1.6.3-fork.4)

- Explorer больше не ходит в CDN: d3 7.9.0 вендорится в `web/vendor/` и раздаётся
  локально через `/vendor/*` (защита от path traversal). Источник настраивается
  env-переменной `MEGAMEMORY_D3_URL` (любой абсолютный URL, по умолчанию — локальный файл).

## Fork (1.6.3-fork.2)

### Explorer UI (U1-U6)

- per-kind node filter with persistence and a visible/total counter
- markdown export from the explorer: bundle JSON and per-node .md downloads
- Health chip and /api/health: vectors, FTS sync, digests, empty ids, orphans, memory
- digest cards reveal source concepts, staleness badge, focus toggle
- status lifecycle history: status_history table (schema v3), timeline status mode, node history
- search budget line shows saved tokens vs full mode
- docs: FORK.md in english, russian version alongside (docs/FORK.ru.md)
- package metadata: repository/homepage/bugs point at the fork; published as @bloodyeagle/megamemory

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
