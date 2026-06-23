//! Rust exports linked into custom `sqlite3.wasm` (embedder only; SQL API is in C).

#[cfg(embedded_model)]
use anki_core::embedder::Embedder;

/// Warms the bundled ONNX embedder. Called from `anki_extension.c` during init.
///
/// # Safety
///
/// Must only be called from the SQLite extension init path (single-threaded).
#[no_mangle]
pub extern "C" fn anki_embedder_init() -> i32 {
    #[cfg(embedded_model)]
    {
        match Embedder::global() {
            Ok(_) => 0,
            Err(e) => {
                eprintln!("anki embedder init failed: {e}");
                1
            }
        }
    }
    #[cfg(not(embedded_model))]
    {
        eprintln!("anki embedder init failed: embedded model missing");
        1
    }
}
