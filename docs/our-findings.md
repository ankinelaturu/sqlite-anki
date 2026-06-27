# sqlite-anki: performance & size findings

A running log of what we measured while profiling in-browser embedding for
sqlite-anki. Numbers are from `all-MiniLM-L6-v2` (384-dim, 6-layer BERT) unless
noted. Tag each figure as **wasm** (what ships) vs **host** (native, for trend
only), and **measured** vs **estimated**.

> Status: working notes — to be distilled into the README once we settle the
> decisions at the end.

---

## TL;DR

- The custom `sqlite3.wasm` is **~14 MB** not because of SQLite (~1 MB) or our
  extension (~50 KB), but because it statically links a full **ONNX inference
  engine (Tract) + ndarray** (~12 MB).
- An embedding takes **~87 ms** (wasm, SIMD, single-thread). Model load, graph
  optimization, and tokenizer init all happen **once**; per-row cost is purely
  the transformer forward pass.
- Swapping Tract → **Candle** cuts the wasm to **~5 MB (–65%)** with **identical
  embeddings** — Candle is a tiny interpreter vs Tract's optimizing compiler.
  Latency looked equal under padding, but once padding is removed **Tract is
  ~34% faster** — so it's a real **size vs speed** tradeoff.
- The single biggest latency lever is **not the engine**: the tokenizer padded
  every input to a **fixed 128 tokens** — **82% of every forward pass wasted on
  `[PAD]`** (avg 22.5 real tokens of 128). Padding to actual length cut a short
  embed **96 ms → 10.7 ms (~9×)**, the **full demo build ~105 s → 19 s (Tract) /
  25 s (Candle)**, and fixed a latent **mean-pooling correctness bug**.

---

## 1. Size anatomy — where the 14 MB goes

The final wasm is dominated by the Rust ML stack, not SQLite.

| component | contribution | note |
| --- | ---: | --- |
| SQLite C (amalgamation) | ~1–1.5 MB | the database engine itself |
| **our extension** (`anki_core`) | **~0.05 MB** | the vtab + glue — tiny |
| **ML stack** (Tract + ndarray + deps) | **~12 MB** | the ONNX engine |

Tract staticlib symbol breakdown (pre-DCE, `llvm-nm`):

| crate | size |
| --- | ---: |
| `tract` (ONNX optimizer + runtime) | 6.4 MB |
| "other" (generics, small deps) | 5.9 MB |
| `ndarray` (tensors) | 4.3 MB |
| rust std/core/alloc | 2.1 MB |
| `regex`/`aho-corasick` (tokenizer dep) | 0.9 MB |
| `serde`/`serde_json` | 0.7 MB |
| `tokenizers` | 0.6 MB |
| **`anki_core` (our code)** | **0.05 MB** |

- Final wasm: **14,436,140 bytes (~14.4 MB)**, gzip **~3.64 MB**.
- Tract staticlib (pre-link): **49 MB**.
- There is **no debug info** in the shipped wasm — it's `-O2` + `wasm-strip`; the
  size is real code (mostly Tract).

---

## 2. Embedding cost anatomy

Confirmed in `embedder.rs`: per INSERT, the only work is the forward pass.

- **Model** — loaded once into a `OnceCell` at `anki_load_model` (init), reused.
- **Tract optimize/compile** — `into_optimized().into_runnable()` runs **once**
  at load, producing a `SimplePlan`; `embed()` only executes it.
- **Tokenizer** — `Tokenizer::from_bytes` runs **once**; `embed()` only calls
  `encode()`.

Per embed: tokenize (cheap) → 3 input tensors → **`model.run`** (the cost) →
mean-pool → L2-normalize.

- **~87 ms/embed** wasm, SIMD, single-thread (measured).
- **~200 ms/embed** wasm **without** SIMD — `+simd128` gives ~2×.

---

## 3. The demo workload: 400 rows = 1,200 embeddings

The three vector tables each have **3 `TEXT VECTOR` columns**, so each INSERT
embeds 3 cells:

| table | rows | vector cols | embeddings |
| --- | ---: | ---: | ---: |
| opportunities | 150 | 3 | 450 |
| support_tickets | 150 | 3 | 450 |
| knowledge_articles | 100 | 3 | 300 |
| **total** | **400** | | **1,200** |

From the instrumented run (`anki_embed_log`, 1,200 embeds, wasm):

| metric | value |
| --- | ---: |
| total | **104.77 s** |
| average | **87.31 ms** |
| min / max | 86.65 / 103.79 ms |
| p50 / p95 / p99 | 87.25 / 87.71 / 89.12 ms |
| std-dev | **0.63 ms** |

The ~105 s of pure embedding accounts for nearly all of the ~110 s demo build.
The remarkable consistency (std 0.63 ms, max is just the first/warmup call) is a
clue — see §5.

---

## 4. Engine comparison — Tract vs Candle

Same model, same API (`Embedder`), engine selected by a build flag
(`build:wasm:tract-st` / `build:wasm:candle-st`; see `docs/build-variants.md`).

| | **Tract (default)** | **Candle** |
| --- | ---: | ---: |
| wasm size | **14.4 MB** | **5.0 MB** |
| wasm size (gzip) | ~3.64 MB | ~1.3 MB |
| per-embed, padded-128 (wasm) | ~89.7 ms | ~96.8 ms |
| per-embed, pad-to-actual (wasm) | **15.7 ms** | **21.0 ms** |
| per-embed (host, native) | ~62 ms | ~48 ms |
| correctness | reference | **identical to Tract** (≈6 sig-figs) |
| integration suite | 34/34 | **34/34** |

- **Latency:** padded to 128, the engines are a **wash** (~8%). But after the
  padding fix (§5) the gap **widens to ~34%** (Tract 15.7 vs Candle 21.0 ms) —
  with the real matmuls now small, Candle's per-node interpreter overhead is a
  bigger fraction. (On the host Candle is *faster*, because it gets AVX +
  `rayon` threads that single-threaded wasm doesn't.)
- **Size is the real difference: –65%.** So it's a genuine **size (Candle) vs
  speed (Tract)** tradeoff — see §8.

### Why Candle is so much smaller

Candle staticlib breakdown (pre-DCE):

| crate | size |
| --- | ---: |
| "other" (generics, small deps) | 4.8 MB |
| `candle-core` | 2.0 MB |
| rust std/core/alloc | 1.5 MB |
| `tokenizers` | 0.6 MB |
| **`gemm` (matmul)** | **0.38 MB** |
| **`candle_onnx` (the engine)** | **0.14 MB** |

The difference is what each "ONNX engine" *is*:

- **Tract is an optimizing compiler + runtime** — hundreds of ONNX ops, a
  graph-rewriting optimizer (`into_optimized`), shape inference, a typed-fact
  system, and `tract-linalg`'s broad kernel set. Heavily generic → lots of
  monomorphized code. You pay for all of it even though MiniLM uses ~20 ops, and
  it can't be dead-stripped (the op registry is reachable).
- **`candle-onnx` is a ~140 KB interpreter** — `simple_eval` walks the graph
  node-by-node calling `candle-core` ops; no optimizer, no broad registry. Matmul
  is delegated to **`gemm`** (one focused 380 KB crate). No `ndarray`.

**The honest tradeoff:** Tract's bulk *is* its ahead-of-time optimizer, which is
why it stays competitive on speed in wasm despite its size. Candle skips it and
interprets — tiny, but ~equal/slightly slower. Not free; a real swap.

Build gotchas for Candle: needs **`protoc`** at build time
(`brew install protobuf`), and **`prost` pinned to 0.12** (candle-onnx 0.8.4
generates against it) so `ModelProto::decode` is in scope.

---

## 5. The biggest lever: fixed-128 tokenizer padding

Per-embed latency is **flat across input length** for both engines:

| tokens | Tract p50 | Candle p50 |
| ---: | ---: | ---: |
| ~16 | 97.2 | 97.8 |
| ~96 | 97.5 | 99.8 |
| ~256 | 97.5 | 99.4 |
| ~448 | 97.3 | 98.3 |

Cause: the model's `tokenizer.json` ships with

```
padding:    Fixed(128)
truncation: max_length 128
```

so **every input is processed at exactly 128 tokens** — short text padded *up*,
long text truncated *down*. That explains the flatness, the tiny variance in §3,
and why "longer text = slower" never happens.

### What the real demo data shows

Per-embed token counts from the 1,200-embedding demo run (saved as
`docs/embeddings-metrics-{tract,candle}-st-padding128.json`):

| | tract-st | candle-st |
| --- | ---: | ---: |
| total | 107.7 s | 116.1 s |
| avg per embed | 89.7 ms | 96.8 ms |
| avg real tokens | 22.5 | 22.5 |
| avg pad tokens | 105.5 | 105.5 |
| real-token range | 9–60 | 9–60 |

**82% of every forward pass is spent on `[PAD]` tokens.** The longest real text
in the whole demo is **60 tokens** — nothing approaches 128, so truncation never
even fires; it's pure padding waste. Effect of the fix (measured below): the
full build drops from ~105 s to **~19 s** (Tract).

### The fix, measured on a single short text

Removing the fixed padding (pad to the input's **actual** length) on a short
text:

| | host (Tract) | wasm (Tract) |
| --- | ---: | ---: |
| fixed-128 padding | 59.4 ms | **96.0 ms** |
| pad-to-actual-length | 6.2 ms | **10.7 ms** |

**~9× faster in wasm** for typical short fields (titles, notes), and
**engine-independent**.

### After the fix: the full demo, both engines

Re-running the 1,200-embedding demo with `with_padding(None)`
(`docs/embeddings-metrics-{tract,candle}-st-paddingNONE.json`):

| | tract-st | candle-st |
| --- | ---: | ---: |
| before — Fixed(128) | 107.7 s / 89.7 ms | 116.1 s / 96.8 ms |
| **after — pad-to-actual** | **18.9 s / 15.7 ms** | **25.2 s / 21.0 ms** |
| **speedup** | **5.7×** | **4.6×** |
| p50 / p95 | 15.4 / 28.7 ms | 20.1 / 34.2 ms |
| min / max | 7.6 / 40.2 ms | 11.5 / 47.4 ms |
| pad tokens | 105.5 → **0** | 105.5 → **0** |

Per-embed now **scales with real length** (9–60 tokens) instead of being pinned
at 128 — note the p95 (28.7 ms) is well above the p50 (15.4 ms), which never
happened when every input was 128 tokens.

And a consequence worth flagging: **with padding gone, the engine gap widens**.
Padded to 128, Tract and Candle were within ~8%; now Tract is **~34% faster**
(15.7 vs 21.0 ms). The real matmuls are now small, so Candle's fixed per-node
interpreter overhead is a larger fraction — exactly where Tract's pre-optimized
plan pays off. The padding fix didn't just speed both up; it **changed the engine
tradeoff** (see §4, §8).

### Bonus: a pooling correctness bug

Our `pool()` does a **plain mean** over the whole sequence, with the comment
"no padding for a single input, so a plain mean equals masked mean." That
assumption is **false** given `Fixed(128)` — we currently average the output over
~122 padding positions + the real tokens. Padding to actual length makes the
sequence real-tokens-only, so plain mean = the canonical **masked mean** that
sentence-transformers uses. **The fix is faster *and* more correct.**

Caveat: re-embedding is required for DBs built before the fix (vectors change to
the correct ones).

---

## 6. Threading

Both `-mt` variants need the **same** toolchain: wasm threads on
`wasm32-unknown-emscripten` require `+atomics`/`+bulk-memory`, i.e. a **nightly
`-Z build-std`** (the prebuilt `std` is single-threaded) + emscripten `-pthread`.
That cost is engine-agnostic.

- **`candle-mt` — built, runs, but no speedup.** On an n=400 node bench it measured
  **~17.6 ms, identical to `candle-st` (~17.8 ms)** — and all 34 integration tests
  pass (correct under threads). `gemm`'s `rayon` *is* enabled, so it *should* be
  able to parallelize; on this runtime (node, 10-core M-series) it didn't help —
  rayon likely saw 1 thread, or `gemm` kept the small per-sentence matmuls (9–60
  tokens) single-threaded by heuristic. **Kept as a reproducible experiment**
  (`build:wasm:candle-mt`): it may differ on another runtime/core-count/browser.
- **`tract-mt` — deliberately not built (tombstone).** It would take the *same*
  toolchain as `candle-mt` — nightly + `-Z build-std` (`+atomics`/`+bulk-memory`)
  + emscripten `-pthread`, and a COOP/COEP-isolated host to load. We skipped it
  because: (1) `candle-mt` already showed wasm threads give **no gain** on these
  small matmuls, and (2) Tract doesn't parallelize a single forward pass anyway —
  so it's the same nightly dependency for an expected null result. The
  `build:wasm:tract-mt` script therefore **fails with this explanation** instead
  of carrying a nightly toolchain we don't benefit from.

**Why threads don't help here:** after the padding fix the matmuls are tiny (avg
~22 real tokens, 384 hidden, 6 layers). At that size, thread dispatch overhead
cancels any parallelism gain — the same reason batching, not threading, is the
real throughput lever.

---

## 7. The ceiling: wasm vs native

~87 ms is mostly the **wasm tax**, not Tract:

- wasm SIMD is **128-bit** (4×f32) vs native AVX2 (8×) / AVX-512 (16×).
- **single-threaded** (`SQLITE_THREADSAFE=0`, no wasm threads).

Estimated alternatives (ballpark, not all benchmarked):

| engine / target | est. per-embed | notes |
| --- | ---: | --- |
| Tract / Candle, wasm, SIMD, 1 thread (today) | ~87–95 ms | what ships |
| ONNX Runtime **Web**, wasm | ~20–40 ms (1-thread), ~10–20 ms (multi) | **JS layer — runs outside the extension; breaks the "embed inside SQL" design** |
| ONNX Runtime **native**, desktop CPU | ~3–10 ms | only if shipping a *native* SQLite extension, not wasm |

ORT-web was taken off the table: it's a JS library that can't be called
synchronously from the vtab's `xUpdate`, so it would force embedding in JS and
passing vectors in — the workflow this project exists to replace.

---

## 8. Decisions / recommendations

1. **Padding fix — done.** `with_padding(None)` (pad to actual length) gave
   **5.7× (Tract) / 4.6× (Candle)** on the demo and corrected the masked-mean
   pooling. The biggest, cheapest, engine-independent win. (Requires re-embedding
   DBs built before it — old vectors aren't comparable.)
2. **Engine choice is now a real size-vs-speed tradeoff** — *not* the wash it
   looked like under padding. Post-fix: **Tract 15.7 ms / 14.4 MB** vs
   **Candle 21.0 ms / 5.0 MB**. Tract for latency, Candle for download size.
3. **`candle-mt` is the deciding experiment** — Candle's `gemm` parallelizes, so
   threads could shrink (or erase) the 34% latency gap while keeping the –65%
   size win. Skip `tract-mt` (not viable).
4. **True single-digit-ms** embedding needs a **native** build — out of scope for
   the browser deliverable, but the path for a desktop extension.

---

### Method notes / caveats

- wasm numbers via the `anki_embed_log` instrumentation (per-embed `text`+`ms`)
  exposed by the extension; host numbers via a throwaway example.
- Single-machine (Apple Silicon), single runs; treat ±a few ms as noise.
- "pre-DCE" crate sizes are `llvm-nm` symbol sizes on the staticlib (before the
  linker dead-strips); they show *relative* composition, not the final wasm.
