# sqlite-anki

SQLite with built-in semantic search for the browser.

**sqlite-anki** lets you store text and query it by meaning using plain SQL.

```sql
CREATE VIRTUAL TABLE docs USING anki(
  title TEXT,
  body TEXT VECTOR
);

SELECT * FROM docs
WHERE body MATCH 'how do I cancel my subscription';
```

Embeddings are generated automatically on `INSERT`/`UPDATE` and stored in the same table as your text—no joins, no separate vector database, no synchronization pipeline. The model runs *inside* SQLite (Rust compiled to WebAssembly), so search happens entirely in the browser—no embedding API, and no JavaScript on the query hot path.

## Quick start

```bash
pnpm install
pnpm build:wasm   # build the custom WASM → packages/wasm/dist/
pnpm dev          # Explorer SPA → http://localhost:5173
```

The model is **not** bundled in the wasm; it's fetched/loaded at init:

```js
import sqlite3Init from "@sqlite-anki/wasm";

const sqlite3 = await sqlite3Init({
  anki: {
    model: "all-MiniLM-L6-v2" 
    } 
});

const db = new sqlite3.oo1.OpfsDb("/app.db");
```

## Querying

Create an `anki` table with `TEXT VECTOR` columns; text is auto-embedded on
write. Search with `MATCH`, score/order with `similarity()`.

```sql
CREATE VIRTUAL TABLE customers USING anki(name TEXT, status TEXT, notes TEXT VECTOR);

INSERT INTO customers(name, status, notes) VALUES
  ('Acme', 'active', 'potential upsell opportunity');

-- semantic search, best-first, with the score
SELECT name, status FROM customers
WHERE notes MATCH 'upsell opportunity'
ORDER BY similarity(notes) DESC
LIMIT 10;
```

**Relational + semantic (hybrid).** Plain SQL predicates combine with `MATCH`;
equality/range filters are *pre-filtered* (the relational filter runs first, then
similarity ranks the survivors), so selective filters don't lose matches:

```sql
SELECT name FROM customers
WHERE status = 'active' AND notes MATCH 'billing issue'
ORDER BY similarity(notes) DESC;
```

`**MATCH` DSL.** A regex-style suffix controls *how* the search runs (see
[docs/match-dsl.md](./docs/match-dsl.md)):

```sql
WHERE notes MATCH 'apple'            -- default: HNSW (fast, approximate)
WHERE notes MATCH 'apple/exact'      -- brute-force (exact, complete)
WHERE notes MATCH 'apple/hnsw:512'   -- approximate, candidate budget 512
```

Notes:

- `similarity(col)` returns the cosine score for the active `MATCH` (NULL without
one); it does **not** recompute — the score is cached from the scan. It works in
`SELECT`/`WHERE`/`ORDER BY`/`GROUP BY` keys, but **not inside aggregates** yet
(returns NULL — see [docs/query-planning.md](./docs/query-planning.md)).
- Default similarity threshold is `0.5`; tighten with `AND similarity(col) > 0.7`.
- The model runs in Rust/WASM — no JavaScript on the query hot path.

## Documentation


| Document                                                         | Description                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/DESIGN.md](./docs/DESIGN.md)                               | Full design specification                            |
| [docs/dynamic-model-loading.md](./docs/dynamic-model-loading.md) | Runtime model loading (no bundled model)             |
| [docs/match-dsl.md](./docs/match-dsl.md)                         | The `MATCH` semantic-query DSL                       |
| [docs/hybrid-filtering.md](./docs/hybrid-filtering.md)           | Relational `WHERE` + `MATCH` pushdown                |
| [docs/query-planning.md](./docs/query-planning.md)               | How SQLite plans queries against the vtab            |
| [docs/metrics.md](./docs/metrics.md)                             | Per-operation metrics via `anki_metrics()`           |
| [docs/our-findings.md](./docs/our-findings.md)                   | Performance & size profiling: where the time/size go |
| [docs/build-variants.md](./docs/build-variants.md)               | WASM build variants (engine / threading)             |


## Performance

In-browser embedding was profiled in depth — full data in
[docs/our-findings.md](./docs/our-findings.md), build variants in
[docs/build-variants.md](./docs/build-variants.md). Highlights:

- **Where the size goes.** The wasm is ~~14 MB not because of SQLite (~~1 MB) or the
extension (~50 KB) but because it statically links a full ONNX engine
(Tract + ndarray ≈ 12 MB). An embedding is a single transformer forward pass;
the model, graph optimization, and tokenizer load **once**.
- **The biggest win was the tokenizer, not the engine.** The model's tokenizer
padded every input to a fixed 128 tokens — ~~82% of each forward pass wasted on
`[PAD]`. Padding to the input's actual length cut a short embed **~~96 ms → ~~11 ms
(~~9×)** and the 1,200-embedding demo build **~105 s → ~19 s** — and corrected a
latent mean-pooling bug (it now matches sentence-transformers' masked mean).
- **Engine choice (Tract vs Candle).** Both give identical embeddings and pass the
suite. Tract is faster for short text (the common case); Candle is **−65% smaller**
and edges ahead only for long documents:

  | build                     | typical text | long (512 tok) | wasm    |
  | ------------------------- | ------------ | -------------- | ------- |
  | `tract-onnx-st` (default) | ~16 ms       | 525 ms         | 14.4 MB |
  | `candle-onnx-st`          | ~21 ms       | 506 ms         | 5.0 MB  |

  Per-embed time scales ~linearly with tokens (BERT caps at 512). wasm threads
  (`candle-onnx-mt`) gave **no** measurable gain at any length — the per-sentence
  matmuls are too small. Native (non-wasm) ONNX would be ~single-digit ms, but
  that's a different deliverable.

Default is `**tract-onnx-st`** (fastest, stable toolchain, no nightly).

## Monorepo layout

```
crates/           Rust extension (anki-core, anki-wasm)
packages/
  wasm/           SQLite WASM bundle (@sqlite-anki/wasm) — sqlite3Init + model loader
apps/
  explorer/       Test SPA (@sqlite-anki/explorer); src/db/ holds the worker + DB client
wasm/             sqlite3_wasm_extra_init.c + anki_extension.c (C glue / exports)
models/           ONNX + tokenizer — dev/test fixture, not bundled (see models/all-MiniLM-L6-v2/README.md)
```

## Explorer app

- **Left:** schema tree (tables → columns, `TEXT VECTOR` badges)
- **Right:** data grid with inline edit, add/delete rows, semantic search bar

Uses OPFS for persistence. Requires COOP/COEP headers (configured in Vite).

## Tests

Two layers, both run in CI on every push (`.github/workflows/deploy.yml`):

- **Rust unit tests** — pure logic (the `MATCH` DSL parser, HNSW, the `WHERE`
  pre-filter comparisons); no model or wasm needed:

  ```bash
  cargo test -p anki-core
  ```

- **WASM integration tests** — load the built wasm + the real model under Node
  and exercise the virtual table end-to-end. The model isn't in git, so fetch it
  once first:

  ```bash
  bash scripts/download-model.sh         # → models/all-MiniLM-L6-v2/ (gitignored, 86 MB)
  pnpm build:wasm                        # if not already built
  pnpm --filter @sqlite-anki/wasm test
  ```

## Status

- `**anki` virtual table:** working — `CREATE VIRTUAL TABLE … USING anki`,
auto-embedding INSERT/UPDATE/DELETE, `MATCH`, `similarity()`, persistence
(shadow tables), transactions/savepoints.
- **Search:** HNSW ANN + exact brute-force (`MATCH` DSL `mode`), hybrid
relational+semantic pre-filtering, and **multiple `MATCH` columns per query**
(AND'd, each with its own `similarity()` score).
- **Model:** loaded at runtime (not bundled); wasm ≈ 14 MB (Tract default) or
≈ 5 MB (Candle build variant). See [Performance](#performance).
- **Tests:** Rust unit tests (`cargo test`) + WASM integration suite
(`pnpm --filter @sqlite-anki/wasm test`).
- **Not yet:** `similarity()` inside aggregates, quantized model.

