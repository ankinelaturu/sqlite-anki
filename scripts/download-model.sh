#!/usr/bin/env bash
# Downloads pinned all-MiniLM-L6-v2 ONNX + tokenizer into models/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DIR="$ROOT/models/all-MiniLM-L6-v2"
BASE_URL="https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main"

mkdir -p "$MODEL_DIR"

download() {
  local name="$1"
  local dest="$MODEL_DIR/$name"
  if [[ -f "$dest" ]]; then
    echo "==> $name already exists"
    return
  fi
  echo "==> Downloading $name"
  curl -fsSL "$BASE_URL/onnx/$name" -o "$dest" 2>/dev/null || \
    curl -fsSL "$BASE_URL/$name" -o "$dest"
}

download "model.onnx"
download "tokenizer.json"

if [[ ! -f "$MODEL_DIR/config.json" ]]; then
  echo "==> Writing config.json"
  cat > "$MODEL_DIR/config.json" <<'EOF'
{
  "model_id": "all-MiniLM-L6-v2",
  "embed_dim": 384,
  "pooling": "mean"
}
EOF
fi

echo "==> Model files in $MODEL_DIR"
ls -lh "$MODEL_DIR"
