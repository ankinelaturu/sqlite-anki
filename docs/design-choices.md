# Design choices

Why sqlite-anki is shaped the way it is. Each decision below starts from one
problem — *semantic search expressed in ordinary SQL, over your own data, running
in the browser* — and follows it to the design, including the costs we accept.

## 1. Text and its embedding live in one table

A `TEXT VECTOR` column stores text; its embedding is generated and stored
automatically on write. You query the text directly with `col MATCH 'query'`.

**Why.** The whole point is to ask your data a question without standing up a
second system. The moment embeddings live in a separate store, you also own the
plumbing that keeps the two in sync and the joins that recombine them — a second
source of truth that can drift out from under the first. Keeping the text and its
embedding in the same row means there is nothing to synchronize and nothing to
join: write text, search meaning.

**Cost we accept.** A virtual-table column has no native b-tree index, so ordinary
relational filters can't be index-accelerated; we evaluate them in memory during
the scan. We took that cost deliberately to keep the one-table model.

## 2. Each vector column is an independent semantic field

A table may have several `TEXT VECTOR` columns. Each is searched on its own, and
each produces its own similarity.

**Why.** A real row usually holds more than one kind of text — a short summary, a
long note, a title. "How well does the *summary* match?" is a genuinely different
question from "how well do the *notes* match?", and you often want to rank on one
specifically. Collapsing them into a single combined relevance would throw away
exactly the distinction you'd want to query on. So matching is per column — and,
because each match answers a different question, so is the score.

## 3. A similarity score is data about a (row, query) pair — so it is a column

This is the load-bearing decision, and it has three parts.

**A score cannot be stored.** An embedding depends only on the row's own text, so
it is computed once and written alongside the row. A similarity depends on the row
*and the query* — it exists only relative to a specific `MATCH`. At write time
there is no query, and every query produces different numbers, so there is simply
nothing to persist.

**A score must work everywhere a value works.** You want to `ORDER BY` it,
threshold it in `WHERE`, group by it, and aggregate it — for example, the best or
average match per category. The only thing the SQL engine carries correctly
through sorting, grouping, aggregation, and subqueries is **row data**: a column.
A value reconstructed from transient scan state survives the simplest per-row read
but silently becomes `NULL` the moment the engine buffers or reorders rows — which
is exactly what aggregation does.

**Therefore the score is a column**, named `<col>_score`, filled in during the
scan and read back per row. There is one way to obtain a score, and it behaves the
same in every position a value can appear. (A per-row *function* would be a second,
weaker way to get the same number — one that quietly fails inside aggregates — so
we don't keep one.)

**It is computed lazily.** A score is produced only for the columns a query
actually matches. `<col>_score` for a column with no active `MATCH` in that query
is `NULL` — no embedding, no comparison, no work. The cost scales with the number
of matched columns in the query (usually one), not with how many vector columns
the table happens to have.

## 4. Embeddings are write-time and stored; scores are read-time and computed

The two values look parallel — one extra slot per vector column — but their
lifecycles are opposites, and that asymmetry explains the whole model:

| | embedding | score |
|------------------|---------------------|----------------------------|
| depends on | the row's text | the row **and** the query |
| computed | once, on `INSERT`/`UPDATE` | every query, during the scan |
| stored on disk | yes | no — transient |
| with no `MATCH` | present | `NULL` |

One is a stored hidden column; the other is a computed hidden column. A score is
meaningless — and therefore `NULL` — until a query gives it something to be
relative to.

## 5. The relational pre-filter only ever narrows

When a query combines ordinary predicates with `MATCH`, the predicates run first
to shrink the candidate set, and similarity ranks the survivors.

**Why.** Ranking everything first and filtering afterward can bury good matches
behind a candidate cap; filtering first keeps results complete. But the pre-filter
is strictly an *optimization*, never the source of truth — the engine still
re-checks every row we emit. That gives an asymmetry we lean on: we may
*over-include* (the re-check discards extras), but we must never *drop* a row that
belongs, because a row we never emit can't be recovered.

That single rule drives the details: when a comparison is uncertain (a `NULL` or a
cross-type pair) we **keep** the row and let the engine decide; and where we *do*
decide — text collation, integer-vs-float precision — we match the engine's own
comparison exactly, so we never narrow away a row it would have kept. (Full
treatment in [hybrid-filtering.md](./hybrid-filtering.md).)

## 6. Embedding happens inside the database

The model runs in-process — Rust compiled to WebAssembly — and the query path
computes embeddings itself rather than calling out to anything.

**Why.** The product is "search your data where it lives." A network hop to an
embedding service would attach a remote dependency, added latency, and a
data-egress question to every write and every query. In-process keeps the system
self-contained: the data, the index, and the model are all in the page. (The model
*file* is downloaded and loaded at startup rather than baked into the build — see
[dynamic-model-loading.md](./dynamic-model-loading.md).)
