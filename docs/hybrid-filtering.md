# Hybrid filtering (relational `WHERE` + semantic `MATCH`)

**Status:** ✅ implemented (equality/range pushdown + pre-filter)
**Last updated:** 2026-06-25

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

Predicate evaluation is conservative: when a comparison is unknown (NULL or
cross-type) the row is kept, and SQLite re-checks it — so completeness is
guaranteed without re-implementing exact SQL comparison semantics.

## Why this was its own track

It is independent of model loading and of the core vtab/persistence/HNSW work
already done. It touches `xBestIndex`/`xFilter` planning and the shadow-table
query path, and benefits from being designed and tested on its own.
