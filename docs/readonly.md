# Read-only database access

Which commands open `knowledge.db` read-only, what to do on a schema
mismatch, and why the reference demo database must not be written.

## Which commands open read-only

| Command | Mode |
|---|---|
| `megamemory stats --funnel --json` | readonly (`PRAGMA query_only = ON`) |
| `megamemory migrate --dry-run` | readonly |
| test-suite accesses to `fixtures/*` | readonly + fixture guard (`MEGAMEMORY_FIXTURES_DIR`) |

Everything else that reads (`stats`, `export`, `eval`, `doctor`, `bench`)
opens the database for writing and auto-migrates an older schema in place.
`serve` and the MCP server write to the database themselves: usage and the
call journal (`timeline`) are recorded on every tool call — that journal is
what `stats --funnel` reads.

## Schema mismatch on a readonly access

A readonly connection cannot migrate the schema, so it fails with an
explicit error instead of reading with the wrong queries:

- `SCHEMA_TOO_OLD_READONLY` — the database is older than this build. Make a
  copy and run the printed command:
  `megamemory migrate --apply --db "<path>"` (run it on the copy; fixtures
  are regenerated with `scripts/make-demo-db.cjs`).
- `SCHEMA_TOO_NEW_READONLY` — the database was created by a newer version of
  megamemory (`user_version` is printed). Update the package.
- `DB_CORRUPT_READONLY` — `PRAGMA quick_check` fails; the migrate hint is
  deliberately withheld (migration does not repair a broken file). Restore
  from a backup.
- `DB_MISSING_READONLY` — the path does not exist.

## Why the demo database is read-only

`fixtures/demo.db` is a reference file: its bytes are pinned by
`fixtures/sha256sums.txt`, and any write — including the invisible ones from
an auto-migration or a deferred WAL checkpoint on process exit — changes
those bytes. That is why a readonly connection is the only legitimate way to
open it, and any real work happens on a copy. Note that libsql 0.5.x ignores
the constructor option `readonly: true` (and `fileMustExist`); the actual
guarantee is `PRAGMA query_only = ON`, set by the `KnowledgeDB` constructor
(see `src/db.ts`), verified by a probe and covered by tests.
