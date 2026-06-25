#!/usr/bin/env bash
# Builds custom sqlite3.wasm with sqlite-anki statically linked (Emscripten + SQLite + ONNX).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="${SQLITE_SRC:-$ROOT/vendor/sqlite}"
SQLITE_TAG="${SQLITE_TAG:-version-3.49.1}"
DIST="$ROOT/packages/wasm-minilm/dist"
# Emscripten target so Rust's ABI + getrandom backend match the emcc link
# (vs. wasm32-unknown-unknown, which mismatches the triple and needs JS RNG shims).
WASM_TARGET="wasm32-unknown-emscripten"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
CARGO_TARGET="$CARGO_TARGET_DIR/$WASM_TARGET/release"
EXTRA_INIT_SRC="$ROOT/wasm/sqlite3_wasm_extra_init.c"
ANKI_EXT_SRC="$ROOT/wasm/anki_extension.c"

die() { echo "error: $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# --- prerequisites -----------------------------------------------------------

need_cmd cargo
need_cmd git
need_cmd make

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

rustup target add "$WASM_TARGET" >/dev/null 2>&1 || true

if [[ -z "${EMSDK:-}" ]]; then
  if [[ -f "/opt/homebrew/Cellar/emscripten"/*/libexec/emsdk_env.sh ]]; then
    # shellcheck disable=SC1091
    source "/opt/homebrew/Cellar/emscripten"/*/libexec/emsdk_env.sh
  elif [[ -f "$HOME/emsdk/emsdk_env.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/emsdk/emsdk_env.sh"
  elif [[ -f "$ROOT/vendor/emsdk/emsdk_env.sh" ]]; then
    # shellcheck disable=SC1091
    source "$ROOT/vendor/emsdk/emsdk_env.sh"
  fi
fi

need_cmd emcc
need_cmd wasm-strip

# The model is no longer bundled — it is fetched at runtime by the JS glue and
# handed to the extension via anki_load_model (see docs/dynamic-model-loading.md).
# scripts/download-model.sh remains a dev convenience for local testing.

# --- Rust extension (static archive for emcc link) ----------------------------
#
# We link the single staticlib archive, not scraped per-crate .bc files. The
# archive bundles the crate + all deps + the Rust sysroot (core/alloc/std), so
# wasm-ld can resolve everything (e.g. core::panicking, core::fmt) and pull only
# the members it needs. Loose .bc files omit the sysroot and break the link the
# moment the embedder is actually reachable.

echo "==> Building anki-wasm-minilm ($WASM_TARGET, staticlib)"
cargo build -p anki-wasm-minilm --target "$WASM_TARGET" --release

ANKI_LIB="$CARGO_TARGET/libanki_wasm_minilm.a"
[[ -f "$ANKI_LIB" ]] || die "missing staticlib $ANKI_LIB (cargo build failed?)"

echo "    linking $ANKI_LIB"

# --- SQLite source tree --------------------------------------------------------

if [[ ! -d "$VENDOR/ext/wasm" ]]; then
  echo "==> Fetching SQLite $SQLITE_TAG into $VENDOR"
  mkdir -p "$(dirname "$VENDOR")"
  git clone --depth 1 --branch "$SQLITE_TAG" https://github.com/sqlite/sqlite.git "$VENDOR"
fi

if [[ ! -f "$VENDOR/sqlite3.c" ]]; then
  echo "==> Configuring SQLite and generating sqlite3.c"
  (cd "$VENDOR" && ./configure --disable-shared && make sqlite3.c)
fi

WASM_DIR="$VENDOR/ext/wasm"

if [[ ! -f "$WASM_DIR/config.make" ]]; then
  echo "==> Writing $WASM_DIR/config.make"
  WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
  cat >"$WASM_DIR/config.make" <<EOF
bin.bash = $(command -v bash)
bin.emcc = $(command -v emcc)
bin.wasm-strip = $(command -v wasm-strip)
bin.wasm-opt = ${WASM_OPT:-false}
SHELL := \$(bin.bash)
EOF
fi
EXTRA_INIT_DST="$WASM_DIR/sqlite3_wasm_extra_init.c"
ANKI_EXT_DST="$WASM_DIR/anki_extension.c"
for pair in "$EXTRA_INIT_SRC:$EXTRA_INIT_DST" "$ANKI_EXT_SRC:$ANKI_EXT_DST"; do
  src="${pair%%:*}"
  dst="${pair##*:}"
  if [[ ! -f "$dst" ]] || ! cmp -s "$src" "$dst"; then
    echo "==> Installing $(basename "$src")"
    cp "$src" "$dst"
  fi
done

# Inject through emcc.flags.sqlite3 (unused by the makefile, present on every
# link line) rather than sqlite3-wasm.cfiles, whose makefile value a command-line
# += would clobber, dropping sqlite3-wasm.c itself. It also lands after
# emcc.jsflags, so the -sEXPORTED_RUNTIME_METHODS here overrides the makefile's.
#
# HEAPU64/HEAP64 are required: SQLite 3.49's JS glue accesses them, but this
# Emscripten no longer auto-exports the int64 heap views, which otherwise aborts
# in sqlite3ApiBootstrap with "HEAPU64 was not exported".
# HEAPU8 is needed so the JS glue can copy model/tokenizer bytes into the wasm
# heap before calling anki_load_model.
ANKI_LINK="$ANKI_LIB -sEXPORTED_RUNTIME_METHODS=wasmMemory,HEAPU64,HEAP64,HEAPU8"

# Headroom for the runtime-loaded ONNX model (copied into the heap at load) +
# inference arenas. ALLOW_MEMORY_GROWTH covers larger models.
EMCC_INITIAL_MEMORY="${EMCC_INITIAL_MEMORY:-128}"

echo "==> Building official SQLite WASM (ext/wasm)"
make -C "$WASM_DIR" clean >/dev/null 2>&1 || true
make -C "$WASM_DIR" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)" \
  emcc.INITIAL_MEMORY="$EMCC_INITIAL_MEMORY" \
  "emcc.flags.sqlite3=${ANKI_LINK}" \
  jswasm/sqlite3.mjs \
  jswasm/sqlite3-bundler-friendly.mjs \
  jswasm/sqlite3-worker1.js \
  jswasm/sqlite3-worker1-bundler-friendly.mjs \
  jswasm/sqlite3-opfs-async-proxy.js

# --- Publish to packages/wasm-minilm/dist --------------------------------------

echo "==> Copying artifacts to $DIST"
mkdir -p "$DIST"
shopt -s nullglob
for f in \
  "$WASM_DIR/jswasm/sqlite3.mjs" \
  "$WASM_DIR/jswasm/sqlite3.wasm" \
  "$WASM_DIR/jswasm/sqlite3-bundler-friendly.mjs" \
  "$WASM_DIR/jswasm/sqlite3-worker1.js" \
  "$WASM_DIR/jswasm/sqlite3-worker1-bundler-friendly.mjs" \
  "$WASM_DIR/jswasm/sqlite3-opfs-async-proxy.js" \
  "$WASM_DIR/jswasm/sqlite3-api.mjs" \
  "$WASM_DIR/jswasm/sqlite3-api-bundler-friendly.mjs"
do
  [[ -f "$f" ]] && cp -p "$f" "$DIST/"
done
shopt -u nullglob

cat >"$DIST/BUILD_INFO.txt" <<EOF
sqlite-anki custom WASM build
sqlite tag: $SQLITE_TAG
emcc: $(emcc --version | head -1)
rust target: $WASM_TARGET
model: runtime-loaded (not bundled)
built: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo ""
echo "Done. Custom WASM is in packages/wasm-minilm/dist/"
echo "Run: pnpm --filter @sqlite-anki/explorer dev"
