//! Propagates `embedded_model` cfg from the workspace models directory.

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
