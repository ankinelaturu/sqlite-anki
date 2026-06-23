//! Sentence embedding via bundled ONNX model (Tract).
//!
//! The WASM build embeds `model.onnx` and `tokenizer.json` at compile time.
//! This module will tokenize text and return fixed-size `f32` vectors.

/// Embedding dimension for the default `all-MiniLM-L6-v2` model.
pub const EMBED_DIM: usize = 384;

/// Logical model identifier baked into this build.
pub const MODEL_ID: &str = "all-MiniLM-L6-v2";

/// Placeholder embedder until Tract integration lands (v0 spike).
pub struct Embedder;

impl Embedder {
    /// Returns the model identifier for this build.
    pub fn model_id() -> &'static str {
        MODEL_ID
    }

    /// Returns the embedding dimension for this build.
    pub fn dimension() -> usize {
        EMBED_DIM
    }
}
