# MATCH DSL — semantic query options

**Status:** ✅ implemented (`query` + `mode` + `candidates`)
**Last updated:** 2026-06-25

Parser: `crates/anki-core/src/match_query.rs` (host unit-tested). Wired into
`x_filter`; integration tests in `packages/wasm/test/match-dsl.test.mjs`.

## Goal

Let the `MATCH` string carry a few **semantic-search options** as a compact,
regex-inspired suffix — so users can explicitly choose the search behavior
(approximate vs exact, candidate budget) instead of it being hidden. It is *not*
a relational query language: relational predicates stay in SQL and keep flowing
through the planner.

This is a pure parsing layer on the `MATCH` value (`argv[0]` in `xFilter`) — no
SQLite, planner, or FFI changes (the same place FTS5 parses its query string).

## Forms

```sql
WHERE notes MATCH 'apple'                 -- query="apple", mode=hnsw (default)
WHERE notes MATCH 'apple/exact'           -- exact (brute-force, complete)
WHERE notes MATCH 'apple/hnsw'            -- explicit approximate
WHERE notes MATCH 'apple/hnsw:256'        -- approximate, candidate budget 256
WHERE notes MATCH ?                       -- recommended: bind the string
```

## Grammar

```
match     := query [ "/" directive ]
query     := '"' ...literal... '"'      -- quoted: verbatim, may contain '/' and ':'
           | bare-text                  -- a trailing "/directive" is stripped ONLY if valid
directive := mode [ ":" candidates ]
mode      := "hnsw" | "exact"
candidates:= positive integer           -- hnsw only
```

### Parse rules

1. Trim the string.
2. **Quoted** (`"..."`) → the query is the verbatim content between the quotes
   (may contain `/` and `:`). Whatever follows the closing quote must be empty or
   a `/directive`; anything else is an error.
3. **Bare** → look at the text after the **last `/`**. If it parses as a valid
   directive (a known `mode`, optionally `:N`), strip it and use the prefix as
   the query. Otherwise the **whole string** (slashes and all) is the query.

This keyword-gating means slashy queries Just Work without quoting; quoting is
only needed for the rare query that *itself* ends in `/exact` or `/hnsw`.

### Examples

| MATCH string | query | mode | candidates |
|--------------|-------|------|------------|
| `apple` | `apple` | hnsw | default |
| `apple/exact` | `apple` | exact | — |
| `apple/hnsw:256` | `apple` | hnsw | 256 |
| `TCP/IP` | `TCP/IP` | hnsw | default | *(tail not a mode → literal)* |
| `24/7 support` | `24/7 support` | hnsw | default |
| `"apple/tcp/ip:45/hnsw"` | `apple/tcp/ip:45/hnsw` | hnsw | default |
| `"apple/tcp/ip:45/hnsw"/hnsw:256` | `apple/tcp/ip:45/hnsw` | hnsw | 256 |

### Errors

Malformed directives are **hard errors** (not silently treated as a literal
query), to catch typos:

- `apple/hnsw:abc` → "invalid candidates"
- `apple/exact:256` → "candidates (`:N`) is only valid with `hnsw` mode"
- `"apple" extra` → "unexpected text after quoted query"
- `"apple` (unterminated) → "unterminated quote"

(A typo'd mode like `apple/hsnw` is *not* an error — `hsnw` isn't a known mode,
so it's treated as the literal query `apple/hsnw`. Only strings that begin a
valid mode keyword are validated strictly.)

## Field semantics

### `mode: hnsw | exact`

- **`hnsw`** (default) — HNSW approximate nearest-neighbor. Fast; may miss
  results (approximate candidate generation). When combined with SQL predicates
  that can't be pushed down (functions, non-prefix `LIKE`), SQLite applies those
  *after* candidate generation, which can further reduce recall — see
  `query-planning.md`.
- **`exact`** — brute-force cosine over the applicable rows; no ANN
  approximation, returns the exact matches. The candidate cap does not apply
  (exact = complete). Slower on large unfiltered tables — the user's explicit
  choice.

Note: when a **pushable relational filter** is present, we already brute-force
the filtered subset, so that path is exact regardless of `mode`. `mode`
therefore chiefly governs the *no-pushable-filter* path (where HNSW kicks in).

### `candidates: N` (hnsw only)

The HNSW candidate budget — how many neighbors the index retrieves before the
similarity threshold is applied (recall vs speed). Defaults to
`HNSW_CANDIDATE_CAP` (256). Distinct from SQL `LIMIT`, which caps the *final*
row count after threshold + `ORDER BY`.

## Scope

The DSL controls **only** semantic-search behavior (`query`, `mode`,
`candidates`). It must **not** carry relational predicates (`region='west'`,
`age>25`) — those stay in SQL. SQL owns relational logic; the MATCH string
configures how the semantic search executes.

## Deferred (and why)

- **`threshold:`** — redundant with `AND <col>_score > X` for any threshold
  `>= 0.5` (the in-scan default). The only thing it could add is *loosening*
  below 0.5, which all-MiniLM's high baseline makes rarely useful. The grammar
  can add it later without breaking the suffix form.
- **`metric`** — only cosine today.
- **Multiple `MATCH` columns** in one query — separate limitation.

Keep the field set minimal; FTS5's MATCH syntax is a known footgun.

## Implementation notes

- Pure parser module `match_query` → `MatchQuery { query, mode, candidates }`,
  host unit-tested (no wasm needed).
- `x_filter` parses `argv[0]`, embeds `query`, and routes by `mode`/`candidates`.
  Parse errors set the vtab error message and return `SQLITE_ERROR`.
- Relational pushdown / `idxStr` machinery is unchanged.
