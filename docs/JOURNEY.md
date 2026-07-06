# The sqlite-anki journey

A narrative, chronological account of how this project was built — the decisions, the
walls we hit, the reversals, and the small stuff too. Unlike [CHANGELOG.md](../CHANGELOG.md)
(a terse "what changed, when" ledger) and the design docs (the *what/how* of a finished
piece), this is the *why* and the *story*: read it top-to-bottom like a log book.

Each step is its own section in commit order — even minor ones, and even when several
belong to the same theme. When we come back to something we'd already built, the heading
says **"Revisiting…"**.

---

## Jun 23 — The founding bet: put the model *inside* SQLite

The initial commit stakes the whole thesis: semantic search where the embedding model
runs *inside* SQLite (Rust compiled to WASM), so there's no embedding API, no service, and
no JavaScript on the query hot path. `WHERE col MATCH 'text'` should feel like a native SQL
capability. Everything after this is in service of that bet. (Spec: [DESIGN.md](./DESIGN.md).)

## Jun 23 — Writing the spec (and rewriting it, and rewriting it)

A run of README/DESIGN passes (`960d197`, `5eb6de1`, `1b6ab9c`, `126c260`, `3245af5`)
hammered out the shape before much code existed: the `anki` virtual table, `TEXT VECTOR`
columns, query semantics, NULL/empty handling, parameterized `MATCH`, the monorepo layout,
and the choice of the HNSW crate. Iterating the prose first was a way to think — the design
churned here so the code wouldn't have to later.

## Jun 23 — The build pipeline: link Rust into the *official* SQLite wasm

Rather than hand-roll a wasm, the build compiles `anki-core` to a static library and links
it into SQLite's own `ext/wasm` build (`fd74851`), pulling in ONNX and gitignoring the
vendored SQLite + Emscripten trees. This "ride the official build" decision is why the JS
API namespace stays upstream's and only the artifact names differ.

## Jun 23 — Trimming the staticlib wiring

`d25d9da` cleaned up `Cargo.lock` and `build.rs` to conditionally set the embedded-model
config and get Emscripten linking of the staticlib right. Small, but it's the seam that made
the "Rust inside SQLite's wasm" approach actually link.

## Jun 24 — Fighting Emscripten for SQLite 3.49

`408f88f`: the link needed extra runtime methods (`HEAPU64`, `HEAP64`) exposed or SQLite
3.49 would fault at runtime. The kind of environment-specific paper cut that costs an
afternoon and one line.

## Jun 24 — `panic = "abort"` and taming ONNX output shapes

`2ed48d4` made two consequential calls. First, release builds abort on panic — because
unwinding across the FFI boundary into SQLite's C is undefined behavior and Emscripten can't
lower the unwind. (This is why, to this day, we prefer returning `AnkiError` over panicking
on any load/inference path.) Second, the embedder learned to handle the various ONNX output
shapes and mean-pool correctly. The `anki` vtab module got registered in the wasm extension.

## Jun 24 — Shadow-table persistence

`eafc587` taught the vtab to persist: prepared-statement handling and a real backing
"shadow" table so rows (and later, embeddings) survive. The virtual table you query and the
real table that stores bytes become two separate things here.

## Jun 24 — Transactions, and reloading the cache on rollback

`7d0abf5` added transaction handling with a lazy cache reload on rollback — if a transaction
rolls back the shadow table, the in-memory cache must re-sync to match. A correctness detail
that would quietly matter for years.

## Jun 24 — Bringing in HNSW

`8da40f2` refactored in an HNSW index for approximate nearest-neighbour search — the bet
that we'd want sub-linear vector search, not just brute force.

## Jun 24 — Making HNSW lazy

`07e8bc6` made the index lazy-loading and optimized search around it — build/consult the
graph only when needed, for memory efficiency. (Years later this same "when is the index
built?" question resurfaces in the streaming redesign.)

## Jun 25 — The size wall: stop bundling the model

`c024d75` is a pivot. Bundling the ONNX weights into the wasm made it enormous. So the model
became a **runtime** artifact: the wasm links a full ONNX engine but *no weights*; the model
is fetched by id or URL/bytes, cached in OPFS, and handed to the extension at load. The
embedding *dimension* becomes a property of the loaded model, not a constant.
(See [dynamic-model-loading.md](./dynamic-model-loading.md).)

## Jun 25 — Naming the package and adding a test harness

`77d18c0` renamed artifacts to `@sqlite-anki/wasm` and added an integration test harness
that loads the real wasm + real model under Node — the e2e layer that would gate every
change from here on.

## Jun 25 — Hybrid filtering: the first WHERE + MATCH pushdown

`7b7f529` added relational `WHERE` + semantic `MATCH` in one statement, with a pre-filter:
rank only the rows passing the filter instead of ranking everything and filtering after
(which would drop matching rows off the similarity "cliff"). This is the first cut of what
becomes a long correctness saga. (See [hybrid-filtering.md](./hybrid-filtering.md).)

## Jun 25 — Documenting the vtab lifecycle in the code

`c0efce3` wasn't behavior — it was heavy inline comments on the SQLite integration and vtab
lifecycle. Worth its own line because "explain the C ABI contract in the source" became a
standing convention.

## Jun 25 — The MATCH DSL

`af3a6e9` gave users a per-query strategy knob: `/exact` vs `/hnsw:N`, parsed from the MATCH
string. Small syntax, big control — and a surface we'd guard fiercely later.
(See [match-dsl.md](./match-dsl.md).)

## Jun 25 — `anki_metrics()`

`cbb3090` added operation metrics + instrumentation so the cost of embedding vs search vs
persist is observable, not guessed. (See [metrics.md](./metrics.md).)

## Jun 25 — Explorer groundwork: deps + structure

`de4ea38` — unglamorous dependency and structure updates for the explorer app. Noting it
because it's where the demo SPA starts taking shape.

## Jun 25 — Explorer: notes

`aba8479` added a per-database notes feature (Markdown sidecar). The first of many small
explorer affordances.

## Jun 25 — Explorer: a WHERE-clause search toolbar (and a Vite wasm fix)

`28ffb4b` added a search toolbar and fixed Vite dev wasm loading — the recurring "the
bundler must rewrite the wasm URL" gotcha of shipping a custom sqlite3.wasm.

## Jun 26 — Explorer: model registry + an animated load gate

`fb3ac84` expanded the model registry and added a model-details gate with an animated load —
the first-run screen where you pick a model before anything else.

## Jun 26 — Explorer: a persistent SQL editor

`7ca4d97` made the SQL editor persistent with run-selection, kept across tab switches — so
your query, results, and selection survive navigation. (This "keep it mounted" pattern
recurs across the explorer.)

## Jun 26 — Explorer: Markdown preview in notes

`9a1fcc8` added a rendered Markdown preview toggle to the notes editor. Small polish.

## Jun 26 — SIMD: ~2× faster embedding

`2462a02` built the wasm with `+simd128`, roughly doubling embedding throughput — the single
biggest cheap perf win. (See [our-findings.md](./our-findings.md).)

## Jun 26 — Explorer: the rich demo database

`6b8e501` added the CRM + knowledge-base demo (~870 rows) behind a Populate button — the
thing that makes the project *show* rather than *tell*, with multiple `TEXT VECTOR` columns
across realistic tables.

## Jun 26 — Explorer: an elapsed-time ticker during populate

`c844947` added elapsed-time tracking during demo population — because embedding hundreds of
rows in-browser is slow and silence feels broken. Motion == trust.

## Jun 26 — Schema tree gains table descriptions

`fe11a9f` enhanced the SchemaTree + schema with table descriptions (parsed from inline `--`
comments in the CREATE text). Turning SQLite's preserved DDL comments into UI.

## Jun 26 — Explorer: tooltips

`4b56ddd` added tooltips throughout. Minor — but it's the start of the "shadcn only, never
native controls" UI discipline.

## Jun 26 — Explorer: a five-theme switcher

`1cc6b8f` added a theme switcher (5 distinct themes) and fixed popover/tooltip contrast.

## Jun 26 — Clarifying the worker's SQL examples

`27cf849` — doc-only polish on the worker's example queries. Kept separate because it's its
own tiny step.

## Jun 26 — Multiple MATCH columns per query

`8549943` let one query `MATCH` several vector columns (AND'd), each contributing its own
similarity — the seed of the per-column score idea that gets rethought at the end of the
month.

## Jun 27 — A dedicated SQLite worker + DB API

`1dee665` moved SQLite into a Web Worker with a clean database API — search off the main
thread. The architecture the explorer keeps to this day.

## Jun 27 — Revisiting app structure: drop the db-client package

`3f43e70` removed the separate db-client package and rewired imports — collapsing an
abstraction that wasn't earning its keep.

## Jun 27 — Per-embedding profiling log

`5a98439` added a per-embedding profiling log + reset, so we could measure *individual*
embeddings, not just aggregates. This instrument makes the next week's perf discoveries
possible.

## Jun 27 — Revisiting the profiling log: enhancements

`7e19bdd` refined that log (timings, token counts, reset semantics). Separate step, same
tool — sharpening the microscope before using it.

## Jun 27 — Naming the real build target

`15eb6dd` made `build:wasm:tract-st` the actual build target — committing to Tract,
single-threaded, as the default engine.

## Jun 27 — A build variant that fails on purpose

`b27bea5` added `build:wasm:tract-mt` that *exits 1 with an explanation*. A "tombstone":
multi-threaded wasm gave no measurable gain, so the variant exists only to tell the next
person why not to bother.

## Jun 27 — The performance & size findings doc

`42c7879` started [our-findings.md](./our-findings.md) — the running lab notebook where the
perf story gets recorded rather than lost.

## Jun 27 — A second engine: Candle

`f9fcd5f` added a Candle engine variant alongside Tract, to compare. Engine becomes a
compile-time feature, the two mutually exclusive.

## Jun 27 — Measuring real vs padding tokens

`4ce98d9` recorded real vs padding token counts per embedding. Instrumentation with a
purpose — it's about to expose something embarrassing.

## Jun 27 — The 82%-wasted-on-[PAD] finding

`361bb7d` wrote it down: with fixed 128-token padding, ~82% of the compute was spent on
`[PAD]` tokens. A measurement that demanded a fix.

## Jun 27 — The padding fix

`8147cd2` stopped padding to the model's fixed 128 and padded to the *actual* length. Since
we embed one text at a time, fixed padding was almost all waste — and it had also been
skewing mean-pooling. (To this day, don't reintroduce fixed padding.)

## Jun 27 — Recording the payoff

`361b371` captured the after-padding-fix demo numbers in the findings. Close the loop:
measure, fix, re-measure.

## Jun 27 — Revisiting threads: candle-mt, and why tract-mt stays a tombstone

`0b8127f` added a `candle-mt` variant and documented, again, why `tract-mt` is a dead end.
The threads question keeps getting asked; the answer keeps being "no."

## Jun 27 — The engine crossover sweep

`0dbc7df` added a variable-length token sweep to the findings: Candle wins only for long
docs (an engine crossover), and threads still don't help. Data settling the engine debate.

## Jun 27 — Distilling findings into the README

`92f4f9b` pulled the key perf findings up into the README (and fixed a stale monorepo
layout). Make the hard-won numbers visible where people actually look.

## Jun 27 — Model panel polish

`461ddfc` gave the model picker token limits, two-row dropdown items, and page links —
turning a bare `<select>` into something informative.

## Jun 27 — Revisiting build-variant naming

`54981de` renamed the variants to `[engine]-[format]-[threads]` and reserved
`candle-native`. Now that there were several, they needed a scheme.
(See [build-variants.md](./build-variants.md).)

## Jun 27 — Renaming artifacts to sqlite-anki_*

`75fd2be` renamed the emitted files `sqlite3* → sqlite-anki_*` so it's clear this is our
build, not stock SQLite — while keeping the upstream JS API namespace.

## Jun 27 — Gitignoring Claude settings + worktrees

`1b942ab` — housekeeping so personal tool settings and worktrees stay out of the repo.

## Jun 27 — CI: build the wasm and deploy

`edec074` added Vercel config + a GitHub Actions deploy that *builds the wasm in CI*. The
project goes live.

## Jun 27 — Analytics + engagement events

`b52355c` added Vercel Web Analytics + Speed Insights + engagement events. Knowing whether
anyone uses it.

## Jun 27 — Schema tree: affinity + qualifier icons

`2963208` added type-affinity icons and qualifier icons to the schema tree — reading a
column's shape at a glance.

## Jun 27 — Revisiting the schema tree: streamline columns

`6f9fb28` refactored the column display. Same component, cleaner rendering.

## Jun 27 — Revisiting the schema tree again: pills, hover, sizing

`7fb8ae2` added qualifier pills, hover rows, and larger column rows. Three tweaks to the same
tree — kept distinct on purpose.

## Jun 27 — Phase 1: an activity bar and two workspaces

`fbc6c9f` added a VSCode-style activity bar and split the app into **SQLite** and **OPFS**
workspaces. The explorer grows from one screen into an IDE-shaped thing.

## Jun 27 — Phase 2: the OPFS workspace

`8c1d77f` fleshed out the OPFS workspace: a recursive file tree, a tabbed editor, a storage
status bar, and a sidebar width shared with the SQLite workspace.

## Jun 27 — Revisiting theming: management refactor

`451baa9` refactored theme management and styles — consolidating the five-theme system into
something maintainable.

## Jun 27 — Pinning pnpm for CI

`2e5a9df` pinned pnpm via `packageManager` so CI could resolve the version. A one-liner that
unbreaks the build.

## Jun 28 — The read-only config.make CI fix

`2e9757b` made `build-wasm.sh` overwrite the read-only `config.make` so the CI build would
succeed — the vendored SQLite tree shipping read-only files, meeting a fresh CI checkout.

## Jun 29 — Revisiting the WHERE pre-filter: collation + exact int/real

`3595f48` hardened the pre-filter to be collation-aware and to compare integers vs reals
*exactly* (no `as f64` precision loss past 2^53). This is the pre-filter's second life — and
the hand-rolled comparison logic it introduces is exactly what the July streaming redesign
later *deletes* in favour of letting SQLite compare. (See [query-planning.md](./query-planning.md).)

## Jun 29 — CI: test before deploying

`58bde81` made CI run the Rust unit + wasm e2e tests before deploying. Gate the deploy on
green.

## Jun 29 — Documenting pre-filter correctness (false +/-)

`af0e325` wrote down the pre-filter's correctness contract: it may over-return (SQLite
re-checks) but must never wrongly drop a row. Plus a README rework. This "conservative,
omit=0" principle becomes load-bearing later.

## Jun 29 — CI: skip deploy on docs-only pushes

`3d4d15c` made the deploy workflow ignore docs-only changes (`paths-ignore`) — don't rebuild
and redeploy for a typo fix.

## Jun 29 — README formatting pass

`44d35bb` — formatting + documentation polish. Its own small step.

## Jun 29 — README: live demo + TS quick-start

`34abede` added a live-demo link and a TypeScript quick-start, and fixed rendering
artifacts. Lowering the barrier to try it.

## Jun 29 — Documenting the similarity()-in-aggregate workaround

`aa80cef` documented that `similarity()` inside an aggregate needed a MATERIALIZED-CTE
workaround. Writing down a wart is the first step to removing it.

## Jun 29 — A failing test that names the goal

`e71977d` added a *failing* (todo) test for `similarity()` inside aggregates, plus regression
tests for the workaround. Encoding the desired end-state as a red test.

## Jun 29 — The Design Choices doc

`079a9ab` added [design-choices.md](./design-choices.md) — the rationale for the key
decisions, explained on their own terms (deliberately *not* framed against FTS5 or
sqlite-vec).

## Jun 29 — Revisiting similarity(): the `<col>_score` column

`bf2aa6e` replaced the function idea with a hidden, query-time `<col>_score` column: it flows
through SQLite as ordinary row data, so it works in SELECT/WHERE/ORDER BY/GROUP BY *and*
inside aggregates — no CTE workaround. The failing test from earlier goes green.

## Jun 29 — Removing similarity() entirely

`0f7f2d4` deleted the `similarity()` function so there's exactly one surface for the score.
Pre-1.0 discipline: one clean way, no legacy alias.

## Jun 29 — Propagating the `<col>_score` change through the docs

`9717159` swept the docs to use `<col>_score` everywhere `similarity()` had appeared. Keep
the story consistent.

## Jul 1 — An fp16 model variant

`3c5a4f7` added an fp16 `all-MiniLM-L6-v2` registry entry — roughly half the download for
users willing to trade a little precision.

## Jul 1 — Noting the WebGPU path

`785fc29` recorded the WebGPU acceleration path in the findings (§8) — a future direction
captured while it was fresh, not built.

## Jul 5 — A CLAUDE.md for future sessions

`e362c57` added `CLAUDE.md` — the standing instructions and map so future work (including
everything below) starts oriented.

## Jul 5 — Import & Vectorize

`c3a6c6b` shipped the big feature of the day: upload an existing `.sqlite`, pick which TEXT
columns to make semantically searchable, and rebuild it into a sqlite-anki database with
embeddings computed on import — plus generated sample `MATCH` queries. Tables without picks
are copied verbatim (their full DDL preserved); nothing picked persists the file unchanged.
Building it forced a core fix: `Cell::Blob`, because the vtab's `Cell` type had no blob
variant, so a BLOB column in a vectorized table was silently turning to NULL.

## Jul 5 — Revisiting the import dialog: layout

`aa438f2` fixed the ImportDialog layout — the tables panel scrolls on its own while the
database-name/notes/actions stay pinned, and the notes box has a two-line minimum. UI polish
on the just-shipped feature.

## Jul 5 — Revisiting the status bar: make metrics primary

`5e5e340` enlarged the status bars (both workspaces) — the per-operation embed/search/persist
metrics are the point, so they got more visual weight.

## Jul 5 — The WASM-RAM realization, written up as a design

`b23aeff` is where this session's big arc begins. Working through how the `anki` vtab uses
memory, we realized it *materializes the entire table* — all columns and embeddings — into
WASM linear memory at open, capped at ~2 GB. For a 20-column table with one vector column,
19/20 of the row data sits in RAM for no reason. We weighed sqlite-vec's brute-force-from-disk
model, decided to *keep* HNSW (and the `/exact` `/hnsw` DSL) but *stream the storage*, and
wrote it all down in [streaming-storage.md](./streaming-storage.md).

## Jul 5 — Revisiting the design: sharpening correctness

`efe0262` refined the design doc's correctness section: the false-+/- risk shifts from
*semantic* (our hand-rolled comparison being wrong) to *mechanical* (translating a
constraint into SQL), because SQLite will now do the comparing; plus the join RHS-binding
rule and the per-outer-row perf note.

## Jul 5 — Streaming, step 1: a type-full shadow table

`bdd1802` gave the shadow table's data columns their declared types + `COLLATE` (kept
positional `c{i}` names to avoid colliding with a user column named `id`), so a `WHERE` run
directly on the shadow table matches SQLite's affinity/collation. Added a storage-format
version guard that refuses to open pre-redesign DBs with a clear "rebuild required."

## Jul 5 — Streaming, step 2: let SQLite evaluate the WHERE

`149f2f7` replaced the hand-rolled pre-filter with a prepared `SELECT id FROM <name>_data
WHERE …` on the typed shadow table — SQLite does the comparison, so the whole
`cell_passes`/`collated_cmp`/`cmp_int_real` cluster (the very code hardened back on Jun 29)
gets *deleted*. `omit=0` stays, so SQLite re-checks and the pre-filter can only narrow.

## Jul 5 — Streaming, step 3: serve columns from disk

`efa9639` made `xColumn` fetch user columns from the shadow table on demand (a reused
per-cursor point lookup, cached per row) instead of from the in-RAM cache — the read side of
"don't keep columns in RAM." A side effect became visible here: mixed-type inserts now take
the column's affinity (text `'42'` into an INTEGER column reads back as `42`).

## Jul 5 — Streaming, step 4: drop the cell cache (the payoff)

`e2eeea3` is the reward: `Row` now holds only its embeddings, `load_all` selects just
`id, e{vi}`, and writes cache only embeddings. The resident footprint becomes **rowid +
embeddings + HNSW** — exactly the essentials — with all column data on disk.

## Jul 5 — Streaming, step 5: cache the query embedding for joins

`6639d5f` added a per-cursor `(col, text) → embedding` cache. In a join, SQLite re-enters
`xFilter` once per outer row with the same MATCH text; without the cache we re-embed it every
iteration (the dominant cost). Now it's embedded once per query.

## Jul 5 — A roadmap for what we deferred

`ac6d334` added [TODO.md](./TODO.md), consolidating the follow-ups that surfaced along the
way: HNSW incremental insertion, persisting the HNSW graph, int8 quantization, streaming the
embeddings too ("Option B"), a session-level embedding cache, the `omit=1` optimization,
indexing filtered shadow columns, the "rebuild required" UI, and the Import & Vectorize gaps.

## Jul 5 — Revisiting the roadmap: what import really drops

`f461ecf` sharpened the import fidelity item after a good question: data, JOINs, and
*plain-copied* tables' full DDL (incl. FKs) are preserved; the real gap is secondary
**indexes** (a performance loss), plus triggers and constraints on *vectorized* tables. FK
enforcement is off by default in browser SQLite anyway.

## Jul 5 — A CHANGELOG

`e4101bb` added [CHANGELOG.md](../CHANGELOG.md) — the terse, date-sectioned ledger, curated
from this same history, with each entry linking to its design doc. The companion to this
narrative.

## Jul 5 — This document

The narrative you're reading — the "why" and the "journey," kept separate from the changelog
so each can do its own job. Add new sections at the bottom as the story continues.
