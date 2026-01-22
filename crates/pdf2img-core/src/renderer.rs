//! PDF rendering implementation

use crate::config::OutputFormat;
use crate::error::{Error, Result};
use crate::stream::StreamReader;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ImageBuffer, ImageEncoder, Rgba};
use pdfium_render::prelude::*;
use std::io::Cursor;
use std::path::Path;
use webp::{Encoder as WebpEncoder, WebPConfig};

/// WebP maximum dimension
const WEBP_MAX_DIMENSION: u32 = 16383;

/// Render configuration
#[derive(Debug, Clone)]
pub struct RenderConfig {
    /// Target render width
    pub target_width: u32,
    /// Width for image-heavy/scanned pages
    pub image_heavy_width: u32,
    /// Maximum scale factor
    pub max_scale: f32,
    /// Enable scan detection
    pub detect_scan: bool,
    /// Output format
    pub format: OutputFormat,
    /// WebP quality (0-100)
    pub webp_quality: u8,
    /// WebP encoding method (0-6)
    pub webp_method: i32,
    /// JPEG quality (0-100)
    pub jpeg_quality: u8,
    /// PNG compression level (0-9)
    pub png_compression: u8,
}

impl Default for RenderConfig {
    fn default() -> Self {
        Self {
            target_width: 1280,
            image_heavy_width: 1024,
            max_scale: 4.0,
            detect_scan: true,
            format: OutputFormat::WebP,
            webp_quality: 80,
            webp_method: 4,
            jpeg_quality: 85,
            png_compression: 6,
        }
    }
}

/// Single page render result
#[derive(Debug, Clone)]
pub struct PageResult {
    /// Page number (1-based)
    pub page_num: u32,
    /// Image width
    pub width: u32,
    /// Image height
    pub height: u32,
    /// Encoded image data
    pub data: Vec<u8>,
    /// Whether rendering succeeded
    pub success: bool,
    /// Error message if failed
    pub error: Option<String>,
    /// Render time in milliseconds
    pub render_time_ms: u32,
    /// Encode time in milliseconds
    pub encode_time_ms: u32,
}

/// Conversion result
#[derive(Debug, Clone)]
pub struct ConvertResult {
    /// Whether conversion succeeded
    pub success: bool,
    /// Error message if failed
    pub error: Option<String>,
    /// Total page count
    pub total_pages: u32,
    /// Rendered pages
    pub pages: Vec<PageResult>,
    /// Total time in milliseconds
    pub total_time_ms: u32,
}

/// PDF renderer
pub struct PdfRenderer<'a> {
    pdfium: &'a Pdfium,
    config: RenderConfig,
}

impl<'a> PdfRenderer<'a> {
    /// Create new renderer
    pub fn new(pdfium: &'a Pdfium, config: RenderConfig) -> Self {
        Self { pdfium, config }
    }

    /// Render from file path
    pub fn render_from_file<P: AsRef<Path>>(
        &self,
        path: P,
        pages: &[u32],
    ) -> Result<ConvertResult> {
        let start = std::time::Instant::now();

        let document = self
            .pdfium
            .load_pdf_from_file(path.as_ref(), None)
            .map_err(|e| Error::PdfLoad(e.to_string()))?;

        let result = self.render_document(&document, pages);
        
        Ok(ConvertResult {
            success: result.0,
            error: result.1,
            total_pages: result.2,
            pages: result.3,
            total_time_ms: start.elapsed().as_millis() as u32,
        })
    }

    /// Render from buffer
    pub fn render_from_buffer(
        &self,
        data: &[u8],
        pages: &[u32],
    ) -> Result<ConvertResult> {
        let start = std::time::Instant::now();

        let document = self
            .pdfium
            .load_pdf_from_byte_slice(data, None)
            .map_err(|e| Error::PdfLoad(e.to_string()))?;

        let result = self.render_document(&document, pages);
        
        Ok(ConvertResult {
            success: result.0,
            error: result.1,
            total_pages: result.2,
            pages: result.3,
            total_time_ms: start.elapsed().as_millis() as u32,
        })
    }

    /// Render from stream (URL with HTTP Range requests)
    pub async fn render_from_stream(
        &self,
        url: &str,
        pages: &[u32],
    ) -> Result<ConvertResult> {
        let start = std::time::Instant::now();

        // Create stream reader
        let reader = StreamReader::new(url).await?;
        
        // Load PDF from stream
        let document = self
            .pdfium
            .load_pdf_from_reader(reader, None)
            .map_err(|e| Error::PdfLoad(format!("Failed to load PDF from stream: {}", e)))?;

        let result = self.render_document(&document, pages);
        
        Ok(ConvertResult {
            success: result.0,
            error: result.1,
            total_pages: result.2,
            pages: result.3,
            total_time_ms: start.elapsed().as_millis() as u32,
        })
    }

    /// Render pages from document
    fn render_document(
        &self,
        document: &PdfDocument,
        pages: &[u32],
    ) -> (bool, Option<String>, u32, Vec<PageResult>) {
        let total_pages = document.pages().len() as u32;
        
        // If no pages specified, render all
        let page_nums: Vec<u32> = if pages.is_empty() {
            (1..=total_pages).collect()
        } else {
            pages.to_vec()
        };

        let mut results = Vec::with_capacity(page_nums.len());
        let mut all_success = true;

        for page_num in page_nums {
            let result = self.render_single_page(document, page_num, total_pages);
            if !result.success {
                all_success = false;
            }
            results.push(result);
        }

        (all_success, None, total_pages, results)
    }

    /// Render single page
    fn render_single_page(
        &self,
        document: &PdfDocument,
        page_num: u32,
        total_pages: u32,
    ) -> PageResult {
        let render_start = std::time::Instant::now();

        // Validate page number
        if page_num < 1 || page_num > total_pages {
            return PageResult {
                page_num,
                width: 0,
                height: 0,
                data: vec![],
                success: false,
                error: Some(format!(
                    "Invalid page number: {} (total: {})",
                    page_num, total_pages
                )),
                render_time_ms: 0,
                encode_time_ms: 0,
            };
        }

        // Get page (0-based index)
        let page = match document.pages().get((page_num - 1) as u16) {
            Ok(p) => p,
            Err(e) => {
                return PageResult {
                    page_num,
                    width: 0,
                    height: 0,
                    data: vec![],
                    success: false,
                    error: Some(format!("Failed to get page: {}", e)),
                    render_time_ms: 0,
                    encode_time_ms: 0,
                };
            }
        };

        // Calculate dimensions
        let original_width = page.width().value as f32;
        let original_height = page.height().value as f32;

        let target_width = if self.config.detect_scan && self.is_likely_scan(&page) {
            self.config.image_heavy_width as f32
        } else {
            self.config.target_width as f32
        };

        let mut scale = (target_width / original_width).min(self.config.max_scale);

        let mut render_width = (original_width * scale).round() as u32;
        let mut render_height = (original_height * scale).round() as u32;

        // Apply dimension limits
        let max_dimension = if self.config.format == OutputFormat::WebP {
            WEBP_MAX_DIMENSION
        } else {
            32767
        };

        if render_width > max_dimension || render_height > max_dimension {
            let factor = (max_dimension as f32 / render_width as f32)
                .min(max_dimension as f32 / render_height as f32);
            scale *= factor;
            render_width = (original_width * scale).round() as u32;
            render_height = (original_height * scale).round() as u32;
        }

        // Render page
        let bitmap = match page.render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(render_width as i32)
                .set_target_height(render_height as i32)
                .render_form_data(true)
                .render_annotations(true),
        ) {
            Ok(b) => b,
            Err(e) => {
                return PageResult {
                    page_num,
                    width: 0,
                    height: 0,
                    data: vec![],
                    success: false,
                    error: Some(format!("Failed to render page: {}", e)),
                    render_time_ms: render_start.elapsed().as_millis() as u32,
                    encode_time_ms: 0,
                };
            }
        };

        let render_time_ms = render_start.elapsed().as_millis() as u32;
        let encode_start = std::time::Instant::now();

        let actual_width = bitmap.width() as u32;
        let actual_height = bitmap.height() as u32;
        let rgba_data = bitmap.as_rgba_bytes();

        // Handle dimension limits on actual bitmap
        let (final_width, final_height, final_rgba) =
            if actual_width > max_dimension || actual_height > max_dimension {
                let factor = (max_dimension as f32 / actual_width as f32)
                    .min(max_dimension as f32 / actual_height as f32);
                let new_width = (actual_width as f32 * factor).round() as u32;
                let new_height = (actual_height as f32 * factor).round() as u32;

                let img: ImageBuffer<Rgba<u8>, _> =
                    match ImageBuffer::from_raw(actual_width, actual_height, rgba_data.to_vec()) {
                        Some(img) => img,
                        None => {
                            return PageResult {
                                page_num,
                                width: actual_width,
                                height: actual_height,
                                data: vec![],
                                success: false,
                                error: Some("Failed to create image buffer".to_string()),
                                render_time_ms,
                                encode_time_ms: 0,
                            };
                        }
                    };

                let resized = image::imageops::resize(
                    &img,
                    new_width,
                    new_height,
                    image::imageops::FilterType::Lanczos3,
                );
                (new_width, new_height, resized.into_raw())
            } else {
                (actual_width, actual_height, rgba_data.to_vec())
            };

        // Encode image
        let encoded = match self.encode_image(&final_rgba, final_width, final_height) {
            Ok(data) => data,
            Err(e) => {
                return PageResult {
                    page_num,
                    width: final_width,
                    height: final_height,
                    data: vec![],
                    success: false,
                    error: Some(e),
                    render_time_ms,
                    encode_time_ms: 0,
                };
            }
        };

        let encode_time_ms = encode_start.elapsed().as_millis() as u32;

        PageResult {
            page_num,
            width: final_width,
            height: final_height,
            data: encoded,
            success: true,
            error: None,
            render_time_ms,
            encode_time_ms,
        }
    }

    /// Check if page is likely a scanned document
    fn is_likely_scan(&self, page: &PdfPage) -> bool {
        let text_count = page
            .objects()
            .iter()
            .filter(|obj| matches!(obj.object_type(), PdfPageObjectType::Text))
            .count();

        let image_count = page
            .objects()
            .iter()
            .filter(|obj| matches!(obj.object_type(), PdfPageObjectType::Image))
            .count();

        text_count == 0 && image_count > 0
    }

    /// Encode image to configured format
    fn encode_image(
        &self,
        rgba_data: &[u8],
        width: u32,
        height: u32,
    ) -> std::result::Result<Vec<u8>, String> {
        match self.config.format {
            OutputFormat::WebP => self.encode_webp(rgba_data, width, height),
            OutputFormat::Png => self.encode_png(rgba_data, width, height),
            OutputFormat::Jpeg => self.encode_jpeg(rgba_data, width, height),
        }
    }

    /// Encode as WebP
    fn encode_webp(
        &self,
        rgba_data: &[u8],
        width: u32,
        height: u32,
    ) -> std::result::Result<Vec<u8>, String> {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_raw(width, height, rgba_data.to_vec())
                .ok_or_else(|| "Failed to create image buffer".to_string())?;

        let encoder = WebpEncoder::from_rgba(img.as_raw(), width, height);

        let mut config =
            WebPConfig::new().map_err(|_| "Failed to create WebPConfig".to_string())?;
        config.method = self.config.webp_method;
        config.quality = self.config.webp_quality as f32;

        let webp_data = encoder
            .encode_advanced(&config)
            .map_err(|_| "WebP encoding failed".to_string())?;

        Ok(webp_data.to_vec())
    }

    /// Encode as PNG
    fn encode_png(
        &self,
        rgba_data: &[u8],
        width: u32,
        height: u32,
    ) -> std::result::Result<Vec<u8>, String> {
        let mut buffer = Vec::new();

        let compression = match self.config.png_compression {
            0..=3 => CompressionType::Fast,
            4..=6 => CompressionType::Default,
            _ => CompressionType::Best,
        };

        let encoder = PngEncoder::new_with_quality(&mut buffer, compression, FilterType::Adaptive);

        encoder
            .write_image(rgba_data, width, height, image::ExtendedColorType::Rgba8)
            .map_err(|e| format!("PNG encoding failed: {}", e))?;

        Ok(buffer)
    }

    /// Encode as JPEG
    fn encode_jpeg(
        &self,
        rgba_data: &[u8],
        width: u32,
        height: u32,
    ) -> std::result::Result<Vec<u8>, String> {
        // Convert RGBA to RGB (blend with white background)
        let rgb_data = self.rgba_to_rgb(rgba_data);

        let mut buffer = Cursor::new(Vec::new());
        let mut encoder = JpegEncoder::new_with_quality(&mut buffer, self.config.jpeg_quality);

        encoder
            .encode(&rgb_data, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("JPEG encoding failed: {}", e))?;

        Ok(buffer.into_inner())
    }

    /// Convert RGBA to RGB (blend with white background)
    fn rgba_to_rgb(&self, rgba_data: &[u8]) -> Vec<u8> {
        let pixel_count = rgba_data.len() / 4;
        let mut rgb_data = Vec::with_capacity(pixel_count * 3);

        for i in 0..pixel_count {
            let r = rgba_data[i * 4] as f32;
            let g = rgba_data[i * 4 + 1] as f32;
            let b = rgba_data[i * 4 + 2] as f32;
            let a = rgba_data[i * 4 + 3] as f32 / 255.0;

            // Blend with white background
            let bg = 255.0;
            rgb_data.push((r * a + bg * (1.0 - a)) as u8);
            rgb_data.push((g * a + bg * (1.0 - a)) as u8);
            rgb_data.push((b * a + bg * (1.0 - a)) as u8);
        }

        rgb_data
    }
}
