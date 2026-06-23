//! HNSW approximate nearest-neighbor index (`hnsw_rs`).
//!
//! One [`ColumnIndex`] is maintained per `TEXT VECTOR` column on each
//! `anki` virtual table.

/// Per-column HNSW index placeholder until `hnsw_rs` is wired (v0 spike).
pub struct ColumnIndex {
    /// Vector dimension (must match embedder output).
    pub dim: usize,
}

impl ColumnIndex {
    /// Creates an empty index for vectors of dimension `dim`.
    pub fn new(dim: usize) -> Self {
        Self { dim }
    }
}
