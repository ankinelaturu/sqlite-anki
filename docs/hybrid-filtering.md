# Hybrid filtering (relational `WHERE` + semantic `MATCH`)

**Status:** ✅ implemented (equality/range pushdown + pre-filter; collation-aware + exact numeric)
**Last updated:** 2026-06-29

## Outcome

Equality/range filters are pushed down and, when present, the vtab **pre-filters**
— it ranks only the rows passing the filter instead of ranking everything and
filtering after. This eliminates the post-filter recall cliff: a row that passes
the filter is never dropped because non-matching rows are more similar.

- `xBestIndex` claims `MATCH` (`omit=1`) plus `=,<>,<,<=,>,>=` constraints
  (`omit=0`, so SQLite still verifies — the pre-filter only has to *narrow*),
  encoding the plan into `idxStr`.
- `xFilter` evaluates the pushed predicates against the in-memory cache and, when
  a filter is present, brute-force ranks the surviving subset (no candidate cap →
  no cliff). With no filter it uses the HNSW path as before.
- Verified by `packages/wasm/test/hybrid-filtering.test.mjs`, including a cliff
  case: 3 `active` rows are all returned despite 300 more-similar `archived` rows.

Chosen trade-offs (see "Decisions" history): **in-memory** predicate evaluation
(not a shadow-btree query); **always** pre-filter when a pushable filter is
present (no selectivity heuristic yet); push down the six comparison ops only
(LIKE/GLOB/OR/functions stay post-filtered by SQLite, still correct).

### Still open
- Selectivity heuristic (fall back to HNSW for non-selective filters over very
  large tables — pre-filtering is correct there, just brute-force).
- Pushdown via the shadow btree's real indexes (for huge filtered sets).
- Multiple simultaneous `MATCH` columns (separate limitation).

## The query that matters

```sql
SELECT title FROM notes
WHERE status = 'active'          -- relational filter
  AND body MATCH 'revenue'        -- semantic search
ORDER BY similarity(body) DESC
LIMIT 10;
```

This is the "query + question" fusion — the single strongest reason to put
semantic search *inside* SQL instead of beside it. Getting it right is core to
the project's value, not a nice-to-have.

## The problem (post-filtering — what happened *before* the fix)

Originally, `xBestIndex` only claimed the `MATCH` constraint on the vector
column and **ignored** `status = 'active'`. When a vtab does not claim a
constraint, SQLite applies it itself, against each row the vtab emits. So
execution was:

1. `xFilter` runs HNSW → up to **256** candidates, sorted by similarity.
2. SQLite filters those 256 by `status = 'active'` (`xColumn` per row).
3. `ORDER BY` / `LIMIT` applied to what survives.

### Consequences

| Property | Status |
|----------|--------|
| Correctness | ✅ Fine — only `active` rows are returned. |
| Completeness | ❌ **Post-filtering recall cliff.** The 256 cap is applied *before* the `status` filter. If `active` rows are sparse among the top-256 semantic matches, you get far fewer results than exist — possibly zero — while good `active` matches sit at rank 257+. |
| Index acceleration | ❌ None. Virtual-table columns have no native btree index, so `status = 'active'` is always scan-and-filter. |

Concretely: `... WHERE status='active' AND body MATCH '...' ORDER BY similarity DESC LIMIT 10`
can return fewer than 10 rows even when 100 good `active` matches exist, because
only 256 candidates are produced before the filter runs.

This is the cost of the one-table DX choice. sqlite-vec's "normal `TABLE` +
`vec0`" split lets the planner use a real btree on `status` (and it added
metadata/partition columns to `vec0` for in-index pre-filtering). We traded that
for `text in / one table / no join`.

## Alternative not taken (shadow btree)

We evaluate predicates against the in-memory cache. A different option — kept for
the future, for very large filtered sets — is to push down to the shadow table
`<name>_data`, which is a **real SQLite btree table** we control (unlike an
in-memory ANN index):

- **Selective filter** → query the shadow btree first
  (`SELECT id FROM <name>_data WHERE status = 'active'`, index-accelerated),
  then vector-rank only that subset (brute force is cheap when the subset is
  small). Complete *and* fast.
- **Non-selective filter** → HNSW first, then post-filter (today's path). Good
  recall, fast.
- Choose pre- vs post-filter by estimated selectivity — what mature vector DBs
  do.

## Implementation (shipped)

1. `xBestIndex` claims `MATCH` (`omit=1`) and the comparison constraints
   `=,<>,<,<=,>,>=` on any column (`omit=0`, so SQLite still re-checks —
   the pre-filter only has to *narrow*). The plan (match column + each filter's
   column/op and argv slot) is encoded into `idxStr`.
2. `xFilter` parses `idxStr`, reads the right-hand values from `argv`, and:
   - **filter present** → pre-filter: iterate the in-memory cache, keep rows that
     satisfy the predicates (`cell_passes`, conservative on NULL/cross-type), and
     brute-force cosine-rank that subset. No candidate cap → no cliff.
   - **no filter** → the existing HNSW path.
   - **no MATCH** → a filtered scan (`similarity()` stays NULL).

Predicate evaluation is conservative — the next section explains exactly how the
pre-filter stays correct, and the two ways a naive comparison would silently drop
rows that belong in the result.

## Correctness: false positives vs. false negatives

The pre-filter is an **optimization layered on top of SQLite's own filtering**,
not a replacement for it. We claim each comparison constraint with
`aConstraintUsage[].omit = 0`, and the SQLite vtab docs are explicit about what
that buys us:

> "By default, the SQLite [core] generates bytecode that will double-check all
> constraints on each row of the virtual table to verify that they are satisfied."
> … setting `omit` "is only a hint and there is no guarantee that the redundant
> check … will be suppressed." — [sqlite.org/vtab.html](https://www.sqlite.org/vtab.html)

So SQLite re-evaluates every row `xFilter` emits. That creates a deliberate
**asymmetry** the pre-filter is built around:

- **False positive** — we *keep* a row that doesn't actually satisfy the
  predicate. **Harmless.** SQLite's double-check discards it. Our filter is
  allowed to return a *superset*; it only has to *narrow*.
- **False negative** — we *drop* a row that *does* satisfy it. **A correctness
  bug.** SQLite only re-checks rows we emit, so a row we never return is gone for
  good — it silently disappears from results.

Hence the governing rule: **when in doubt, keep.** `cell_partial_cmp` returns
"unknown" (→ `cell_passes` keeps the row) for any pair we won't evaluate the way
SQLite would — a `NULL` operand, or a cross-type pair. SQLite defines an order
for those (`NULL` < INTEGER/REAL < TEXT < BLOB, per
[datatype3](https://sqlite.org/datatype3.html)), but rather than reproduce it we
punt and let the double-check decide. Those become false positives — safe.

"Keep on doubt" only covers the cases we *decline* to judge. For the cases we
*do* decide — two numbers, or two text values — our comparison must match
SQLite's **exactly**, or we manufacture a false negative. Two places this bit us:

### 1. Text collation
SQLite picks the collation for a comparison as: explicit postfix `COLLATE`
(left operand wins) → a column's declared collation (left wins) → else `BINARY`.
The built-ins: **BINARY** = `memcmp`; **NOCASE** = binary but the 26 ASCII A–Z
are folded to lower case (`sqlite3_strnicmp`, ASCII-only — *not* Unicode);
**RTRIM** = binary but trailing spaces are ignored (all per
[datatype3](https://sqlite.org/datatype3.html)).

A plain byte compare on a `NOCASE` column would rank `'alice' = 'Alice'` as
*not equal* and **drop** the row — a false negative SQLite can't recover. Fix:
`xBestIndex` calls `sqlite3_vtab_collation(info, i)` for each pushed comparison
and

- **BINARY / NOCASE / RTRIM** → reproduced exactly in `collated_cmp` (the
  collation is carried through the `idxStr` token and `Filter` into
  `cell_passes`);
- **any other (custom/user-defined) collation** → **not claimed** — left
  unclaimed so SQLite evaluates it entirely. We refuse to pre-filter text we
  can't compare the way SQLite will.

### 2. Integer vs. real precision
SQLite compares an integer against a float numerically and exactly. Our old code
cast `i64 as f64` first, which rounds magnitudes past 2^53 — e.g.
`9007199254740993 > 9007199254740992.0` is true, but the rounded cast collapses
the left side to `2^53` and makes it false → dropped row. Fix: `cmp_int_real`
compares without the lossy cast (integer vs the float's `floor`, with the
fractional part breaking ties). Note: SQLite usually applies **NUMERIC affinity**
first — "If one operand has INTEGER, REAL or NUMERIC affinity and the other …
TEXT or BLOB or no affinity then NUMERIC affinity is applied to the other" — so
an integer-valued real RHS against an `INTEGER` column is coerced to an integer
(int↔int, already exact). The int↔real path stays live for columns with no/BLOB
affinity or non-integer reals.

### What gets pushed down

| WHERE term | Pushed? | Why |
|---|---|---|
| `=,<>,<,<=,>,>=` on numbers | ✅ | exact int/int, real/real, **int/real** |
| same on text, BINARY/NOCASE/RTRIM | ✅ | collation reproduced in `collated_cmp` |
| same on text, **custom collation** | ❌ | can't reproduce → SQLite evaluates it |
| operand is `NULL` / cross-type | kept (superset) | SQLite double-checks |
| `LIKE` / `GLOB` / `REGEXP` / `OR` / functions | ❌ | not claimed → SQLite evaluates |
| `MATCH` on a vector column | ✅ (`omit=1`) | *we* own it — SQLite can't re-check our operator, so we must be exact by construction |

`MATCH` is the one constraint we claim with `omit=1`: it has no relational
meaning SQLite could double-check, so correctness there is on us (we compute it).
Everything else rides on the omit=0 double-check as the safety net.

### Tested
- **Unit** — `crates/anki-core/src/vtab.rs` → `prefilter_tests`: `2^53+1`,
  `NaN`/±inf, NOCASE/RTRIM ordering, and NULL/cross-type "keep".
- **e2e** — `packages/wasm/test/pushdown-fidelity.test.mjs`: NOCASE/RTRIM and
  `2^53+1` through real SQL. This is the only layer that exercises
  `sqlite3_vtab_collation`, the `idxStr` round-trip, and SQLite's double-check
  together.

## Why this was its own track

It is independent of model loading and of the core vtab/persistence/HNSW work
already done. It touches `xBestIndex`/`xFilter` planning and the shadow-table
query path, and benefits from being designed and tested on its own.
