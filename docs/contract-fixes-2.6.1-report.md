# План 23 — локальная приёмка контрактных исправлений 2.6.1

Дата: 2026-11-16. База: `origin/main = 2785075a34e865988f14989b3cd0ce8c65ce288e`.
Ветка: `release/2.6.1`. Версия пакета: `2.6.1`, схема БД: `14`.

Это отчёт **локальной и PR-приёмки**: локальный полный набор, packaged smoke и PR CI подтверждены; выпуск в npm и CI main после мержа не выполнялись.
Отправка ветки `release/2.6.1` и один non-draft PR в `main` выполнены по разрешению владельца; результаты push/PR/CI приведены ниже. Авто-мерж, approve, мерж, тег, GitHub Release и npm-публикация остаются запрещены без отдельного разрешения.
Файл `docs/project-audit-2.6.0-2026-11-16.md` оставлен нетронутым и не включён в коммиты по разрешённому исключению из проверки чистого дерева.

## Регрессии: падение до исправления и результат после

Числа ниже — реально выполненные узкие прогоны, а не сумма уникальных тестов: соседние наборы пересекаются.
Все узкие прогоны ограничены `--maxWorkers=1`, кроме явно названного контроля provenance с тремя воркерами.

| ID | Потребительский тест / существующий файл | До исправления | После исправления |
|---|---|---|---|
| A01 | `aggregate-history.test.ts`: `merge carries buildDigest v2 through the source reader (remap=%s)`; legacy membership; unknown version rejection | 3 failed / 5 passed: v2 `sources is not iterable`, неизвестный формат принимался | 8/8; соседние aggregate/provenance/digest 43/43 |
| A02 | `support-revisions.test.ts`: `merge keeps artifact confirmations and full history metadata (remap=%s)`; `merge deduplicates the full journal including %s` | 6 failed / 9 passed: терялись digest/actor-поля и склеивались ревизии | 15/15; соседние history/support/artifact 83/83 |
| A03 | `p05-edge-conflict-contract.test.ts`: `re-merge cannot refresh the CAS pin after %s changed`; immutable pin и повторные identity remaps | 7 failed / 3 passed: stale resolve проходил после re-merge, pins переписывались | 10/10; соседние merge/provenance/conflict/history 77/77 |
| A04 | `freshness.test.ts`: unobserved record, общая changed-сводка, частичное собственное покрытие, смешанные repo pin | 4 failed / 31 passed: неверные fresh/stale_input и чужие наблюдения | 35/35; итоговый freshness после A10/A11/A16 62/62 |
| A05 | `audit-K-03-wire-budget.test.ts`: `A05 MCP %s final wire fits all metadata, delta and unchanged or explicitly refuses`; batch final-wire/continuation; epoch 257 | 7 failed: oversize wire, неверная финальная оценка, epoch без ограничения | 4 suites / 70 passed; oracle включает continuation и mixed missing-id batch |
| A06 | `audit-K-03-wire-budget.test.ts`: `A06 MCP wrapper resumes a budget-truncated batch using only its continuation` | второй MCP-вызов давал ошибку «токен пакета» | 4 suites / 60 passed |
| A07 | `expire-versioned.test.ts`: `A07: версионный отчёт не допускает неполные или противоречивые pins` | 7 failed / 1 контрольный passed: apply без claim/status/expiry/removal pin, пустые pins и дубликаты | expire-versioned + expire-cli 33/33; после A09 34/34 |
| A08 | `audit-K-03-wire-budget.test.ts`: evidence why/file_refs drift; issued-card rationale drift | 3 failed: continuation принимал изменившуюся проекцию | 4 suites / 63 passed |
| A08, review | `A08 MCP batch continuation inherits token neighbor width and rejects explicit mismatch` | continuation без лимита раскрыл двух детей вместо одного; width20 не отвергался | regression passed; MCP+batch narrow 21 passed; изменение имени выданного ребёнка → version_conflict |
| A09 | `expire-cli.test.ts`: `полный stdout CLI парсится как один JSON-документ` | `Unexpected non-whitespace character after JSON` | expire suites 34/34 |
| A10 | `freshness.test.ts`: `A10: $label — adapter и freshness соблюдают locator.file` | 3 failed / 4 passed: единственный другой файл, несколько вне пути, утечка чужих candidates | P2.2 17 passed |
| A11 | `freshness.test.ts`: malformed rdeps и valid complete/incomplete controls | 11 failed / 5 passed: неизвестная форма принималась как пустой полный граф | P2.2 33 passed; отдельный consumer зависимости passed |
| A12 | `stats-funnel.test.ts`: understand до окна, верхняя граница, window/all | 3 failed / 16 passed | 19/19 |
| A13 | `telemetry-report.test.ts`: invalid/missing/non-string/empty timestamp | 4 failed / 13 passed | 16/16 после объединения двухсессионных кейсов; DB fixture удалена, suite переведён в unit |
| A14 | `telemetry-report.test.ts`: independent token/cost axes, mixed coverage, explicit zeros, invalid axes | 8 failed / 16 passed | 24/24 |
| A15 | `audit-B03-sse-fingerprint.test.ts`: внешний writer → description-only → SSE → реальный VM consumer; provenance-only/null reset | не было edge_updated после внешнего UPDATE description | 2 SSE suites / 8 passed |
| A16 | `freshness.test.ts`: same-second node ref; inplace artifact ref; inplace passport params; external UPDATE между чтениями | 4 failed / 58 passed: lookup возвращал пустой список | 62/62, повтор после усиления race assertion 62/62 |
| R01 | `migration.test.ts`: CLI v0/v3 original backup с duplicate edges и committed WAL; SDK callback до write; backup failure | 4 failed: backup уже содержал мигрированную схему/данные | 9 scoped suites / 97 passed; type-only annotation fix повторно 4/4 |
| R01, review | `auto-migrate.test.ts`: actual MCP/serve startup v3 backup; MCP opt-out; raw-upstream reject; fresh/healthy repeat; failure до write | 3 failed / 2 passed: startup backup после constructor migration или отсутствовал | auto-migrate 14/14 + соседние routing/schema-repair/fresh 25 passed |
| R02 | `install-profile-contract.test.ts`: mocked rename всех 12 managed destinations, instructions append/legacy/versioned, fsync failure | 15 failed / 1 passed (старый Codex atomic control) | 4 install suites / 54 passed |
| R02, review | resolved-target publication и fchmod-before-fsync; реальные symlink и POSIX mode/umask cases | 3 portable regression failed | 57 passed / 7 platform skips в 4 install suites |

### Существенные исправления

- Merge сохраняет digest envelope v1/v2 и все исторические поля; неизвестные форматы и устаревшие unresolved CAS-пины отклоняются атомарно. Identity-only remap не обновляет содержательное `applied`.
- Freshness квалифицирует каждую запись по своим observations/ref/repo pin; fingerprint и entries строятся из одного readonly SAVEPOINT с SHA-256 содержимого индексируемых входов.
- V2 expire требует полного pin выбранных строк и точного ids↔pins; stdout JSON не содержит инструкции.
- MCP continuation реально маршрутизируется, сохраняет каноническую проекцию и ширину токена; final wire-fit учитывает metadata/delta/continuation. Epoch ≤256.
- Usage/стоимость считаются по независимым осям и явным denominators; невалидное время — malformed. Funnel считает только события `[from,to)`.
- SSE замечает rationale/provenance-only updates и инвалидирует поставляемый consumer без изменения preview→apply CAS.
- Backup защищает CLI, deferred SDK и автоматический MCP/serve startup до pending writes. Installer публикует sibling temp → fsync → close → rename в real target, сохраняет symlink и восстанавливает existing permissions после write.

## Блок D и результаты полного набора

Сохранены fixture/readonly guards, migration/FTS/rollback, CAS/tombstones/remap, векторы и конкурентные писатели, Host/Origin/CSP/DOM, packaged runtime и UTF-8/Windows проверки.

- `telemetry-report` переведён в unit; удалена неиспользуемая БД, объединены два двухсессионных кейса без потери wall/count/p50/p95 assertions.
- Include/exclude используются из одного экспортируемого контракта Vitest; nightly проверяет тот же default suite и обязательный build.
- `journal-kind` проверяет реальный MCP `tools/list`: description и enum create/update; 8/8 passed.
- Source и compiled HTTP/SSE adapters используют общий lifecycle; actual `dist/index.js` сохранён. Ошибки startup закрывают child; SIGKILL ожидает close, relative paths разрешаются от owned cwd.
- Полный прогон №1: `npm test -- --run --maxWorkers=3`, **199 suites: 195 passed / 4 failed; 1950 tests passed / 13 failed / 2 skipped**, 391,74 с.
  - 12 падений: несовместимость HTTP fixture ownership/path и SSE early release. Устранены с сохранением guards и security assertions.
  - 1 таймаут: подготовка provenance 10k/20k star индивидуальными коммитами. Изолированный baseline прошёл, но seed занимал 45,810 с из 46,855 с. Транзакционный batch прежних write paths сократил seed до 12,318 с; размеры и 60-секундный timeout сохранены, добавлены DB cardinality assertions. Изолированный контроль workers=3: 6/6, star 6,642 с.
- Полный прогон №2: та же команда, **199 suites: 198 passed / 1 failed; 1978 tests passed / 1 failed / 9 skipped**, 351,39 с.
  - Единственное падение: `audit-K-03-wire-budget.test.ts` cleanup `EBUSY wire.db`. Детерминированный lifecycle guard выявил удержанные SDK callbacks/schemas и process-spies до удаления фикстуры; одного исправления порядка освобождения было недостаточно. Временная WeakRef-диагностика показала завершение native finalizers после explicit disposal, но чистая GC barrier не дала стабильности: sequential narrow 39 passed, parallel narrow 47 passed / 1 EBUSY. Итоговое исправление перевело только этот suite на реальный stdio-процесс MCP с ограниченным lifecycle; бюджетный oracle проверяет тот же настоящий wire. Полный прогон №3 подтвердил исправление под нагрузкой.
- HTTP/security scoped gate после исправлений: **13 suites / 73 tests passed**; final security 11/11; test typecheck exit 0.
- Финальный MCP stdio lifecycle: **31/31** при одном воркере; paired MCP/board/batch parallel narrow — **48/48** при трёх воркерах, без cleanup warnings. Guard проверяет закрытие child до удаления фикстуры, пустые proxy refs и неизменность parent env/cwd/argv. Последний typecheck-tests — pass.
- Полный прогон №3 на `7849a0c`: `npm test -- --run --maxWorkers=3` — **199/199 suites passed, 1980 tests passed, 9 skipped (1989 total)**, 294,86 с, exit 0. Posttest fixture guard: `OK — эталонные хеши сходятся, сайдкаров нет`. Код во время прогона не изменялся. В старых libsql suites остаются предупреждения о cleanup временных каталогов; failures отсутствуют, предупреждения не выдаются за отсутствующие.

Журнал полного успешного прогона: `C:/Users/KuninAA/AppData/Local/Temp/zcode-bash-6b249k/sess_776cda7b-488f-4720-ad99-f279b26641b6/call_ZLQaXSlUospsT1WXlYBUVKYX-stdout.log`.

## Windows loopback: согласованный тройной контракт

Пользователь отдельно одобрил проверку свойства bind вместо обязательного `ECONNREFUSED`:
1. Положительный loopback TCP+HTTP контроль.
2. Непустая OS listener table, каждый адрес только `127.0.0.1`/`::1`; wildcard/Ethernet — падение; PID сверяется при наличии.
3. Реальная негативная попытка по external IPv4 с жёстким 1,5-секундным deadline; `connected` — падение, refused/timeout/error:<code> — отдельные явные исходы, не подмена друг другом.

Наблюдение: **win32; listener `127.0.0.1:7823`, owner PID 42220; loopback TCP connected, HTTP 200; Ethernet `192.168.185.232` → timeout**, также два vEthernet адреса → timeout. Причина timeout неизвестна. Windows/Linux парные oracle-тесты отвергают `0.0.0.0`, `::`, Ethernet и пустую таблицу. Windows не пропускается.

## Защищённая фикстура: локальный CRLF-дрейф

До восстановления:
- HEAD SHA-256: `03b0ac84509fd6fc2b2c96c2c4dc06e2b8d67bf314b646fbc2b04d81cceac032`.
- Worktree SHA-256: `71e96d0e43a26be85b8fbcbdec59f6a5e39ef24f51be2303185519278270ada6`.
- Побайтно проверено: **единственное отличие — 25 CRLF → LF**.

С отдельного разрешения владельца blob извлечён напрямую `git cat-file blob HEAD:fixtures/eval.jsonl > fixtures/eval.jsonl`, без checkout/eol-фильтров. `sha256sums.txt` не изменялся.

Git stat refresh также выполнен с отдельного разрешения; blob индекса до/после одинаковый: `5b70bf06ef8aec98a1154ac72007d9a3f8d3695e`. Первичный refresh дал needs-update, subsequent porcelain=v2/v1 пуст; размер stat-кэша и файла 1770, mode 644. `core.fileMode=false`, `core.autocrlf=true`.

`git log -1 -- .gitattributes`: `6be983f`, 2026-11-15T16:03:04+03:00. Точная причина старого worktree CRLF не установлена: старый checkout или последующая запись остаются гипотезами.

Свежий локальный клон с `core.autocrlf=true` проверен отдельно: `i/lf w/lf attr/-text`, CRLF=0, эталонный SHA-256, guard зелёный. Дефект `.gitattributes` не воспроизведён.

Финальный повтор guard после прогонов: `fixtures-guard: OK — эталонные хеши сходятся, сайдкаров нет`; `git status --porcelain fixtures/` пуст.

## Версия, упаковка и ограничения

- `metadata v2.6.1`: pass; package/lock root engines совпадают, Node ≥20.10.0.
- `npm run build`: pass; `npm run typecheck:tests`: pass.
- CHANGELOG записан перед `chore(release): 2.6.1`, обновлены оба бейджа и обе пары tarball-примеров.
- `node scripts/package.mjs <isolated staging>`: **pass**, 278 entries, manifest `@bloodyeagle/megamemory@2.6.1`.
- Smoke упакованного расклада: `--version`, `--help`, `guide --workflow` побайтно, `stats` на копии `demo.db` — pass. Зависимости перенаправлены в локальный node_modules; **это не npm-install dependency check**.
- Tarball: `bloodyeagle-megamemory-2.6.1.tgz`, 945316 байт, SHA-256 `eed8827dab2ae06261de4da0be4dded62d435fc190bed7d46e2d7462be8fc338`.
- Реальные file-symlink cases: 6 пропусков из-за Windows EPERM; POSIX permissions case: 1 пропуск на Windows. Portable runInstall realpath/fchmod consumer проверки прошли. Ещё 2 прежних пропуска зависят от наличия `AGENT_SKILLS_ROOT` для README-контрактов. Итого локальный полный набор имеет 9 skips; это не девять чисто платформенных пропусков. В Linux CI skills checkout и права symlink/umask отличаются, поэтому CI count сверяется отдельно.
- Нормативная рекомендация `journal`: не использовать изменчивые журналы как опоры решений; технический запрет не введён по решению владельца.

## Укладка истории и внешняя приёмка

Fixup-коммиты уложены в коммиты находок. Tree до/после совпадает: **`a273deb2870f753ffc60d3e315ec24164b9f4e95`**, содержимое не менялось. Укладка выполнена неинтерактивно в отдельном candidate, затем release ref обновлён CAS: `7849a0c832ec1f3f72a1ea3bb2ad96c0a90cf943` → `067f78c245752fc73ee604388c64928f66ad3e93`. История содержит **25 коммитов**: ровно по одному на A01–A16/R01–R02, тесты в тех же коммитах, плюс отдельные test/docs/release-коммиты. A05/A08 совместные фрагменты адаптированы вручную; остальные группы применились без конфликтов. Авторы и committers — Alexey Kuninin `<kuninaa@evolenta.ru>`.

Резервная ветка `backup/2.6.1-presquash` сохранена на исходном HEAD; detached candidate `C:/p/MegaMemoryAgent-261-candidate-20261116` сохранён чистым. `main` остался `2785075a34e865988f14989b3cd0ce8c65ce288e`. Отдельное исключение для argv-subprocess с `cwd` candidate разрешено владельцем; навигация выполнялась штатными token-economy scripts, без другого поиска.

После укладки узкий набор MCP/continuation и recovery/installer-контрактов прошёл: **5 suites, 105 tests passed, 7 platform skips**, 41,10 с, `--maxWorkers=3`; metadata v2.6.1 — pass. Полный локальный прогон не повторяется: tree побайтно тот же, что у зелёного full №3.

Ветка отправлена в GitHub, создан non-draft [PR №40](https://github.com/BloodyEagle/MegaMemoryAgent/pull/40), `release/2.6.1 → main`; autoMergeRequest — null, approve не выставлялся. Первый PR run [43902477819](https://github.com/BloodyEagle/MegaMemoryAgent/actions/runs/43902477819): `event=pull_request`, `head_sha=38f2c0b8becf68b2ff3c43449f4cfa62ad60e407`, name `CI`, path `.github/workflows/ci.yml`, created/updated различаются; `/jobs.total_count=3`.

Первый CI результат: Windows runtime 20.10.0 — success (packaged smoke), Windows dev 22 — success (strict types, **9 unit suites / 90 tests passed**); Linux source 22 — failure только на `schema-repair.test.ts` A2 cleanup `waitUntilGone` (временный файл остаётся после close). Full Linux: **199 suites: 198 passed / 1 failed; 1988 tests passed / 1 failed, 1989 total, skips=0**, 108,90 с. Разница с локальными 1980 passed / 9 skipped объясняется выполнением всех девяти локальных пропусков: 7 symlink/permissions cases и 2 README/bench cases с `AGENT_SKILLS_ROOT`. Файлы не исключались. Причина cleanup разбирается в релизной ветке; первый красный run не выдаётся за зелёный.

Причина cleanup локализована: закрытая raw libsql-БД и statement остаются в async test frame во время ожидания удаления. Новые два parameterized lifecycle guards (успех/ошибка callback) реально падали до scoped helper и прошли после синхронного `try/finally` close + выхода из raw frame; проверяются настоящие native WeakRefs только через primitive predicates. Production не меняется, no-write/FTS/schema assertions и timeout не ослабляются. Проверки исправления: schema-repair **14/14**, параллельный schema-repair/auto-migrate/MCP набор **59/59** с `--maxWorkers=3`, после type-only сигнатуры close guard **2/2**, strict test typecheck — pass. Прежние предупреждения cleanup в старых suites остаются и не выдаются за отсутствующие. Следующий full total ожидается **1991**: прежние 1989 + два новых lifecycle guards.

Повторный PR run [43906795103](https://github.com/BloodyEagle/MegaMemoryAgent/actions/runs/43906795103) — **success**: `event=pull_request`, `head_sha=c40a11dab0a6e5130c07c2f71b9b20b3d44e4332`, name `CI`, path `.github/workflows/ci.yml`, created `2026-11-16T16:22:39Z`, updated `2026-11-16T16:25:12Z`. Подтверждены ровно три реальных завершённых джоба: Linux `source (22)`, Windows `platform-windows (20.10.0, runtime)`, Windows `platform-windows (22, dev)` — все success.

Linux full: **199/199 suites, 1991/1991 tests passed, skips=0**, 92,72 с; schema-repair **14/14** за 1465 мс, posttest fixture guard — OK. Linux targeted gate **4 suites / 74 tests passed**; eval recall@10 **0.800 (20/25) ≥ 0.8**. Числа сверены: 1991 = 1980 локально passed + 9 локальных skips, исполненных в CI + 2 новых lifecycle guards. Файлы не исключены. Оба Windows matrix jobs прошли предусмотренные им lint/typecheck/build/metadata и runtime smoke либо unit gate; matrix-skipped этапы относятся к разделению runtime/dev, а не пропускам Linux full.

CI на исходной main был success для `2785075a…`; после мержа CI не проверялся, потому что мерж не разрешён. Push release не запускает workflow: в `ci.yml` push-фильтр только `main`/`feat/**`; использован настоящий PR-trigger. Последующее добавление этого CI-отчёта — документальный коммит без изменения production/tests; финальный CI головы PR сверяется отдельно в описании PR.

Мерж/авто-мерж/approve, тег/Release/npm dist-tags/time/blob, чистая установка из реестра и doctor опубликованного пакета не выполнены: отдельного разрешения на выпуск нет, 2.6.1 пока не опубликован.
