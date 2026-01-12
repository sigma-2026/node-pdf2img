//! 错误类型定义

use thiserror::Error;

#[derive(Error, Debug)]
pub enum RenderError {
    #[error("Failed to load PDF: {0}")]
    PdfLoadError(String),
    
    #[error("Failed to render page {page}: {message}")]
    PageRenderError {
        page: u32,
        message: String,
    },
    
    #[error("Failed to encode image: {0}")]
    EncodeError(String),
    
    #[error("Invalid page number: {0}")]
    InvalidPageNumber(u32),
    
    #[error("PDFium library not available: {0}")]
    PdfiumNotAvailable(String),
}
