# Dynamic model loading (un-bundle the model)

**Status:** planned — not yet implemented
**Last updated:** 2026-06-24

## Goal

Stop `include_bytes!`-bundling the ONNX model into the wasm. The wasm ships
*without* the model (~3–5 MB instead of ~106 MB). Our JS glue fetches the model
+ tokenizer (by model id from a registry, or via custom URLs) and hands the
bytes to the extension through an exported `anki_load_model` function at **init
time**. The Rust extension never fetches.

### Why

- The ~106 MB bundled wasm is a hard adoption/caching/CDN liability.
- "One wasm per model" does not scale; un-bundling allows many models against a
  single cached wasm.
- The model is the heavy, fast-moving, externally-owned part; decoupling it from
  the stable extension is the right architecture.

### Non-goals for this change

Multi-model-per-session, OPFS model cache, lazy/first-use loading, Asyncify.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Who fetches | **JS glue**, not Rust | `fetch` is async; Rust runs synchronously inside SQLite. Reuses the existing `Embedder::from_bytes` seam. |
| When | **Init time** (inside our `sqlite3Init`) | Avoids Asyncify; model ready before any SQL runs. |
| Model registry | **In JS** (id → `{modelUrl, tokenizerUrl, dim, sha256?}`), custom URLs override | URLs change without a wasm rebuild. |
| Models per instance | **One** (first load wins) | Matches the `OnceCell` global embedder. |
| JS ↔ wasm buffer | **sqlite3-wasm helpers** (`sqlite3.wasm.allocFromTypedArray`, `sqlite3.wasm.exports.*`) | Avoids raw `_malloc`/`HEAPU8` juggling. |
| Export mechanism | **`EMSCRIPTEN_KEEPALIVE`** on a tiny C wrapper | Avoids splicing the sqlite `EXPORTED_FUNCTIONS` file. |

### Target API (app-facing)

```js
const sqlite3 = await sqlite3Init({
  anki: { model: "all-MiniLM-L6-v2" }       // a NAME; glue does the rest
  // or: { modelUrl, tokenizerUrl, dim }     // custom model
  // or: { modelBytes, tokenizerBytes, dim } // offline escape hatch
});
// then pure SQL; the app never sees fetch, heap pointers, or anki_load_model.
```

## Changes by area

### 1. `crates/anki-core/src/embedder.rs`
- Delete `from_embedded()`, the `include_bytes!`, and all `#[cfg(embedded_model)]`
  branches.
- Add a `dim` field to `Embedder`; `from_bytes` takes/stores it. Pooling and the
  output-shape check use `self.dim` instead of the hardcoded `EMBED_DIM`.
- Replace `global()`'s lazy init: `load(model, tok, dim)` sets the `OnceCell`;
  `global()` returns the loaded embedder or `AnkiError::Inference("no model loaded")`.

### 2. `crates/anki-core/` — new loader/FFI (e.g. `loader.rs`)
- `#[no_mangle] pub extern "C" fn anki_load_model(model_ptr,len, tok_ptr,len, dim, id_ptr,len) -> i32`
  rebuilds slices, calls `Embedder::load`, and stashes runtime metadata
  `(model_id, dim)` in a global.
- Move `anki_model()` / `anki_dim()` SQL functions into Rust (registered in
  `anki_register_vtab`) so they read the **runtime** metadata. `anki_version()`
  stays a build constant.

### 3. `crates/anki-wasm-minilm/src/lib.rs`
- Remove `anki_embedder_init` (no eager warm-up). lib.rs becomes minimal (keeps
  anki-core linked).

### 4. `wasm/anki_extension.c`
- Drop the `anki_embedder_init()` call from `sqlite3_anki_init` (registration only).
- Remove the C constants `anki_model` / `anki_dim` (now Rust); keep `anki_version`.
- Add `#include <emscripten.h>` and a `EMSCRIPTEN_KEEPALIVE` wrapper
  `anki_load_model(...)` forwarding to the Rust symbol — this is what makes it
  callable from JS.

### 5. `build.rs` (both crates)
- Delete the `embedded_model` cfg machinery (nothing to detect anymore).

### 6. `scripts/build-wasm.sh`
- Remove the model download/bake step; the wasm shrinks dramatically.
- Add `HEAPU8` to `EXPORTED_RUNTIME_METHODS` (alongside `HEAPU64,HEAP64`) so JS
  can copy bytes in.
- `scripts/download-model.sh` becomes a dev/test convenience (self-hosting), not
  part of the build.

### 7. JS glue — `packages/wasm-minilm/src/index.ts`
- Export `sqlite3Init(opts)`: `await sqlite3InitModule()` → if `opts.anki`,
  resolve id/URLs from a JS **registry**, `fetch` model + tokenizer (HTTP cache
  for now; OPFS later), `sqlite3.wasm.allocFromTypedArray(...)`, call
  `sqlite3.wasm.exports.anki_load_model(...)`, free, return `sqlite3`.
- Escape hatch: `opts.anki.modelBytes` / `tokenizerBytes` for offline/self-bundling.

### 8. Tests
- Node loader reads `models/.../model.onnx` + `tokenizer.json` from disk and
  calls `anki_load_model` (simulating the glue), then re-runs the vtab / persist
  / txn / HNSW smoke tests.
- Add a "no model loaded → clear error" check.

## Open decisions

1. **Dynamic `dim` now, or pin 384 for v1?** — ✅ **Decided: dynamic.**
   `dim` is stored per-loaded-model and threaded through pooling, introspection,
   and storage. No hardcoded 384.
2. **Persistence model-mismatch guard now, or defer?** — ✅ **Decided: include now.**
   - On `xCreate`, write an `anki_meta(key,value)` row recording `model_id` + `dim`.
   - On `xConnect`, compare the loaded model's `id`/`dim` against the stored
     values; on mismatch, **fail the connect** with a clear error
     (`"table built with model X (dim N), current model is Y (dim M) — reindex required"`)
     rather than loading garbage.
3. **No-model UX** — `anki_load_model` failures surface in JS; the in-SQL path
   stays graceful-empty (MATCH returns nothing). OK?
4. **CORS/caching** — HF `resolve` URLs are generally CORS-friendly; custom URLs
   are the caller's responsibility. Phase-1 caching = HTTP cache; OPFS deferred.
5. **Quantized model default** — un-bundling makes the ~23 MB quantized export
   the obvious registry default (vs the ~90 MB fp32). Switch the default id?

## Ripple effects to keep in mind

- `EMBED_DIM = 384` is currently hardcoded in pooling + introspection; making
  `dim` dynamic is the main code ripple (HNSW + blob storage are already generic
  over `Vec<f32>` length).
- Stored embeddings carry no model tag today; see open decision #2.
- Bundling previously gave deterministic embeddings + offline support "for free";
  fetching shifts that to caching (open decision #4) and hash-pinning (registry
  `sha256`).

## Future work: re-vector on model mismatch

The mismatch guard errors by default. Later, offer a "reindex" path instead of a
hard error — feasible because the **source text is persisted** in the shadow
table (`c{i}` columns), so embeddings can be regenerated:

- App-facing: `sqlite3Init({ anki: { model, onMismatch: "reindex" } })`
  (default `"error"`).
- Wiring: the glue calls a small `anki_set_mismatch_policy(error|reindex)` export
  right after `anki_load_model`. `xConnect` reads the policy and, on mismatch,
  walks each row, re-embeds the stored text with the new model, rewrites the
  `e{i}` blobs, and updates `anki_meta` — instead of failing.
- No data loss: the text is the source of truth; only the vectors are derived.
