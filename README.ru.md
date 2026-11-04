<p align="center">
  <h1 align="center">MegaMemory <sub><sup>форк</sup></sub></h1>
</p>
<p align="center">Граф знаний проекта для кодинг-агентов — мультиязычный, экономный по токенам, видимый в интерфейсе.</p>

<p align="center">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="version" src="https://img.shields.io/badge/version-2.1.4-orange?style=flat-square" />
</p>

<p align="center">
  <img src="./assets/preview.png" alt="Веб-обозреватель MegaMemory" width="800" />
</p>

> **Форк [0xK3vin/MegaMemory](https://github.com/0xK3vin/MegaMemory) v1.6.2 (MIT).**
> Форк npm-пакета [`megamemory`](https://www.npmjs.com/package/megamemory), публикуется как `@bloodyeagle/megamemory`.
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

## Провенанс

Решение стоит столько, сколько стоит его источник. Граф держит эту связь
явной и проверяемой машиной.

**Опоры (`informed_by`)** — «from материально опирается на to»: решение
указывает на факт, тест, лог или диалог, из которого оно выведено. Рационал
обязателен: ребро `informed_by` с пустым `description` отклоняется — и в
`link`, и в батче `create_concept`. Граф опор — строгий DAG: ребро, замыкающее
цикл, отвергается. Циклы, принесённые merge, идут в карантин: компонента
закрыта для записи, видна в `weak_links` с `needs_merge: true`, а `in_paths`
сквозь неё честно отдаёт `null` вместо выдуманного числа.

**Шорткат `evidence`** — опоры объявляются в том же вызове `create_concept`,
отдельный `link` не нужен:

```json
{ "evidence": [
    { "ref": "src/auth/session.ts#L42", "why": "таймаут прочитан из кода" },
    { "node": "req-session-ttl", "why": "требование фиксировало TTL" }
] }
```

На элемент — ровно одно из `ref` (файл; узел, уже цитирующий его,
переиспользуется, иначе создаётся узел-факт) или `node` (существующая
концепция), плюс обязательный `why`. Автовывод опор из `why` + `file_refs`
существует, но **выключен по умолчанию** (`provenance.auto_ground` в
`megamemory.config.json` рядом с базой) — опоры, придуманные сервером, не
должны выдавать себя за объявленные агентом.

**Строгий режим** — `provenance.require_support: true` отклоняет `decision`
без единой опоры: ни `evidence`, ни ребра `informed_by`, ни (при включённом
автовыводе) выведенных опор. Текст отказа говорит передать `evidence` в том
же вызове — опора «добавлю потом» отклоняется намеренно: к следующему вызову
источник вывода утерян. Флаг читается заново на каждом вызове
(`megamemory.config.json` рядом с базой; переопределение переменными
окружения `MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT` / `MEGAMEMORY_REQUIRE_SUPPORT`,
`1|0`). Другие типы узлов, `link` и чтение флаг не трогает.

**`provenance_trace` / `provenance_audit`** — обход `informed_by` в одну
сторону: `ancestry` («на чём стоит этот вывод») или `impact` («кто на него
опирается»). Контракт полноты честно сообщает, чего он не показал:
`total_within_depth` считает узлы в пределах `depth`; причина остановки —
`truncated_by: depth | nodes | scan | null`; `in_paths` — число путей в
показанном подграфе, с потолком и пометкой (`in_paths_capped`) вместо
преувеличения; бюджет сканирования `max_scan_nodes` (по умолчанию 5000)
ограничивает и выдачу, и работу (`total_exact: false` при срабатывании).
Слабые звенья идут первыми — refuted/abandoned, цикловые компоненты, рёбра
без рационала, решения с `no_support` / `missing_support` / только
`ungrounded`-опорами (числовые `count` и `sample` — первые ≤ 5 id) — а весь
блок `weak_links` ограничен 8 КБ с маркером `weak_links_truncated`.

**Гигиена удаления** — удаление узла, на который опираются другие, отклоняется
с подсказкой, называющей зависимые узлы; `force` переопределяет. Удаления
оставляют надгробия, и в merge надгробие ребра побеждает живую копию —
разорванная связь не воскресает от того, что вторая ветка о ней не знала.

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
npm install -g ./megamemory-1.7.0-fork.1.tgz
```
Или сборка из чекаута (для разработки):

```bash
git clone https://github.com/BloodyEagle/MegaMemoryAgent.git
cd MegaMemoryAgent
npm ci
npm run build
npm pack                      # bloodyeagle-megamemory-1.7.0-fork.1.tgz
npm install -g ./bloodyeagle-megamemory-1.7.0-fork.1.tgz
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

**Свежесть инструкций.** `install` ставит в каждый сгенерированный файл штамп
`<!-- megamemory:instructions vX.Y.Z -->`. Сервер сверяет штамп со своей
версией на каждом вызове `list_roots` / `understand` и отдаёт
`instructions_stale` / `instructions_version` / `server_version` прямо в
ответе — после `npm update -g` перезапустите `megamemory install`, когда флаг
вернулся `true` (агент stderr не видит, поэтому сигнал едет в полезной
нагрузке, которую он и так читает).

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
| `provenance_trace` | Обход `informed_by` (`ancestry` / `impact`) с честной полнотой и слабыми звеньями в начале. |
| `provenance_audit` | Аудит провенанса по всему графу: слабые звенья, необоснованные решения, ретеншн прошлых аудитов. |

**Типы узлов:** `feature` · `module` · `pattern` · `config` · `decision` · `component` · `digest`

**Типы связей:** `connects_to` · `depends_on` · `implements` · `calls` · `configured_by` · `supersedes` · `contradicts` · `informed_by`

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
| `MEGAMEMORY_D3_URL` | `/vendor/d3.min.js` | Источник D3 для explorer; укажите URL CDN, чтобы грузить его извне вместо локальной копии |

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