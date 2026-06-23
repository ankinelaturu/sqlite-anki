//! `anki` virtual table module (planner-driven `MATCH` + HNSW).
//!
//! Full virtual table implementation is in progress; SQL scalar functions are
//! registered from [`crate::extension`] today.

/// Name of the virtual table module: `CREATE VIRTUAL TABLE ... USING anki(...)`.
pub const MODULE_NAME: &str = "anki";
