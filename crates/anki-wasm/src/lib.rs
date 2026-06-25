//! Links the sqlite-anki Rust extension into custom `sqlite3.wasm`.
//!
//! All exported symbols live in `anki-core` (`anki_register_vtab`,
//! `anki_embedder_load`); this crate only pulls them into the staticlib. The
//! model is loaded at runtime from JS — nothing is bundled. See
//! `docs/dynamic-model-loading.md`.

// Force a link dependency on anki-core so its `#[no_mangle]` exports are
// available to the C glue and the JS-facing wasm exports.
pub use anki_core as _anki_core;
