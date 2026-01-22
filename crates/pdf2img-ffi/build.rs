//! Build script for generating C header file

use std::env;
use std::path::PathBuf;

fn main() {
    let crate_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_dir = PathBuf::from(&crate_dir).join("include");

    // Create include directory
    std::fs::create_dir_all(&out_dir).ok();

    // Generate C header using builder pattern
    cbindgen::Builder::new()
        .with_crate(&crate_dir)
        .with_language(cbindgen::Language::C)
        .with_include_guard("PDF2IMG_H")
        .with_no_includes()
        .with_sys_include("stdint.h")
        .with_sys_include("stdbool.h")
        .with_sys_include("stdlib.h")
        .generate()
        .expect("Unable to generate C bindings")
        .write_to_file(out_dir.join("pdf2img.h"));

    println!("cargo:rerun-if-changed=src/lib.rs");
}
