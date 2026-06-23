# all-MiniLM-L6-v2 model artifacts

Place pinned ONNX export here (not committed by default — see root `.gitignore`):

- `model.onnx` — quantized sentence embedding model (~20–25 MB)
- `tokenizer.json` — HuggingFace tokenizer
- `config.json` — pooling=mean, dim=384

Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2

After adding files, run `pnpm build:wasm` to embed them in the custom WASM build.
