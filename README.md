# sqlite-anki

Semantic text search for SQLite in the browser (WebAssembly).

**sqlite-anki** stores text and embeddings together, and supports SQL like `WHERE notes MATCH 'some query'`. Embeddings run in Rust — no JavaScript on the query hot path.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/DESIGN.md](./docs/DESIGN.md) | Full design specification |

## Quick start

```bash
pnpm install
pnpm dev          # Explorer SPA → http://localhost:5173
```

```bash
cargo check       # Rust extension crates
pnpm build:wasm   # Custom WASM (stub until Emscripten pipeline is wired)
```

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

Until the custom `anki` WASM build is ready, the explorer uses stock `@sqlite.org/sqlite-wasm` with regular tables; semantic search activates once the extension is linked.

## Status

- **Design:** complete ([DESIGN.md](./docs/DESIGN.md))
- **Rust:** scaffold (`anki-core` stubs)
- **Explorer:** working against stock SQLite WASM
- **Custom WASM + anki vtab:** not yet built
