# Query planning — how SQLite drives the `anki` vtab

**Status:** reference (empirically observed)
**Last updated:** 2026-06-25

How various query shapes are actually planned and executed against the `anki`
virtual table. These are **observations**, captured by temporarily instrumenting
`xBestIndex` / `xFilter` / `xFindFunction` to print what they receive, then
running a battery of queries (the instrumentation was reverted afterward).

## Mental model

The extension is a **row source**, not a query interceptor. SQLite's planner owns
the query; it decomposes the `WHERE` clause into simple `column OP value`
constraints and offers them to `xBestIndex`. We *claim* the ones we can use
(MATCH, comparison ops); SQLite applies the rest to the rows we emit. `xFilter`
then produces rows for the chosen plan. Everything else (joins, OR, `ORDER BY`,
`LIMIT`, functions) is SQLite's job.

## What each query shape does

Sample table: `docs(status TEXT, year INTEGER, notes TEXT VECTOR)`; `notes` is
column 2. `idxStr` tokens: `m<col>` = MATCH, `f<col>,<op>` = filter (op is the
SQLite constraint code: EQ=2, GT=4, LE=8, LT=16, GE=32, NE=68).

| Query | Offered to xBestIndex | Claimed (`idxStr`) | Execution |
|-------|----------------------|--------------------|-----------|
| `notes MATCH 'q'` | `MATCH(2)` | `m2` | HNSW over all rows |
| `status='active' AND notes MATCH 'q'` | `EQ(0)`, `MATCH(2)` | `f0,2;m2` | **pre-filter** then rank |
| `year>=2021 AND notes MATCH 'q'` | `GE(1)`, `MATCH(2)` | `f1,32;m2` | **pre-filter** (range) then rank |
| `status='active' OR notes MATCH 'q'` | (split) | two scans: `f0,2` + `m2` | **MULTI-INDEX OR**, union |
| `status LIKE 'act%' AND notes MATCH 'q'` | `MATCH(2)`, `GE(0)`, `LT(0)`, `LIKE(0)` | `m2;f0,32;f0,16` | pre-filter on **derived range**; SQLite re-checks `LIKE` |
| `(status='active' OR status='trial') AND notes MATCH 'q'` | (split) | `m2;f0,2` per branch | MULTI-INDEX OR; **MATCH pushed into each branch** |
| `lower(status)='active' AND notes MATCH 'q'` | `MATCH(2)` only | `m2` | **MATCH first, SQLite post-filters** `lower()` |
| `notes MATCH 'q' AND similarity(notes)>0.7` | `MATCH(2)` only | `m2` | MATCH; SQLite applies `similarity()` after |
| `notes MATCH 'q' ORDER BY similarity(notes) DESC LIMIT 1` | `MATCH(2)` | `m2` | MATCH → SQLite orders + limits |
| `year<2022` (no MATCH) | `LT(1)` | `f1,16` | filtered scan, no embedding |

## Notable behaviors

### Prefix `LIKE` is partially pushed down (for free)

SQLite's own optimizer rewrites a *prefix* `LIKE 'act%'` into a **range**
`status >= 'ACT' AND status < 'acu'` (case-folded) plus a residual `LIKE`. It
offers us the `GE`/`LT`, which we pre-filter on, and re-checks the real `LIKE`
itself. So prefix-LIKE hybrid queries are cliff-proof without any work on our
side. (Non-prefix patterns like `'%act%'` are not turned into a range and stay
post-filtered.)

### OR → MULTI-INDEX OR, with MATCH pushed into every branch

`A OR B` (and `(A OR B) AND MATCH`) becomes SQLite's MULTI-INDEX OR: it runs a
separate vtab scan per OR branch and unions the rowids. MATCH and the branch's
filter are pushed into each scan (e.g. `m2;f0,2` with `'active'`, then with
`'trial'`). So OR + MATCH is handled correctly, pre-filtered per branch.

### Multiple `MATCH` columns: AND = one scan, OR = union of scans

The vtab is a **conjunctive engine** — `xFilter` only ever executes a set of
AND-ed constraints. SQLite decomposes OR *above* the vtab, so the two cases are
fundamentally different:

- **`a MATCH x AND b MATCH y [AND rel]`** → one `xBestIndex` claims *every*
  vector-column MATCH (plus pushable filters) into a single `idxStr` (e.g.
  `m2;m3;f1,2`); one `xFilter` embeds all the queries and does a **single pass**,
  keeping a row only if it clears the threshold on **every** matched column,
  storing a **per-column score**. So multi-column MATCH is one intersecting scan,
  and `similarity(summary)` vs `similarity(customer_notes)` return different
  numbers. (Cost ≈ O(rows × matches) — the general/exact path; a lone MATCH with
  no filter still uses the HNSW fast path.)

- **`a MATCH x OR b MATCH y`** → MULTI-INDEX OR: `xFilter` runs **once per
  branch**, each a *single*-MATCH scan (so each can use HNSW), and SQLite unions
  the rowids. Scores are per-branch: a row from the `a` branch has a score for
  `a`; `similarity(b)` on it is `NULL`.

- **`(a MATCH x OR b MATCH y) AND status='open'`** → the OR expands to a union and
  the AND'd filter is distributed into each branch (`a MATCH x AND status='open'`,
  then `b MATCH y AND status='open'`), each scanned and unioned.

The mechanism: `xBestIndex` claims all MATCH constraints it is offered in a single
plan (it used to take only the first, which made a second MATCH error with
*"unable to use function MATCH in the requested context"*).

### Functions on a column are the genuine post-filter case

`lower(status)='active'` is not `column OP value`, so it is **never offered** to
`xBestIndex`. MATCH runs first and SQLite applies the function predicate to the
emitted rows. This is the one shape where the post-filter recall cliff genuinely
applies — relevant to the `mode:exact` option in `match-dsl.md`.

### `xBestIndex` is called multiple times per query

The planner explores alternative plans (different `usable` subsets / scan orders)
and picks the lowest `estimatedCost`. The OR cases trigger six or more calls.

### `xFindFunction` is consulted for any function over a vtab column

Observed for `like`, `lower`, and `similarity`. We only claim `similarity`
(return non-zero); for the rest we return 0 and SQLite uses its built-in.

### Pre-filter reach is wider than "the six ops"

Pre-filtering kicks in for equality, range, **and** prefix-`LIKE`-as-range. True
post-filtering is limited to: column-functions, non-prefix `LIKE`, `OR` residuals
SQLite can't split, and `similarity()` thresholds.

## Implications for users

- **The default 0.5 threshold is loose with all-MiniLM** — its similarity
  baseline is high, so unrelated short texts can score ~0.5–0.65 and "match".
  Tighten with `AND similarity(notes) > 0.7` (or the DSL `threshold:`).
- **Equality / range / prefix-LIKE filters are cliff-proof** (pre-filtered).
- **Column-function filters are cliff-prone** — prefer a plain `col = value`
  where possible, or use `mode:exact` once the DSL lands.
- **`ORDER BY similarity(col) DESC`** is needed for best-first order; MATCH alone
  doesn't guarantee ordering.

## How to reproduce

Temporarily add a trace shim (`anki_trace` in `wasm/anki_extension.c`) and `trace`
calls in the three callbacks, rebuild the node loader, and run a battery of
queries with `printErr` capturing stderr. Revert the instrumentation before
committing.
