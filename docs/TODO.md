# TODO / roadmap

Follow-up work, deferred by design. Grouped by theme; each has a matching auto-memory
note (assistant recall) and, where relevant, a design section in another doc.

## Index build / write cost
- **HNSW incremental insertion** — writes currently set `index_dirty` and the next
  `MATCH` full-rebuilds the graph (O(N)). Splice single nodes on write instead
  (~O(log N)); keep full-rebuild as a fallback. *Separate from the WASM-RAM axis.*
- **Persist the HNSW graph to disk** — build it once and store it (shadow table), so
  open / first-`MATCH` reads it instead of rebuilding. Removes the open-time CPU spike;
  does not cut RAM. Complementary to incremental insertion.

## RAM reduction (beyond the streaming redesign)
The streaming redesign (see `streaming-storage.md`, shipped) already cut RAM to
**rowid + embeddings + HNSW**. Further levers:
- **int8 / binary quantization** — store & hold embeddings as 8-bit → ~4× less RAM *and*
  disk, small recall loss. Highest RAM-per-effort lever; keeps `/hnsw` + `/exact`.
- **Stream embeddings ("Option B" / DiskANN)** — keep only the HNSW graph resident, read
  vectors from disk during traversal. Big win at very large N; cost is random OPFS-read
  latency (worst for `/exact`). Only worth it at ~100k+ vectorized rows.

## Query perf / correctness optimizations
- **Session-level query-embedding cache** — reuse embeddings *across* queries in a
  session (LRU keyed by `(model, text)`), not just within one query. Commit 5 added the
  per-query (per-cursor) cache only.
- **`omit=1` for proven filters** — pushed filters use `omit=0` so SQLite re-checks
  (redundant in the common case). Once exact parity is proven for a constraint, set
  `omit=1` to skip the re-check. Risky (removes the net); exhaustive parity tests needed.
- **Index frequently-filtered shadow columns** — `filter_candidate_ids` scans the shadow
  table for unindexed filter columns. Add indexes (auto-heuristic or explicit).

## Explorer UX
- **"Rebuild required" surfacing** — the storage-format guard hard-fails opening
  pre-redesign OPFS DBs with a raw error. Show a friendly message that offers to rebuild
  (Import & Vectorize / re-populate demo).

## Import & Vectorize
- **Reproduce source indexes / triggers / FK constraints** on import (currently dropped).
- **Per-import model switching** — currently one model per session.

## Related design docs
- `streaming-storage.md` — the shipped WASM-RAM redesign; §correctness + open questions
  cover `omit=1`, indexing, and Option B in more depth.
- `hybrid-filtering.md`, `query-planning.md` — WHERE + MATCH pushdown.
