//! Error types for pdf2img-core

use thiserror::Error;

/// Result type alias for pdf2img operations
pub type Result<T> = std::result::Result<T, Error>;

/// Error types for PDF conversion operations
#[derive(Error, Debug)]
pub enum Error {
    /// File not found
    #[error("File not found: {0}")]
    FileNotFound(String),
    
    /// Failed to load PDFium library
    #[error("Failed to load PDFium: {0}")]
    PdfiumLoad(String),
    
    /// Failed to load PDF document
    #[error("Failed to load PDF: {0}")]
    PdfLoad(String),
    
    /// Failed to render page
    #[error("Failed to render page {page}: {message}")]
    RenderError { page: u32, message: String },
    
    /// Failed to encode image
    #[error("Failed to encode image: {0}")]
    EncodeError(String),
    
    /// Invalid page number
    #[error("Invalid page number: {page} (total pages: {total})")]
    InvalidPage { page: u32, total: u32 },
    
    /// HTTP request error
    #[error("HTTP error: {0}")]
    HttpError(String),
    
    /// IO error
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    
    /// Stream timeout
    #[error("Stream timeout: {0}")]
    StreamTimeout(String),
    
    /// Server doesn't support range requests
    #[error("Server doesn't support range requests")]
    RangeNotSupported,
}
