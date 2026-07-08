# Limitations

Known limitations of the `anki` virtual table and the tooling around it. Most are
**by design** — inherent to SQLite's virtual-table interface — rather than bugs. This is a
living document; add to it as new constraints surface. Deferred *work* (things we intend to
build) lives in [TODO.md](TODO.md); this file is the honest list of what currently can't be done.

## Virtual-table limitations (SQLite-imposed)

These are enforced by SQLite itself, before the anki module is ever consulted — no extension can
change them:

- **No indexes.** `CREATE INDEX … ON <anki_table>` fails with *"virtual tables may not be
  indexed"* (SQLite `build.c`, at statement-compile time). `MATCH` uses the HNSW index, not a SQL
  index; relational filters scan the shadow. Indexing the shadow table directly *works* but is
  manual and internal — a vtab-managed shadow index is a [TODO](TODO.md) follow-up.
- **No triggers.** `CREATE TRIGGER … ON <anki_table>` is rejected.
- **No schema alterations.** `ALTER TABLE <anki_table> ADD COLUMN …` (and friends) are blocked.
- **No foreign keys.** FKs can't be declared on the vtab, and FK cascades would modify the shadow
  table *behind* the vtab and desync its in-RAM cache. (FK enforcement is off by default in
  browser SQLite anyway.)
- **`DEFAULT` is ignored.** SQLite does not apply a virtual table's declared column defaults, and
  `xUpdate` can't tell an omitted column from an explicit `NULL` — so an omitted column that has a
  `DEFAULT` comes back `NULL`.

## Constraints

Column constraints **are** enforced — a deliberate choice (SQLite doesn't forbid a vtab from
enforcing them; FTS5 rejects some as its own policy). They ride on the real shadow table:

- **Enforced (greenfield):** `UNIQUE`, `CHECK`, `NOT NULL`. The declared column type flows into
  the shadow `CREATE TABLE`, and every write routes through the shadow via `xUpdate`. The SQL
  conflict clause is honored — `INSERT OR REPLACE` replaces, `INSERT OR IGNORE` skips, plain
  `INSERT` rejects (via `sqlite3_vtab_on_conflict`).
- **A single-column `PRIMARY KEY` becomes `UNIQUE` on the shadow.** The shadow's own rowid,
  `anki_id INTEGER PRIMARY KEY`, is the table's sole `PRIMARY KEY` (SQLite allows one), so a user
  `id INTEGER PRIMARY KEY` is stored `id INTEGER UNIQUE` (uniqueness still enforced; `AUTOINCREMENT`
  dropped). The `anki` vtab keeps its own rowid — a user PK column is an ordinary unique column, not
  the rowid.
- **Not expressible:** table-level constraints — multi-column `UNIQUE`, `PRIMARY KEY(a, b)`,
  table-level `CHECK`. The `USING anki(col …)` DSL is per-column only.
- **`DEFAULT`:** see above (a vtab limitation).

## Import & Vectorize

When you **vectorize** a table, it becomes an `anki` vtab and inherits all of the above:

- **Carried:** `NOT NULL`, single-column `UNIQUE`/`PRIMARY KEY`, and column-level `CHECK` —
  reconstructed from the source schema (`PRAGMA table_info`/`index_list`, and the `CREATE TABLE`
  DDL for `CHECK`) and re-declared on the vectorized table, where they enforce via the shadow.
  (Column `CHECK` is skipped for a table with a reserved-name rename, since the expression may
  reference the old column name.)
- **Dropped:** indexes, triggers, foreign keys, `DEFAULT`, and **table-level** constraints
  (multi-column `UNIQUE`/`PK`, table-level `CHECK`) — the `anki(col …)` DSL is per-column, and the
  rest are vtab limits.
- **Kept:** **plain-copied** tables (not vectorized) keep everything — their original
  `CREATE TABLE` (constraints + FKs), plus replayed secondary indexes and triggers.

For constraint-heavy tables you still want searchable, the intended path is the companion-table
strategy (keep the original table plain, vectorize into a companion) — see [TODO.md](TODO.md).

## Storage format

- **Format v3, no migration.** A database written by an older build fails to open with a
  *"rebuild required"* error; re-import or rebuild it. Pre-1.0, we don't ship migrations.
- **Reserved `anki_` prefix.** User column names can't start with `anki_` (the shadow uses
  `anki_id` / `anki_emb_<col>`). Greenfield: rejected at `CREATE`. Import: an inline rename is
  offered for `anki_*` columns on a vectorized table.

## Model

- **One model per module instance.** The first `Embedder::load` wins; the embedding dimension is
  a property of the loaded model. Switching models needs a fresh module instance.
- **Panics abort the instance.** The release profile is `panic = "abort"`; a panic on the
  load/inference path aborts the whole wasm instance rather than returning a clean error.

## See also

- [TODO.md](TODO.md) — deferred work and performance/RAM follow-ups (HNSW incremental insert,
  int8 quantization, streaming embeddings, session-level embedding cache, …).
- [streaming-storage.md](streaming-storage.md) — the WASM-RAM design that shapes several of these.
