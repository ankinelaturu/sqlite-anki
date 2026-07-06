# The Journey of the `sqlite-anki` project

**The goal** — make semantic search feel like ordinary SQL. No embedding API, no service, no
JavaScript on the query path: declare a column `TEXT VECTOR`, and search it by meaning.

```sql
CREATE VIRTUAL TABLE docs USING anki(
  title TEXT, 
  body TEXT VECTOR -- the vector column
);

INSERT INTO docs(title, body) VALUES
  ('Acme renewal', 'the enterprise contract is up for renewal next quarter');

SELECT title, round(body_score, 3) AS score
FROM docs
WHERE body MATCH 'contract renewal' -- the semantic search
ORDER BY score DESC;
```

Everything below is the journey to make those three statements real — the decisions, the walls
we hit, the reversals, and the small stuff too.

---

## The founding bet: put the model *inside* SQLite
`Jun 23, 2026`

The initial commit stakes the whole thesis: semantic search where the embedding model runs
*inside* SQLite (Rust compiled to WASM), so there's no embedding API, no service, and no
JavaScript on the query hot path. `WHERE col MATCH 'text'` should feel like a native SQL
capability. Everything after this is in service of that bet. (Spec: [DESIGN.md](docs/DESIGN.md).)

## Writing the spec (and rewriting it, and rewriting it)

A run of README/DESIGN passes hammered out the shape before much code existed — iterating the
prose first was a way to think, so the design churned here instead of in the code later.

### First cut of README + DESIGN
`Jun 23, 2026`
Clarified features/usage and restructured DESIGN around the virtual-table module and query
semantics; dropped outdated sections and stated the "key decisions for v1."

### A quick-summary README; retire docs/README
`Jun 23, 2026`
Added a short summary of the key functionality and removed a duplicate docs README.

### Column types, indexing, parameterized MATCH, NULL/empty
`Jun 23, 2026`
Spelled out column types and search behavior, parameterized `MATCH`, NULL/empty handling, and
committed to multiple `TEXT VECTOR` columns + the chosen HNSW crate.

### Worked usage examples
`Jun 23, 2026`
Fleshed out concrete usage examples and the architecture/data-handling narrative.

### Monorepo layout + the explorer test app
`Jun 23, 2026`
Streamlined descriptions, clarified the monorepo layout, and documented the explorer test app.

## The build pipeline: link Rust into the *official* SQLite wasm

Rather than hand-roll a wasm, the build compiles `anki-core` to a static library and links it
into SQLite's own `ext/wasm` build — "ride the official build," which is why the JS API stays
upstream's and only the artifact names differ.

### Build script + ONNX + gitignore the vendored trees
`Jun 23, 2026`
Added the ONNX-integrated deps and the `build-wasm.sh` automation; gitignored the vendored
SQLite + Emscripten trees.

### Trim the staticlib wiring
`Jun 23, 2026`
Cleaned up `Cargo.lock`/`build.rs` (conditional embedded-model config) and got Emscripten
linking of the staticlib right — the seam that made the whole approach link.

### Fight Emscripten for SQLite 3.49
`Jun 24, 2026`
The link needed `HEAPU64`/`HEAP64` runtime methods exposed or SQLite 3.49 faulted at runtime —
an environment paper cut that costs an afternoon and one line.

## WASM panic handling + ONNX output shapes
`Jun 24, 2026`

Two consequential calls. First, release builds **abort on panic** — unwinding across the FFI
boundary into SQLite's C is undefined behavior and Emscripten can't lower the unwind (still why
we prefer returning `AnkiError` over panicking on any load/inference path). Second, the embedder
learned to handle the various ONNX output shapes and mean-pool correctly. The `anki` vtab module
got registered in the wasm extension.

## Persistence & transactions

Making the shadow table durable and transaction-safe — the base the vtab still stands on.

### Shadow-table persistence
`Jun 24, 2026`
Prepared-statement handling and a real backing "shadow" table so rows survive. The virtual table
you query and the real table that stores bytes become two separate things here.

### Transactions + lazy cache reload on rollback
`Jun 24, 2026`
If a transaction rolls back the shadow table, the in-memory cache must re-sync to match — a
correctness detail that would quietly matter for years (and resurface in the streaming redesign).

## The HNSW index

The bet that we'd want sub-linear vector search, not just brute force.

### Bring in HNSW
`Jun 24, 2026`
Refactored an HNSW ANN index into `anki-core`.

### Make it lazy
`Jun 24, 2026`
Lazy-loading + search optimization: build/consult the graph only when needed. (The "when is the
index built?" question returns in July.)

## The size wall: stop bundling the model
`Jun 25, 2026`

A pivot. Bundling the ONNX weights made the wasm enormous, so the model became a **runtime**
artifact: the wasm links a full ONNX engine but *no weights*; the model is fetched by id or
URL/bytes, cached in OPFS, and handed to the extension at load. The embedding *dimension* becomes
a property of the loaded model, not a constant. (See [dynamic-model-loading.md](docs/dynamic-model-loading.md).)

## Packaging + the e2e harness
`Jun 25, 2026`

Renamed artifacts to `@sqlite-anki/wasm` and added an integration test harness that loads the
real wasm + real model under Node — the e2e layer that would gate every change from here on.

## Hybrid filtering: the first WHERE + MATCH pushdown
`Jun 25, 2026`

Relational `WHERE` + semantic `MATCH` in one statement, with a pre-filter: rank only the rows
passing the filter instead of ranking everything and filtering after (which drops matches off the
similarity "cliff"). The first cut of a long correctness saga. (See [hybrid-filtering.md](docs/hybrid-filtering.md).)

## Documenting the vtab lifecycle in the code
`Jun 25, 2026`

Not behavior — heavy inline comments on the SQLite integration and vtab lifecycle. Worth a line
because "explain the C ABI contract in the source" became a standing convention.

## The MATCH DSL
`Jun 25, 2026`

A per-query strategy knob: `/exact` vs `/hnsw:N`, parsed from the MATCH string. Small syntax, big
control — and a surface we'd guard fiercely later. (See [match-dsl.md](docs/match-dsl.md).)

## `anki_metrics()`
`Jun 25, 2026`

Operation metrics + instrumentation so the cost of embedding vs search vs persist is observable,
not guessed. (See [metrics.md](docs/metrics.md).)

## Explorer groundwork: deps + structure
`Jun 25, 2026`

Unglamorous dependency/structure updates — where the demo SPA starts taking shape.

## Explorer: notes
`Jun 25, 2026`

A per-database notes feature (Markdown sidecar) — the first of many small explorer affordances.

## Explorer: a WHERE-clause search toolbar (and a Vite wasm fix)
`Jun 25, 2026`

A search toolbar, plus a fix for the recurring "the bundler must rewrite the wasm URL" gotcha of
shipping a custom sqlite3.wasm.

## Explorer: model registry + an animated load gate
`Jun 26, 2026`

Expanded the model registry and added a model-details gate with an animated load — the first-run
screen where you pick a model before anything else.

## Explorer: a persistent SQL editor
`Jun 26, 2026`

Persistent SQL editor with run-selection, kept across tab switches, so your query/results/selection
survive navigation. (This "keep it mounted" pattern recurs across the explorer.)

## Explorer: Markdown preview in notes
`Jun 26, 2026`

A rendered Markdown preview toggle for the notes editor. Small polish.

## SIMD: ~2× faster embedding
`Jun 26, 2026`

Built the wasm with `+simd128`, roughly doubling embedding throughput — the single biggest cheap
perf win. (See [our-findings.md](docs/our-findings.md).)

## The demo database

The thing that makes the project *show* rather than *tell*.

### Build it (CRM + knowledge base)
`Jun 26, 2026`
A ~870-row CRM + knowledge-base demo behind a Populate button, with multiple `TEXT VECTOR` columns
across realistic tables.

### An elapsed-time ticker during populate
`Jun 26, 2026`
Because embedding hundreds of rows in-browser is slow and silence feels broken — motion == trust.

## Schema tree gains table descriptions
`Jun 26, 2026`

Turned SQLite's preserved inline `--` DDL comments into table descriptions in the schema tree.

## Explorer: tooltips
`Jun 26, 2026`

Tooltips throughout — the start of the "shadcn only, never native controls" UI discipline.

## Explorer: a five-theme switcher
`Jun 26, 2026`

A switcher with 5 distinct themes, plus a popover/tooltip contrast fix.

## Clarifying the worker's SQL examples
`Jun 26, 2026`

Doc-only polish on the worker's example queries. Its own tiny step.

## Multiple MATCH columns per query
`Jun 26, 2026`

One query can `MATCH` several vector columns (AND'd), each contributing its own similarity — the
seed of the per-column score idea that gets rethought at month's end.

## A dedicated SQLite worker + DB API
`Jun 27, 2026`

Moved SQLite into a Web Worker with a clean database API — search off the main thread. The
architecture the explorer keeps to this day.

## Revisiting app structure: drop the db-client package
`Jun 27, 2026`

Removed the separate db-client package and rewired imports — collapsing an abstraction that wasn't
earning its keep.

## Per-embedding profiling log

The instrument that makes the next stretch of perf discoveries possible.

### Add the log + reset
`Jun 27, 2026`
A per-embedding profiling log with reset, so we could measure *individual* embeddings, not just
aggregates.

### Sharpen the microscope
`Jun 27, 2026`
Refined the log (timings, token counts, reset semantics) before putting it to use.

## Engines, threads & the performance investigation

One coherent investigation into how fast and how small the wasm could be — which engine, whether
threads help, and where the compute was actually going. It produced [our-findings.md](docs/our-findings.md)
and, in the middle of it, an embarrassing discovery and its fix.

### Make tract-st the real build target
`Jun 27, 2026`
Committed to Tract, single-threaded, as the default engine.

### A build variant that fails on purpose
`Jun 27, 2026`
`build:wasm:tract-mt` *exits 1 with an explanation* — a "tombstone" so the next person learns that
multi-threaded wasm gave no measurable gain.

### The findings doc
`Jun 27, 2026`
Started the running lab notebook where the perf story gets recorded rather than lost.

### A second engine: Candle
`Jun 27, 2026`
Added a Candle engine variant to compare; engine becomes a compile-time, mutually-exclusive feature.

### Measure real vs padding tokens
`Jun 27, 2026`
Instrumented real vs padding token counts per embedding — with a purpose.

### The 82%-wasted-on-[PAD] finding
`Jun 27, 2026`
Wrote it down: with fixed 128-token padding, ~82% of the compute was spent on `[PAD]` tokens.

### The padding fix
`Jun 27, 2026`
Padded to the *actual* length instead of the model's fixed 128. Since we embed one text at a time,
fixed padding was almost all waste — and had been skewing mean-pooling. (Don't reintroduce it.)

### Record the payoff
`Jun 27, 2026`
Captured the after-fix demo numbers. Measure, fix, re-measure.

### Revisiting threads: candle-mt, tract-mt still a tombstone
`Jun 27, 2026`
Added a `candle-mt` variant and re-documented why `tract-mt` is a dead end.

### The engine crossover sweep
`Jun 27, 2026`
A variable-length token sweep: Candle wins only for long docs (a crossover), and threads still
don't help. Data settling the engine debate.

### Distill findings into the README
`Jun 27, 2026`
Pulled the key numbers up into the README (and fixed a stale monorepo layout) — visible where people
actually look.

## Revisiting the model panel: token limits & links
`Jun 27, 2026`

Gave the model picker token limits, two-row dropdown items, and page links — a bare `<select>` made
informative.

## Revisiting build-variant naming
`Jun 27, 2026`

Renamed the variants to `[engine]-[format]-[threads]` and reserved `candle-native` — now that there
were several, they needed a scheme. (See [build-variants.md](docs/build-variants.md).)

## Renaming artifacts to sqlite-anki_*
`Jun 27, 2026`

`sqlite3* → sqlite-anki_*` so it's clear this is our build, not stock SQLite — while keeping the
upstream JS API namespace.

## Gitignoring Claude settings + worktrees
`Jun 27, 2026`

Housekeeping so personal tool settings and worktrees stay out of the repo.

## Going live: deploy + analytics

Shipping it, and knowing whether anyone uses it.

### CI builds the wasm and deploys
`Jun 27, 2026`
Vercel config + a GitHub Actions deploy that *builds the wasm in CI*. The project goes live.

### Analytics + engagement events
`Jun 27, 2026`
Vercel Web Analytics + Speed Insights + engagement events.

## Revisiting the schema tree: icons, pills, hover

A polish pass on the schema tree (first built with table descriptions on Jun 26).

### Type-affinity + qualifier icons
`Jun 27, 2026`
Read a column's shape at a glance.

### Streamline the column display
`Jun 27, 2026`
Cleaner rendering, same data.

### Qualifier pills, hover rows, sizing
`Jun 27, 2026`
Three small tweaks to the same tree.

## Splitting into workspaces (Phases 1 & 2)

The explorer grows from one screen into an IDE-shaped thing.

### Phase 1: activity bar + two workspaces
`Jun 27, 2026`
A VSCode-style activity bar and a split into **SQLite** and **OPFS** workspaces.

### Phase 2: the OPFS workspace
`Jun 27, 2026`
A recursive file tree, a tabbed editor, a storage status bar, and a sidebar width shared with the
SQLite workspace.

## Revisiting theming: management refactor
`Jun 27, 2026`

Refactored theme management and styles — consolidating the five-theme system into something
maintainable.

## Pinning pnpm for CI
`Jun 27, 2026`

Pinned pnpm via `packageManager` so CI could resolve the version. A one-liner that unbreaks the build.

## The read-only config.make CI fix
`Jun 28, 2026`

Made `build-wasm.sh` overwrite the read-only `config.make` so the CI build would succeed — the
vendored SQLite tree's read-only files meeting a fresh CI checkout.

## Revisiting the WHERE pre-filter: collation + exact int/real
`Jun 29, 2026`

Hardened the pre-filter to be collation-aware and to compare integers vs reals *exactly* (no
`as f64` precision loss past 2^53). The pre-filter's second life — and the hand-rolled comparison
logic it introduces is exactly what the July streaming redesign later *deletes* in favour of letting
SQLite compare. (See [query-planning.md](docs/query-planning.md).)

## CI: test before deploying
`Jun 29, 2026`

Made CI run the Rust unit + wasm e2e tests before deploying. Gate the deploy on green.

## Documenting pre-filter correctness (false +/-)
`Jun 29, 2026`

Wrote down the pre-filter's contract: it may over-return (SQLite re-checks) but must never wrongly
drop a row. This "conservative, omit=0" principle becomes load-bearing in July.

## CI: skip deploy on docs-only pushes
`Jun 29, 2026`

Made the deploy workflow ignore docs-only changes — don't rebuild and redeploy for a typo.

## README formatting pass
`Jun 29, 2026`

Formatting + documentation polish. Its own small step.

## README: live demo + TS quick-start
`Jun 29, 2026`

A live-demo link and a TypeScript quick-start, plus rendering-artifact fixes. Lowering the barrier to
try it.

## The similarity()-in-aggregate problem

Naming a wart, and encoding its fix as a red test.

### Document the workaround
`Jun 29, 2026`
Wrote down that `similarity()` inside an aggregate needed a MATERIALIZED-CTE workaround.

### A failing test that names the goal
`Jun 29, 2026`
Added a *failing* (todo) test for `similarity()` inside aggregates, plus regressions for the
workaround — encoding the desired end-state.

## The Design Choices doc
`Jun 29, 2026`

Added [design-choices.md](docs/design-choices.md) — rationale for the key decisions, explained on their
own terms (deliberately *not* framed against FTS5 or sqlite-vec).

## Revisiting similarity(): the `<col>_score` column

Replacing the function with a column — the reversal that made the failing test go green.

### Add the hidden score column
`Jun 29, 2026`
A query-time `<col>_score` column flows through SQLite as ordinary row data, so it works in
SELECT/WHERE/ORDER BY/GROUP BY *and* inside aggregates — no CTE workaround.

### Remove similarity() entirely
`Jun 29, 2026`
Deleted the function so there's exactly one surface for the score. Pre-1.0 discipline: one clean way,
no legacy alias.

### Sweep the docs
`Jun 29, 2026`
Replaced `similarity()` with `<col>_score` everywhere it had appeared.

## An fp16 model variant
`Jul 01, 2026`

An fp16 `all-MiniLM-L6-v2` registry entry — roughly half the download for a little precision.

## Noting the WebGPU path
`Jul 01, 2026`

Recorded the WebGPU acceleration path in the findings (§8) — a future direction captured while fresh,
not built.

## A CLAUDE.md for future sessions
`Jul 05, 2026`

Added `CLAUDE.md` — the standing instructions and map so future work (including everything below)
starts oriented.

## Import & Vectorize
`Jul 05, 2026`

The big feature of the day: upload an existing `.sqlite`, pick which TEXT columns to make
semantically searchable, and rebuild it into a sqlite-anki database with embeddings computed on
import — plus generated sample `MATCH` queries. Tables without picks are copied verbatim (full DDL
preserved); nothing picked persists the file unchanged. Building it forced a core fix: `Cell::Blob`,
because the vtab's `Cell` type had no blob variant, so a BLOB column in a vectorized table was
silently turning to NULL.

## Revisiting the import dialog: layout
`Jul 05, 2026`

Fixed the ImportDialog layout — the tables panel scrolls on its own while name/notes/actions stay
pinned, and the notes box has a two-line minimum.

## Revisiting the status bar: make metrics primary
`Jul 05, 2026`

Enlarged both workspaces' status bars — the per-operation embed/search/persist metrics are the point,
so they got more visual weight.

## The streaming-storage redesign

This session's big arc. Working through the vtab's memory use, we realized it *materializes the
entire table* — all columns and embeddings — into WASM linear memory at open (~2 GB cap); for a
20-column table with one vector column, 19/20 of the row data sits in RAM for nothing. We weighed
sqlite-vec's brute-force-from-disk model, chose to *keep* HNSW (and the `/exact` `/hnsw` DSL) but
*stream the storage*, and shipped it as five green commits. (Design: [streaming-storage.md](docs/streaming-storage.md).)

### The design
`Jul 05, 2026`
Wrote up the problem, the alternatives, and the plan in [streaming-storage.md](docs/streaming-storage.md).

### Sharpen the correctness argument
`Jul 05, 2026`
The false-+/- risk shifts from *semantic* (our comparison being wrong) to *mechanical* (translating a
constraint to SQL), since SQLite now does the comparing; plus the join RHS-binding rule and the
per-outer-row perf note.

### Step 1 — a type-full shadow table
`Jul 05, 2026`
Gave the shadow columns their declared types + `COLLATE` (positional `c{i}` names, to avoid colliding
with a user column named `id`), and a storage-format version guard that refuses pre-redesign DBs.

### Step 2 — let SQLite evaluate the WHERE
`Jul 05, 2026`
Replaced the hand-rolled pre-filter with a prepared `SELECT id FROM <name>_data WHERE …` on the typed
shadow table — *deleting* the `cell_passes`/`collated_cmp`/`cmp_int_real` cluster hardened back on
Jun 29. `omit=0` stays, so SQLite re-checks and the pre-filter only narrows.

### Step 3 — serve columns from disk
`Jul 05, 2026`
`xColumn` fetches user columns from the shadow table on demand (a reused per-cursor point lookup,
cached per row). A side effect surfaced: mixed-type inserts now take the column's affinity (text `'42'`
into an INTEGER column reads back as `42`).

### Step 4 — drop the cell cache (the payoff)
`Jul 05, 2026`
`Row` now holds only embeddings; `load_all` selects just `id, e{vi}`. The resident footprint becomes
**rowid + embeddings + HNSW** — the essentials — with all column data on disk.

### Step 5 — cache the query embedding for joins
`Jul 05, 2026`
A per-cursor `(col, text) → embedding` cache: in a join, SQLite re-enters `xFilter` once per outer row
with the same MATCH text, so it's now embedded once per query instead of per iteration.

## The roadmap

Consolidating what we deferred, then sharpening it after a good question.

### Add TODO.md
`Jul 05, 2026`
Consolidated the follow-ups that surfaced along the way (HNSW incremental insert, persist the graph,
int8 quantization, streaming the embeddings too, a session-level embedding cache, `omit=1`, indexing
filtered columns, the "rebuild required" UI, and the Import gaps). (See [TODO.md](docs/TODO.md).)

### Revisiting: what import really drops
`Jul 05, 2026`
Clarified that data, JOINs, and *plain-copied* tables' full DDL (incl. FKs) are preserved; the real gap
is secondary **indexes** (performance), plus triggers and constraints on *vectorized* tables. FK
enforcement is off by default in browser SQLite anyway.

## A CHANGELOG
`Jul 05, 2026`

Added [CHANGELOG.md](CHANGELOG.md) — the terse, date-sectioned ledger, curated from this same
history. The companion to this narrative.

## This document
`Jul 05, 2026`

The narrative you're reading — the "why," kept separate from the changelog so each can do its own job.
Written, then restructured to group consecutive commits under one section with per-commit sub-sections.
Add new sections at the bottom as the story continues.
