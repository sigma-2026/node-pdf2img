//! PDF 渲染核心实现

use crate::config::RenderConfig;
use crate::{PageResult, RawBitmapResult};
use image::{ImageBuffer, Rgba, ImageEncoder};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::jpeg::JpegEncoder;
use napi::bindgen_prelude::*;
use pdfium_render::prelude::*;
use webp::{Encoder as WebpEncoder, WebPConfig};
use std::io::Cursor;

/// WebP 格式限制
const WEBP_MAX_DIMENSION: u32 = 16383;

/// 输出格式
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OutputFormat {
    WebP,
    Png,
    Jpg,
}

impl OutputFormat {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "png" => OutputFormat::Png,
            "jpg" | "jpeg" => OutputFormat::Jpg,
            _ => OutputFormat::WebP,
        }
    }
}

/// PDF 渲染器
pub struct PdfRenderer<'a> {
    pdfium: &'a Pdfium,
    config: RenderConfig,
}

impl<'a> PdfRenderer<'a> {
    /// 创建新的渲染器实例
    pub fn new(pdfium: &'a Pdfium, config: RenderConfig) -> Self {
        Self { pdfium, config }
    }

    /// 从 Buffer 渲染 PDF 页面
    pub fn render_from_buffer(
        &self,
        pdf_data: &[u8],
        page_nums: &[u32],
    ) -> std::result::Result<(u32, Vec<PageResult>), String> {
        // 加载 PDF 文档
        let document = self
            .pdfium
            .load_pdf_from_byte_slice(pdf_data, None)
            .map_err(|e| format!("Failed to load PDF: {}", e))?;

        self.render_document_pages(&document, page_nums)
    }

    /// 从文件路径渲染 PDF 页面
    /// 
    /// 直接从文件系统读取，避免在 Node.js 堆中创建大 Buffer
    pub fn render_from_file(
        &self,
        file_path: &str,
        page_nums: &[u32],
    ) -> std::result::Result<(u32, Vec<PageResult>), String> {
        // 直接从文件加载 PDF 文档
        let document = self
            .pdfium
            .load_pdf_from_file(file_path, None)
            .map_err(|e| format!("Failed to load PDF from file: {}", e))?;

        self.render_document_pages(&document, page_nums)
    }

    /// 从已加载的 PdfDocument 渲染指定页面
    ///
    /// 这个方法允许外部代码先加载文档（例如通过流式加载），
    /// 然后调用此方法进行渲染。
    pub fn render_document_pages(
        &self,
        document: &PdfDocument,
        page_nums: &[u32],
    ) -> std::result::Result<(u32, Vec<PageResult>), String> {
        let num_pages = document.pages().len() as u32;
        let mut results = Vec::with_capacity(page_nums.len());

        for &page_num in page_nums {
            let result = self.render_single_page(document, page_num, num_pages);
            results.push(result);
        }

        Ok((num_pages, results))
    }

    /// 渲染单个页面
    fn render_single_page(
        &self,
        document: &PdfDocument,
        page_num: u32,
        num_pages: u32,
    ) -> PageResult {
        let render_start = std::time::Instant::now();

        // 检查页码有效性
        if page_num < 1 || page_num > num_pages {
            return PageResult {
                page_num,
                width: 0,
                height: 0,
                buffer: Buffer::from(vec![]),
                success: false,
                error: Some(format!("Invalid page number: {} (total: {})", page_num, num_pages)),
                render_time: 0,
                encode_time: 0,
            };
        }

        // PDFium 页码从 0 开始
        let page_index = (page_num - 1) as u16;
        
        let page = match document.pages().get(page_index) {
            Ok(p) => p,
            Err(e) => {
                return PageResult {
                    page_num,
                    width: 0,
                    height: 0,
                    buffer: Buffer::from(vec![]),
                    success: false,
                    error: Some(format!("Failed to get page: {}", e)),
                    render_time: 0,
                    encode_time: 0,
                };
            }
        };

        // 获取页面原始尺寸（点，72 DPI）
        let original_width = page.width().value as f32;
        let original_height = page.height().value as f32;

        // 计算缩放比例
        let target_width = if self.config.detect_scan && self.is_likely_scan(&page) {
            self.config.image_heavy_width as f32
        } else {
            self.config.target_width as f32
        };

        let mut scale = target_width / original_width;
        scale = scale.min(self.config.max_scale);

        let mut render_width = (original_width * scale).round() as u32;
        let mut render_height = (original_height * scale).round() as u32;

        // WebP 尺寸限制检查（单边不能超过 16383）
        // 注意：PNG 和 JPG 没有这个限制，但为了一致性和内存考虑，仍然应用此限制
        let max_dimension = if self.config.format == OutputFormat::WebP {
            WEBP_MAX_DIMENSION
        } else {
            // PNG/JPG 理论上支持更大尺寸，但为了性能和内存，限制在 32767
            32767
        };

        if render_width > max_dimension || render_height > max_dimension {
            let width_factor = if render_width > max_dimension {
                max_dimension as f32 / render_width as f32
            } else {
                1.0
            };
            let height_factor = if render_height > max_dimension {
                max_dimension as f32 / render_height as f32
            } else {
                1.0
            };
            let limit_factor = width_factor.min(height_factor);
            
            scale *= limit_factor;
            render_width = (original_width * scale).round() as u32;
            render_height = (original_height * scale).round() as u32;
        }

        // 渲染页面为 RGBA 位图
        let bitmap = match page.render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(render_width as i32)
                .set_target_height(render_height as i32)
                .render_form_data(true)
                .render_annotations(true)
        ) {
            Ok(b) => b,
            Err(e) => {
                return PageResult {
                    page_num,
                    width: 0,
                    height: 0,
                    buffer: Buffer::from(vec![]),
                    success: false,
                    error: Some(format!("Failed to render page: {}", e)),
                    render_time: render_start.elapsed().as_millis() as u32,
                    encode_time: 0,
                };
            }
        };

        let render_time = render_start.elapsed().as_millis() as u32;
        let encode_start = std::time::Instant::now();

        // 转换为 image crate 的格式
        let actual_width = bitmap.width() as u32;
        let actual_height = bitmap.height() as u32;
        
        // 获取 RGBA 像素数据
        let rgba_data = bitmap.as_rgba_bytes();

        // 最终尺寸检查
        let (final_width, final_height, final_rgba) = if actual_width > max_dimension || actual_height > max_dimension {
            let width_factor = if actual_width > max_dimension {
                max_dimension as f32 / actual_width as f32
            } else {
                1.0
            };
            let height_factor = if actual_height > max_dimension {
                max_dimension as f32 / actual_height as f32
            } else {
                1.0
            };
            let limit_factor = width_factor.min(height_factor);
            
            let new_width = ((actual_width as f32) * limit_factor).round() as u32;
            let new_height = ((actual_height as f32) * limit_factor).round() as u32;
            
            let img: ImageBuffer<Rgba<u8>, _> = match ImageBuffer::from_raw(actual_width, actual_height, rgba_data.to_vec()) {
                Some(img) => img,
                None => {
                    return PageResult {
                        page_num,
                        width: actual_width,
                        height: actual_height,
                        buffer: Buffer::from(vec![]),
                        success: false,
                        error: Some("Failed to create image buffer for resize".to_string()),
                        render_time,
                        encode_time: 0,
                    };
                }
            };
            
            let resized = image::imageops::resize(&img, new_width, new_height, image::imageops::FilterType::Lanczos3);
            (new_width, new_height, resized.into_raw())
        } else {
            (actual_width, actual_height, rgba_data.to_vec())
        };

        // 根据配置的格式进行编码
        let encoded_buffer = match self.encode_image(&final_rgba, final_width, final_height) {
            Ok(buf) => buf,
            Err(e) => {
                return PageResult {
                    page_num,
                    width: final_width,
                    height: final_height,
                    buffer: Buffer::from(vec![]),
                    success: false,
                    error: Some(e),
                    render_time,
                    encode_time: 0,
                };
            }
        };

        let encode_time = encode_start.elapsed().as_millis() as u32;

        PageResult {
            page_num,
            width: final_width,
            height: final_height,
            buffer: Buffer::from(encoded_buffer),
            success: true,
            error: None,
            render_time,
            encode_time,
        }
    }

    /// 检测页面是否可能是扫描件（启发式判断）
    fn is_likely_scan(&self, page: &PdfPage) -> bool {
        let text_objects = page.objects().iter()
            .filter(|obj| matches!(obj.object_type(), PdfPageObjectType::Text))
            .count();
        
        let image_objects = page.objects().iter()
            .filter(|obj| matches!(obj.object_type(), PdfPageObjectType::Image))
            .count();
        
        text_objects == 0 && image_objects > 0
    }

    /// 根据配置的格式编码图像
    fn encode_image(&self, rgba_data: &[u8], width: u32, height: u32) -> std::result::Result<Vec<u8>, String> {
        match self.config.format {
            OutputFormat::WebP => self.encode_webp(rgba_data, width, height),
            OutputFormat::Png => self.encode_png(rgba_data, width, height),
            OutputFormat::Jpg => self.encode_jpg(rgba_data, width, height),
        }
    }

    /// 将 RGBA 数据编码为 WebP
    fn encode_webp(&self, rgba_data: &[u8], width: u32, height: u32) -> std::result::Result<Vec<u8>, String> {
        let img: ImageBuffer<Rgba<u8>, _> = ImageBuffer::from_raw(width, height, rgba_data.to_vec())
            .ok_or_else(|| "Failed to create image buffer".to_string())?;

        let encoder = WebpEncoder::from_rgba(img.as_raw(), width, height);
        
        // 使用 WebPConfig 来控制编码速度和质量
        let mut config = WebPConfig::new()
            .map_err(|_| "Failed to create WebPConfig".to_string())?;
        
        // method: 0-6, 0 最快, 6 最慢但压缩最好
        // 默认值 4 是速度和压缩率的最佳平衡点
        config.method = self.config.webp_method;
        config.quality = self.config.webp_quality as f32;
        
        let webp_data = encoder.encode_advanced(&config)
            .map_err(|_| "WebP encoding failed".to_string())?;

        Ok(webp_data.to_vec())
    }

    /// 将 RGBA 数据编码为 PNG
    fn encode_png(&self, rgba_data: &[u8], width: u32, height: u32) -> std::result::Result<Vec<u8>, String> {
        let mut buffer = Vec::new();
        
        // 根据压缩级别选择压缩类型
        let compression = match self.config.png_compression {
            0 => CompressionType::Fast,
            1..=3 => CompressionType::Fast,
            4..=6 => CompressionType::Default,
            _ => CompressionType::Best,
        };
        
        let encoder = PngEncoder::new_with_quality(&mut buffer, compression, FilterType::Adaptive);
        
        encoder.write_image(
            rgba_data,
            width,
            height,
            image::ExtendedColorType::Rgba8,
        ).map_err(|e| format!("PNG encoding failed: {}", e))?;

        Ok(buffer)
    }

    /// 将 RGBA 数据编码为 JPG
    fn encode_jpg(&self, rgba_data: &[u8], width: u32, height: u32) -> std::result::Result<Vec<u8>, String> {
        // JPG 不支持 alpha 通道，需要转换为 RGB
        let rgb_data = self.rgba_to_rgb(rgba_data);
        
        let mut buffer = Cursor::new(Vec::new());
        let mut encoder = JpegEncoder::new_with_quality(&mut buffer, self.config.jpeg_quality);
        
        encoder.encode(
            &rgb_data,
            width,
            height,
            image::ExtendedColorType::Rgb8,
        ).map_err(|e| format!("JPG encoding failed: {}", e))?;

        Ok(buffer.into_inner())
    }

    /// 将 RGBA 数据转换为 RGB（移除 alpha 通道，与白色背景混合）
    fn rgba_to_rgb(&self, rgba_data: &[u8]) -> Vec<u8> {
        let pixel_count = rgba_data.len() / 4;
        let mut rgb_data = Vec::with_capacity(pixel_count * 3);

        for i in 0..pixel_count {
            let r = rgba_data[i * 4] as f32;
            let g = rgba_data[i * 4 + 1] as f32;
            let b = rgba_data[i * 4 + 2] as f32;
            let a = rgba_data[i * 4 + 3] as f32 / 255.0;

            // 与白色背景混合
            let bg = 255.0;
            rgb_data.push((r * a + bg * (1.0 - a)) as u8);
            rgb_data.push((g * a + bg * (1.0 - a)) as u8);
            rgb_data.push((b * a + bg * (1.0 - a)) as u8);
        }

        rgb_data
    }

    /// 渲染单页到原始位图（不进行编码）
    /// 
    /// 这个方法跳过编码步骤，直接返回 RGBA 像素数据。
    /// 适合将编码工作交给 Sharp 等更高效的库处理。
    pub fn render_page_to_raw_bitmap(
        &self,
        document: &PdfDocument,
        page_num: u32,
    ) -> RawBitmapResult {
        let render_start = std::time::Instant::now();
        let num_pages = document.pages().len() as u32;

        // 检查页码有效性
        if page_num < 1 || page_num > num_pages {
            return RawBitmapResult {
                success: false,
                error: Some(format!("Invalid page number: {} (total: {})", page_num, num_pages)),
                width: 0,
                height: 0,
                channels: 4,
                buffer: Buffer::from(vec![]),
                render_time: render_start.elapsed().as_millis() as u32,
            };
        }

        // PDFium 页码从 0 开始
        let page_index = (page_num - 1) as u16;
        
        let page = match document.pages().get(page_index) {
            Ok(p) => p,
            Err(e) => {
                return RawBitmapResult {
                    success: false,
                    error: Some(format!("Failed to get page: {}", e)),
                    width: 0,
                    height: 0,
                    channels: 4,
                    buffer: Buffer::from(vec![]),
                    render_time: render_start.elapsed().as_millis() as u32,
                };
            }
        };

        // 获取页面原始尺寸（点，72 DPI）
        let original_width = page.width().value as f32;
        let original_height = page.height().value as f32;

        // 计算缩放比例
        let target_width = if self.config.detect_scan && self.is_likely_scan(&page) {
            self.config.image_heavy_width as f32
        } else {
            self.config.target_width as f32
        };

        let mut scale = target_width / original_width;
        scale = scale.min(self.config.max_scale);

        let mut render_width = (original_width * scale).round() as u32;
        let mut render_height = (original_height * scale).round() as u32;

        // 尺寸限制检查（为了内存安全）
        let max_dimension: u32 = 32767;

        if render_width > max_dimension || render_height > max_dimension {
            let width_factor = if render_width > max_dimension {
                max_dimension as f32 / render_width as f32
            } else {
                1.0
            };
            let height_factor = if render_height > max_dimension {
                max_dimension as f32 / render_height as f32
            } else {
                1.0
            };
            let limit_factor = width_factor.min(height_factor);
            
            scale *= limit_factor;
            render_width = (original_width * scale).round() as u32;
            render_height = (original_height * scale).round() as u32;
        }

        // 渲染页面为 RGBA 位图
        let bitmap = match page.render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(render_width as i32)
                .set_target_height(render_height as i32)
                .render_form_data(true)
                .render_annotations(true)
        ) {
            Ok(b) => b,
            Err(e) => {
                return RawBitmapResult {
                    success: false,
                    error: Some(format!("Failed to render page: {}", e)),
                    width: 0,
                    height: 0,
                    channels: 4,
                    buffer: Buffer::from(vec![]),
                    render_time: render_start.elapsed().as_millis() as u32,
                };
            }
        };

        let actual_width = bitmap.width() as u32;
        let actual_height = bitmap.height() as u32;
        
        // 获取 RGBA 像素数据
        let rgba_data = bitmap.as_rgba_bytes().to_vec();

        RawBitmapResult {
            success: true,
            error: None,
            width: actual_width,
            height: actual_height,
            channels: 4,
            buffer: Buffer::from(rgba_data),
            render_time: render_start.elapsed().as_millis() as u32,
        }
    }
}
