# Hybrid filtering (relational `WHERE` + semantic `MATCH`)

**Status:** known limitation — pushdown not yet implemented
**Last updated:** 2026-06-24

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

## What happens today

The `anki` vtab folds regular columns and `TEXT VECTOR` columns into one virtual
table. `xBestIndex` only claims the `MATCH` constraint on the vector column; it
**ignores** `status = 'active'`. When a vtab does not claim a constraint, SQLite
applies it itself, against each row the vtab emits. So execution is:

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

## What's in our favor (not yet used)

The shadow table `<name>_data` is a **real SQLite btree table** we control —
unlike an in-memory ANN index. That gives a natural pushdown path:

- **Selective filter** → query the shadow btree first
  (`SELECT id FROM <name>_data WHERE status = 'active'`, index-accelerated),
  then vector-rank only that subset (brute force is cheap when the subset is
  small). Complete *and* fast.
- **Non-selective filter** → HNSW first, then post-filter (today's path). Good
  recall, fast.
- Choose pre- vs post-filter by estimated selectivity — what mature vector DBs
  do.

## Planned fix

1. `xBestIndex` accepts equality/range constraints on non-vector columns (mark
   `argvIndex`, leave `omit = 0` so SQLite still re-checks for correctness), and
   estimates selectivity.
2. `xFilter` receives those predicates and chooses:
   - **pre-filter**: resolve candidate ids from the shadow btree, then
     brute-force cosine over that subset; or
   - **post-filter**: HNSW first, filter the candidates (raise the effective
     candidate count when a filter is present to soften the cliff).
3. Optionally add user-defined indexes on the shadow table for hot filter
   columns.

### Interim mitigation (cheap)

Even before full pushdown: when non-`MATCH` constraints are present, over-fetch
from HNSW (raise the effective `k` toward/above the cap) so the post-filter has
more to work with. Reduces, does not eliminate, the cliff.

## Why this is its own track

It is independent of model loading and of the core vtab/persistence/HNSW work
already done. It touches `xBestIndex`/`xFilter` planning and the shadow-table
query path, and benefits from being designed and tested on its own.
