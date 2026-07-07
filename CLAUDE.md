# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

sqlite-anki is SQLite with built-in semantic search that runs entirely in the browser. A Rust extension (`anki-core`) is compiled to WebAssembly and statically linked into a custom `sqlite3.wasm`. It adds an `anki` virtual table where `TEXT VECTOR` columns are auto-embedded on write and queried by meaning with `WHERE col MATCH 'text'`. The embedding model runs *inside* SQLite (Rust/WASM) — there is no embedding API and no JavaScript on the query hot path.

## Commands

```bash
pnpm install
pnpm build:wasm        # build the custom sqlite3.wasm → packages/wasm/dist/ (REQUIRED before tests/dev)
pnpm dev               # explorer SPA → http://localhost:5173
pnpm typecheck         # tsc --noEmit across all TS packages
pnpm build             # build all workspace packages

# Rust unit tests — pure logic (MATCH DSL parser, HNSW, WHERE pre-filter). No wasm/model needed.
cargo test -p anki-core

# WASM integration tests — load the built wasm + real model under Node, exercise the vtab e2e.
bash scripts/download-model.sh          # fetch model → models/all-MiniLM-L6-v2/ (gitignored, 86 MB, one-time)
pnpm build:wasm                         # if not already built
pnpm --filter @sqlite-anki/wasm test    # runs node --test test/*.test.mjs
```

Run a single Rust test: `cargo test -p anki-core <name>`. Run a single WASM test file: `node --test packages/wasm/test/<file>.test.mjs` (from repo root, after `build:wasm`).

**Build variants** (via `scripts/build-wasm.sh`, selected by npm script or env):
- `pnpm build:wasm` → default `tract-onnx-st` (Tract engine, single-threaded, ~14 MB, stable toolchain).
- `pnpm build:wasm:candle-onnx-st` → Candle engine (~5 MB, faster only for long docs). Sets `ANKI_ENGINE=candle`.
- Multi-threaded (`*-mt`) and `candle-native` scripts are intentionally stubbed to exit 1 — wasm threads gave no measurable gain (see `docs/our-findings.md`). Engine is a compile-time feature (`engine-tract` / `engine-candle`), mutually exclusive.

The build needs `emcc` (Emscripten) and `wasm-strip` on PATH; `wasm-opt` (binaryen) is optional but recommended. `build-wasm.sh` clones the pinned SQLite tag into `vendor/sqlite` on first run and links the Rust staticlib into the official `ext/wasm` build.

## Architecture

The data flow crosses four layers — Rust → staticlib → custom sqlite3.wasm (C glue) → JS glue → app:

- **`crates/anki-core`** — all the logic and every `#[no_mangle]` FFI export. Key modules: `vtab.rs` (the `anki` virtual table: `xBestIndex` query planning, `MATCH`, `<col>_score`, WHERE pushdown), `embedder/` (tokenize → ONNX forward pass → mean-pool → L2-normalize), `hnsw.rs` (ANN index), `match_query.rs` (the `/exact`, `/hnsw:N` MATCH DSL), `loader.rs`, `metrics.rs`.
- **`crates/anki-wasm`** — a thin staticlib whose only job is to force-link `anki-core`'s exports into the wasm. Built for `wasm32-unknown-emscripten` as `libanki_wasm.a`.
- **`wasm/*.c`** — C glue linked into SQLite's `ext/wasm` build. `anki_extension.c` registers the vtab + SQL functions and exposes the JS-facing `anki_load_model(...)` (an `EMSCRIPTEN_KEEPALIVE` forwarder to Rust's `anki_embedder_load`). `sqlite3_wasm_extra_init.c` wires `sqlite3_anki_init` into `sqlite3_auto_extension`.
- **`packages/wasm`** (`@sqlite-anki/wasm`) — the published JS glue. `src/index.ts` `sqlite3Init({ anki: { model } })` is THE public entry point: it boots `dist/`, fetches the model+tokenizer bytes, copies them into the wasm heap, and calls `anki_load_model`. `src/registry.ts` (`ANKI_MODEL_REGISTRY`) is pure data (no wasm import) exported at `@sqlite-anki/wasm/registry`, and drives both the glue's URL resolution and the explorer's model picker.
- **`apps/explorer`** (`@sqlite-anki/explorer`) — React/Vite demo SPA behind sqlite-anki.app. `src/db/worker.ts` runs SQLite in a Web Worker; `src/db/index.ts` is the main-thread client.

### Load-time model, not bundled

The ONNX model is **never** compiled into the wasm — the wasm links a full ONNX engine (Tract ≈ 12 MB) but no weights. The model is fetched at runtime (by registry id or custom URL/bytes), cached in OPFS, and handed to the extension via `anki_load_model`. The embedding dimension is a property of the loaded model, not a constant. One model per module instance (first `Embedder::load` wins). A model-mismatch guard records `model_id` + `dim`; each distinct id (including fp32 vs fp16 variants) is a different model. `models/` is a dev/test fixture only. See `docs/dynamic-model-loading.md`.

### Things that will bite you

- **Panics abort the whole wasm instance.** The release profile is `panic = "abort"` (unwinding across the FFI boundary into SQLite is UB, and emscripten can't lower unwind). A panic in `Engine::load` (e.g. an ONNX op Tract doesn't implement, like int8 `MatMulInteger`) aborts with `RuntimeError: Aborted()` rather than returning a clean error. Prefer returning `AnkiError` over panicking on any load/inference path.
- **Padding is deliberately disabled** (`tokenizer.with_padding(None)`) — we embed one text at a time, so fixed 128-token padding was ~82% wasted compute and also broke mean-pooling. Don't reintroduce fixed padding.
- **OPFS + threads need cross-origin isolation** (COOP `same-origin` + COEP `require-corp`). The explorer's Vite config sets these; self-hosting must too.
- `<col>_score` is a hidden, query-time column (not stored, not recomputed) — it works in SELECT/WHERE/ORDER BY/GROUP BY and inside aggregates. Default MATCH similarity threshold is `0.5`.
- **Shadow storage is format v3** (`storage_format` in `anki_meta`; older DBs fail `xConnect` with "rebuild required"). The backing table is `<name>_anki`; internal columns are `anki_id` (rowid) + `anki_emb_<col>` (embedding blobs); user columns are stored under their **real names** with declared type + `COLLATE`. The `anki_` prefix is **reserved** — a user column named `anki_*` is rejected at `xCreate` (import offers a rename). Declared column constraints flow into the shadow, so **UNIQUE/CHECK/NOT NULL enforce** on greenfield tables and writes honor the SQL conflict clause (`sqlite3_vtab_on_conflict`); **DEFAULT does not** (a vtab limitation), and `CREATE INDEX`/`CREATE TRIGGER`/`ALTER TABLE` on the vtab are blocked by SQLite before the module. See `docs/streaming-storage.md`, `docs/TODO.md`.

## Conventions

- **Rust docs are mandatory** (`.cursor/rules/rust-documentation.mdc`): every `pub` item, module (`//!`), and non-obvious block gets a `///`; `unsafe`/FFI exports require a `# Safety` section documenting the SQLite C ABI contract, pointer lifetimes, and ownership. Add/update docs in the same change as the code. Prose + `#` sections, never JavaDoc `@param`.
- **Explorer UI: shadcn components only** — never use native `title`/tooltips/controls.
- **`docs/design-choices.md`: do NOT frame the design against FTS5 or sqlite-vec.** Explain choices on their own terms.
- **Pre-1.0: make clean changes.** No backward-compat shims, migrations, or deprecation aliases unless explicitly asked.
- **Commit/push only when asked.** Never commit the ~86 MB `models/**/*.onnx` (gitignored). Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- CI (`.github/workflows/deploy.yml`) runs both test layers and deploys on push; it ignores docs-only changes (`paths-ignore: ["**.md", "docs/**"]`).

## Docs map

`docs/DESIGN.md` (full spec), `design-choices.md` (rationale), `dynamic-model-loading.md` (runtime model path), `match-dsl.md` (MATCH syntax), `hybrid-filtering.md` (WHERE + MATCH pushdown correctness), `query-planning.md` (vtab planning), `metrics.md` (`anki_metrics()`), `our-findings.md` (perf/size profiling), `build-variants.md` (engine/threading builds), `streaming-storage.md` (design: cut WASM RAM by streaming shadow-table data instead of full materialization), `limitations.md` (known by-design limits: vtab constraints, imports, storage format), `TODO.md` (deferred follow-up work / roadmap).

Repo-root `CHANGELOG.md` tracks notable changes over time (date-sectioned, newest first, links to the docs above) — add a new entry at the top when landing a notable change. Repo-root `JOURNEY.md` is the narrative companion — the *why* and the story, one section per step in chronological order; append a new section at the bottom as the story continues.
