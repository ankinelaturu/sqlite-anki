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
- **Index replay — DONE (2026-07-05).** `rebuildImport` now replays each `CREATE INDEX`
  from `sqlite_master` for plain-copied tables (after data; auto-indexes skipped).
  Vectorized tables became `anki` virtual tables, which SQLite won't let you index, so
  their source indexes are necessarily dropped (unavoidable). Data, JOINs, and plain-table
  DDL (PK/FK/UNIQUE/CHECK/DEFAULT) were already preserved.
- **Trigger replay — DONE (2026-07-05).** `rebuildImport` replays `CREATE TRIGGER` from
  `sqlite_master` for plain tables and views (INSTEAD OF) — created *last*, after all data,
  so a trigger neither fires on the copied rows nor references a missing target. SQLite
  forbids triggers on virtual tables, so triggers on vectorized tables are dropped.
- **Dialog transparency** — warn in ImportDialog which indexes/triggers/constraints a table
  will lose when you tick it to vectorize. (Now the only remaining import-fidelity gap that's
  actually fixable — the rest are inherent vtab limits.)
- **Per-import model switching** — currently one model per session.

## Future direction: native CLI + faithful (companion) import
A native macOS/Windows **CLI** reusing `anki-core` + the `anki` vtab (link into a native
SQLite build — see the reserved `candle-native` variant). Its "vectorize an existing DB"
feature makes import a serious tool on real, possibly write-heavy DBs — where silently
dropping a vectorized table's indexes/triggers/constraints is a real footgun.

- **Companion-table import strategy.** Instead of transforming a constraint-heavy table into
  a vtab (losing its indexes/triggers/constraints), keep it **plain** and add a **companion**
  `anki` table (`USING anki(<pk> INTEGER, <text> TEXT VECTOR)`) kept in sync by **triggers on
  the plain table** (allowed — only triggers *on* a vtab are forbidden). Search joins back to
  the original. Zero fidelity loss; the import tool auto-generates the companion + triggers.
  Needs **no vtab changes**. Offer two strategies: *in-place* (current, simple) vs *companion*
  (faithful, default for constraint-heavy tables).
- **Framing:** greenfield (new table) stays a single `USING anki` table — simpler than the
  hand-rolled companion+vectors pattern other extensions require. The companion strategy is
  only for *retrofitting* existing tables, where it's the same structure done for you.
- **Dialog transparency** (near-term, explorer): until the companion strategy exists, warn in
  ImportDialog which indexes/triggers/constraints a table loses when you tick it to vectorize.
- **Constraint pushdown onto the shadow table.** The shadow table is a real table and every vtab
  write flows through it, so a constraint declared there actually enforces on the vtab. Recover
  **UNIQUE** (unique index), **NOT NULL**, **CHECK** (needs expr rewrite unless columns are
  named), **DEFAULT** (in the declared vtab schema), and **index speed** (index on the shadow
  column — same as the query-perf "index filtered shadow columns" item). **FK and triggers can't**
  be recovered cleanly (FK cascades / triggers modify the shadow behind the vtab and desync its
  in-RAM cache) → those need the companion strategy.
- **Real column names via an `anki_` prefix — DONE (2026-07-06, storage-format v3).** Shadow
  table `<name>_anki`, internal columns `anki_id` / `anki_emb_<col>`, data columns stored under
  their real names. Greenfield: `xCreate` hard-errors on a reserved-prefix or duplicate column
  name. Import: `ImportDialog` shows an inline rename for `anki_*` columns on a vectorized table
  and blocks the rebuild until resolved. This is the enabler for constraint pushdown below.

## Related design docs
- `streaming-storage.md` — the shipped WASM-RAM redesign; §correctness + open questions
  cover `omit=1`, indexing, and Option B in more depth.
- `hybrid-filtering.md`, `query-planning.md` — WHERE + MATCH pushdown.
