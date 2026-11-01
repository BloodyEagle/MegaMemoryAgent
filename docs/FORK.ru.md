# MegaMemory Fork — что отличается от upstream

Base: upstream [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory) v1.6.2 (MIT).
English version of this document: [docs/FORK.md](./FORK.md).

## Возможности форка

| Задача | Что даёт | Где видно |
|---|---|---|
| T0 | Unicode-`makeId`: кириллица/CJK/арабский/иврит/эмодзи дают корректные id; диакритика снимается только после латиницы/кириллицы/греческого/иврита (катакана с дакутэном и хангыль сохраняются); `/` становится `-`; NFC на выходе; hash-фолбэк для пустых slug; суффикс `-<hash8>` при коллизиях имён | любые id узлов; `repair-ids` чинит старые базы |
| T0.5 | Миграция с upstream v1.6.2: аддитивная схема (meta, status-колонки, `name_norm`, aliases, FTS-индекс, usage), бэкапы, `migrate --dry-run/--apply`, автомиграция при старте MCP | `megamemory migrate`, лог старта |
| T1 | Мультиязычные эмбеддинги: `Xenova/multilingual-e5-small` по умолчанию (env `MEGAMEMORY_EMBED_MODEL`), e5-префиксы, прерываемый `reembed` (заполняет `WHERE embedding IS NULL`), векторный поиск отключается при смене модели | `/api/stats → embeddings`, `megamemory reembed` |
| T2 | Гибридный поиск: FTS5 + вектор через RRF, бейдж `via: vector/fts/both` у каждого результата, префикс-запросы с посимвольным кавычированием (`"ток"*` — санитизация ввода + компенсация морфологии), trigram-таблица для CJK ≥3 символов (`MEGAMEMORY_FTS_TOKENIZER=trigram`), LIKE-фолбэк по `name_norm` для коротких CJK и регистронезависимой кириллицы | бейджи `via` в поиске explorer, env `MEGAMEMORY_SEARCH` |
| T2.5 | Eval-сет: `megamemory eval` измеряет recall@10 по `fixtures/eval.jsonl`, в разрезе языков | `megamemory eval`, CI |
| T3 | Бюджет контекста: `understand` в режиме `compact` (по умолчанию) укладывает выдачу в `max_tokens` (1500), обрезка summary до 240 символов, `meta.returned/dropped/tokens_estimated`, `edges_between` для возвращённых узлов; бюджетный `list_roots` | зелёная строка «N nodes, ~X tokens, dropped M» в explorer |
| T4 | Актуальность фактов: `status` (active/superseded/deprecated), `supersedes`, `contradicts`; устаревшее скрыто из выдачи, но видно в графе | бейдж статуса в карточке, пунктирные янтарные рёбра `supersedes`, тумблер «show outdated» |
| T5 | Консолидация дублей: косинус эмбеддингов ≥ 0.95, merge в старший узел с переносом рёбер, digest-узлы исключены | `megamemory consolidate`, вкладка «consolidate…» в explorer |
| T6 | Digest-узлы: один узел-сводка на модуль (≥5 детей), вес 0.8 в поиске, дети digest убираются из выдачи, автосборка после 5-го ребёнка | жёлтые узлы `digest`, `megamemory digest` |
| T7 | Markdown-экспорт: файл на узел, frontmatter, wiki-ссылки, детерминированный порядок, `--check` подчищает лишние файлы | `megamemory export --md <dir> [--check]` |
| T8 | Учёт токенов: что и сколько вернули `understand`/`list_roots`/`get_concept` за 7 дней, экономия против full-режима | панель Tokens в explorer, `megamemory stats` |
| T9 | Doctor: health-check базы с кодом выхода 1 при проблемах | `megamemory doctor` |

## UI обозревателя (U1-U6)

| Задача | Что даёт | Где |
|---|---|---|
| U1 | Чекбоксы фильтра по типам (с сохранением в localStorage), счётчик видимых | легенда в футере |
| U2 | Markdown-экспорт из обозревателя: `/api/export.json` бандл и `/api/node/:id.md` (RFC 5987 имена), без записи на диск | кнопка «export bundle», «download .md» в карточке |
| U3 | `healthReport(db)` + `GET /api/health`; чип health в обозревателе с подсказками | `megamemory doctor`, чип в футере |
| U4 | Карточка digest показывает исходные концепции (соседей), бейдж `stale`, фокус | карточка узла |
| U5 | Таблица `status_history` (схема v3), режим «status changes» в таймлайне, история узла через `/api/node/:id/history` | селектор таймлайна, карточка узла |
| U6 | Строка бюджета поиска показывает «saved ~Z vs full» из `estimated_full_tokens` | результаты поиска |

Нативный векторный поиск (без JS-перебора): эмбеддинги дублируются в теневую таблицу
`nodes_vec` (`F32_BLOB`), top-k считает SQLite через `vector_distance_cos`; JS-косинус
остаётся фолбэком на случай неполной таблицы.

## Синхронизация с upstream

```bash
git remote add upstream https://github.com/0xK3vin/MegaMemory.git
git fetch upstream
git rebase upstream/main
# при конфликте — resolve и продолжить
git rebase --continue
```

### Конфликты в `src/tools.ts`

Upstream двигает те же функции (`understand`, `createConcept`, `makeId`). Правила:

1. Не принимать upstream-версию целиком: в форке `understand` — compact-режим + фильтр
   статусов, `createConcept` — коллизии + `supersedes`, `makeId` — Unicode (lookbehind
   при снятии диакритики, NFC).
2. После rebase прогнать: `npm run build` и
   `npx vitest run src/__tests__/id-generation.test.ts src/__tests__/context-budget.test.ts src/__tests__/status.test.ts --reporter=dot`.
3. Если upstream поменял схему БД — поднять аддитивную миграцию в `src/migrate-schema.ts`
   (новая версия `schema_version`), никогда не менять/удалять существующие колонки.

## Обратная совместимость

- База upstream v1.6.2 открывается форком: при старте применяется аддитивная миграция
  (без потери данных; `migrate --dry-run` покажет план, включая узлы, потерянные
  upstream'ом до миграции).
- Обратный откат: upstream v1.6.2 продолжает работать с мигрированной базой — новые
  колонки имеют DEFAULT, FTS-триггеры поддерживают индекс при вставках upstream,
  `usage` самовосстанавливается. Бэкапы: `knowledge.db.bak-<ts>`, хранятся 3 последних.
- Старые вызовы MCP-инструментов работают без изменений; новые параметры (`max_tokens`,
  `mode`, `include_inactive`, `supersedes`) опциональны.
- Id, переименованные `repair-ids`, остаются разрешимыми через таблицу `aliases`
  (в `getConcept` и `/api/node/:id`).

## Переменные окружения

| Переменная | По умолчанию | Значение |
|---|---|---|
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Модель эмбеддингов (~120 МБ при первом запуске, кеш в `~/.cache/huggingface`) |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid` / `fts` / `vector` |
| `MEGAMEMORY_FTS_TOKENIZER` | — | `trigram` — вторая FTS-таблица для CJK |
| `MEGAMEMORY_AUTO_DIGEST` | вкл (`0` — выкл) | Автосборка digest после 5-го ребёнка |
| `MEGAMEMORY_EMBED_IDLE_MS` | `300000` | Выгрузка модели после простоя; `0` — не выгружать |
| `MEGAMEMORY_EMBED_THREADS` | `1` | Внутренние потоки ONNX-сессии |
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | Путь к базе |

**Лицензия модели.** `intfloat/multilingual-e5-small` — MIT; ONNX-экспорт
`Xenova/multilingual-e5-small` распространяется под той же лицензией. Альтернатива без
prefix-механики (`query:`/`passage:`): `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
(Apache-2.0, ONNX-версия существует) — префиксы к ней не применяются автоматически
(имя модели не содержит "e5").

**Меньшая модель.** Для чисто русских проектов `cointegrated/rubert-tiny2`
(29M параметров, 312 измерений) — в 4–5 раз меньше памяти и в 4–6 раз быстрее e5-small.
ONNX-экспорта под transformers.js может не быть — тогда требуется конвертация
(отдельная задача); префиксы `passage:`/`query:` к ней не применяются автоматически.

**Память.** Модель выгружается после `MEGAMEMORY_EMBED_IDLE_MS` простоя (по умолчанию
5 минут), сессия ONNX создаётся без memory-арены, потоки — `MEGAMEMORY_EMBED_THREADS`.
Режим `MEGAMEMORY_SEARCH=fts` вообще не загружает модель. Текущее потребление —
`megamemory doctor` и `/api/stats → memory`.

## Ограничения хостов

FTS5/virtual tables работают в **локальном** file-режиме libsql (единственный режим
MegaMemory). На удалённых хостах Turso виртуальные таблицы запрещены — если форк
переводят на remote-хранилище, гибридный поиск теряет FTS-половину (остаются
LIKE-fallback и векторный канал). Также после любого VACUUM нужен
`megamemory migrate --apply` (пересборка FTS — SQLite не гарантирует стабильность rowid).

## Установка

Основной путь: `npm install -g @bloodyeagle/megamemory` (см. README). Из tarball:

```bash
npm run build && npm pack   # bloodyeagle-megamemory-<version>.tgz
npx ./bloodyeagle-megamemory-1.6.3-fork.1.tgz migrate --apply   # в проекте с .megamemory
npx ./bloodyeagle-megamemory-1.6.3-fork.1.tgz reembed   # после смены модели
npx ./bloodyeagle-megamemory-1.6.3-fork.1.tgz doctor    # проверка
```
