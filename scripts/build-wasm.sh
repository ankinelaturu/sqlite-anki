#!/usr/bin/env bash
# Builds custom sqlite3.wasm with sqlite-anki statically linked (Emscripten + SQLite + ONNX).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="${SQLITE_SRC:-$ROOT/vendor/sqlite}"
SQLITE_TAG="${SQLITE_TAG:-version-3.49.1}"
DIST="$ROOT/packages/wasm-minilm/dist"
WASM_TARGET="wasm32-unknown-unknown"
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

# --- ONNX model --------------------------------------------------------------

MODEL="$ROOT/models/all-MiniLM-L6-v2/model.onnx"
if [[ ! -f "$MODEL" ]]; then
  echo "==> Downloading all-MiniLM-L6-v2 model"
  bash "$ROOT/scripts/download-model.sh"
fi

# --- Rust extension (LLVM bitcode for emcc link) ------------------------------

echo "==> Building anki-wasm-minilm ($WASM_TARGET, llvm-bc)"
export RUSTFLAGS="${RUSTFLAGS:---emit=llvm-bc}"
cargo build -p anki-wasm-minilm --target "$WASM_TARGET" --release

# One .bc per crate (deps/ may retain older hashes from prior builds).
ANKI_BC=()
while IFS= read -r line; do
  ANKI_BC+=("$line")
done < <(
  python3 - "$CARGO_TARGET/deps" <<'PY'
import re
import sys
from pathlib import Path

deps = Path(sys.argv[1])
pat = re.compile(r"^(?:lib)?(.+)-[0-9a-f]{16}\.bc$")
latest: dict[str, Path] = {}
for bc in deps.glob("*.bc"):
    m = pat.match(bc.name)
    if not m:
        continue
    latest[m.group(1)] = bc
for path in sorted(latest.values()):
    print(path)
PY
)
[[ ${#ANKI_BC[@]} -gt 0 ]] || die "no LLVM bitcode files in $CARGO_TARGET/deps (RUSTFLAGS=--emit=llvm-bc?)"

echo "    linking ${#ANKI_BC[@]} Rust bitcode object(s)"

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

# Append Rust bitcode to the emcc link line (see tantaman/sqlite-rust-wasm).
ANKI_BC_MAKE=""
for bc in "${ANKI_BC[@]}"; do
  ANKI_BC_MAKE+=" $bc"
done

# Larger initial memory for bundled ONNX (~86MB model + runtime).
EMCC_INITIAL_MEMORY="${EMCC_INITIAL_MEMORY:-128}"

echo "==> Building official SQLite WASM (ext/wasm)"
make -C "$WASM_DIR" clean >/dev/null 2>&1 || true
make -C "$WASM_DIR" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)" \
  emcc.INITIAL_MEMORY="$EMCC_INITIAL_MEMORY" \
  "sqlite3-wasm.cfiles+=${ANKI_BC_MAKE}" \
  jswasm/sqlite3.mjs \
  jswasm/sqlite3-bundler-friendly.mjs \
  jswasm/sqlite3-worker1.mjs \
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
  "$WASM_DIR/jswasm/sqlite3-worker1.mjs" \
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
embedded model: all-MiniLM-L6-v2
built: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo ""
echo "Done. Custom WASM is in packages/wasm-minilm/dist/"
echo "Run: pnpm --filter @sqlite-anki/explorer dev"
