# WASM build variants (embedding-engine benchmarks)

**Status:** planned — not yet implemented.
**Last updated:** 2026-06-27

## Goal

Produce alternate `sqlite3.wasm` builds that swap the **embedding engine** and the
**threading model**, so we can benchmark per-embedding latency against today's
baseline (~87 ms/embed, Tract + wasm SIMD, single-threaded). The default build is
**unchanged**; variants are opt-in via separate scripts.

The bottleneck is the in-wasm transformer forward pass (see
`docs/metrics.md` / the `anki_embed_log` instrumentation). These variants exist
to answer "is the engine or the single-threading the limiter?" empirically.

## Two orthogonal axes

| axis | values | meaning |
| --- | --- | --- |
| **engine** | `tract` \| `candle` | which Rust inference crate runs the ONNX model |
| **threads** | `st` \| `mt` | single-threaded vs wasm threads (emscripten `-pthread`) |

Threading is a **wasm build concern**, not an engine feature — the same emscripten
plumbing applies to either engine. So it's two flags, not four bespoke builds.

## Scripts

| script | engine | threads | notes |
| --- | --- | --- | --- |
| `build:wasm` | tract | st | **alias of `build:wasm:tract-st`** — the default, unchanged |
| `build:wasm:tract-st` | tract | st | today's baseline |
| `build:wasm:tract-mt` | tract | mt | Tract + wasm threads |
| `build:wasm:candle-st` | candle | st | Candle (uses the `gemm` matmul kernels) |
| `build:wasm:candle-mt` | candle | mt | Candle + wasm threads |

Each script sets env and calls `scripts/build-wasm.sh`; all variants **overwrite
`packages/wasm/dist/`** (build one → benchmark → build the next). They are not
co-installed.

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
  `"build:wasm:candle-mt": "ANKI_ENGINE=candle ANKI_THREADS=1 bash scripts/build-wasm.sh"`.

## Benchmarking

Each variant keeps the `anki_embed_log` instrumentation. To compare:

1. Build a variant (e.g. `pnpm build:wasm:candle-st`).
2. Run a node bench against `packages/wasm/dist` (load model → embed a fixed set of
   texts → read `anki_embed_log()` → report count / avg / p50 / p95).
3. Repeat per variant; compare averages.

Report: engine, threads, avg ms/embed, p50/p95, wasm size.

## Expectations & caveats (hypotheses to test, not conclusions)

- **`tract-st`** — baseline (~87 ms).
- **`tract-mt`** — *likely little gain.* Tract doesn't obviously parallelize a single
  short-sentence forward pass; small matmuls + thread overhead may wash out. The
  plumbing is real but the payoff is doubtful — treat as a quick spike.
- **`candle-st`** — *possibly faster than `tract-st`*: Candle's matmul uses the
  `gemm` crate (well SIMD-tuned). Unknowns: does `candle-onnx` run MiniLM correctly
  in wasm, and do the pooled embeddings match Tract's?
- **`candle-mt`** — *the most likely to show a threading win*, since `gemm`
  parallelizes. This is the headline experiment.
- **Shared caveats:**
  - All variants pay the **wasm SIMD tax** (128-bit lanes, no AVX) — none will
    approach native ORT (~single-digit ms).
  - `mt` builds need **`SharedArrayBuffer`** → COOP/COEP headers (the explorer
    already sets them) and spawn worker threads; growable shared memory has
    emscripten constraints to watch.
  - `candle` adds heavy deps → larger wasm + slower build.
  - Output correctness must be verified per engine (cosine of a known pair, and
    that `MATCH` results are sane), not just speed.

## Decision

After benchmarking, pick one default. If no in-wasm variant beats the baseline
meaningfully, the real lever remains a **smaller/quantized model** (engine-agnostic)
or a **native** (non-wasm) deployment — see `docs/embeddings-metrics.json` analysis.
