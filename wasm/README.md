# SQLite WASM build

Custom `sqlite3.wasm` with sqlite-anki statically linked.

## Prerequisites

- Rust `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- ONNX model in `models/all-MiniLM-L6-v2/` (`./scripts/download-model.sh`)
- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) on `PATH` (`emcc`)
- [wabt](https://github.com/WebAssembly/wabt) (`wasm-strip`) — required for release-quality WASM
- GNU Make, git

## One-command build

From the repo root:

```bash
pnpm build:wasm
# or: ./scripts/build-wasm.sh
```

This script:

1. Builds `anki-wasm-minilm` as LLVM bitcode (`RUSTFLAGS=--emit=llvm-bc`)
2. Fetches SQLite `version-3.49.1` into `vendor/sqlite/` (override with `SQLITE_SRC`)
3. Installs `wasm/sqlite3_wasm_extra_init.c` → `ext/wasm/sqlite3_wasm_extra_init.c`
4. Runs the official `ext/wasm` Makefile, appending Rust `.bc` files to the emcc link
5. Copies `jswasm/*` artifacts to `packages/wasm-minilm/dist/`

`@sqlite-anki/wasm-minilm` loads the custom `dist/` bundle when present; otherwise it re-exports `@sqlite.org/sqlite-wasm`.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `SQLITE_SRC` | `vendor/sqlite` | Path to SQLite source tree |
| `SQLITE_TAG` | `version-3.49.1` | Git tag to clone |
| `EMCC_INITIAL_MEMORY` | `128` | Initial WASM memory (MB) — large ONNX model |
| `EMSDK` | auto-detect | Emscripten SDK root |

## Verify extension

After a custom build, in the explorer app or worker:

```sql
SELECT anki_version();
SELECT anki_model();
SELECT anki_dim();
```
