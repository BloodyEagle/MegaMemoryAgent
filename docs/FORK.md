# MegaMemory Fork — что отличается от upstream / What differs from upstream

База: upstream [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory) v1.6.2 (MIT).
Ветка форка: `feat/multilang`. `main` остаётся зеркалом upstream.

## Возможности форка / Fork features

| Задача | Что даёт | Где видно |
|---|---|---|
| T0 | Unicode-`makeId`: кириллица/CJK/арабский/эмодзи дают корректные id; hash-фолбэк для пустых slug; коллизии имён решаются суффиксом `-<hash4>` | любые id узлов; `repair-ids` чинит старые базы |
| T0.5 | Миграция с upstream v1.6.2: аддитивная схема (meta, status-колонки, FTS-индекс, usage), бэкапы, `migrate --dry-run/--apply`, автомиграция при старте MCP | `megamemory migrate`, лог старта |
| T1 | Мультиязычные эмбеддинги: `Xenova/multilingual-e5-small` по умолчанию (env `MEGAMEMORY_EMBED_MODEL`), e5-префиксы, resumable `reembed`, векторный поиск отключается при смене модели | `/api/stats → embeddings`, `megamemory reembed` |
| T2 | Гибридный поиск: FTS5 + вектор через RRF, `via: vector/fts/both`, trigram-таблица для CJK (`MEGAMEMORY_FTS_TOKENIZER=trigram`), LIKE-фолбэк | бейджи `via` в поиске explorer, env `MEGAMEMORY_SEARCH` |
| T3 | Бюджет контекста: `understand` в режиме `compact` (по умолчанию) укладывает выдачу в `max_tokens` (1500), обрезка summary до 240 символов, `meta.returned/dropped/tokens_estimated`; `list_roots` с `roots_compact` | зелёная строка «N nodes, ~X tokens, dropped M» в explorer |
| T4 | Жизненный цикл: `status` (active/superseded/deprecated), `supersedes`, `contradicts`; устаревшее скрыто из выдачи, но видно в графе | бейдж статуса в карточке, пунктирные янтарные рёбра `supersedes`, тумблер «show outdated» |
| T5 | Консолидация дублей: косинус эмбеддингов ≥ 0.95, merge в старший узел с переносом рёбер | `megamemory consolidate`, вкладка «consolidate…» в explorer |
| T6 | Digest-узлы: один узел на модуль со сводкой по детям (≥5), вес 0.8 в поиске, автосборка после 5-го ребёнка | жёлтые узлы `digest`, `megamemory digest` |
| T7 | Markdown-экспорт: файл на узел, frontmatter, wiki-ссылки, детерминированный порядок | `megamemory export --md <dir> [--check]` |
| T8 | Учёт токенов: что и сколько вернули `understand`/`list_roots`/`get_concept` за 7 дней | панель Tokens в explorer, `megamemory stats` |
| T9 | Doctor: health-check базы с кодом выхода 1 | `megamemory doctor` |

## Обновление из upstream / Syncing with upstream

```bash
git remote add upstream https://github.com/0xK3vin/MegaMemory.git
git fetch upstream
git checkout feat/multilang
git rebase upstream/main
# при конфликте — resolve и продолжить
git rebase --continue
```

### Конфликты в `src/tools.ts`

Upstream двигает те же функции (`understand`, `createConcept`, `makeId`). Правила:

1. Не принимать upstream-версию целиком: в форке `understand` — compact-режим + фильтр статусов,
   `createConcept` — коллизии + `supersedes`, `makeId` — Unicode.
2. После rebase прогнать: `npm run build` и `npx vitest run src/__tests__/id-generation.test.ts src/__tests__/context-budget.test.ts src/__tests__/status.test.ts --reporter=dot`.
3. Если upstream поменял схему БД — поднять аддитивную миграцию в `src/migrate-schema.ts`
   (новая версия `schema_version`), никогда не менять/удалять существующие колонки.

## Обратная совместимость / Compatibility

- База upstream v1.6.2 открывается форком: при старте применяется аддитивная миграция
  (без потери данных; `migrate --dry-run` покажет план, включая узлы, потерянные upstream'ом до миграции).
- Обратный откат: upstream v1.6.2 продолжает работать с мигрированной базой — новые колонки имеют
  DEFAULT, FTS-триггеры поддерживают индекс при вставках upstream. Бэкапы: `knowledge.db.bak-<ts>`,
  хранятся 3 последних.
- Старые вызовы MCP-инструментов работают без изменений; новые параметры (`max_tokens`, `mode`,
  `include_inactive`, `supersedes`) опциональны.

## Переменные окружения

| Переменная | По умолчанию | Значение |
|---|---|---|
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Модель эмбеддингов (~120 МБ при первом запуске, кеш в `~/.cache/huggingface`) |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid` / `fts` / `vector` |
| `MEGAMEMORY_FTS_TOKENIZER` | — | `trigram` — вторая FTS-таблица для CJK |
| `MEGAMEMORY_AUTO_DIGEST` | вкл (`0` — выкл) | Автосборка digest после 5-го ребёнка |
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | Путь к базе |

**Лицензия модели (М11).** `intfloat/multilingual-e5-small` — MIT; ONNX-экспорт
`Xenova/multilingual-e5-small` распространяется под той же лицензией. Альтернатива без
prefix-механики (`query:`/`passage:`), если она не нужна: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
(Apache-2.0, ONNX-версия существует) — префиксы к ней не применяются автоматически
(имя модели не содержит "e5").

## Ограничения хостов (А7)

FTS5/virtual tables работают в **локальном** file-режиме libsql (единственный режим
MegaMemory). На удалённых хостах Turso виртуальные таблицы запрещены — если форк когда-нибудь
переводят на remote-хранилище, гибридный поиск теряет FTS-половину (остаётся LIKE-fallback
и векторный канал). Также после любого VACUUM нужен `megamemory migrate --apply`
(пересборка FTS — SQLite не гарантирует стабильность rowid, М5).

## Установка из tarball

```bash
npm run build && npm pack   # megamemory-1.6.3-fork.1.tgz
npx ./megamemory-1.6.3-fork.1.tgz migrate --apply   # в проекте с .megamemory
npx ./megamemory-1.6.3-fork.1.tgz reembed   # после смены модели
npx ./megamemory-1.6.3-fork.1.tgz doctor    # проверка
```
