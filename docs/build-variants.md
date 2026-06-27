# WASM build variants (embedding-engine benchmarks)

**Status:** implemented — `tract-onnx-st` (default), `candle-onnx-st`, `candle-onnx-mt` build and
pass the suite; `tract-onnx-mt` is a tombstone (see below). Results in
`docs/our-findings.md`.
**Last updated:** 2026-06-27

## Goal

Produce alternate `sqlite3.wasm` builds that swap the **embedding engine** and the
**threading model**, so we can benchmark per-embedding latency against today's
baseline (~87 ms/embed, Tract + wasm SIMD, single-threaded). The default build is
**unchanged**; variants are opt-in via separate scripts.

The bottleneck is the in-wasm transformer forward pass (see
`docs/metrics.md` / the `anki_embed_log` instrumentation). These variants exist
to answer "is the engine or the single-threading the limiter?" empirically.

## Naming: `[engine]-[format]-[threads]`

| axis | values | meaning |
| --- | --- | --- |
| **engine** | `tract` \| `candle` | which Rust inference crate runs the model |
| **format** | `onnx` \| `native` | ONNX graph (interpreted/optimized) vs native weights (safetensors via `candle-transformers`) |
| **threads** | `st` \| `mt` | single-threaded vs wasm threads (emscripten `-pthread`) |

Not every combination exists: **Tract is ONNX-only** (no `native`), and the `-mt`
axis is a documented dead end (threads show no gain — see Results), so the real set
is small. `build:wasm` aliases `build:wasm:tract-onnx-st`; a format target with no
thread suffix (e.g. `build:wasm:candle-onnx`) aliases its `-st` form.

## Scripts

| script | format | threads | status |
| --- | --- | --- | --- |
| `build:wasm` → `tract-onnx-st` | onnx | st | ✅ **default**, stable toolchain |
| `build:wasm:tract-onnx[-st]` | onnx | st | ✅ fastest (see Results) |
| `build:wasm:tract-onnx-mt` | onnx | mt | ⚰️ tombstone — no gain; would need nightly |
| `build:wasm:candle-onnx[-st]` | onnx | st | ✅ smallest wasm; `gemm` kernels |
| `build:wasm:candle-onnx-mt` | onnx | mt | ✅ built, no gain — **needs nightly** |
| `build:wasm:candle-native[-st]` | native | st | 🔮 not implemented — safetensors → quantized |
| `build:wasm:candle-native-mt` | native | mt | 🔮 not implemented |

(`tract-native` / `*-dual` don't exist — Tract can't read safetensors.)

Each script sets env and calls `scripts/build-wasm.sh`; all variants **overwrite
`packages/wasm/dist/`** (build one → benchmark → build the next). They are not
co-installed.

### Prerequisites

- **All variants:** `protoc` is needed only for the Candle engine
  (`brew install protobuf`).
- **`-mt` variants:** a **nightly** toolchain + `rust-src`
  (`rustup toolchain install nightly && rustup component add rust-src --toolchain nightly`)
  — wasm threads need `-Z build-std` with `+atomics` (the prebuilt emscripten
  `std` is single-threaded). The resulting wasm uses `SharedArrayBuffer`, so it
  only **loads in a browser under COOP/COEP** (cross-origin isolation). The
  default `build:wasm` needs none of this.

## How it works (implementation plan)

- **Cargo features** on `anki-core` (passed through `anki-wasm`):
  - `engine-tract` (default) and `engine-candle` — mutually exclusive.
  - The embedder splits into `embedder/tract.rs` + `embedder/candle.rs`, selected by
    `#[cfg(feature = ...)]`, behind the **same `Embedder` API** so `vtab.rs` and the
    rest of the extension never change.
  - An optional `threads` feature turns on the engine's parallelism where relevant.
- **`scripts/build-wasm.sh`** reads two env vars:
  - `ANKI_ENGINE=tract|candle` (default `tract`) → cargo `--no-default-features
    --features engine-<engine>[,threads]`.
  - `ANKI_THREADS=0|1` (default `0`) → when `1`, add emscripten threading flags
    (`-pthread`, `-sPTHREAD_POOL_SIZE=<ncpu>`, shared memory) and the matching
    `RUSTFLAGS` (`-C target-feature=+atomics,+bulk-memory,+simd128`).
- **pnpm scripts** are thin wrappers, e.g.
  `"build:wasm:candle-onnx-mt": "ANKI_ENGINE=candle ANKI_THREADS=1 bash scripts/build-wasm.sh"`.

## Benchmarking

Each variant keeps the `anki_embed_log` instrumentation. To compare:

1. Build a variant (e.g. `pnpm build:wasm:candle-onnx-st`).
2. Run a node bench against `packages/wasm/dist` (load model → embed a fixed set of
   texts → read `anki_embed_log()` → report count / avg / p50 / p95).
3. Repeat per variant; compare averages.

Report: engine, threads, avg ms/embed, p50/p95, wasm size.

## Results (measured — full numbers in `docs/our-findings.md`)

All produce **identical embeddings** and pass the 34-test integration suite. Speeds
below are post the tokenizer **padding fix** (pad to actual length), n=400 node bench.

- **`tract-onnx-st`** — **fastest, ~12.7 ms**, 14.4 MB wasm. The default.
- **`candle-onnx-st`** — ~17.8 ms (~40% slower), but **5.0 MB** (−65%). Pick for size.
- **`candle-onnx-mt`** — **~17.6 ms — no gain over `candle-onnx-st`.** `gemm`'s `rayon` *is*
  enabled, but on this runtime (node, 10-core M-series) it measured identical to
  st: rayon likely saw 1 thread, or `gemm` kept the small per-sentence matmuls
  (9–60 tokens) single-threaded by heuristic. Kept as a reproducible experiment —
  it may behave differently on another runtime/core-count/browser.
- **`tract-onnx-mt`** — tombstone. Same nightly cost as `candle-onnx-mt` and Tract doesn't
  parallelize a single pass, so the script fails with an explanation instead.

**Shared caveats:**
- All variants pay the **wasm SIMD tax** (128-bit lanes, no AVX) — none approach
  native ORT (~single-digit ms).
- `candle` adds heavy deps → smaller wasm but slower build (and needs `protoc`).

## Decision

**Default = `tract-onnx-st`** (fastest, stable toolchain). `candle-onnx-st` is the
size-optimized alternative (−65%). Neither `-mt` variant helps — the post-padding
matmuls are too small for threads to pay off. The remaining lever for big gains is
a **smaller/quantized model** (engine-agnostic) or a **native** (non-wasm)
deployment — see `docs/our-findings.md`.
