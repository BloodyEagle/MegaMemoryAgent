# MegaMemory Fork — что отличается от upstream

Основа: upstream [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory)
v1.6.2 (MIT). Этот репозиторий публикует `@bloodyeagle/megamemory` 2.5.1.
English version: [docs/FORK.md](./FORK.md).

## Возможности форка

Исходные метки задач сохранены для исторической трассируемости.

| Задача | Текущий контракт | Где видно |
|---|---|---|
| T0 | Unicode-`makeId`: кириллица/CJK/арабский/иврит/эмодзи дают пригодные id; marks снимаются только после латиницы/кириллицы/греческого/иврита, `/` становится `-`, вывод — NFC, emoji-only имена получают hash-фолбэк, коллизии — `-<hash8>`. Вложенный legacy-repair планирует id в итоговом namespace родителя и сохраняет старые id как aliases. | id узлов; `repair-ids` |
| T0.5 | Аддитивная конверсия сырой upstream v1.6.2: fork-колонки/meta, aliases, FTS/триггеры, usage и ремонт id с согласованными SQLite-бэкапами. У сырой upstream-базы уже есть `nodes`, но `PRAGMA user_version=0`; обычный RW-open её отклоняет, поэтому нужен явный `migrate --apply`. | `migrate`, startup-диагностика |
| T1 | По умолчанию `Xenova/multilingual-e5-small` (`MEGAMEMORY_EMBED_MODEL`), e5-префиксы `passage:`/`query:`, q8 mean pooling, нормализованные векторы, размерность по первой опубликованной строке. `reembed` начинает/продолжает поколение model+preprocessing; в поиск идут только валидные строки активного поколения. | `reembed`, `doctor`, `/api/stats` |
| T2 | Гибрид FTS5 + vector через RRF; `via: vector/fts/both`, безопасные prefix-запросы, опциональная CJK trigram-FTS, фолбэк коротких CJK/нормализованного имени через LIKE. Отсутствующий, старый, malformed, чужого поколения или недоступный vector-путь в hybrid понижается до FTS и не смешивает пространства; явный `MEGAMEMORY_SEARCH=vector` остаётся строгим и возвращает inference-ошибки. | бейджи explorer; `MEGAMEMORY_SEARCH` |
| T2.5 | Fail-closed JSONL eval: recall@k по языкам; каждая непустая некомментарная строка обязана иметь корректные `query`, `expected_id` и необязательный строковый `lang`, иначе разбор останавливается с номером строки до DB/search. | `megamemory eval`, CI |
| T3 | Бюджет фактического MCP wire: `understand` по умолчанию compact/1500 токенов, поддерживает full и brief ≤8 строк и всегда несёт `next`; у `list_roots` свой бюджет. Невозможный обязательный конверт отклоняется, а не превышается. | MCP-ответы; budget line explorer |
| T4 | Lifecycle (`active/superseded/deprecated`), эпистемическая ось, `supersedes`/`contradicts`, надгробия и необязательный `valid_until`. Просроченные активные факты уходят из обычного поиска, но доступны через `include_stale`. | карточки, граф, trace, stats |
| T5 | Кандидаты дублей по эмбеддингам (apply-порог по умолчанию 0.95), группировка/ранжирование с ограниченной генерацией; apply переносит identity, рёбра и workflow-state под version guards. | `consolidate`, preview/apply explorer |
| T6 | Один производный digest-сосед на родителя после 5 пригодных non-digest детей; summary ≤800 символов, refs ≤10, вес поиска 0.8. Записываются точный состав источников и версии смысла; исходные соседи остаются самостоятельными/поисковыми, несовпадение содержания помечает digest stale. | `digest`, карточка digest |
| T7 | Детерминированный containment-safe Markdown-экспорт с frontmatter, wiki-links, рационалами informed-by и проверками path/collision. `export --check` сообщает о missing/differing/extra `.md` и даёт ненулевой код при drift; он **никогда не удаляет файлы** и не владеет каталогом. | `export --md … [--check]` |
| T8 | Учёт usage/токенов для `understand`, `list_roots`, `get_concept`; агрегаты за 7 дней и упорядоченная воронка understand → follow-up → record. | `stats`, `stats --funnel`, Tokens panel |
| T9 | Health-check схемы, FTS, векторов, id, сирот, digest, expiry, D3 и памяти; ненулевой статус при проблемах. | `doctor`, `/api/health` |
| W | Offline-договор workflow агента: единственная редактируемая полная версия живёт в `docs/agent-workflow.md`, печатается дословно `megamemory guide --workflow` (UTF-8, один завершающий LF, без базы и сети); реестр стоимости и ограничений операций — `docs/capabilities.md`. | `guide --workflow`, `docs/` |

Нативный vector search зеркалит эмбеддинги текущего поколения в `nodes_vec`
(`F32_BLOB`) и использует `vector_distance_cos`. Без native-capability или parity
проекции JS cosine-фолбэк видит те же пригодные строки текущего поколения.
Переключение поколения атомарно инвалидирует canonical blobs и native-проекцию;
публикация каждого узла проверяет поколение и захваченные name/kind/summary, поэтому
смена модели или правка во время inference не публикует stale-вектор. Прерванный
`reembed` продолжает только недостающие пригодные строки.

## Поздние контракты и историческое появление схем

Эти version-introduced пометки исторические и намеренно сохранены. Настоящий текущий
compatibility-номер — `PRAGMA user_version=14`.

| Появилось | Контракт, сохранённый в 2.5.1 |
|---|---|
| schema v3 | Журнал вызовов `timeline`; U5 `status_history`/Timeline появился в ранней серии fork-схем. |
| schema v5 | Надгробия рёбер, lifecycle/epistemic axes, validation scope и уже существующая колонка `valid_until`. |
| schema v6 | Reasoning trails, role slots и состояние/due task-board. |
| schema v7 | Provenance-срез `informed_by` с рационалом и cycle-safe DAG writes. |
| schema v8 | Подтверждённые support baselines и явное происхождение/acceptance рёбер. |
| schema v9–v10 | История вытесненных baseline и индексы ограниченного обхода живых опор. |
| schema v11 | Журнал ревизий опор и явные наблюдения файловых/git-артефактов. |
| schema v12 | `created_via` различает agent claims, file anchors, imports и server-generated nodes. |
| schema v13 | Закрепление artifact `repo_path` и активная семантика срока фактов. |
| schema v14 | Digest validation claim/scope, полные переносимые поля истории и identity поколения в canonical/native vector rows. |

`PRAGMA user_version` и `meta.schema_version` невзаимозаменяемы:

- **`PRAGMA user_version=14`** — настоящий compatibility guard схемы.
- **`meta.schema_version`** — только маркер upstream-конверсии для fork hygiene
  (`"1"` — ожидается, `"3"` — выполнена). Маркер `"3"` не означает schema 3.

## UI обозревателя (U1–U7)

| Задача | Текущий контракт | Где |
|---|---|---|
| U1 | Чекбоксы фильтра по kind с сохранением в `localStorage` и счётчиком visible/total. | легенда футера |
| U2 | In-memory Markdown download: bundle `/api/export.json` и `/api/node/:id.md` с безопасными RFC 5987 именами; без серверной записи на диск. | export button; карточка |
| U3 | `healthReport(db)` и `GET /api/health`, status chip и remedy hints. | футер; `doctor` |
| U4 | Карточка digest показывает пригодные **соседние** концепции в родительском модуле, а не детей digest. Stale сравнивает точный записанный состав/смысл источников; focus — view-toggle. Исходные концепции не скрываются из графа и не удаляются навсегда из поиска. | карточка digest |
| U5 | Status history и Timeline-режим смен статусов. Исторические graph/card routes принимают полный date-time snapshot, используют общие lifetime predicates, показывают tombstone как readonly-сохранённое текущее содержимое (не выдуманную текстовую ревизию) и запрещают consolidate во время scrub. | Timeline; карточка |
| U6 | Budget line поиска показывает returned/dropped tokens и `saved ~Z vs full` из `estimated_full_tokens`. | результаты поиска |
| U7 | D3 лежит в `web/vendor/d3.min.js` и раздаётся с `/vendor/*`; `MEGAMEMORY_D3_URL` переопределяет. Без вендорного файла serve предупреждает и откатывается к jsDelivr; `/api/health` показывает источник. | head explorer; health/env |

Веб-пути 2.5.1 также связывают план consolidate и обе показанные карточки одним
DB-snapshot, обнаруживают значимые same-second изменения узла по fingerprint, а не
только `updated_at`, различают HTTP/not-found и network failures и восстанавливают
Timeline-state после неудачного scrub/SSE-init.

## MCP surface

Сервер регистрирует 25 tools: `understand`, `get_concept`, `create_concept`,
`update_concept`, `link`, `remove_concept`, `list_roots`, `list_conflicts`,
`resolve_conflict`, `provenance_trace`, `provenance_audit`, `confirm_supports`,
`provenance_history`, `check_artifacts`, `trail_save`, `trail_get`,
`trail_refresh`, `trail_extend`, `slot_set`, `slot_get`, `slot_release`,
`slot_list`, `task_add`, `task_done` и `board`. Полный краткий справочник — в
[README](../README.ru.md#mcp-инструменты).

Два часто неверно читаемых response-контракта:

- `list_roots` возвращает пустой legacy-массив `roots`, затем бюджетные записи
  `roots_compact` (`id`, `name`, `kind`, `child_count`, `valid_until`), после них
  `slots`, `board_top`, `meta` усечения, `stats` графа и поля устаревания обёртки.
- `provenance_audit` — корневой: обязательный `node_id`, по умолчанию `impact`
  (либо `ancestry`). Он помечает `at_risk` узлы и журналирует этот ограниченный
  прогон; это не аудит всего графа.

## Миграция, dry-run и совместимость

```bash
megamemory migrate --dry-run --db .megamemory/knowledge.db
megamemory migrate --apply   --db .megamemory/knowledge.db
megamemory reembed           --db .megamemory/knowledge.db
megamemory doctor            --db .megamemory/knowledge.db
```

`migrate --dry-run` и `repair-ids --dry-run` работают на одноразовом согласованном
снимке `VACUUM INTO` и сравнивают fingerprint основного source-файла вместе с
`-wal` до/после. Они говорят `nothing written` только при стабильном fingerprint;
конкурентный writer даёт предупреждение. Dry-run не выдаёт токена для позднего apply.
Apply пересчитывает текущее состояние; ремонт id атомарен и fail-closed при stale target,
collision или unresolved descendants. Полная и автоматическая миграции также
отказывают/откатываются, а не штампуют успех при оставшихся unresolved descendants.
Для сырой upstream нужен `migrate --apply`, потому что обычный
RW-конструктор отклоняет форму `user_version=0` до startup-автомиграции.

Бэкапы — согласованные снимки `knowledge.db.bak-<UTC timestamp>`; retention удаляет
только файлы с именем MegaMemory и корректным SQLite header и оставляет три новейших.
Миграция аддитивна, но старые fork-билды без future-version guard v14 не являются
безопасным downgrade-path: восстановите бэкап до обновления. Уже потерянные upstream
строки из-за коллизии empty-ID primary key восстановить нельзя.

Readonly-поведение задано в [readonly.ru.md](./readonly.ru.md). В частности,
`MEGAMEMORY_ALLOW_AUTO_MIGRATE=1` влияет только на `export`, `eval` и `conflicts`;
он не меняет snapshot-dry-run, dry-run `expire`, защиту фикстур и другие команды.

## Переменные окружения

Runtime controls (полный список собственных `MEGAMEMORY_*` controls):

| Переменная | По умолчанию | Значение |
|---|---|---|
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | Фолбэк базы после `--db`, разрешается от cwd. |
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Идентичность модели; после смены нужен `reembed`. |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid`, `fts` или `vector` (без валидного поколения vector понижается до FTS). |
| `MEGAMEMORY_FTS_TOKENIZER` | не задана | Точное `trigram` запрашивает дополнительную CJK FTS. |
| `MEGAMEMORY_EMBED_IDLE_MS` | `300000` | Задержка idle-unload; `0` отключает. |
| `MEGAMEMORY_EMBED_THREADS` | `1` | ONNX intra-op threads. |
| `MEGAMEMORY_AUTO_DIGEST` | включено | Точное `0` отключает первый auto-digest. |
| `MEGAMEMORY_DEDUPE_THRESHOLD` | `0.92` | `(0,1]` cosine threshold дублей; перебивает соседний config. |
| `MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT` | config/выкл | Перевычисляемый strict-decision override. |
| `MEGAMEMORY_REQUIRE_SUPPORT` | config/выкл | Fallback-алиас предыдущей переменной. |
| `MEGAMEMORY_PROVENANCE_AUTO_GROUND` | config/выкл | Перевычисляемый auto-ground override. |
| `MEGAMEMORY_TIMELINE_RETENTION_DAYS` | `90` | Возрастной retention; `0` отключает. |
| `MEGAMEMORY_TIMELINE_MAX_ENTRIES` | `50000` | Retention по числу строк; `0` отключает. |
| `MEGAMEMORY_D3_URL` | вендорный путь | D3 override; иначе вендорный файл, затем предупреждённый CDN-фолбэк. |
| `MEGAMEMORY_AUTO_MIGRATE` | включено | Только MCP startup-hygiene; точное `0` пропускает полную конверсию/ремонт id. |
| `MEGAMEMORY_ALLOW_AUTO_MIGRATE` | выкл | Точное `1`, только для защищённых opens `export`/`eval`/`conflicts`. |
| `MEGAMEMORY_FIXTURES_DIR` | не задана | Тестовая граница фикстур, запрещающая RW-open. |

Пути установщика контролируют `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `CODEX_HOME`
и `HOME`. Соседний `megamemory.config.json` поддерживает
`provenance.require_support`, `provenance.auto_ground` и `dedupe.threshold`.

Модель по умолчанию (~120 МБ) скачивается при первом vector-use. MegaMemory не задаёт
стабильный cache path. В поставляемом Transformers.js runtime файловый кеш по умолчанию
— `.cache` относительно установленной библиотеки, а не гарантированный домашний
кеш Hugging Face.

## Установка и dev-runtime

Runtime поддерживает Node `>=20.10`. Репозиторный dev-gate Vite/Vitest принимает
Node 20.19+, 22.12+ или 24+; Node 21 и 23 не поддерживаются как dev-runtime.

```bash
npm install -g @bloodyeagle/megamemory
# Asset GitHub Release / имя npm-pack для 2.5.1:
npm install -g ./bloodyeagle-megamemory-2.5.1.tgz
```

В чекауте `npm pack` печатает точное созданное имя; не переиспользуйте старые
placeholders `1.6.3-fork.1`/`1.7.0-fork.1`.

## Синхронизация с upstream

```bash
git remote add upstream https://github.com/0xK3vin/MegaMemory.git
git fetch upstream
git rebase upstream/main
# разрешить конфликты, затем
git rebase --continue
```

### Конфликты в `src/tools.ts` и storage

1. Не принимайте upstream-реализацию целиком. Сохраните Unicode ID,
   compact/wire-budgeted retrieval, qualification/expiry filtering, provenance,
   guards поколений векторов и атомарные записи.
2. Сохраняйте оба version-domain: поднимайте `SCHEMA_VERSION`/`PRAGMA user_version`
   для структурных fork-миграций; не считайте conversion-marker
   `meta.schema_version` этим номером.
3. Новые изменения схемы должны оставаться аддитивными без отдельно одобренной
   breaking migration. При merge/import сохраняйте tombstones, aliases, workflow
   identity, validation history, support snapshots/revisions и artifact observations.
4. После rebase запускайте актуальные build, typecheck, lint и релевантные
   targeted/full test gates репозитория на поддерживаемом dev-Node; не полагайтесь на
   историческую команду трёх тестов раннего форка.

## Ограничения хоста

FTS5 virtual tables требуют local-file режима libsql; remote Turso такую раскладку не
поддерживает. После внешнего `VACUUM` выполните `megamemory migrate --apply`, чтобы
перестроить FTS: rowid нестабилен. FTS5 `unicode61` не стеммит русский; компенсируют
vector retrieval и prefix-запросы.
