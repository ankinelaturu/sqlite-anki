# HNSW index

The approximate-nearest-neighbor index behind `WHERE col MATCH 'text'`. It lives
entirely in one file — [`crates/anki-core/src/hnsw.rs`](../crates/anki-core/src/hnsw.rs) —
as a compact, dependency-free HNSW (Hierarchical Navigable Small World) graph. This doc
explains what it is, how it searches, how it grows and shrinks incrementally, and how it
is persisted so a reopen skips the rebuild.

For *why* it's hand-rolled rather than a crate, see [design-choices.md §7](./design-choices.md)
and [DESIGN.md §9](./DESIGN.md). For where it sits in the write/query path, see
[query-planning.md](./query-planning.md) and [streaming-storage.md](./streaming-storage.md).

## What HNSW is, briefly

Exact similarity search is O(N) per query — compute the cosine of the query against every
stored vector. HNSW trades a little accuracy for a lot of speed by organizing the vectors
into a **layered proximity graph**:

- Every vector is a **node** on layer 0. Each node is also promoted to a random number of
  higher layers, with exponentially fewer nodes on each layer up. The tall nodes form
  sparse "express lanes."
- A search starts at the top layer's entry point and **greedily walks toward the query**,
  dropping down a layer each time it can't get closer, until it does a fuller local search
  on layer 0. This is ~O(log N) hops instead of a full scan.

Because the embedder L2-normalizes every vector, **cosine similarity is just the dot
product**, and we use `distance = 1 - dot` throughout. `search` returns similarity
(`1 - distance`), best-first.

## Data model

One `Hnsw` is built **per `TEXT VECTOR` column** per table. Its fields:

| Field | Meaning |
|-------|---------|
| `vectors: Vec<Vec<f32>>` | stored vectors, indexed by internal **node id** (`0..N`) |
| `ids: Vec<i64>` | node id → user **rowid** |
| `neighbors: Vec<Vec<Vec<u32>>>` | `neighbors[node][level]` = neighbor node ids at that layer |
| `dead: Vec<bool>` | tombstones — removed nodes (see [Incremental remove](#incremental-remove)) |
| `id_to_node: HashMap<i64, u32>` | live rowid → node id, for O(1) `remove` |
| `entry: Option<u32>` | the top-layer entry node |
| `max_level: usize` | highest layer index in the graph |
| `ml: f64` | level-generation constant, `1 / ln(M)` |
| `rng: u64` | SplitMix64 state for random level assignment |

**Node id vs rowid.** Internally the graph addresses nodes by dense position (`0..N`);
`ids[node]` maps back to the SQLite rowid that `search` returns. The two diverge after
deletes and rebuilds — don't assume `node == rowid`.

### Tuning constants

| Constant | Value | Role |
|----------|-------|------|
| `M` | 16 | max neighbors per node above layer 0 |
| `M0` | 32 (`2·M`) | max neighbors on layer 0 |
| `EF_CONSTRUCTION` | 100 | candidate-list width while inserting |
| `ml` | `1/ln(M)` | scales the exponential level distribution |

The **query-time** knobs live in the vtab, not here: the default candidate cap
(`HNSW_CANDIDATE_CAP`) and the `0.5` similarity threshold
(`DEFAULT_SIMILARITY_THRESHOLD`) are applied by the `MATCH` path in `vtab.rs`, and the
`/hnsw:N` MATCH directive overrides the cap per query (see [match-dsl.md](./match-dsl.md)).

## Build

`Hnsw::build(&[(rowid, vector)])` seeds a fresh graph and loops the private `insert` over
every point (returns `None` for an empty input). `insert` is the core primitive:

1. **Pick a level** via `next_level()` — advance `rng` (SplitMix64), map it to a uniform
   `u ∈ (0,1)`, and take `⌊-ln(u) · ml⌋`. This is the exponential distribution that makes
   most nodes layer-0-only and a few tall.
2. **Descend** from the current entry through the layers above the new node's top level,
   greedily following the closest neighbor (`search_layer` with `ef = 1`).
3. **Connect** from the new node's top level down to 0: run `search_layer` with
   `EF_CONSTRUCTION` to gather candidates, pick up to `M` (or `M0` on layer 0) with the
   neighbor-selection heuristic, and add bidirectional edges. If a neighbor exceeds its
   degree cap, `prune` re-selects its edges.
4. If the new node is taller than the current graph, it becomes the new `entry`.

### Neighbor-selection heuristic

`select_neighbors` implements the paper's Algorithm 4, not naive "closest M." A candidate
is kept only if it is closer to the base node than to any already-selected neighbor. This
spreads edges around the base and keeps the graph **connected** — plain closest-M pruning
can strand nodes, which showed up as exact matches going missing at moderate N (guarded by
the `exact_nearest_always_retrieved` test). If the heuristic can't reach `M`, it back-fills
with the remaining closest candidates.

## Search

`search(query, k, ef)`:

1. Start at `entry`; for each layer from `max_level` down to 1, take one greedy step
   (`search_layer` with `ef = 1`) to refine the entry for the layer below.
2. On layer 0, run `search_layer` with beam width `ef.max(k)`.
3. **Filter out tombstoned nodes**, take the top `k`, and map each to `(rowid,
   similarity)` where `similarity = 1 - distance`.

`search_layer` is the greedy best-first primitive: a min-heap of candidates and a bounded
max-heap of the current best `ef`, expanding the closest unvisited node until nothing can
improve the result set. It borrows a shared `visited` scratch buffer and restores it before
returning (so it can be reused across layers without reallocation).

## Incremental insert

`add(rowid, vector)` splices a single node into a **live** graph in ~O(log N), so an
`INSERT`/`UPDATE` doesn't have to rebuild the whole index. It's the same `insert` primitive
`build` loops — `add` just manages its own `visited` scratch and first calls `remove(rowid)`
so a re-added rowid resolves to exactly one live node. See
[the incremental-insertion note](./TODO.md) (roadmap "Done") for the write-path wiring.

## Incremental remove

`remove(rowid)` is an **O(1) tombstone**, not a surgical unstitch:

- It looks up the node via `id_to_node`, sets `dead[node] = true`, and drops the map entry.
- The dead node **stays wired into the graph as a routing hop** (so the graph stays
  connected) but is **filtered out of `search` results** — that filtering is mandatory for
  correctness, because the `MATCH` fast path returns the rowids `search` yields without
  re-checking them against storage.
- Tombstones accumulate until a full `build` (rebuild) or a `serialize` **compacts them
  away**.

This keeps deletes cheap. The cost is a slow drift in graph quality under heavy churn (a
node whose neighbors were all deleted can get stranded), which the occasional rebuild fixes.

## Persistence

The built graph normally lives only in WASM RAM and is rebuilt from the shadow table's
`anki_emb_<col>` blobs on the first `MATCH` after open — an O(N) CPU spike. `serialize` /
`deserialize` remove that spike by caching the graph to the `<name>_anki_hnsw` shadow
table (storage format v5; see [streaming-storage.md](./streaming-storage.md)).

**Topology only.** `serialize` writes the graph structure — ids, adjacency, entry, levels,
`rng` — but **not the vectors**, which already sit in `anki_emb_<col>`. On load,
`deserialize` rehydrates each node's vector from those blobs (by rowid) via a caller-supplied
closure. This avoids storing every 384-float vector twice.

**Compaction.** `serialize` drops tombstoned nodes, remaps the survivors to a dense
`0..live` range, rewrites neighbor lists to the new indices, and re-picks a live top-layer
node as the entry — necessary because a deleted rowid's vector is gone and couldn't be
rehydrated. Returns `None` if no live nodes remain.

### Blob layout

All integers little-endian. A fixed 24-byte header, then one variable-length record per
node (and, within it, per level):

| Section                  | Field        | Type           | Notes                                  |
|--------------------------|--------------|----------------|----------------------------------------|
| Header                   | `version`    | `u32`          | `GRAPH_FORMAT` (currently `1`)         |
|                          | `node_count` | `u32`          | number of live nodes                   |
|                          | `max_level`  | `u32`          | top layer index                        |
|                          | `entry`      | `u32`          | entry node index, or `u32::MAX` = none |
|                          | `rng`        | `u64`          | SplitMix64 state (for future inserts)  |
| Per node (×`node_count`) | `id`         | `i64`          | rowid                                  |
|                          | `levels`     | `u32`          | number of layers this node is on       |
| Per level (×`levels`)    | `degree`     | `u32`          | neighbor count at this layer           |
|                          | `neighbors`  | `u32`×`degree` | neighbor **node indices** (not rowids) |

Worked size for a 10-node graph where one node is on 2 layers with 9 neighbors and the rest
are on 1 layer with 9 neighbors: `24 (header) + 56 (tall node) + 9·52 = 548 bytes`. The
vectors for those 10 nodes are elsewhere — 10 × 1536 bytes in `anki_emb_<col>`.

It is **not** a standard format (FAISS/usearch/`hnsw_rs` each have their own); it's bespoke
because our needs are narrow — topology-only, tombstone-compacting, and versioned so it can
evolve. `GRAPH_FORMAT` is independent of the shadow `storage_format`: the graph is an
optional cache, so a version bump just falls back to a rebuild instead of refusing to open
the table.

### Defensive parsing

`deserialize` reads through a bounds-checked `Reader` cursor: every field access returns
`None` past the end of the buffer, neighbor indices are range-checked against `node_count`,
and nothing is pre-allocated from an untrusted length. A truncated, corrupt, or
version-mismatched blob — or one referencing a rowid whose vector is missing — yields `None`,
and the caller quietly rebuilds. This matters because the release profile is
`panic = abort`: a panic while parsing on-disk bytes would take down the whole wasm
instance, so parsing must never panic.

## Integration with the virtual table

`hnsw.rs` is pure graph logic; all the wiring is in `vtab.rs`:

- **Build / rebuild** — `rebuild_indexes` builds one `Hnsw` per vector column from the
  in-RAM embedding cache. It's the fallback path: first build after open, and resync after
  a rollback or a `REPLACE`/`IGNORE` write.
- **Query** — the single-`MATCH`, no-filter fast path calls `search`; other paths
  (multi-`MATCH`, `MATCH` + `WHERE`, `/exact`) use exact cosine over the (pre-filtered)
  rows and don't touch the graph. See [hybrid-filtering.md](./hybrid-filtering.md).
- **Writes** — `x_update` splices via `index_add_row` / `index_remove_row` when the index
  is live, else defers to a pending rebuild.
- **Persistence** — `save_graphs` (in `xSync`, inside the committing txn) serializes each
  column; `load_graphs` (in `xConnect`, after the cache is loaded) rehydrates them so the
  first `MATCH` skips the rebuild. `graph_saves` / `graph_loads` metrics track both (see
  [metrics.md](./metrics.md)).

The steady state, combining incremental insert and persistence: writes keep the in-RAM graph
fresh (~O(log N) each), commits persist it, and opens reload it — so a **full rebuild is
never on the hot path**, only the fallback.

## Inspecting the graph (SQL functions)

Two scalar SQL functions export the graph so the app can visualize it (e.g. the
explorer's "Show HNSW graph" on a vector field). Both take `(table, col)`, read the
**persisted** `<table>_anki_hnsw` cache, and decode it in Rust — so the blob format
stays single-sourced (no hand-written JS parser to drift):

- **`anki_hnsw_json(table, col)`** → a JSON object:

  ```json
  { "entry": 0, "max_level": 1,
    "nodes": [ { "node": 0, "rowid": 2, "level": 1 }, … ],
    "edges": [ { "a": 0, "b": 1, "layer": 0 }, … ] }
  ```

  `node` is the compact internal index; `rowid` **joins back to the table** for a label.
  The functions return topology only — the app supplies text from the **public vtab**, not
  the internal shadow: the graph `rowid` is exactly the vtab's `rowid`, so a single
  `SELECT rowid, <cols> FROM <table>` scan builds a rowid→label map for the whole graph.
  (Prefer that one scan over per-node `WHERE rowid = ?` lookups: the vtab doesn't
  PK-optimize a rowid constraint, so N point lookups scan N times. The shadow's
  `anki_id` *is* a real primary key if you ever need fast point lookups, but reading the
  shadow means reaching past the public interface.) Edges are undirected, de-duplicated
  per layer.

- **`anki_hnsw_dot(table, col)`** → Graphviz DOT (node label = rowid, entry emphasized,
  edges colored by layer) for a quick static render.

Both return **`NULL`** when there's no graph to show — no cache row yet, an empty
(all-NULL) column, an unknown table/column, or an undecodable blob. Because they read the
*persisted* cache (written at commit), a graph appears after it has been built (a `MATCH`)
and committed; a freshly-inserted-but-never-searched table returns `NULL` until then. The
app treats `NULL` as "no graph yet — run a search."

Tombstoned nodes are omitted from both exports (they're compacted out of the persisted
blob anyway). Implemented by `Hnsw::to_json` / `to_dot` / `deserialize_topology` in
`hnsw.rs` and registered next to `anki_model()` / `anki_dim()` in `vtab.rs`.

## Assumptions and limits

- **Normalized vectors.** Cosine = dot product only holds for L2-normalized inputs; the
  embedder guarantees this. Feeding unnormalized vectors would distort distances.
- **Approximate.** Recall is high (the tests assert ≥ 0.85 on random data and exact-match
  retrieval), but not guaranteed 100% — that's the ANN trade. `/exact` bypasses the graph
  for a complete scan when a query needs it.
- **Single-threaded, in-RAM vectors.** No parallel build, no memory-mapped vectors; the
  graph and vectors are resident. Streaming vectors from disk during traversal (DiskANN /
  "Option B") is a separate, future axis — see [TODO.md](./TODO.md).

## Tests

Unit tests live at the bottom of `hnsw.rs` (run with `cargo test -p anki-core`):
recall-vs-brute-force, exact-match retrieval, incremental add/remove/update, tombstone
exclusion, and serialize→deserialize round-trip / compaction / corruption-rejection. The
end-to-end persistence behavior (reopen skips the rebuild) is covered by
`packages/wasm/test/persistence.test.mjs`.
