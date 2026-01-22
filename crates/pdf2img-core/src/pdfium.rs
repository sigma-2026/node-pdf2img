//! PDFium library loading and management

use crate::error::{Error, Result};
use pdfium_render::prelude::*;
use std::panic;

/// Create a new PDFium instance
///
/// Uses PDFium library. When built with "static" feature of pdfium-render,
/// the library is statically linked. Otherwise, it's dynamically loaded.
pub fn create_pdfium() -> Result<Pdfium> {
    // Catch panic from Pdfium::default() when PDFium is not available
    let result = panic::catch_unwind(|| Pdfium::default());
    
    match result {
        Ok(pdfium) => Ok(pdfium),
        Err(_) => Err(Error::PdfiumLoad(
            "PDFium library not found. Please install PDFium and ensure it's in the library path.".to_string()
        )),
    }
}
