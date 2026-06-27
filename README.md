# sqlite-anki

Semantic text search for SQLite in the browser (WebAssembly).

**sqlite-anki** stores text and embeddings together, and supports SQL like `WHERE notes MATCH 'some query'`. Embeddings run in Rust — no JavaScript on the query hot path.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/DESIGN.md](./docs/DESIGN.md) | Full design specification |
| [docs/dynamic-model-loading.md](./docs/dynamic-model-loading.md) | Runtime model loading (no bundled model) |
| [docs/match-dsl.md](./docs/match-dsl.md) | The `MATCH` semantic-query DSL |
| [docs/hybrid-filtering.md](./docs/hybrid-filtering.md) | Relational `WHERE` + `MATCH` pushdown |
| [docs/query-planning.md](./docs/query-planning.md) | How SQLite plans queries against the vtab |
| [docs/metrics.md](./docs/metrics.md) | Per-operation metrics via `anki_metrics()` |

## Quick start

```bash
pnpm install
bash scripts/download-model.sh   # fetch the dev model into models/ (one-time)
pnpm build:wasm                  # build the custom WASM → packages/wasm/dist/
pnpm --filter @sqlite-anki/wasm test   # integration tests
pnpm dev                         # Explorer SPA → http://localhost:5173
```

The model is **not** bundled in the wasm; it's fetched/loaded at init:

```js
import sqlite3Init from "@sqlite-anki/wasm";
const sqlite3 = await sqlite3Init({ anki: { model: "all-MiniLM-L6-v2" } });
const db = new sqlite3.oo1.OpfsDb("/app.db");
```

## Querying

Create an `anki` table with `TEXT VECTOR` columns; text is auto-embedded on
write. Search with `MATCH`, score/order with `similarity()`.

```sql
CREATE VIRTUAL TABLE customers USING anki(name TEXT, status TEXT, notes TEXT VECTOR);

INSERT INTO customers(name, status, notes) VALUES
  ('Acme', 'active', 'discussed renewal — potential upsell opportunity');

-- semantic search, best-first, with the score
SELECT name, similarity(notes) AS score
FROM customers
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

**`MATCH` DSL.** A regex-style suffix controls *how* the search runs (see
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

## Monorepo layout

```
crates/           Rust extension (anki-core, anki-wasm)
packages/
  wasm/    SQLite WASM bundle (@sqlite-anki/wasm)
  db-client/      Worker + schema + CRUD API (@sqlite-anki/db-client)
apps/
  explorer/       Two-panel test SPA (@sqlite-anki/explorer)
wasm/             sqlite3_wasm_extra_init.c
models/           ONNX + tokenizer (see models/all-MiniLM-L6-v2/README.md)
```

## Explorer app

- **Left:** schema tree (tables → columns, `TEXT VECTOR` badges)
- **Right:** data grid with inline edit, add/delete rows, semantic search bar

Uses OPFS for persistence. Requires COOP/COEP headers (configured in Vite).

## Status

- **`anki` virtual table:** working — `CREATE VIRTUAL TABLE … USING anki`,
  auto-embedding INSERT/UPDATE/DELETE, `MATCH`, `similarity()`, persistence
  (shadow tables), transactions/savepoints.
- **Search:** HNSW ANN + exact brute-force (`MATCH` DSL `mode`), hybrid
  relational+semantic pre-filtering, and **multiple `MATCH` columns per query**
  (AND'd, each with its own `similarity()` score).
- **Model:** loaded at runtime (not bundled); wasm ≈ 14 MB.
- **Tests:** Rust unit tests (`cargo test`) + WASM integration suite
  (`pnpm --filter @sqlite-anki/wasm test`).
- **Not yet:** `similarity()` inside aggregates, quantized model.
