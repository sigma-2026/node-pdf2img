//! PDF 渲染核心实现

use crate::config::RenderConfig;
use crate::PageResult;
use image::{ImageBuffer, Rgba};
use napi::bindgen_prelude::*;
use pdfium_render::prelude::*;
use webp::Encoder as WebpEncoder;

/// WebP 格式限制
const WEBP_MAX_DIMENSION: u32 = 16383;

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
        if render_width > WEBP_MAX_DIMENSION || render_height > WEBP_MAX_DIMENSION {
            let width_factor = if render_width > WEBP_MAX_DIMENSION {
                WEBP_MAX_DIMENSION as f32 / render_width as f32
            } else {
                1.0
            };
            let height_factor = if render_height > WEBP_MAX_DIMENSION {
                WEBP_MAX_DIMENSION as f32 / render_height as f32
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

        // 转换为 image crate 的格式并编码为 WebP
        let actual_width = bitmap.width() as u32;
        let actual_height = bitmap.height() as u32;
        
        // 获取 RGBA 像素数据 - as_rgba_bytes() 直接返回 Vec<u8>
        let rgba_data = bitmap.as_rgba_bytes();

        // 最终尺寸检查：如果实际渲染尺寸仍超过 WebP 限制，需要缩放
        let (final_width, final_height, final_rgba) = if actual_width > WEBP_MAX_DIMENSION || actual_height > WEBP_MAX_DIMENSION {
            // 计算缩放因子
            let width_factor = if actual_width > WEBP_MAX_DIMENSION {
                WEBP_MAX_DIMENSION as f32 / actual_width as f32
            } else {
                1.0
            };
            let height_factor = if actual_height > WEBP_MAX_DIMENSION {
                WEBP_MAX_DIMENSION as f32 / actual_height as f32
            } else {
                1.0
            };
            let limit_factor = width_factor.min(height_factor);
            
            let new_width = ((actual_width as f32) * limit_factor).round() as u32;
            let new_height = ((actual_height as f32) * limit_factor).round() as u32;
            
            // 使用 image crate 缩放图像
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

        // 编码为 WebP
        let webp_buffer = match self.encode_webp(&final_rgba, final_width, final_height) {
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
            buffer: Buffer::from(webp_buffer),
            success: true,
            error: None,
            render_time,
            encode_time,
        }
    }

    /// 检测页面是否可能是扫描件（启发式判断）
    fn is_likely_scan(&self, page: &PdfPage) -> bool {
        // 简化的启发式检测：
        // 1. 检查页面是否有文本对象
        // 2. 如果没有文本但有图像，则可能是扫描件
        
        let text_objects = page.objects().iter()
            .filter(|obj| matches!(obj.object_type(), PdfPageObjectType::Text))
            .count();
        
        let image_objects = page.objects().iter()
            .filter(|obj| matches!(obj.object_type(), PdfPageObjectType::Image))
            .count();
        
        // 如果没有文本但有图像，认为是扫描件
        text_objects == 0 && image_objects > 0
    }

    /// 将 RGBA 数据编码为 WebP
    fn encode_webp(&self, rgba_data: &[u8], width: u32, height: u32) -> std::result::Result<Vec<u8>, String> {
        // 创建图像缓冲区
        let img: ImageBuffer<Rgba<u8>, _> = ImageBuffer::from_raw(width, height, rgba_data.to_vec())
            .ok_or_else(|| "Failed to create image buffer".to_string())?;

        // 使用 webp crate 进行有损压缩
        let encoder = WebpEncoder::from_rgba(img.as_raw(), width, height);
        let webp_data = encoder.encode(self.config.webp_quality as f32);

        Ok(webp_data.to_vec())
    }
}
