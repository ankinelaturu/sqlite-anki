//! Propagates `embedded_model` cfg from the workspace models directory.

fn main() {
    println!("cargo::rustc-check-cfg=cfg(embedded_model)");
    // Re-run when anki-core build.rs fires (model presence).
    println!("cargo:rerun-if-changed=../anki-core/build.rs");
}
