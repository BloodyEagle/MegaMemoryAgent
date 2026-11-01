<p align="center">
  <h1 align="center">MegaMemory <sub><sup>форк</sup></sub></h1>
</p>
<p align="center">Граф знаний проекта для кодинг-агентов — мультиязычный, экономный по токенам, видимый в интерфейсе.</p>

<p align="center">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="version" src="https://img.shields.io/badge/version-1.6.3--fork.3-orange?style=flat-square" />
</p>

<p align="center">
  <img src="./assets/preview.png" alt="Веб-обозреватель MegaMemory" width="800" />
</p>

> **Форк [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory) v1.6.2 (MIT).**
> Идея и база — upstream. В форке: исправлены идентификаторы для любых языков, добавлены
> гибридный поиск, бюджет контекста, актуальность фактов, digest-узлы, экспорт и учёт токенов.
> English version: [README.md](./README.md).

[MCP](https://modelcontextprotocol.io/)-сервер, который даёт кодинг-агенту строить граф концепций,
архитектуры и решений — и **помнить проект между сессиями**.

Индексатор — сам LLM. Никакого AST-парсинга и статического анализа: агент читает код, записывает
концепции своими словами и запрашивает их перед следующими задачами. В графе хранятся **концепции** —
фичи, модули, паттерны, решения, — а не символы кода. Всё лежит в SQLite проекта:
`.megamemory/knowledge.db`.

---

## Что изменилось в форке

| Область | Upstream 1.6.2 | Этот форк |
|---|---|---|
| Идентификаторы | slug вырезает всё вне `[a-z0-9-]`: кириллица, CJK, греческий, эмодзи схлопываются в `""`, второй такой узел теряется | Unicode-слаг: буквы любого алфавита, диакритика снимается только после латиницы/кириллицы/греческого/иврита (дакутэн катаканы и хангыль сохраняются), `/` → `-`, вывод в NFC, hash-фолбэк для имён из эмодзи, суффикс `-<hash8>` при коллизии |
| Эмбеддинги | `all-MiniLM-L6-v2`, только английский, размерность зашита | по умолчанию `Xenova/multilingual-e5-small` (`MEGAMEMORY_EMBED_MODEL`), префиксы e5 `passage:`/`query:`, размерность берётся из модели, при смене модели векторный поиск отключается до `megamemory reembed` |
| Поиск | только косинус | гибрид: FTS5 + вектор через RRF, у каждого попадания `via: vector \| fts \| both`, санитизация запросов для `MATCH`, маршрутизация коротких CJK-запросов, опциональный trigram-индекс, LIKE-фолбэк по `name_norm` |
| Контекст | `understand` отдаёт всё найденное | по умолчанию `mode: "compact"` с лимитом `max_tokens` (1500), summary обрезается до 240 символов, рёбра — только между возвращёнными узлами, `meta.returned / dropped / tokens_estimated` |
| Актуальность | либо удалить, либо никак | `status` (`active`/`superseded`/`deprecated`), рёбра `supersedes` и `contradicts`, устаревшее скрыто из ответов, но видно в графе |
| Дубли | только ручной merge | `megamemory consolidate` находит пары с близостью эмбеддингов ≥ 0.95 и сливает их с переносом рёбер |
| Большие модули | каждый ребёнок читается отдельно | `digest`-узлы: один на модуль, пересобирается после 5-го ребёнка, пониженный вес в поиске |
| Переносимость | только БД | `megamemory export --md <dir>` — по файлу на узел (frontmatter + wiki-ссылки), `--check` для CI |
| Видимость цены | нет | каждый `understand` / `list_roots` / `get_concept` измеряется; агрегаты за 7 дней в `megamemory stats`, `/api/stats` и панели **Tokens** в explorer |
| Миграция | — | `megamemory migrate --dry-run/--apply` обновляет базу upstream на месте, аддитивно, с бэкапами и совместимостью вниз |

---

## Цикл работы

`understand → работа → update`

1. **Начало сессии** — агент вызывает `list_roots` (с бюджетом), чтобы сориентироваться.
2. **Перед задачей** — `understand` с запросом на естественном языке или `get_concept` по точному id.
3. **После задачи** — `create_concept` / `update_concept`, затем `link` для связей.

---

## Установка

Нужен Node.js >= 18. Для чисто русских проектов подойдёт значительно меньшая модель (`cointegrated/rubert-tiny2`, 312-мерная) после конвертации в ONNX; модель выгружается после 5 минут простоя (`MEGAMEMORY_EMBED_IDLE_MS=0` отключает выгрузку), а `MEGAMEMORY_SEARCH=fts` не загружает её вовсе. Модель эмбеддингов (~120 МБ, мультиязычная) скачивается при первом
запуске и кешируется в `~/.cache/huggingface`.

Установка глобально из npm:

```bash
npm install -g @bloodyeagle/megamemory
```


Или скачайте tarball из GitHub Releases (без сборки):

```bash
npm install -g ./megamemory-1.6.3-fork.3.tgz
```
Или сборка из чекаута (для разработки):

```bash
git clone https://github.com/BloodyEagle/MegaMemoryAgent.git
cd MegaMemoryAgent
npm ci
npm run build
npm pack                      # bloodyeagle-megamemory-1.6.3-fork.3.tgz
npm install -g ./bloodyeagle-megamemory-1.6.3-fork.3.tgz
```

Дальше — либо установщик, либо регистрация MCP-сервера руками:

```bash
megamemory install            # интерактивно: opencode / [CC] / Codex / Antigravity
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

Сервер читает `.megamemory/knowledge.db` относительно рабочей директории; путь переопределяется
через `MEGAMEMORY_DB_PATH`.

### Обновление существующей базы upstream

```bash
megamemory migrate --dry-run    # печатает план, ничего не меняет
megamemory migrate --apply      # бэкап knowledge.db.bak-<ts>, аддитивная миграция схемы
megamemory reembed              # нужен только если сменилась модель эмбеддингов
megamemory doctor               # проверка здоровья, код выхода 1 при проблемах
```

Миграция не удаляет и не переименовывает столбцы, поэтому upstream v1.6.2 открывает
мигрированную базу. Узлы, потерянные в upstream из-за пустых id, восстановить нельзя —
`--dry-run` честно их показывает.

---

## MCP-инструменты

| Инструмент | Что делает |
|---|---|
| `understand` | Гибридный поиск по графу. `top_k`, `max_tokens`, `mode: "compact" \| "full"`, `include_inactive`. |
| `get_concept` | Точный поиск по id: дети, рёбра, входящие рёбра, родитель. |
| `create_concept` | Новая концепция с рёбрами, ссылками на файлы и `supersedes`. |
| `update_concept` | Обновление полей; эмбеддинг пересчитывается. |
| `link` | Типизированная связь между концепциями. |
| `remove_concept` | Мягкое удаление с причиной; история сохраняется, статус `deprecated`. |
| `list_roots` | Корневые концепции с детьми (с бюджетом). |
| `list_conflicts` | Неразрешённые конфликты merge и пары `contradicts`. |
| `resolve_conflict` | Разрешение конфликта проверенным содержимым. |

**Типы узлов:** `feature` · `module` · `pattern` · `config` · `decision` · `component` · `digest`

**Типы связей:** `connects_to` · `depends_on` · `implements` · `calls` · `configured_by` · `supersedes` · `contradicts`

---

## CLI

| Команда | Назначение |
|---|---|
| `megamemory install` | Настроить MCP-клиент |
| `megamemory serve [--port N]` | Веб-обозреватель: граф, поиск, карточки узлов, панель Tokens, вкладка consolidate |
| `megamemory migrate [--dry-run\|--apply]` | Обновить базу upstream |
| `megamemory repair-ids [--apply]` | Пересобрать пустые id и id с хвостовым `/` |
| `megamemory reembed` | Пересчитать эмбеддинги (прерываемо, пакетами) |
| `megamemory doctor` | Проверка: схема, модель, FTS, id, векторы, осиротевшие рёбра, digest |
| `megamemory stats` | Статистика графа и токенов |
| `megamemory eval` | recall@10 по `fixtures/eval.jsonl` |
| `megamemory consolidate [--dry-run\|--apply]` | Поиск и слияние почти одинаковых узлов |
| `megamemory digest [--apply]` | Сборка и пересборка digest-узлов |
| `megamemory export --md <dir> [--check]` | Markdown-экспорт и проверка расхождений для CI |
| `megamemory merge`, `conflicts`, `resolve` | Двусторонний merge графов между ветками |

---

## Переменные окружения

| Переменная | По умолчанию | Значение |
|---|---|---|
| `MEGAMEMORY_DB_PATH` | `./.megamemory/knowledge.db` | Путь к базе |
| `MEGAMEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Модель эмбеддингов (любая ONNX-модель transformers.js) |
| `MEGAMEMORY_SEARCH` | `hybrid` | `hybrid` / `fts` / `vector` |
| `MEGAMEMORY_FTS_TOKENIZER` | — | `trigram` добавляет второй индекс для CJK |
| `MEGAMEMORY_AUTO_DIGEST` | включено | `0` отключает автосборку digest после 5-го ребёнка |

---

## Веб-обозреватель

```bash
megamemory serve --port 8080
```

- узлы раскрашены по типу, размер — по числу рёбер; `digest` и устаревшие (`superseded`) визуально отличаются
- рёбра `supersedes` — пунктиром, бейдж статуса в карточке узла, тумблер «показывать устаревшие»
- у результатов поиска бейдж `via` (vector / fts / both) и строка бюджета: `N nodes, ~X tokens, dropped M` · `saved ~Z vs full`
- панель **Tokens**: средний размер ответа и сэкономленные токены за 7 дней
- вкладка **Consolidate**: кандидаты-дубликаты с кнопкой применения
- чекбоксы фильтра по типам узлов (с сохранением), счётчик видимых, кнопка **export bundle** и `download .md` в карточке
- чип **Health**: векторы, синхронность FTS, digest, пустые id, сироты, память — с подсказками
- карточка digest показывает исходные концепции, бейдж `stale` и переключатель **focus**
- режим **status changes** в таймлайне; в карточке узла — последние смены статусов с причинами

---

## Тесты

```bash
npm run build
npx vitest run src/__tests__/id-generation.test.ts --reporter=dot     # целевой прогон
npx vitest run                                                       # всё (долго: скачивание модели)
```

`fixtures/demo.db` — готовый граф (ru/en/zh/эмодзи, один `superseded`, один `digest`, пара дублей)
для ручной проверки в обозревателе.

---

## Совместимость и ограничения

- Upstream v1.6.2 работает с мигрированной базой: у новых столбцов есть `DEFAULT`, FTS-триггеры
  поддерживают индекс при вставках upstream. Бэкапы `knowledge.db.bak-<ts>`, хранятся 3 последних.
- FTS5 требует локального файлового режима libsql — MegaMemory локальная; удалённый Turso
  виртуальные таблицы запрещает.
- После любого `VACUUM` нужен `megamemory migrate --apply` — пересборка FTS (rowid не гарантированы).
- Русский текст FTS5 `unicode61` не стеммит; компенсирует векторный канал, помогают префикс-запросы.

---

## Авторы и лицензия

Основа — [MegaMemory](https://github.com/0xK3vin/MegaMemory), автор 0xK3vin (MIT).
Форк поддерживает [BloodyEagle](https://github.com/BloodyEagle). MIT, см. [LICENSE](./LICENSE).
Отличия и порядок синхронизации с upstream: [docs/FORK.ru.md](./docs/FORK.ru.md) (english: [docs/FORK.md](./docs/FORK.md)).