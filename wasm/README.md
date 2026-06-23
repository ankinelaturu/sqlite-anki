# SQLite WASM build

Custom `sqlite3.wasm` with sqlite-anki statically linked.

## Prerequisites

- SQLite source tree (checked out, not amalgamation-only)
- Emscripten SDK
- GNU Make, wabt (`wasm-strip`)
- Rust `wasm32-unknown-unknown` target

## Steps (manual until Makefile is wired)

1. Build Rust staticlib: `cargo build -p anki-wasm-minilm --target wasm32-unknown-unknown --release`
2. Copy or symlink `sqlite3_wasm_extra_init.c` into SQLite `ext/wasm/`
3. Link `libanki_wasm_minilm.a` in the Emscripten link step
4. `make` in `ext/wasm` → copy `jswasm/sqlite3.{js,wasm}` to `packages/wasm-minilm/dist/`

Or run from repo root (placeholder):

```bash
./scripts/build-wasm.sh
```
