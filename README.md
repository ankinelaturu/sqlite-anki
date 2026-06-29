# sqlite-anki

SQLite with built-in semantic search for the browser.

**▶ Live demo — [sqlite-anki.app](https://sqlite-anki.app)** (SQLite, the model, and your data all run in the tab)

**sqlite-anki** lets you store text and query it by meaning using plain SQL:

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

Try it without installing anything at **[sqlite-anki.app](https://sqlite-anki.app)**. To run the explorer locally:

```bash
pnpm install
pnpm build:wasm   # build the custom WASM → packages/wasm/dist/
pnpm dev          # → http://localhost:5173
```

### Use it in your own app

```ts
import sqlite3Init from "@sqlite-anki/wasm";

// Boot SQLite (WASM) and load an embedding model. The model is fetched once
// from HuggingFace and cached in OPFS — it is NOT bundled into the wasm.
const sqlite3 = await sqlite3Init({
  anki: { model: "all-MiniLM-L6-v2" },
});

// Open a persistent, OPFS-backed database (or ":memory:" for an ephemeral one).
const db = new sqlite3.oo1.OpfsDb("/app.db");

// A `TEXT VECTOR` column is embedded automatically on every write.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS docs USING anki(
    title TEXT,
    body  TEXT VECTOR
  );
`);

db.exec(`
  INSERT INTO docs(title, body) VALUES
    ('Billing', 'how to update your payment method'),
    ('Cancel',  'the steps to cancel a subscription');
`);

// Search by meaning. `<col>_score` is the cosine score for the active MATCH.
const hits = db.selectObjects(`
  SELECT title, body_score AS score
  FROM docs
  WHERE body MATCH 'end my plan'
  ORDER BY score DESC
  LIMIT 5;
`);

console.log(hits); // → [{ title: "Cancel", score: 0.6… }, …]
```

> **Self-hosting note:** OPFS persistence + WASM threads need cross-origin
> isolation, so serve with `Cross-Origin-Opener-Policy: same-origin` and
> `Cross-Origin-Embedder-Policy: require-corp`. The explorer's Vite config sets
> these for you. Other models (MiniLM-L12, mpnet, multilingual…) are available —
> see [docs/dynamic-model-loading.md](./docs/dynamic-model-loading.md).

## Querying

Create an `anki` table with `TEXT VECTOR` columns; text is auto-embedded on
write. Search with `MATCH`, score/order with each column's `<col>_score`.

```sql
CREATE VIRTUAL TABLE customers USING anki(
  name TEXT,
  status TEXT,
  notes TEXT VECTOR
);

INSERT INTO customers(name, status, notes) VALUES
  ('Acme', 'active', 'potential upsell opportunity');

-- semantic search, best-first, with the score
SELECT name, status FROM customers
WHERE notes MATCH 'upsell opportunity'
ORDER BY notes_score DESC
LIMIT 10;
```

**Relational + semantic (hybrid).** Plain SQL predicates combine with `MATCH`;
equality/range filters are *pre-filtered* (the relational filter runs first, then
similarity ranks the survivors), so selective filters don't lose matches. The
pushdown is collation-aware and numerically exact — it only ever *narrows*, never
dropping a row SQLite would keep (see
[docs/hybrid-filtering.md](./docs/hybrid-filtering.md#correctness-false-positives-vs-false-negatives)):

```sql
SELECT name FROM customers
WHERE status = 'active' AND notes MATCH 'billing issue'
ORDER BY notes_score DESC;
```

**`MATCH` DSL.** A regex-style suffix controls *how* the search runs (see
[docs/match-dsl.md](./docs/match-dsl.md)):

```sql
WHERE notes MATCH 'apple'            -- default: HNSW (fast, approximate)
WHERE notes MATCH 'apple/exact'      -- brute-force (exact, complete)
WHERE notes MATCH 'apple/hnsw:512'   -- approximate, candidate budget 512
```

Notes:

- Each `TEXT VECTOR` column exposes a hidden `<col>_score` column (e.g.
  `notes_score`) — the cosine for the active `MATCH` on that column, `NULL`
  without one. It's a query-time column (not stored, not recomputed), so it works
  in `SELECT`/`WHERE`/`ORDER BY`/`GROUP BY` **and inside aggregates**
  (`AVG(notes_score)`, `MAX(notes_score) … GROUP BY`). See
  [docs/query-planning.md](./docs/query-planning.md).
- Default similarity threshold is `0.5`; tighten with `AND notes_score > 0.7`.
- The model runs in Rust/WASM — no JavaScript on the query hot path.

## Documentation

| Document                                                         | Description                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/DESIGN.md](./docs/DESIGN.md)                               | Full design specification                            |
| [docs/design-choices.md](./docs/design-choices.md)              | Why the key design decisions are what they are       |
| [docs/dynamic-model-loading.md](./docs/dynamic-model-loading.md) | Runtime model loading (no bundled model)             |
| [docs/match-dsl.md](./docs/match-dsl.md)                         | The `MATCH` semantic-query DSL                       |
| [docs/hybrid-filtering.md](./docs/hybrid-filtering.md)           | Relational `WHERE` + `MATCH` pushdown + correctness  |
| [docs/query-planning.md](./docs/query-planning.md)               | How SQLite plans queries against the vtab            |
| [docs/metrics.md](./docs/metrics.md)                             | Per-operation metrics via `anki_metrics()`           |
| [docs/our-findings.md](./docs/our-findings.md)                   | Performance & size profiling: where the time/size go |
| [docs/build-variants.md](./docs/build-variants.md)               | WASM build variants (engine / threading)             |

## Performance

In-browser embedding was profiled in depth — full data in
[docs/our-findings.md](./docs/our-findings.md), build variants in
[docs/build-variants.md](./docs/build-variants.md). Highlights:

- **Where the size goes.** The wasm is ~14 MB not because of SQLite (~1 MB) or the
  extension (~50 KB) but because it statically links a full ONNX engine
  (Tract + ndarray ≈ 12 MB). An embedding is a single transformer forward pass;
  the model, graph optimization, and tokenizer load **once**.
- **The biggest win was the tokenizer, not the engine.** The model's tokenizer
  padded every input to a fixed 128 tokens — ~82% of each forward pass wasted on
  `[PAD]`. Padding to the input's actual length cut a short embed **~96 ms → ~11 ms
  (~9×)** and the 1,200-embedding demo build **~105 s → ~19 s** — and corrected a
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

Default is **`tract-onnx-st`** (fastest, stable toolchain, no nightly).

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

The SPA behind the [live demo](https://sqlite-anki.app):

- **Activity bar** switches between a **SQLite** workspace and an **OPFS** file browser.
- **SQLite:** schema tree (tables → columns, `TEXT VECTOR` badges) on the left; a
  data grid with inline edit, add/delete rows, and a semantic search bar on the right.
- **OPFS:** a VSCode-style file tree + tabbed editor over what the explorer persists.

Uses OPFS for persistence; requires COOP/COEP headers (configured in Vite).

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

- **`anki` virtual table:** working — `CREATE VIRTUAL TABLE … USING anki`,
  auto-embedding INSERT/UPDATE/DELETE, `MATCH`, `<col>_score`, persistence
  (shadow tables), transactions/savepoints.
- **Search:** HNSW ANN + exact brute-force (`MATCH` DSL `mode`), hybrid
  relational+semantic pre-filtering, and **multiple `MATCH` columns per query**
  (AND'd, each with its own `<col>_score`).
- **Model:** loaded at runtime (not bundled); wasm ≈ 14 MB (Tract default) or
  ≈ 5 MB (Candle build variant). See [Performance](#performance).
- **Tests:** Rust unit tests (`cargo test -p anki-core`) + WASM integration suite
  (`pnpm --filter @sqlite-anki/wasm test`).
- **Not yet:** quantized model.
