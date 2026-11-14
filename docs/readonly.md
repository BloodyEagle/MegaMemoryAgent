# Read-only database access

Which commands protect the source `knowledge.db`, how snapshot dry-runs differ
from a read-only `KnowledgeDB`, and what happens on a schema mismatch.

## Access matrix

| Command/path | Source database | Other writes and exact boundary |
|---|---|---|
| `megamemory export --md <dir>` | read-only (`PRAGMA query_only = ON`) | Writes rendered markdown unless `--check` is used. `--check` only reports missing, differing, and extra `.md` files; it never deletes them. |
| `megamemory eval` | read-only | JSONL is parsed and structurally validated before the database opens. |
| `megamemory conflicts` | read-only | Inspection only. `merge` and `resolve` are separate writing commands. |
| `megamemory stats --funnel --json` without `--prune` | read-only | This exact scripted mode only. Plain `stats`, non-JSON funnel output, or any `--prune` path opens RW. |
| `megamemory expire` without `--apply` | read-only | Validates every ID and prints the replacement expiry. `--apply` opens RW and atomically rechecks, updates the whole batch, and appends one strict timeline entry. |
| `megamemory migrate --dry-run` (also the default without `--apply`) | source unchanged | Takes a coherent `VACUUM INTO` snapshot, including committed WAL frames; runs the real apply path on the disposable copy; fingerprints source main + `-wal` before/after. |
| `megamemory repair-ids --dry-run` (also the default without `--apply`) | source unchanged | Uses the same snapshot/fingerprint boundary and plans on the copy. |
| test access below `MEGAMEMORY_FIXTURES_DIR` | read-only only | The test guard rejects an RW `KnowledgeDB` open before a connection is created. |

A snapshot dry-run is not a reusable transaction or a promise about a later
process. It emits no CAS token. If the source fingerprint is stable, the CLI may
say `nothing written`; if a concurrent writer changed main or WAL, it warns instead.
A later `migrate --apply` recomputes against current state. A later
`repair-ids --apply` recomputes its plan and applies it atomically, failing closed
if a target is now occupied, a rename is stale, or descendants remain unresolved.
Full and automatic migration likewise refuse/roll back instead of stamping success
while unresolved descendants remain.

The following paths are RW even when the requested high-level operation looks
read-only:

- plain `stats` and `bench` record usage telemetry; `stats --prune` writes by
  definition;
- `doctor` opens RW and migrates an old fork schema;
- `consolidate` and `digest` dry-runs currently construct an RW `KnowledgeDB`, so
  opening can migrate or run one-time hygiene even though the planned domain
  operation is not applied;
- `serve` and the MCP server write usage/timeline and run startup hygiene;
- `migrate --apply`, `repair-ids --apply`, `expire --apply`, `reembed`,
  `resolve`, and other apply/write operations mutate their documented target;
- `merge` reads its two inputs through read-only connections but publishes a new
  output (the first input by default), so it is not a non-writing command.

Commands such as `help`, `--version`, and `guide` do not open a database.
`install` edits client profiles rather than `knowledge.db`.

## Exact scope of `MEGAMEMORY_ALLOW_AUTO_MIGRATE`

`MEGAMEMORY_ALLOW_AUTO_MIGRATE=1` is checked only by
`openReadonlyOrExplain`, which is used by **`export`, `eval`, and `conflicts`**.
For those three commands only, exact value `1` replaces the protected read-only
open with an ordinary RW `KnowledgeDB` open for that process.

It does **not** affect:

- `stats --funnel --json`;
- dry-run `expire`;
- `migrate --dry-run` or `repair-ids --dry-run`;
- fixture protection;
- `serve`, MCP, or any command already using RW access.

Do not confuse it with `MEGAMEMORY_AUTO_MIGRATE`. The latter is consulted only
by MCP startup hygiene: exact value `0` skips the full upstream-conversion/ID-
repair path and runs additive schema setup instead. `serve` does not consult that
flag. Neither flag makes a raw upstream v1.6.2 database safe to open normally:
such a database has an existing `nodes` table with `PRAGMA user_version = 0`, so
an RW constructor rejects it with `UPSTREAM_SCHEMA_V0`; run
`megamemory migrate --apply --db "<path>"` explicitly.

## Schema mismatch on a read-only access

The actual schema compatibility version is **`PRAGMA user_version`**, currently
14. `meta.schema_version` is a different value: the fork-conversion marker
(`"1"` pending, `"3"` completed), not schema v1/v3 and not a compatibility
check.

A read-only connection cannot migrate, so it fails explicitly:

- `SCHEMA_TOO_OLD_READONLY` — `user_version < 14`. The error prints
  `megamemory migrate --apply --db "<path>"`; make a copy when the database is a
  fixture/reference file. Only `export`, `eval`, and `conflicts` add the optional
  `MEGAMEMORY_ALLOW_AUTO_MIGRATE=1` escape-hatch hint.
- `SCHEMA_TOO_NEW_READONLY` — `user_version > 14`. Update the package; an
  auto-migration environment variable cannot make an old build understand a
  future schema.
- `DB_CORRUPT_READONLY` — `PRAGMA quick_check` failed. No migration hint is
  printed because migration does not repair corruption; restore a backup.
- `DB_MISSING_READONLY` — the path does not exist.

## Why the demo database is read-only

`fixtures/demo.db` is a reference file whose bytes are pinned by
`fixtures/sha256sums.txt`. Any RW open can change it through migration, WAL, or a
deferred checkpoint even when the caller intended only to read. Copy it before
using an RW path.

With libsql 0.5.x, constructor options `readonly: true` and `fileMustExist` are
not the enforcement boundary. `KnowledgeDB` checks existence itself and sets
`PRAGMA query_only = ON` before read-only work; writes then fail with
`SQLITE_READONLY`. It also avoids persistent RW PRAGMAs such as switching the
journal to WAL. The snapshot dry-run uses a separate SQLite `VACUUM INTO` read of
the source and writes only the temporary destination.
