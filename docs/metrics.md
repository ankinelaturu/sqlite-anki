# Operation metrics (`anki_metrics`)

**Status:** ✅ implemented
**Last updated:** 2026-06-25

Implemented in `crates/anki-core/src/metrics.rs` (counters + `anki_metrics_json`),
instrumented in `vtab.rs` (embed/search/persist/rebuild), exported via
`wasm/anki_extension.c` (`anki_metrics`). Tests:
`packages/wasm/test/metrics.test.mjs`. Example (real numbers): a single-row
INSERT is ~229 ms — **228 ms embedding**, 0.13 ms persist; a MATCH is ~207 ms —
**206 ms query embedding**, 0.5 ms search. Embedding dominates; that's the story
the footer tells.

## Goal

Surface where time goes inside the extension — embedding (ONNX), search, persist,
HNSW rebuild — so an app (e.g. the explorer footer) can show per-operation
performance. The headline number is **embedding time** (the cost of running the
model in the browser).

## Mechanism

The extension keeps **cumulative counters** (since module load). The app reads a
JSON snapshot via the exported `anki_metrics()` and **diffs** before/after an
operation to get that operation's breakdown — no reset, no race.

```js
const wasm = sqlite3.wasm;
const snap = () => JSON.parse(wasm.cstrToJs(wasm.exports.anki_metrics()));

const before = snap();
db.exec(`INSERT INTO notes(body) VALUES('hello')`);
const after = snap();

const op = {
  embed_ms:   after.embed_ms   - before.embed_ms,
  embed_calls:after.embed_calls- before.embed_calls,
  persist_ms: after.persist_ms - before.persist_ms,
};
```

In the real app the `db-client` worker takes the snapshots around each call and
relays `{ total_ms, ...delta }` to the main thread for the footer (`total_ms` is
the JS wall-clock around the call).

## JSON contract

`anki_metrics()` returns a pointer to a NUL-terminated JSON string (read with
`sqlite3.wasm.cstrToJs`). All times are **milliseconds**, all counters
**cumulative**:

```json
{
  "embed_ms": 1234.5,        // total embedding (tokenize + ONNX) time
  "embed_calls": 42,         // number of embed() calls (inserts/updates + queries)
  "search_ms": 12.3,         // total MATCH search time (HNSW or brute-force)
  "search_ops": 5,           // number of MATCH scans
  "persist_ms": 8.1,         // total shadow-table write time
  "index_rebuild_ms": 50.0,  // total HNSW index (re)build time
  "index_rebuilds": 2,       // number of rebuilds
  "candidates": 300,         // total rows whose cosine was computed during searches
  "rows_matched": 30         // total rows emitted by MATCH scans
}
```

Notes:
- `embed_ms` covers **both** write-time embeddings (INSERT/UPDATE) and query
  embeddings (MATCH). Use `embed_calls` to attribute.
- `index_rebuild_ms` is the lazy HNSW rebuild that fires on the first MATCH after
  a write — worth showing separately, since it's a periodic spike, not per-row.
- `candidates` ≈ work done by the search: rows scanned (exact/brute) or candidates
  returned (HNSW).

## Clock

- WASM (`target_os = "emscripten"`): `emscripten_get_now()` (high-res ms, maps to
  `performance.now()`).
- Host (tests): `std::time::Instant` since first use.

## Implementation

- `crates/anki-core/src/metrics.rs` — the cumulative counters (a `Mutex<Metrics>`),
  the `now_ms()` clock, `record_*` helpers, and the `anki_metrics_json()` export.
- `crates/anki-core/src/vtab.rs` — times `embed_text`, the search, `persist_row`,
  and `rebuild_indexes`, calling the `record_*` helpers.
- `wasm/anki_extension.c` — `EMSCRIPTEN_KEEPALIVE` wrapper `anki_metrics()` →
  `anki_metrics_json()`.

## Future

- `anki_metrics_reset()` (if explicit per-op windows are preferred over diffing).
- Finer splits (tokenize vs ONNX inference; HNSW visited-node count).
- Per-table metrics (currently global to the module instance).
