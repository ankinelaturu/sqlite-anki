# TODO / roadmap

Follow-up work, deferred by design. The **Open roadmap** is ordered by the sequence we intend
to tackle it; each item has a matching auto-memory note (assistant recall) and, where relevant,
a design section in another doc. **Done** work is kept at the bottom for provenance.

## Open roadmap (in intended order)

### 1. Per-DB configuration + core / frontend separation (CLI-readiness)
The core-API hardening the CLI depends on. Do this as one phase so the core boundary is drawn once.
- **Per-DB model selection.** Lift "one model per module instance (first `Embedder::load` wins)" so
  each DB loads its own model. The DB already records `model_id`+`dim` in `anki_meta` (mismatch
  guard); opening reads it and loads that model. *"Per-import model switching" is just the UI face
  of this.*
- **Per-DB config lives in `anki_meta`.** Model **and** int8 mode (#2) ride the same rails: chosen at
  create/import, recorded in `anki_meta`, read on open, fixed for the DB's life (change → rebuild,
  see #3).
- **Explorer / core layering.** Separate the reusable core from the explorer so a CLI can reuse it:
  split **OPFS vs native VFS**, the **tract/candle native** engine variants, and the model-load path
  (OPFS cache vs filesystem). **Do not implement the CLI yet** — just draw the boundary.
- **Decide the home for shared import/vectorize logic** — `analyzeImport`/`rebuildImport`, the CHECK
  scanner, constraint reconstruction, and a future companion generator are all **TypeScript in the
  explorer worker** today. A native (Rust) CLI can't call TS → they'd need a **Rust home exposed via
  FFI**; a Node CLI could share the TS. All import features (incl. companion, backlog) ride this call.

### 2. RAM reduction (beyond the shipped streaming redesign)
The streaming redesign (`streaming-storage.md`) already cut RAM to **rowid + embeddings + HNSW**.
- **int8 quantization — opt-in per DB** (rides the `anki_meta` per-DB config, #1). Each `float32`
  component → one `int8` (~4× less RAM *and* disk). Use **asymmetric** (float query × int8 stored)
  + **per-vector scale** to minimize error; keeps `/hnsw` + `/exact`. **Measure first:** before
  building the storage path, quantify recall@K and `<col>_score` drift on real data (expected ~99%
  recall, drift in the thousandths — proceed if so). **Bumps the storage format.**
  *(Binary quantization — 1 bit/dim, 32× — is the aggressive cousin; needs float reranking to stay
  accurate, so it pairs with #2-Option-B, not plain int8.)*
- **Stream embeddings ("Option B" / DiskANN).** Keep only the HNSW graph resident, read vectors from
  disk during traversal. Big win at very large N; cost is random OPFS-read latency (worst for
  `/exact`). Only ~100k+ vectorized rows. Enables a two-stage **float rerank** of the top-K.

### 3. "Rebuild required" migration UX
The storage-format guard hard-fails opening older-format DBs with a raw error. Show a friendly
message that offers to rebuild (Import & Vectorize / re-populate demo) — the pre-1.0 migration story.
Build it **once, after the format-bumping features settle** (#1 per-DB model, #2 int8; graph cache,
shadow-table rename, and the no-injected-rowid change already took it to v7), so it's written against a
stable format instead of revised each bump.

### 4. Native CLI + interactive import
- A native macOS/Windows **CLI** reusing `anki-core` + the `anki` vtab (link into a native SQLite
  build — the reserved `candle-native` variant). Makes import a serious tool on real, write-heavy DBs.
- **Interactive import tool** (probably a TUI): pick vector columns, choose model + int8, in-place vs
  companion. Built on the shared import layer from #1.

## Low priority / backlog
- **Companion-table import (faithful retrofit).** Vectorizing in-place turns a table into an `anki`
  vtab, stripping what a vtab can't hold (FKs, triggers, indexes, table-level constraints, DEFAULT).
  The companion strategy avoids transforming it: keep the **original table plain** (retains
  everything), add a **companion** `anki` table (`USING anki(<pk> INTEGER, <text> TEXT VECTOR)`) kept
  in sync by **triggers on the plain table** (allowed — only triggers *on* a vtab are forbidden), and
  **JOIN** back to search. Zero fidelity loss; auto-generated.
  - **In-place stays primary/default** (single searchable table — the differentiator; the only sensible
    choice for greenfield). Companion is the retrofit path, surfaced as the answer to the drop-warning
    ("keep the original, add a search companion instead").
  - **Not** just codegen over sqlite-vec: even the companion is an `anki` vtab that auto-embeds on write
    with generated sync — the app never runs a model, inserts a vector, or hand-syncs. Companion changes
    *where the vector column sits*, not *who does the ML work*.
  - **Needs no vtab changes** → a **shared-layer** capability (not CLI-only), living beside the CHECK /
    constraint-reconstruction logic; rides the import-logic-home decision (#1). Costs vs in-place: a
    second copy of the text, sync-trigger overhead, and a JOIN — hence retrofit-only.
- **Index frequently-filtered shadow columns.** `filter_candidate_ids` scans the shadow for unindexed
  filter columns; add indexes (auto-heuristic or explicit). **Low ROI.**
- **DESIGN.md accuracy pass.** `docs/DESIGN.md` is a v1-era spec with stale claims beyond the HNSW
  drift already fixed: it still says `wasm32-unknown-unknown` (target is `-emscripten`), `include_bytes!`
  / "pre-bundled per WASM package" model delivery (now runtime-fetched + OPFS-cached, see
  `dynamic-model-loading.md`), and other v1 assumptions. Reconcile it with shipped reality (or split the
  historical spec from the current-state docs). **Docs only, low priority.**
- **Real shadow-table protection (`xShadowName` + `SQLITE_DBCONFIG_DEFENSIVE`).** The shadow tables
  (`<name>_anki_data`, `<name>_anki_hnsw`, `anki_meta`) are ordinary tables today — any SQL can read *and
  write* them, and a direct write can corrupt vtab invariants (embeddings out of sync, a stale graph).
  Set the module's `xShadowName` and enable defensive mode so **direct writes are blocked while reads
  stay open** (the `anki_hnsw_json`/`anki_hnsw_dot` exports and the explorer's read-only schema view
  keep working; reads are open by design). **Verify our own writes survive:** the extension writes these
  tables via SQL in `xUpdate`/`xSync` — confirm defensive mode treats those as vtab-internal (FTS5 works
  under it, but our write path differs) before shipping. Currently the tables are only hidden
  cosmetically by the explorer's schema filter, not protected.

## Won't do
- **`omit=1` for proven filters.** Pushed filters use `omit=0` so SQLite re-checks (redundant in the
  common case). Setting `omit=1` skips the re-check but removes the safety net — too risky/tricky for
  the payoff, and needs exhaustive parity tests. Dropped.

## Done
- **Session query-embedding cache (LRU) — DONE (2026-07-10).** A module-global LRU (`QUERY_EMBED_CACHE`,
  cap 256) keyed by query text caches the ONNX forward pass so a repeated query is embedded once
  *across* queries, not just within one cursor's scan (`AnkiCursor::q_cache` stays as the fast
  per-scan layer). Consulted only in the query path (`embed_cached` → `embed_query`); write-time row
  embeddings bypass it (mostly one-shot). In-memory only (a query embedding is cheap to recompute).
  Keyed by text alone — correct while the model is global; re-key by model when per-DB models (#1)
  land. Observable via `embed_calls` staying flat on a repeat (no new metric). Tests: `vtab.rs` LRU
  unit + `embed-cache.test.mjs` e2e.
- **No injected rowid; columns stored verbatim — DONE (2026-07-08, storage format v7).** Dropped the
  injected `anki_id`; the shadow keeps the user's columns **verbatim** (constraints incl. any
  `PRIMARY KEY`) and keys on SQLite's `rowid` — a user `INTEGER PRIMARY KEY` *is* that rowid
  (`rowid == id`, VACUUM-stable, autoincrement honored). Fixes `CREATE … (id INTEGER PRIMARY KEY, …)`
  (which had collided with the injected PK and broke the demo) and keeps `PRIMARY KEY` semantics exact
  (no silent `→ UNIQUE`). Reserves the rowid aliases `rowid`/`_rowid_`/`oid`. The HNSW graph cache is
  persisted **only for a pinned rowid** (`INTEGER PRIMARY KEY` present); an unpinned implicit rowid can
  be renumbered by `VACUUM`, so its graph just rebuilds in RAM on open (`rowid_user_idx.is_some()`).
  Net deletion — removed `anki_id` injection, the `shadow_decl_type` PK-rewriter, and the `rowid_col`
  plumbing.
- **Parallel shadow-table names — DONE (2026-07-07, storage format v5).** Renamed the per-table
  shadows to `<name>_anki_data` (rows + embeddings) and `<name>_anki_hnsw` (graph cache), and the
  export functions to `anki_hnsw_json` / `anki_hnsw_dot`, so every per-table internal shares the
  `<name>_anki_*` shape. The explorer's schema filter collapses to one `%_anki_%` rule (was an
  enumerated, leak-prone list), and future shadow tables fit the scheme. Column names keep the
  reserved `anki_` prefix (`anki_id`, `anki_emb_<col>`) — different convention, see `hnsw.md`.
- **Persist the HNSW graph — DONE (2026-07-07, storage format v4).** The built graph is serialized
  (topology only — vectors are rehydrated from `anki_emb_<col>`, tombstones compacted out) into a
  new `<name>_anki_hnsw` shadow table, one row per vector column. Created at `xCreate`; persisted in
  `xSync` (atomic with the committing txn) whenever a write left a live graph, else the cache is
  cleared; loaded in `xConnect` after `load_all`, so the **first `MATCH` after open reads the graph
  instead of rebuilding** (O(N) spike gone). All-or-nothing load; any miss/corruption/stale rowid
  falls back to the rebuild path. Deserialize is fully bounds-checked (never panics under
  `panic = abort`). New `graph_saves`/`graph_loads` metrics. `hnsw.rs` round-trip/corruption unit
  tests + `persistence.test.mjs` reopen-skips-rebuild regressions. Format bumped 3 → 4 (old DBs hit
  the existing rebuild-required guard).
- **HNSW incremental insertion — DONE (2026-07-07).** Once a column's HNSW index is live, each write
  splices the single row in (`Hnsw::add`, ~O(log N)) or tombstones it (`Hnsw::remove`, O(1)) via
  `index_add_row` / `index_remove_row` in `x_update`, instead of dirtying the whole index. The first
  `MATCH` after create still bulk-builds (`rebuild_indexes`), which stays the fallback for post-rollback
  and REPLACE/IGNORE resync; tombstoned nodes route but are filtered from results and compact away on
  the next rebuild. Turns write→search from an O(N) rebuild into ~O(log N) per changed row.
  `hnsw.rs` unit tests + a `metrics.test.mjs` no-rebuild regression.
- **Constraint carry on import — DONE (2026-07-07).** `rebuildImport` reconstructs **NOT NULL +
  single-column UNIQUE/PK** (from `table_info`/`index_list`/`index_info`) and **column-level CHECK**
  (parsed from the source `CREATE TABLE` DDL via a quote/paren-aware scanner — no PRAGMA exposes it),
  re-declared on the vectorized table where they enforce via the shadow. CHECK skipped for a table
  with a reserved-name rename. Only **table-level** constraints can't be carried (per-column DSL).
- **Dialog transparency — DONE (2026-07-07).** ImportDialog warns which schema objects a table drops
  when vectorized (indexes/triggers/FKs/table-level CHECK/DEFAULT/multi-col UNIQUE); `analyzeImport`
  → `ImportDrops`.
- **Constraint enforcement, greenfield — DONE (2026-07-06).** Declared type flows into the shadow
  `CREATE`, so **UNIQUE / CHECK / NOT NULL** enforce; the write path honors the SQL conflict clause via
  `sqlite3_vtab_on_conflict` (`INSERT OR REPLACE`/`OR IGNORE`/plain). `constraints.test.mjs`.
  **DEFAULT** is a vtab limitation (SQLite ignores declared defaults); **index/trigger/FK** are blocked
  on vtabs. See `limitations.md`.
- **Real column names via an `anki_` prefix — DONE (2026-07-06, storage-format v3).** Shadow table
  `<name>_anki`, internal `anki_id` / `anki_emb_<col>`, data columns under real names; `anki_` reserved
  (greenfield hard-errors; import offers a rename). The enabler for constraint enforcement.
- **Trigger replay — DONE (2026-07-05).** `rebuildImport` replays `CREATE TRIGGER` for plain tables /
  views (INSTEAD OF), created after data. Triggers on vtabs are forbidden → dropped for vectorized.
- **Index replay — DONE (2026-07-05).** `rebuildImport` replays each `CREATE INDEX` for plain-copied
  tables (auto-indexes skipped). Vectorized tables can't be indexed → dropped.
- **Streaming-storage redesign — DONE (shipped).** Cut WASM RAM to rowid + embeddings + HNSW. See
  `streaming-storage.md`.

## Related design docs
- `limitations.md` — the by-design drops (vtab limits, import, storage format).
- `streaming-storage.md` — the shipped WASM-RAM redesign; §correctness + open questions cover
  `omit=1`, indexing, and Option B in more depth.
- `hybrid-filtering.md`, `query-planning.md` — WHERE + MATCH pushdown.
