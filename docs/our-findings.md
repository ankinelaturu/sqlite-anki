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
  embeddings** and **~equal latency** — Candle is a tiny interpreter vs Tract's
  optimizing compiler.
- The single biggest latency lever is **not the engine**: the tokenizer pads
  every input to a **fixed 128 tokens**. In the demo, **82% of every forward
  pass is wasted on padding** (avg 22.5 real tokens out of 128). Removing that
  (pad to actual length) takes a short embed from **96 ms → 10.7 ms (~9×)** in
  wasm — and also fixes a latent **mean-pooling correctness bug**.

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
| per-embed (wasm, short) | ~87 ms | ~95 ms |
| per-embed (host, native) | ~62 ms | ~48 ms |
| correctness | reference | **identical to Tract** (≈6 sig-figs) |
| integration suite | 34/34 | **34/34** |

- **Latency is a wash** in wasm (the ~8 ms is run-to-run noise; see §5 where
  matched-length runs are within ~1 ms). On the host Candle is faster because it
  gets AVX + `rayon` threads that single-threaded wasm doesn't.
- **Size is the real difference: –65%.**

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
even fires; it's pure padding waste. Projected effect of the fix: ~90 ms →
**~20–30 ms** average (the demo's real texts average ~22 tokens), i.e. the full
build drops from ~105 s to **~25–35 s**.

### The fix, measured on a single short text

Removing the fixed padding (pad to the input's **actual** length) on a short
text:

| | host (Tract) | wasm (Tract) |
| --- | ---: | ---: |
| fixed-128 padding | 59.4 ms | **96.0 ms** |
| pad-to-actual-length | 6.2 ms | **10.7 ms** |

**~9× faster in wasm** for typical short fields (titles, notes), and
**engine-independent**.

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

- **`tract-mt` — not viable.** wasm threads on `wasm32-unknown-emscripten` need
  `+atomics`/`+bulk-memory`, i.e. a nightly `-Z build-std`; and Tract doesn't
  parallelize a single small forward pass anyway. Heavy plumbing, ~no gain. The
  `build:wasm:tract-mt` script intentionally fails with this explanation.
- **`candle-mt` — pending.** Candle's `gemm` *does* parallelize, so this is the
  one threading variant worth measuring (after the padding fix changes the
  per-embed floor).

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

1. **Fix tokenizer padding first** (engine-independent): `with_padding(None)` so
   short text isn't padded to 128. ~9× on the common case, plus the masked-mean
   correctness fix. This changes the per-embed floor, so re-benchmark everything
   on top of it.
2. **Candle is a strong default for size** (–65% download) at parity latency;
   revisit once `candle-mt` and the padding fix are in.
3. **Threads only matter for Candle** (`gemm`); skip `tract-mt`.
4. **True single-digit-ms** embedding requires a **native** build — out of scope
   for the browser deliverable, but the path if a desktop extension is ever
   shipped.

---

### Method notes / caveats

- wasm numbers via the `anki_embed_log` instrumentation (per-embed `text`+`ms`)
  exposed by the extension; host numbers via a throwaway example.
- Single-machine (Apple Silicon), single runs; treat ±a few ms as noise.
- "pre-DCE" crate sizes are `llvm-nm` symbol sizes on the staticlib (before the
  linker dead-strips); they show *relative* composition, not the final wasm.
