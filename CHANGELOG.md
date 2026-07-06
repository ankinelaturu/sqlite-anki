# Changelog

Notable changes to sqlite-anki, newest first. Pre-1.0 and unversioned, so entries are
grouped by date rather than release. Curated from git history — see linked docs for the
full rationale and design. Add new entries at the top.

## 2026-07-05

### Added
- **Import & Vectorize** (explorer): upload an existing `.sqlite`, pick which TEXT columns
  to make semantically searchable, and rebuild it into a sqlite-anki database with
  embeddings computed on import, plus generated sample `MATCH` queries. Tables without
  picks are copied verbatim (original DDL preserved); nothing picked persists the file
  unchanged. Import schema fidelity and the remaining gaps (secondary indexes, triggers)
  are tracked in [docs/TODO.md](docs/TODO.md).
- **`Cell::Blob`** so `BLOB` columns round-trip through the `anki` vtab (previously nulled).

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
