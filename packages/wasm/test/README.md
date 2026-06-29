# `@sqlite-anki/wasm` integration tests

End-to-end tests for the custom SQLite WASM build: the `anki` virtual table,
embedding, persistence, transactions, HNSW, dynamic model loading, and the
model-mismatch guard. They run the **actual wasm** through the Node loader
(`dist/sqlite3-node.mjs`) — not mocks.

## Run

```bash
scripts/download-model.sh     # once: fetch the dev model into models/
pnpm build:wasm               # build dist/ (incl. the node loader)
pnpm --filter @sqlite-anki/wasm test
```

Uses Node's built-in test runner (`node --test`) and `node:assert` — no extra
deps. Each `*.test.mjs` file runs in its own process and initializes a fresh
wasm module.

## Prerequisites

- `models/all-MiniLM-L6-v2/{model.onnx,tokenizer.json}` (via `download-model.sh`)
- `packages/wasm/dist/{sqlite3-node.mjs,sqlite3.wasm}` (via `build:wasm`)

The harness throws a clear message pointing at the right command if either is
missing.

## Files

| File | Covers |
|------|--------|
| `harness.mjs` | shared setup: module init + model load (byte-passing path) |
| `introspection.test.mjs` | `anki_version/model/dim`, NULL when no model |
| `vtab.test.mjs` | CREATE/INSERT/UPDATE/DELETE, `MATCH`, `<col>_score`, thresholds |
| `persistence.test.mjs` | close/reopen reload, search on reloaded vectors, `DROP`/xDestroy |
| `transactions.test.mjs` | `ROLLBACK`, `COMMIT`, `SAVEPOINT`/`ROLLBACK TO` |
| `hybrid-filtering.test.mjs` | relational `WHERE` + `MATCH` pushdown, incl. the recall-cliff case |
| `match-dsl.test.mjs` | `MATCH` DSL: `query/mode[:candidates]`, slashy literals, quoting, errors |
| `metrics.test.mjs` | `anki_metrics()` JSON shape + counters advancing (embed/search/persist/rebuild) |
| `guards.test.mjs` | no-model graceful behavior, model-mismatch guard |
| `hnsw-scale.test.mjs` | exact-match retrieval across row counts (HNSW regression guard) |

## Scope note

These cover the **extension/wasm behavior**. The browser glue's fetch + model
**registry** logic in `src/index.ts` (network) is not exercised here; the tests
use the same byte-passing path the glue ends in. Pure-Rust algorithm tests
(HNSW recall, embedder math) live in `crates/anki-core` and run via `cargo test`.
