//! Error types for sqlite-anki extension operations.

use thiserror::Error;

/// Errors produced by embedding, indexing, and virtual table logic.
#[derive(Debug, Error)]
pub enum AnkiError {
    /// Input text was `NULL`, empty, or whitespace-only.
    #[error("empty input text")]
    EmptyInput,

    /// ONNX / Tract inference failed.
    #[error("inference failed: {0}")]
    Inference(String),

    /// SQLite virtual table or extension API error.
    #[error("sqlite error: {0}")]
    Sqlite(String),

    /// HNSW index operation failed.
    #[error("index error: {0}")]
    Index(String),
}
