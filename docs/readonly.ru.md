# Доступ к базе только на чтение

Какие команды защищают исходный `knowledge.db`, чем snapshot-dry-run отличается
от readonly-`KnowledgeDB` и что происходит при несовпадении схемы.

## Матрица доступа

| Команда/путь | Исходная база | Другие записи и точная граница |
|---|---|---|
| `megamemory export --md <каталог>` | readonly (`PRAGMA query_only = ON`) | Без `--check` пишет отрендеренный markdown. `--check` только сообщает о недостающих, изменённых и лишних `.md`; он никогда их не удаляет. |
| `megamemory eval` | readonly | JSONL разбирается и структурно валидируется до открытия базы. |
| `megamemory conflicts` | readonly | Только просмотр. `merge` и `resolve` — отдельные пишущие команды. |
| `megamemory stats --funnel --json` без `--prune` | readonly | Только этот точный скриптовый режим. Обычный `stats`, funnel без JSON и любой путь с `--prune` открывают RW. |
| `megamemory expire` без `--apply` | readonly | Проверяет каждый id и печатает замену срока. `--apply` открывает RW и атомарно повторно проверяет, обновляет весь batch и добавляет одну строгую запись timeline. |
| `megamemory migrate --dry-run` (также по умолчанию без `--apply`) | источник не меняется | Делает согласованный снимок `VACUUM INTO` с закоммиченными WAL-фреймами; запускает настоящий apply-путь на одноразовой копии; сравнивает fingerprint source main + `-wal` до/после. |
| `megamemory repair-ids --dry-run` (также по умолчанию без `--apply`) | источник не меняется | Использует ту же границу снимка/fingerprint и строит план на копии. |
| тестовый доступ внутри `MEGAMEMORY_FIXTURES_DIR` | только readonly | Тестовый guard отклоняет RW-открытие `KnowledgeDB` до создания соединения. |

Snapshot-dry-run — не переиспользуемая транзакция и не обещание о следующем
процессе. Он не выдаёт CAS-токен. При стабильном fingerprint CLI может сказать
`nothing written`; если конкурентный writer изменил main или WAL, появляется
предупреждение. Поздний `migrate --apply` заново работает с текущим состоянием.
Поздний `repair-ids --apply` заново строит план и применяет его атомарно,
fail-closed отказывая, если target уже занят, rename устарел или потомки остались
unresolved. Полная и автоматическая миграции также отказывают/откатываются, а не
штампуют успех при оставшихся unresolved descendants.

Следующие пути — RW, даже если запрошенная верхнеуровневая операция похожа на
чтение:

- обычные `stats` и `bench` пишут usage-телеметрию; `stats --prune` пишет по
  определению;
- `doctor` открывает RW и мигрирует старую fork-схему;
- dry-run `consolidate` и `digest` сейчас создают RW-`KnowledgeDB`, поэтому само
  открытие может мигрировать или выполнить одноразовую hygiene-операцию, хотя
  запланированная доменная операция не применяется;
- `serve` и MCP-сервер пишут usage/timeline и выполняют startup-hygiene;
- `migrate --apply`, `repair-ids --apply`, `expire --apply`, `reembed`,
  `resolve` и другие apply/write-операции меняют документированную цель;
- `merge` читает два входа через readonly-соединения, но публикует новый выход
  (по умолчанию поверх первого входа), поэтому не является непишущей командой.

`help`, `--version` и `guide` базу не открывают. `install` меняет профили
клиентов, а не `knowledge.db`.

## Точная область `MEGAMEMORY_ALLOW_AUTO_MIGRATE`

`MEGAMEMORY_ALLOW_AUTO_MIGRATE=1` проверяется только в
`openReadonlyOrExplain`, который используют **`export`, `eval` и `conflicts`**.
Только для этих трёх команд точное значение `1` заменяет защищённое readonly-
открытие обычным RW-`KnowledgeDB` на время процесса.

Переменная **не** влияет на:

- `stats --funnel --json`;
- dry-run `expire`;
- `migrate --dry-run` и `repair-ids --dry-run`;
- защиту фикстур;
- `serve`, MCP и команды, уже использующие RW.

Не путайте её с `MEGAMEMORY_AUTO_MIGRATE`. Последнюю читает только startup-
hygiene MCP: точное `0` пропускает полную upstream-конверсию/ремонт id и вместо
неё запускает аддитивную настройку схемы. `serve` этот флаг не читает. Ни один
флаг не делает обычное открытие сырой базы upstream v1.6.2 безопасным: в ней уже
есть таблица `nodes`, но `PRAGMA user_version = 0`, поэтому RW-конструктор
отказывает с `UPSTREAM_SCHEMA_V0`; явно выполните
`megamemory migrate --apply --db "<путь>"`.

## Несовпадение схемы при readonly-доступе

Настоящая compatibility-версия схемы — **`PRAGMA user_version`**, сейчас 14.
`meta.schema_version` — другое значение: маркер fork-конверсии (`"1"` —
ожидается, `"3"` — выполнена), а не schema v1/v3 и не compatibility-check.

Readonly-соединение не может мигрировать, поэтому отказывает явно:

- `SCHEMA_TOO_OLD_READONLY` — `user_version < 14`. Ошибка печатает
  `megamemory migrate --apply --db "<путь>"`; для фикстуры/эталона работайте на
  копии. Только `export`, `eval` и `conflicts` добавляют подсказку об опциональном
  обходе `MEGAMEMORY_ALLOW_AUTO_MIGRATE=1`.
- `SCHEMA_TOO_NEW_READONLY` — `user_version > 14`. Обновите пакет; переменная
  автомиграции не научит старый билд понимать будущую схему.
- `DB_CORRUPT_READONLY` — не прошёл `PRAGMA quick_check`. Совет мигрировать не
  печатается: миграция не чинит повреждение; восстановите бэкап.
- `DB_MISSING_READONLY` — путь не существует.

## Почему демо-база только на чтение

`fixtures/demo.db` — эталонный файл, чьи байты закреплены в
`fixtures/sha256sums.txt`. Любое RW-открытие может изменить его миграцией, WAL
или отложенным checkpoint, даже если вызывающий хотел только читать. Перед RW-
путём снимите копию.

В libsql 0.5.x опции конструктора `readonly: true` и `fileMustExist` не являются
границей enforcement. `KnowledgeDB` сам проверяет существование и ставит
`PRAGMA query_only = ON` до readonly-работы; после этого записи падают с
`SQLITE_READONLY`. Также он не выполняет постоянные RW-PRAGMA вроде переключения
журнала в WAL. Snapshot-dry-run отдельно читает источник через SQLite
`VACUUM INTO` и пишет только временный destination.
