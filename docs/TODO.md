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
- **Dialog transparency — DONE (2026-07-07).** ImportDialog warns, under any table ticked to
  vectorize, which schema objects it drops (indexes/triggers/FKs/CHECK/DEFAULT/multi-col UNIQUE),
  noting NOT NULL + single-column UNIQUE are kept. (`analyzeImport` → `ImportDrops`.)
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
- **Dialog transparency — DONE (2026-07-07)** (see import-fidelity section above): the near-term
  warning is shipped; the companion strategy remains the faithful long-term path.
- **Constraint enforcement — Layer 1 DONE (2026-07-06, greenfield).** The declared type flows into
  the shadow `CREATE`, so **UNIQUE / CHECK / NOT NULL** enforce on writes; the write path honors the
  SQL conflict clause via `sqlite3_vtab_on_conflict` (`INSERT OR REPLACE`/`OR IGNORE`/plain). See
  `constraints.test.mjs`. **DEFAULT** is a genuine vtab limitation (SQLite ignores a vtab's declared
  defaults). **Index** on the vtab is blocked by SQLite (→ shadow-side index = "index filtered
  shadow columns"). **FK / triggers** can't (cache desync / blocked) → companion strategy.
- **Constraint carry on import — Layer 2 DONE (2026-07-07).** `rebuildImport` reconstructs
  **NOT NULL + single-column UNIQUE/PK** (from `table_info`/`index_list`/`index_info`) and
  **column-level CHECK** (parsed from the source `CREATE TABLE` DDL — no PRAGMA exposes it — via
  a quote/paren-aware scanner in `worker.ts`) and re-declares them on the vectorized table, where
  they enforce via the shadow. CHECK is skipped for a table with a reserved-name rename (its
  expression may reference the old name). Only **table-level** constraints (multi-column UNIQUE/PK,
  table-level CHECK) can't be carried — the per-column `anki(col …)` DSL can't express them; these
  are surfaced by the dialog warning.
- **Real column names via an `anki_` prefix — DONE (2026-07-06, storage-format v3).** Shadow
  table `<name>_anki`, internal columns `anki_id` / `anki_emb_<col>`, data columns stored under
  their real names. Greenfield: `xCreate` hard-errors on a reserved-prefix or duplicate column
  name. Import: `ImportDialog` shows an inline rename for `anki_*` columns on a vectorized table
  and blocks the rebuild until resolved. This is the enabler for constraint pushdown below.

## Related design docs
- `streaming-storage.md` — the shipped WASM-RAM redesign; §correctness + open questions
  cover `omit=1`, indexing, and Option B in more depth.
- `hybrid-filtering.md`, `query-planning.md` — WHERE + MATCH pushdown.
