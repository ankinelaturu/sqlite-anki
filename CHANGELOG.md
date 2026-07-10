# Changelog

Notable changes to sqlite-anki, newest first. Pre-1.0 and unversioned, so entries are
grouped by date rather than release. Curated from git history — see linked docs for the
full rationale and design. Add new entries at the top.

## 2026-07-09

### Explorer
- **SQL scratchpad: schema-aware autocomplete and inline errors.** The query editor now
  completes table/column names (including `anki` `<col>_score` columns) from the open database
  with context-filtered suggestions (tables after `FROM`, columns in `SELECT`/`WHERE`, keywords
  elsewhere), pill badges for type/table metadata in the completion popup, hover tooltips on
  identifiers in the buffer (table/column type, flags, descriptions), per-statement gutter
  icons (run valid statements, error icon with message for invalid), toolbar shortcuts
  (`⌘Enter` / `Ctrl+Enter` run SQL, `⌘⇧Enter` / `Ctrl+Shift+Enter` run selection), a
  resizable editor/results split, and prepare-time squiggles on the statement at the
  cursor before run.

## 2026-07-07

### Performance
- **The HNSW graph is persisted and reloaded on open.** The built index is serialized (topology
  only — vectors are rehydrated from the existing `anki_emb_<col>` blobs, tombstones compacted out)
  into a new `<name>_anki_hnsw` shadow table, persisted at commit (`xSync`, atomically with the
  data). On reopen the **first `MATCH` reads the graph instead of rebuilding it** (O(N)), removing
  the open-time CPU spike. All-or-nothing load with a full safety net: a missing/stale/corrupt cache
  just falls back to the rebuild path. New `graph_saves`/`graph_loads` metrics. Complements
  incremental insertion — writes keep the graph fresh, persistence avoids the cold rebuild. See
  roadmap Done in [docs/TODO.md](docs/TODO.md).
- **HNSW indexes update incrementally on write.** Once a column's index is built, each
  `INSERT`/`UPDATE`/`DELETE` splices the single row into the live graph (`Hnsw::add`, ~O(log N))
  or tombstones it (`Hnsw::remove`, O(1)) instead of dirtying the whole index and forcing the next
  `MATCH` to rebuild it (O(N)). The first `MATCH` after create still bulk-builds; that path stays
  the fallback for post-rollback and `REPLACE`/`IGNORE` resync, and compacts away tombstones. Cuts
  write→search latency on incrementally-growing tables (demo build, Import & Vectorize). See
  roadmap #1 in [docs/TODO.md](docs/TODO.md).

### Added
- **`anki_hnsw_json(table, col)` / `anki_hnsw_dot(table, col)` SQL functions** export the
  persisted HNSW graph topology for a vector column (nodes + per-layer edges, rowids for labels;
  or Graphviz DOT) so the app can visualize the index. Decoded in Rust from the `<table>_anki_hnsw`
  cache (single source of truth for the blob format); `NULL` when no graph is cached. See
  [docs/hnsw.md](docs/hnsw.md).
- **Import carries enforceable constraints** onto vectorized tables — `NOT NULL` and
  single-column `UNIQUE`/`PRIMARY KEY` (reconstructed from `PRAGMA table_info`/`index_list`), and
  **column-level `CHECK`** (parsed from the source `CREATE TABLE` DDL via a quote/paren-aware
  scanner, since no PRAGMA exposes CHECK). They enforce via the shadow, like greenfield.
  Multi-column and table-level constraints can't be expressed in the per-column `anki(col …)` DSL
  and stay dropped.
- **Import drop-warning** — the Import & Vectorize dialog now lists which indexes, triggers,
  foreign keys, `DEFAULT`s, and table-level constraints a table loses when you tick it to vectorize.

### Fixed
- **`CREATE VIRTUAL TABLE … USING anki(id INTEGER PRIMARY KEY, …)` no longer fails.** A user
  column's `PRIMARY KEY` collided with the shadow's own `anki_id INTEGER PRIMARY KEY` (SQLite allows
  one per table), so the shadow `CREATE TABLE` errored — which broke the **demo** (every table
  declares `id INTEGER PRIMARY KEY`). Now a single `INTEGER PRIMARY KEY` column **becomes the shadow
  rowid** (`rowid == id`, VACUUM-stable, `AUTOINCREMENT` honored) with no injected `anki_id` — the
  user's key keeps its full semantics. Tables without an integer PK still get an injected `anki_id`;
  a non-integer/second PK maps to `UNIQUE`. Regression from the 2026-07-06 constraint work.

### Changed
- **Storage format v3 → v4.** Adds the HNSW graph cache table (created at table creation). DBs
  written by an older format still hit the existing "rebuild required" guard on open; rebuild via
  Import & Vectorize or by re-populating the demo.
- **Storage format v4 → v5 — parallel shadow-table names.** Renamed the per-table shadows to
  `<name>_anki_data` (rows + embeddings) and `<name>_anki_hnsw` (graph cache), and the export
  functions to `anki_hnsw_json` / `anki_hnsw_dot`. All per-table internals now share the
  `<name>_anki_*` shape, so the explorer hides them with one rule and future shadow tables fit the
  scheme. (Column names — `anki_id`, `anki_emb_<col>` — keep the reserved `anki_` prefix.)
- **Storage format v5 → v6.** A user `INTEGER PRIMARY KEY` column now *is* the shadow rowid (see
  Fixed), so the shadow layout differs from v5 for such tables. Older DBs hit the "rebuild required"
  guard on open.

### Docs
- Added [docs/limitations.md](docs/limitations.md) — a living list of by-design limits (vtab
  constraints, imports, storage format). Reshuffled [docs/TODO.md](docs/TODO.md) into an ordered
  roadmap.

## 2026-07-06

### Added
- **Column constraints on `anki` tables enforce.** `UNIQUE` / `CHECK` / `NOT NULL` declared on a
  vector table are enforced via the real shadow table, and writes honor the SQL conflict clause
  (`INSERT OR REPLACE` / `OR IGNORE` / plain) through `sqlite3_vtab_on_conflict`. `DEFAULT` is
  ignored (a vtab limitation) and index/trigger/FK/table-level constraints can't apply. See
  [docs/limitations.md](docs/limitations.md).

### Changed
- **Storage format v3 — real shadow column names.** The backing table is now `<name>_anki`;
  internal columns are `anki_id` and `anki_emb_<col>`; user columns are stored under their **real
  names** (declared type + `COLLATE`). The `anki_` prefix is reserved — a user column named
  `anki_*` is rejected at create, and import offers an inline rename. Old DBs need a rebuild. This
  is what makes `CHECK` expressions and readable constraint errors work.

## 2026-07-05

### Added
- **Import & Vectorize** (explorer): upload an existing `.sqlite`, pick which TEXT columns
  to make semantically searchable, and rebuild it into a sqlite-anki database with
  embeddings computed on import, plus generated sample `MATCH` queries. Tables without
  picks are copied verbatim (original DDL preserved); nothing picked persists the file
  unchanged. Import schema fidelity and the remaining gaps (secondary indexes, triggers)
  are tracked in [docs/TODO.md](docs/TODO.md).
- **`Cell::Blob`** so `BLOB` columns round-trip through the `anki` vtab (previously nulled).
- **Index & trigger replay on import** — plain-copied tables keep their secondary indexes and
  triggers (replayed after data, so nothing fires on the copied rows). Vectorized tables can't
  carry them (vtab limits).

### Changed
- **Streaming storage redesign** — the `anki` vtab no longer materializes the whole table
  into WASM linear memory at open. It now holds only **rowid + embeddings + HNSW** in RAM;
  user column data is served from the shadow table on demand, and the `WHERE` pre-filter is
  evaluated by SQLite on a **type-full** shadow table (affinity/collation are SQLite's, not
  hand-rolled). Adds a storage-format version guard (old DBs need a rebuild). Design +
  correctness + follow-ups in [docs/streaming-storage.md](docs/streaming-storage.md).
- Enlarged the explorer status bars so per-operation metrics read as primary info.

### Docs
- Added [docs/streaming-storage.md](docs/streaming-storage.md) (design) and
  [docs/TODO.md](docs/TODO.md) (deferred follow-ups / roadmap).

## 2026-06-29

### Changed
- Replaced the `similarity()` SQL function with the hidden **`<col>_score`** column — a
  query-time value that works in SELECT/WHERE/ORDER BY/GROUP BY and inside aggregates
  (no MATERIALIZED-CTE workaround needed). Rationale in
  [docs/design-choices.md](docs/design-choices.md).

### Added
- `fp16` `all-MiniLM-L6-v2` model registry variant (~half the download).
- `CLAUDE.md` for future sessions; documented the WebGPU acceleration path
  ([docs/our-findings.md](docs/our-findings.md) §8).

## 2026-06-27

### Added
- Explorer: VSCode-style activity bar; split **SQLite** and **OPFS** workspaces; OPFS file
  tree + tabbed editor + status bar (Phases 1–2).
- **Candle** engine build variant; build variants renamed to `[engine]-[format]-[threads]`
  (`candle-native` reserved/stubbed). See [docs/build-variants.md](docs/build-variants.md).

## 2026-06-26

### Added
- Multiple `MATCH` columns per query (AND'd, with a per-column `<col>_score`).
- Explorer: rich **demo database** (CRM + knowledge base) via the Populate button.

### Changed
- Build the wasm with SIMD (`+simd128`) — ~2× faster embedding. See
  [docs/our-findings.md](docs/our-findings.md).

## 2026-06-25

### Added
- **MATCH DSL** — per-query strategy suffixes `/exact` and `/hnsw:N`. See
  [docs/match-dsl.md](docs/match-dsl.md).
- **Hybrid filtering** — relational `WHERE` + semantic `MATCH` pushdown (pre-filter). See
  [docs/hybrid-filtering.md](docs/hybrid-filtering.md) and
  [docs/query-planning.md](docs/query-planning.md).
- **`anki_metrics()`** — per-operation timing/counters + instrumentation. See
  [docs/metrics.md](docs/metrics.md).

### Changed
- The ONNX model is **no longer bundled** into the wasm — it's fetched at runtime (by
  registry id or URL/bytes), cached in OPFS, and handed to the extension; large wasm-size
  reduction. See [docs/dynamic-model-loading.md](docs/dynamic-model-loading.md).

## 2026-06-24

### Added
- **HNSW** approximate-nearest-neighbour index with lazy loading and memory-efficient
  search.

## 2026-06-23

### Added
- Initial sqlite-anki: the **`anki` virtual table** — `TEXT VECTOR` columns auto-embedded on
  write and queried by meaning with `WHERE col MATCH 'text'`, backed by shadow-table
  persistence with transaction/rollback-aware cache reload. The embedding model runs
  *inside* SQLite (Rust compiled to WASM) — no embedding API, no JS on the query hot path.
  Full spec in [docs/DESIGN.md](docs/DESIGN.md), rationale in
  [docs/design-choices.md](docs/design-choices.md).
- Explorer app scaffold; CI build/deploy (wasm built in CI).
