//! Propagates `embedded_model` cfg from the workspace models directory.
//!
//! Must mirror `anki-core/build.rs`: the cfg is per-crate, and `lib.rs` here
//! gates `anki_embedder_init` on it. Without setting it, the init function
//! compiles to the `not(embedded_model)` stub, which both dead-code-eliminates
//! the bundled embedder and makes `sqlite3_anki_init` fail on every DB open.

use std::path::PathBuf;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(embedded_model)");

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let model = manifest.join("../../models/all-MiniLM-L6-v2/model.onnx");
    if model.is_file() {
        println!("cargo:rustc-cfg=embedded_model");
        println!("cargo:rerun-if-changed={}", model.display());
    }
}
