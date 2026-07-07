# Streaming storage for `anki` vector tables

**Status:** design / not yet implemented.
**Related:** [`query-planning.md`](./query-planning.md), [`hybrid-filtering.md`](./hybrid-filtering.md), [`DESIGN.md`](./DESIGN.md).

## Context / problem

An `anki` virtual table today **materializes its entire contents into WASM linear
memory** when a connection first opens it. `xConnect` calls `load_all`
(`crates/anki-core/src/vtab.rs`), which runs `SELECT … FROM <table>_data ORDER BY id`
and copies every row — **all columns *and* the embeddings** — into an in-memory
`BTreeMap<i64, Row>`, then builds an in-RAM HNSW index per vector column
(lazily, on the first `MATCH`).

Consequences:

- **RAM grows with rows × columns**, and WASM linear memory is capped (~2 GB
  practical on this wasm32 build). A 20-column table with one `VECTOR` column holds
  **all 20 columns in RAM even though search only needs the embedding** — for wide
  tables the non-vector cells can dwarf the vectors.
- **Slow open + memory spike:** opening the DB (which the explorer forces by reading
  schema) pays the full `SELECT *` load; the first `MATCH` pays a full HNSW build.
- Embeddings are already persisted (as blobs) and reloaded on open — so this is a
  *reload*, not a re-embed, but it is still a full materialization.

The essential in-RAM footprint for vector search is only **rowid + embedding +
HNSW graph**. Everything else is a cache that duplicates what already lives on disk
in the shadow table.

**Goal:** hold only the essentials in RAM; serve everything else from the shadow
table on demand via SQLite's own page-on-demand machinery — **without changing the
query surface** (`WHERE col MATCH …`, the `/exact` `/hnsw:N` DSL, hidden
`<col>_score`, WHERE + MATCH semantics).

**Non-goals (separate efforts, not this doc):** incremental HNSW insertion (see the
project memory note), int8/vector quantization (complementary — stacks on top),
persisting the HNSW graph to disk (complementary), per-import model switching.

## How it works today (recap)

The layering is: a **virtual table** (the interface you query) → a **shadow table**
(real on-disk SQLite storage) → an **in-RAM cache + HNSW index**.

- `CREATE VIRTUAL TABLE customers USING anki(name TEXT, notes TEXT VECTOR)`:
  - `sqlite3_declare_vtab` announces the **typed** schema of `customers` to SQLite
    (`build_declare`): `"name" TEXT, "notes" TEXT, "notes_score" REAL HIDDEN`
    (the `VECTOR` keyword is stripped; a hidden score column is appended). This is a
    *description* — it creates no table, but it is what SQLite uses to reason about
    queries, **including type affinity and `COLLATE`**.
  - A **real** shadow table is created with ordinary SQL (`build_ddl` via
    `sqlite3_exec`): `CREATE TABLE customers_data(id INTEGER PRIMARY KEY, c0, c1, e1 BLOB)`.
    Its columns are **typeless** (`c0, c1, …`) — values round-trip verbatim, but the
    declared types/collations are **not** carried into storage.
- **Load:** `xConnect` → `load_all` → whole shadow table into `st.rows` (all cells +
  embeddings); `index_dirty = true`.
- **Read:** `xBestIndex` claims constraints (pushdown); `xFilter` scans `st.rows`
  in RAM; `xColumn` serves values **from the in-RAM cells**.
- **MATCH:** `xFilter` embeds the query once, then either HNSW (single MATCH, no
  filter) or exact cosine over the pre-filtered rows.
- **Write:** `xUpdate` embeds vector columns, write-through to the shadow table,
  updates the in-RAM cache, sets `index_dirty`.
- **Pushdown correctness (today):** MATCH constraints get `u.omit = 1` (fully handled
  by us); relational filters get `u.omit = 0` (SQLite re-checks — our pre-filter only
  *narrows*); a filter whose collation we can't reproduce is left **unclaimed** so
  SQLite evaluates it entirely (`vtab.rs` `x_best_index`). This is the correctness
  contract the redesign must preserve — see `hybrid-filtering.md`.

## Why typeless storage is fine today, and why it must change

Typeless `c{i}` columns are safe **only because we never compare on them.** We only
`INSERT` into and bulk-`SELECT *` from the shadow table — storing and reading raw
bytes needs no affinity or collation. All *comparison* happens against the **typed
declared schema**, done by SQLite (for `omit=0` filters) or by our in-RAM
`cell_passes` (which carries the collation).

The redesign pushes the `WHERE` **down onto the shadow table** (`SELECT id FROM
customers_data WHERE …`). The moment we compare on shadow columns, their typelessness
bites: `c3 = 'active'` on a typeless column runs **BINARY, blob-affinity** and would
disagree with a declared `stage TEXT COLLATE NOCASE`. So the shadow table must become
**type-full**.

## The redesign

Three coupled changes, each independently shippable in the order below.

### 1. Type-full shadow table (foundation)

Store shadow columns with their **real declared names, types, and collations**
instead of typeless `c{i}`:

```sql
-- before
CREATE TABLE customers_data(id INTEGER PRIMARY KEY, c0, c1, e1 BLOB);
-- after
CREATE TABLE customers_data(
  id INTEGER PRIMARY KEY,
  "name"  TEXT,
  "notes" TEXT,                        -- the vector column's source text
  "stage" TEXT COLLATE NOCASE,         -- declared type + collation preserved
  e_notes BLOB                         -- embedding blob for the vector column
);
```

Consequences:

- A plain `WHERE stage = 'active'` on the shadow table is **automatically correct**
  (right affinity + collation) and **indexable**.
- Column identity is by declared name (quoted), not positional `c{i}`.
- **Affinity caveat to verify:** typeless columns preserve values *exactly*; typed
  columns apply SQLite affinity on write (e.g. `INTEGER` affinity coerces text `'5'`
  → integer `5`). This matches what the declared vtab column already promises, so it
  is *correct*, but it is a behavior change from today's verbatim storage — call it
  out and test round-tripping for each affinity (esp. mixed-type values and `BLOB`).

**Migration:** existing DBs have typeless `c{i}` shadow tables. Per the pre-1.0
"clean changes, no back-compat shims" rule, we change the storage format outright and
require affected DBs to be **rebuilt/re-imported** (Import & Vectorize already does a
rebuild, so this is a natural path). Guard it: record a **storage-format version** in
`anki_meta`; on open, if the on-disk format predates type-full storage, fail with a
clear "rebuild required" error rather than silently misreading.

### 2. RAM holds essentials only (drop the cell cache — "Option A")

`load_all` changes from "load everything" to **load rowid + embeddings only**:

```sql
SELECT id, e_notes[, e_<other vector cols>] FROM customers_data ORDER BY id;
```

- `st.rows` no longer stores `cells` — only the per-row embeddings (keyed by rowid),
  which feed cosine + the HNSW build.
- `xColumn` no longer reads from an in-RAM cell; it **reads the requested column from
  the shadow table on demand**, by rowid — a prepared, reused point-lookup
  (`SELECT "<col>" FROM customers_data WHERE id = ?`). This is exactly how SQLite
  serves any plain table; the shadow table's own B-tree + page cache absorb it.
- RAM footprint drops to **rowid + embeddings + HNSW graph**. For the 1-of-20
  example, ~19/20 of the row bytes leave RAM.

No query-surface change: results are identical, just sourced from disk.

### 3. Filter via SQL on the shadow table (get candidate rowids)

When a query has a relational `WHERE` alongside (or without) a `MATCH`, evaluate the
filter **in SQLite against the type-full shadow table** instead of against in-RAM
cells:

1. `xBestIndex` claims the pushable filters as today (still leaving unreproducible
   ones unclaimed).
2. `xFilter` builds a **prepared** `SELECT id FROM customers_data WHERE <preds>` from
   the claimed constraints (typed columns → correct affinity/collation for free),
   binds the RHS values, and steps it to collect the candidate rowid set.
3. For those rowids, cosine their embeddings (from RAM), apply the 0.5 threshold,
   rank. `xColumn` then serves output columns from the shadow table (change 2).

This is the *same "pre-filter → exact cosine over survivors" shape the code already
uses* for the filtered path — only the filter now runs in SQLite (correct, complete,
indexable) rather than against a hand-rolled in-RAM `cell_passes`.

### Search-path matrix (unchanged semantics)

| Query | Path |
| --- | --- |
| single `MATCH`, no `WHERE` | HNSW over all embeddings in RAM (or exact if `/exact`) — **unchanged** |
| `MATCH` + `WHERE` | shadow-SQL filter → candidate rowids → **exact** cosine over those embeddings |
| multiple `MATCH` (AND) | as today: exact cosine per matched column over the (filtered) candidates |
| `WHERE`, no `MATCH` | shadow-SQL filter → return rowids; `<col>_score` NULL |

**Broad-filter caveat:** with a `WHERE` that passes most rows, "exact over survivors"
approaches a full exact scan and loses HNSW's speed. That is acceptable and matches
today's behavior (a filter already forces the exact path). A true *filtered-ANN*
(traverse the HNSW graph skipping non-passing nodes) is a possible future
optimization, explicitly out of scope here.

**DSL behavior to document explicitly:** `/hnsw` combined with a `WHERE` filter falls
back to exact-over-filtered (HNSW is bypassed when filtering). `/exact` is always
exact. This is current behavior, made explicit.

## Correctness

### The false-+/- risk shifts category: semantic → mechanical

Today's false-positive/negative risk exists **because `cell_passes` is a hand-rolled
Rust reimplementation of SQLite's comparison rules** (affinity, collation,
int-vs-real, NULLs). Any gap in that reimplementation is a wrong pre-filter — which is
exactly why `hybrid-filtering.md` insists the pre-filter be *conservative*.

This redesign **deletes `cell_passes`.** The comparison is done by **SQLite itself**,
evaluating a prepared statement on the typed shadow table — the reference
implementation. So the whole class of "did we implement `NOCASE`/affinity/… correctly?"
bugs **goes away.** What remains is *not* semantic but **mechanical translation**: did
we build the *right* `WHERE`?

- map the constraint to the right shadow column and operator;
- **reproduce the exact collation SQLite would apply** to that constraint
  (`sqlite3_vtab_collation`), not merely the column's declared collation;
- bind the RHS value into the correct `argv` slot;
- and the load-bearing invariant: the **shadow column's declared type + collation
  must exactly mirror the virtual column's**, because our prepared statement evaluates
  in the shadow table's context and only matches SQLite's evaluation if that context
  is identical.

These are few, mechanical, and directly testable by parity tests — a much smaller and
more tractable surface than reimplementing comparison semantics.

### `omit` policy

- **MATCH** stays `u.omit = 1` (we fully own it) — unchanged.
- **Relational filters** stay `u.omit = 0`. In this design `omit = 0` is
  *belt-and-suspenders*: since SQLite performs the comparison in *our* pass too, our
  candidate set should already equal SQLite's, so the re-check normally drops nothing.
  Its only job is to catch a **translation** bug — and only in the safe direction. The
  one invariant to protect:

  > Our shadow filter must never be **stricter** than SQLite — a superset (or exact) is
  > safe (SQLite drops the extras); a subset is not (`omit = 0` re-checks only rows we
  > *return*, so a row we wrongly dropped is gone for good — a silent false negative).

  With types/collations mirrored exactly, "stricter" essentially can't happen except
  via a translation bug, which the parity tests catch.
- Filters whose collation we cannot reproduce stay **unclaimed** (SQLite does them end
  to end) — unchanged. Type-full storage + explicit `COLLATE` lets us reproduce *more*
  of them; user-defined collations still require the collation to be registered on the
  connection to be usable in the shadow query.
- **Future optimization (deferred, risky):** once we can prove exact parity for a
  claimed filter, we *could* set `u.omit = 1` to skip the re-check. Not in the initial
  change — it removes the safety net and needs exhaustive affinity/collation/NULL
  parity testing.

### Compound queries and joins

Correctness is preserved because we only ever push what we can reproduce, and SQLite
does the rest:

- **`OR`** is never offered to a vtab (the constraint array is a *conjunction*), so
  `WHERE a OR b` is applied entirely by SQLite on our output — we never see it. Same as
  today.
- **`LIKE` / `GLOB` / function expressions** (`lower(x)=…`) aren't in our pushable-op
  set → left **unclaimed** → SQLite handles them end to end.
- **ANDed comparisons** (`amount>10 AND amount<100`) are each pushed and reproduced in
  the shadow `WHERE`; SQLite evaluates them.
- We can only ever *under-claim*, never silently mishandle — anything unclaimed is
  SQLite's.

The one **join subtlety** is the RHS: in `… JOIN … WHERE c.stage = a.col`, the
constraint's right-hand side is a **runtime value from the other table**, delivered
per-iteration in `xFilter`'s `argv`. We must **bind the `argv` value SQLite hands us**,
never resolve it ourselves. With that, joins are correct.

The real join cost is **performance, not correctness** — see the perf notes: `xFilter`
can be called **once per outer row**, so the shadow-SQL filter (and the query
embedding) would repeat per iteration.

## Writes (`xUpdate`) in the new model

- Still embed vector columns and **write-through** to the shadow table (now typed
  columns + embedding blob).
- In-RAM update is now **only the row's embedding** (not cells). Non-vector column
  edits just write to the shadow table — there is no in-RAM cell to update.
- `index_dirty` handling unchanged (HNSW rebuilt lazily on next MATCH; incremental
  HNSW is the separate optimization).

## Performance notes / trade-offs

We are trading **RAM for I/O + latency** — the general tax of streaming, made steeper
by OPFS (sync-access-handle reads are slower than native mmap, and point-lookups are
random reads).

- **Filter query:** a full (streamed) scan of the shadow table unless the filtered
  column is indexed. Consider creating indexes on frequently-filtered columns
  (auto-create? user-driven? — open question). SQLite's page cache keeps hot pages
  resident across queries.
- **`xColumn` point-lookups:** one small read per output column per result row; reuse
  a prepared statement, and lean on SQLite's page cache. For a top-k result set this
  is k lookups, not N.
- **Embeddings stay in RAM** (not streamed). They are on the hot path for every MATCH
  and are the smallest essential structure; streaming them (holding only the HNSW
  graph, reading vectors from disk during traversal — "Option B") is a further step,
  deferred, and only worthwhile at very large N.
- **Joins re-enter `xFilter` per outer row.** In `… JOIN … WHERE anki.col = other.col
  AND anki.vec MATCH …`, SQLite may call `xFilter` once per outer row, so the
  shadow-SQL filter *and* the query embedding would repeat each iteration. Mitigate by
  reusing the prepared filter statement and **caching the query embedding** across
  iterations that share the same `MATCH` argument. This cost exists today too; it's
  just more visible once the filter is a SQL round-trip.

## Phasing

1. **Type-full shadow table** + storage-format version guard (foundation; no
   query-behavior change beyond the affinity note).
2. **Drop the cell cache**, `xColumn` reads on demand (RAM win, identical results).
3. **Filter via shadow SQL**, retire the in-RAM `cell_passes` pre-filter path (keep
   `omit = 0`).
4. *(Optional/future)* index filtered columns; consider `omit = 1` parity
   optimization; stream embeddings (Option B); quantization; persist HNSW graph.

## Testing

The existing correctness suites are the specification and **must keep passing** —
`hybrid-filtering`, collation (`NOCASE`/`RTRIM`), int-vs-real pushdown fidelity, the
`<col>_score` behavior, transactions/rollback resync. Add:

- **Parity:** shadow-SQL filter results == today's in-RAM pre-filter results across
  operators, collations, affinities, NULLs (this is the *mechanical-translation* check
  — the semantic comparison is now SQLite's).
- **Join RHS:** a pushed equality whose RHS is a column from the joined table
  (`… JOIN … WHERE anki.stage = other.col`) returns identical rows — verifies we bind
  the per-iteration `argv` value, not a stale/self-resolved one.
- **Never-stricter:** for every pushed predicate, the shadow filter's row set is a
  superset-or-equal of SQLite's (no false negatives), including `OR`/`LIKE`/function
  predicates that must stay unclaimed.
- **Affinity round-trip:** every declared affinity round-trips through the type-full
  shadow (incl. mixed-type values and `BLOB`).
- **RAM:** a wide table (few vector cols, many/large non-vector cols) shows the cell
  data is no longer resident.
- **Migration guard:** opening a pre-format DB fails with the clear "rebuild required"
  error.

## HNSW graph cache (storage format v5)

The streaming redesign keeps only rowid + embeddings + the HNSW graph in RAM, and the
graph is *rebuilt* from the `anki_emb_<col>` blobs on the first `MATCH` after open —
an O(N) CPU spike. Format **v5** removes that spike by persisting the built graph:

- A second shadow table, **`<name>_anki_hnsw(col TEXT PRIMARY KEY, graph BLOB)`**, one
  row per vector column, is created at `xCreate` (up front, so persisting later never
  needs schema-changing DDL).
- **What's stored is topology only** — adjacency lists, entry point, levels — *not* the
  vectors, which already live in `anki_emb_<col>` and are rehydrated on load. Tombstoned
  (deleted) nodes are compacted out during serialization, since their vectors are gone
  from the shadow. The blob carries its own version tag, independent of `storage_format`.
- **When:** persisted in `xSync`, inside the committing transaction, so the cache is
  durable and rolled back atomically with the data. Each write marks the cache stale; at
  commit we re-serialize the live graph, or clear the cache when there's nothing
  trustworthy to save (post-rollback, or a `REPLACE`/`IGNORE` that moved rows behind the
  vtab's back). Invariant: **after any commit the stored graph reflects committed data or
  is absent — never stale-but-present.**
- **On open:** `xConnect` loads it after `load_all`; a successful all-or-nothing load
  skips the rebuild. Any miss — no cache, a missing column, a corrupt/stale blob, or a
  referenced rowid whose vector is gone — falls back to the existing rebuild-on-first-
  `MATCH` path. The deserializer is fully bounds-checked and allocation-bounded, so a
  corrupt blob can only yield "rebuild", never a panic (fatal under `panic = abort`).

Complements incremental insertion: writes keep the in-RAM graph fresh (~O(log N)),
persistence avoids the cold rebuild on the next open. Together: never a full rebuild in
the steady state.

## Open questions

- Index management for filtered shadow columns — automatic, heuristic, or explicit?
- Do we ever want to stream embeddings too (Option B), or always keep them resident?
- Custom/user-defined collations in the shadow query — require registration; how to
  detect and fall back cleanly (today: leave unclaimed).
- Migration UX — hard-fail + re-import, or an in-place one-time rebuild of the shadow
  table on open?
