//! Runtime model loading (FFI) and model metadata.
//!
//! The JS glue fetches the ONNX model + tokenizer and calls the C export
//! `anki_load_model` (in `wasm/anki_extension.c`), which forwards to
//! [`anki_embedder_load`] here. See `docs/dynamic-model-loading.md`.

use crate::embedder::Embedder;
use parking_lot::Mutex;
use std::os::raw::c_int;
use std::{slice, str};

/// Metadata for the currently loaded model, surfaced by `anki_model()` /
/// `anki_dim()` and used to guard against model/table mismatch on connect.
pub struct ModelMeta {
    pub id: String,
    pub dim: usize,
}

static META: Mutex<Option<ModelMeta>> = Mutex::new(None);

/// Returns `(model_id, dim)` for the loaded model, or `None` if none is loaded.
pub fn current() -> Option<(String, usize)> {
    META.lock().as_ref().map(|m| (m.id.clone(), m.dim))
}

/// Loads the global embedder from raw bytes and records its metadata.
///
/// Returns 0 on success, non-zero on failure. Intended to be called once, at
/// init time, from the JS glue.
///
/// # Safety
///
/// All pointers must be valid for their stated lengths. `tokenizer`/`model_id`
/// must be valid UTF-8.
#[no_mangle]
pub unsafe extern "C" fn anki_embedder_load(
    model_ptr: *const u8,
    model_len: usize,
    tok_ptr: *const u8,
    tok_len: usize,
    dim: u32,
    id_ptr: *const u8,
    id_len: usize,
) -> c_int {
    if model_ptr.is_null() || tok_ptr.is_null() || dim == 0 {
        return 1;
    }
    let model = slice::from_raw_parts(model_ptr, model_len);
    let tokenizer = match str::from_utf8(slice::from_raw_parts(tok_ptr, tok_len)) {
        Ok(s) => s,
        Err(_) => return 1,
    };
    let model_id = if id_ptr.is_null() || id_len == 0 {
        String::new()
    } else {
        String::from_utf8_lossy(slice::from_raw_parts(id_ptr, id_len)).into_owned()
    };

    let dim = dim as usize;
    if Embedder::load(model, tokenizer, dim).is_err() {
        return 1;
    }
    *META.lock() = Some(ModelMeta { id: model_id, dim });
    0
}
