#!/usr/bin/env bash
# Builds custom sqlite-anki WASM and copies artifacts to packages/wasm-minilm/dist/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/packages/wasm-minilm/dist"

echo "==> Building anki-wasm-minilm (Rust staticlib)"
cargo build -p anki-wasm-minilm --target wasm32-unknown-unknown --release

echo ""
echo "==> Custom SQLite WASM link not yet automated."
echo "    See wasm/README.md for manual steps (Emscripten + SQLite ext/wasm)."
echo ""
echo "    Until then, apps use @sqlite.org/sqlite-wasm via packages/wasm-minilm."
echo ""

mkdir -p "$DIST"
if [[ ! -f "$DIST/.gitkeep" ]]; then
  touch "$DIST/.gitkeep"
fi
