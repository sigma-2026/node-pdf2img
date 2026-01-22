//! pdf2img-core - High-performance PDF to image converter using PDFium
//!
//! This library provides functionality to convert PDF pages to images (WebP, PNG, JPEG).
//! It supports two rendering modes:
//! - **native**: Load entire PDF into memory, best for small files
//! - **native-stream**: Stream PDF data via HTTP Range requests, best for large remote files
//!
//! # Example
//!
//! ```no_run
//! use pdf2img_core::{convert, ConvertOptions, OutputFormat};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let options = ConvertOptions {
//!         format: OutputFormat::WebP,
//!         target_width: Some(1280),
//!         quality: Some(80),
//!         ..Default::default()
//!     };
//!     
//!     let result = convert("document.pdf", Some(options)).await?;
//!     
//!     for page in result.pages {
//!         if page.success {
//!             std::fs::write(
//!                 format!("page_{}.webp", page.page_num),
//!                 &page.data
//!             )?;
//!         }
//!     }
//!     
//!     Ok(())
//! }
//! ```

mod config;
mod error;
mod pdfium;
mod renderer;
mod stream;

pub use config::{ConvertOptions, OutputFormat, RenderMode};
pub use error::{Error, Result};
pub use renderer::{PageResult, ConvertResult};

use std::path::Path;

/// Convert PDF to images
///
/// # Arguments
/// * `input` - Path to local PDF file or HTTP(S) URL
/// * `options` - Conversion options (format, quality, pages, etc.)
///
/// # Returns
/// * `ConvertResult` containing rendered pages and metadata
pub async fn convert<P: AsRef<str>>(
    input: P,
    options: Option<ConvertOptions>,
) -> Result<ConvertResult> {
    let input = input.as_ref();
    let options = options.unwrap_or_default();
    
    if input.starts_with("http://") || input.starts_with("https://") {
        convert_from_url(input, options).await
    } else {
        convert_from_file(input, options).await
    }
}

/// Convert PDF from local file
pub async fn convert_from_file<P: AsRef<Path>>(
    path: P,
    options: ConvertOptions,
) -> Result<ConvertResult> {
    let path = path.as_ref();
    
    // Validate file exists
    if !path.exists() {
        return Err(Error::FileNotFound(path.display().to_string()));
    }
    
    // Create a new PDFium instance for this conversion
    let pdfium = pdfium::create_pdfium()?;
    let renderer = renderer::PdfRenderer::new(&pdfium, options.clone().into());
    
    renderer.render_from_file(path, &options.pages)
}

/// Convert PDF from URL
///
/// Uses streaming mode for files larger than 2MB to avoid downloading the entire file.
pub async fn convert_from_url(
    url: &str,
    options: ConvertOptions,
) -> Result<ConvertResult> {
    let mode = options.mode.unwrap_or_default();
    
    match mode {
        RenderMode::Native => {
            // Download entire file and render
            let data = stream::download_file(url).await?;
            convert_from_buffer(&data, options)
        }
        RenderMode::NativeStream => {
            // Use streaming mode
            let pdfium = pdfium::create_pdfium()?;
            let renderer = renderer::PdfRenderer::new(&pdfium, options.clone().into());
            renderer.render_from_stream(url, &options.pages).await
        }
    }
}

/// Convert PDF from memory buffer
pub fn convert_from_buffer(
    data: &[u8],
    options: ConvertOptions,
) -> Result<ConvertResult> {
    let pdfium = pdfium::create_pdfium()?;
    let renderer = renderer::PdfRenderer::new(&pdfium, options.clone().into());
    
    renderer.render_from_buffer(data, &options.pages)
}

/// Get page count from PDF file
pub fn get_page_count<P: AsRef<Path>>(path: P) -> Result<u32> {
    let pdfium = pdfium::create_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path.as_ref(), None)
        .map_err(|e| Error::PdfLoad(e.to_string()))?;
    
    Ok(document.pages().len() as u32)
}

/// Get page count from buffer
pub fn get_page_count_from_buffer(data: &[u8]) -> Result<u32> {
    let pdfium = pdfium::create_pdfium()?;
    let document = pdfium
        .load_pdf_from_byte_slice(data, None)
        .map_err(|e| Error::PdfLoad(e.to_string()))?;
    
    Ok(document.pages().len() as u32)
}

/// Check if PDFium is available
pub fn is_pdfium_available() -> bool {
    pdfium::create_pdfium().is_ok()
}

/// Get library version
pub fn get_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Warmup PDFium library
///
/// Pre-loads PDFium to avoid cold start latency on first render.
/// Returns warmup time in milliseconds.
pub fn warmup() -> Result<u32> {
    let start = std::time::Instant::now();
    
    let pdfium = pdfium::create_pdfium()?;
    
    // Load a minimal PDF to fully initialize PDFium
    let minimal_pdf = b"%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
trailer<</Size 4/Root 1 0 R>>
startxref
170
%%EOF";
    
    let _ = pdfium.load_pdf_from_byte_slice(minimal_pdf, None);
    
    Ok(start.elapsed().as_millis() as u32)
}
