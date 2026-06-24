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
    // No eprintln!/stderr here: the std stdio backing isn't linked into the
    // Emscripten SQLite module, and a WASM extension has nowhere to print. The
    // C caller maps any nonzero return to SQLITE_ERROR.
    #[cfg(embedded_model)]
    {
        match Embedder::global() {
            Ok(_) => 0,
            Err(_) => 1,
        }
    }
    #[cfg(not(embedded_model))]
    {
        1
    }
}
