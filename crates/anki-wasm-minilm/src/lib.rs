//! Static library linked into the custom `sqlite3.wasm` build with MiniLM weights.
//!
//! ONNX and tokenizer bytes will be embedded here via `include_bytes!` once the
//! model artifacts are pinned under `models/all-MiniLM-L6-v2/`.

pub use anki_core::vtab::sqlite3_anki_init;
