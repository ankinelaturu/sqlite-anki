//! Core library for the **sqlite-anki** SQLite extension.
//!
//! Provides embedding via Tract, HNSW indexing, and SQLite extension registration
//! for browser WASM builds linked through `sqlite3_wasm_extra_init`.

pub mod embedder;
pub mod error;
pub mod extension;
pub mod hnsw;
pub mod loader;
pub mod vtab;

/// Extension version string surfaced by `anki_version()` SQL function.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default cosine similarity threshold for `MATCH` (see design doc).
pub const DEFAULT_SIMILARITY_THRESHOLD: f32 = 0.5;

/// Fixed HNSW candidate cap per `MATCH` query.
pub const HNSW_CANDIDATE_CAP: usize = 256;
