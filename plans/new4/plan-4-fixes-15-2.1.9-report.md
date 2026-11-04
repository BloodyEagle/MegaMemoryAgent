# Отчёт: план 2.1.9 (plan-4-fixes-15) — d3 в пакете и запрет опор-заглушек

Дата: 2026-11-05. Ветка `feat/2.1.9` от main, PR #16, merge d34ff14, релиз
v2.1.9 опубликован (npm latest: 2.1.9, publish.yml — success).

## F1. d3 поставляется с пакетом

- `web/vendor/d3.min.js` (v7.9.0, 279 708 байт, версия в комментарии первой
  строки) закоммичен; `package.json > files` уже включал `web/` целиком,
  `.npmignore` нет — файл поехал в tarball автоматически.
- Новый модуль `src/d3-asset.ts`: `resolveD3Src(existsFn)` возвращает
  `{src, source, note}`. Приоритет: `MEGAMEMORY_D3_URL` (env) → локальный
  `web/vendor/d3.min.js` (local) → CDN jsDelivr (cdn) с заметкой
  `d3: локальный файл не найден, используется CDN`, печатаемой при старте
  serve. Молчивого 404 больше нет.
- `/api/health` отдает `d3_source: "local" | "cdn" | "env"` (вынесено в
  экспортируемую `healthPayload(db)` в `web.ts` — тестируемо без запуска
  сервера); `doctor` печатает ту же строку проверкой `d3 asset`.

## F2. Опоры-заглушки не принимаются

- `src/stub.ts` — один предикат на всех потребителей:
  `STUB_SUMMARY_PATTERN = /file-fact node|provenance support|^file:\s/i`,
  отказ при длине < 80 без глагола-утверждения
  (`содержит|хранит|пишет|читает|считает|возвращает|блокирует|требует|
  кэширует|вызывает|помечает|отдаёт`). Kinds: `decision|feature|pattern|fact`
  (fact в схеме нет); `module` и `digest` исключены и в create-проверке, и в
  подсчёте.
- `createConcept` отказывает с текстом из плана до планирования опор;
  `allow_stub: true` (аргумент MCP-схемы `create_concept`) пишет узел с
  `epistemic_status = "stub"`. На оси эпистемии `stub` добавлен как значение
  с переходами `stub → open/validated/refuted/abandoned`; переход в `stub`
  извне (update_concept) невозможен — только через allow_stub при создании.
- Существующие заглушки не удаляются, а помечаются:
  - `weak_links` — новый тип `stub_support` (приоритет 9, между
    ungrounded_support и no_rationale): одна запись на решение,
    count/sample, срабатывает при ≥1 заглушке среди проверенных опор;
  - `provenance_trace.supports[]` — поле `quality: "stub" | "claim"` у
    каждой опоры (отсутствующий узел = "stub");
  - `stats` — строка `Stub supports: N` рядом с `Decisions w/ support`;
  - `doctor` — проверка `stub supports`.

## F3. Сниппет

В пункт 8 (Supports) добавлено: опора на файл — это
`evidence: [{ref: "src/x.ts:120-180", why}]`, не новый узел; узел-опору
создавай только для мысли, которую нельзя выразить ссылкой. Вычитать абзац
не пришлось: сниппет 47 → 49 строк (лимит 60).

## F4. Документация

- README ×2: строка про `MEGAMEMORY_D3_URL` в таблице Environment
  переписана (d3 идёт с пакетом, фолбэк на CDN с предупреждением), в разделе
  «Web explorer» добавлен пункт про офлайн-работу и `d3_source`; бейдж
  версии 2.1.7 → 2.1.9 (в фича-коммите, как заведено с 2.1.6).
- CHANGELOG: запись 2.1.9 (регрессия F1 с момента `{{D3_SRC}}`, запрет
  заглушек, сниппет).

## Попутное исправление: дефект 2.1.7 в supports[]

Контрольный прогон на чистом дереве (git stash -u) показал: два теста
`provenance.weaklinks-budget.test.ts` падали **ещё на HEAD 2.1.7** —
`supports[]` в `provenanceTrace` вызывал `db.getNode` и считал три sha256
на КАЖДУЮ живую опору, хотя отдаёт первые 50 (`SUPPORT_DIGESTS_CAP`):
на 20k-звезде 9900 лишних запросов (q10000=10207 против q100=307) и вылет
за 1200 мс (2428 мс). Исправлено: пары id/rationale сортируются, дайджесты
считаются только для возвращаемого окна, `supports_count` считается по
списку id без запросов. Прогон после фикса: delta=0, файл зелёный.

## Тесты

- Новых 17 (план требовал ≥16): `d3-asset.test.ts` — 7 (в т.ч. tarball через
  `npm pack --dry-run --json`), `stub-supports.test.ts` — 8 (тесты 7–14 из
  плана), `guide.test.ts` — 2 (тесты 15–16).
- Фикстуры: plan-правило «правится фикстура, не ассерт» выполнено — саммари
  в 8 тестовых файлах (create-concept, id-generation, informed-by.dag,
  provenance.record, provenance.require-support, status, support-baselines,
  support-revisions) переведены на утверждения (≥80 символов или
  глагол-утверждение); ассерты не ослаблялись, ни один ассерт не удалён.
  Единственная синхронизация ассерта: §9.17 support-baselines считает
  `claimDigestOf` от литерала саммари — литерал и вызов заменены одной
  строкой.
- Полный прогон `vitest run --exclude db.test.ts --maxWorkers=3`:
  572/573; единственный падёж — `digest.test.ts` «summary is capped at 800»
  по 5-секундному таймауту, в изоляции зелёный (известный флак). Также в
  изоляции перепроверены board и trail.fingerprint (зелёные).
- `tsc --noEmit` без ошибок; схема БД не менялась.

## Ручная приёмка веб-интерфейса

Первый прогон веб-интерфейса за историю форка.

- Копия живой базы `C:\p\MegaMemoryAgent\accept-219\knowledge.db`
  (VACUUM INTO из `.megamemory/knowledge.db`, 27 узлов, оригинал не тронут).
- `node dist/index.js serve --port 4399 --db …`: страница открывается, граф
  отрисован (узлы по типам, рёбра, подписи, панель Tokens, чип health: ok,
  Live-события). Скриншот: `plans/new4/serve-2.1.9-screenshot.png` (снят
  записью in-app браузера + кадр через ffmpeg: headless Chrome/Edge на этой
  машине зависают, IAB-скриншот-сурфейс падал по таймауту 3000 мс даже на
  about:blank).
- `/api/health`: `d3_source: "local"`; `<script src="/vendor/d3.min.js">`;
  GET /vendor/d3.min.js → 200, 279 708 байт.

## Повторный прогон на TwonkyGrabber3-копии

Копия `knowledge.db.accept-219.db` (VACUUM INTO, оригинал не тронут;
порт 4321 держал посторонний serve из глобальной установки — работа шла на
отдельном порту, его не трогали).

- `stats`: **`Stub supports: 8`** — ровно как в плане; `Decisions w/
  support: 2`.
- `provenance_trace`: обе решения дали по записи `stub_support` с count=3
  (6 заглушек под двумя решениями, все опоры в supports[] — `quality:
  "stub"`). Остальные 2 заглушки висят под `pattern`-узлом: weak_links
  проверяет опоры только у решений (та же область действия, что у
  missing_support/ungrounded_support), в суммарном счётчике stats они есть —
  поэтому ровно 8.
- `doctor`: `d3 asset — local web/vendor/d3.min.js`, `stub supports — 8
  support node(s) without a claim`.

## Релиз

- PR #16 → merge d34ff14 → тег v2.1.9 на merge-коммите → release published
  → publish.yml success.
- Реестр (curl packument с cache-buster, без учета лага CDN не сошёлся бы):
  `dist-tags.latest: 2.1.9`.
- Опубликованный tarball распакован: `package/web/vendor/d3.min.js` на месте
  (первая строка `// https://d3js.org v7.9.0 …`), `web/index.html` рядом.

## Отклонения от плана (зафиксировано)

1. Язык двух строк сниппета F3 — английский (сниппет целиком англоязычный);
   содержание — дословно из плана.
2. Текст отказа и заметка о CDN — на русском, как в плане.
3. Попутный фикс дефекта 2.1.7 в supports[] (выше) — вне плана, но без него
   невыполним критерий «прежние тесты зелёные».
4. Глаголы-утверждения — только русский список из плана; англоязычные
   короткие саммари проходят либо через длину ≥80, либо не проходят вовсе
   (в фикстурах удлинены).
