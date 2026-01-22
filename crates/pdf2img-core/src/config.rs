//! Configuration types for pdf2img-core

use crate::renderer::RenderConfig;

/// Output image format
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutputFormat {
    /// WebP format (default, best compression)
    #[default]
    WebP,
    /// PNG format (lossless)
    Png,
    /// JPEG format (lossy, no alpha)
    Jpeg,
}

impl OutputFormat {
    /// Parse format from string
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "png" => OutputFormat::Png,
            "jpg" | "jpeg" => OutputFormat::Jpeg,
            _ => OutputFormat::WebP,
        }
    }
    
    /// Get file extension
    pub fn extension(&self) -> &'static str {
        match self {
            OutputFormat::WebP => "webp",
            OutputFormat::Png => "png",
            OutputFormat::Jpeg => "jpg",
        }
    }
}

/// Render mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RenderMode {
    /// Load entire PDF into memory (best for local/small files)
    #[default]
    Native,
    /// Stream PDF via HTTP Range requests (best for large remote files)
    NativeStream,
}

impl RenderMode {
    /// Parse mode from string
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "native-stream" | "stream" => RenderMode::NativeStream,
            _ => RenderMode::Native,
        }
    }
}

/// Conversion options
#[derive(Debug, Clone)]
pub struct ConvertOptions {
    /// Output format (default: WebP)
    pub format: OutputFormat,
    
    /// Render mode (default: Native)
    pub mode: Option<RenderMode>,
    
    /// Target render width (default: 1280)
    pub target_width: Option<u32>,
    
    /// Width for image-heavy/scanned pages (default: 1024)
    pub image_heavy_width: Option<u32>,
    
    /// Maximum scale factor (default: 4.0)
    pub max_scale: Option<f32>,
    
    /// Enable scan detection (default: true)
    pub detect_scan: Option<bool>,
    
    /// Pages to render (empty = all pages)
    pub pages: Vec<u32>,
    
    /// Image quality (0-100, for WebP/JPEG)
    pub quality: Option<u32>,
    
    /// WebP encoding method (0-6, 0=fast, 6=best compression)
    pub webp_method: Option<i32>,
    
    /// PNG compression level (0-9)
    pub png_compression: Option<u32>,
}

impl Default for ConvertOptions {
    fn default() -> Self {
        Self {
            format: OutputFormat::default(),
            mode: None,
            target_width: Some(1280),
            image_heavy_width: Some(1024),
            max_scale: Some(4.0),
            detect_scan: Some(true),
            pages: vec![],
            quality: Some(80),
            webp_method: Some(4),
            png_compression: Some(6),
        }
    }
}

impl From<ConvertOptions> for RenderConfig {
    fn from(opts: ConvertOptions) -> Self {
        RenderConfig {
            target_width: opts.target_width.unwrap_or(1280),
            image_heavy_width: opts.image_heavy_width.unwrap_or(1024),
            max_scale: opts.max_scale.unwrap_or(4.0),
            detect_scan: opts.detect_scan.unwrap_or(true),
            format: opts.format,
            webp_quality: opts.quality.unwrap_or(80) as u8,
            webp_method: opts.webp_method.unwrap_or(4),
            jpeg_quality: opts.quality.unwrap_or(85) as u8,
            png_compression: opts.png_compression.unwrap_or(6) as u8,
        }
    }
}
