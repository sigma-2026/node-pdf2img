//! PDF Renderer - High-performance PDF to WebP converter
//!
//! 使用 PDFium 渲染 PDF 页面，并编码为 WebP 格式
//! 通过 NAPI-RS 暴露给 Node.js 调用

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod renderer;
mod config;
mod error;

use renderer::PdfRenderer;
use config::RenderConfig;

/// 创建 PDFium 实例
fn create_pdfium() -> Result<pdfium_render::prelude::Pdfium> {
    use pdfium_render::prelude::*;
    
    // Pdfium::default() 返回 Pdfium 而非 Result
    // 它会自动查找库：
    // 1. PDFIUM_DYNAMIC_LIB_PATH 环境变量指定的路径
    // 2. 当前目录
    // 3. 系统库路径
    Ok(Pdfium::default())
}

/// 单页渲染结果
#[napi(object)]
pub struct PageResult {
    /// 页码（从 1 开始）
    pub page_num: u32,
    /// 图像宽度
    pub width: u32,
    /// 图像高度
    pub height: u32,
    /// WebP 编码后的图像数据
    pub buffer: Buffer,
    /// 是否成功
    pub success: bool,
    /// 错误信息（如果失败）
    pub error: Option<String>,
    /// 渲染耗时（毫秒）
    pub render_time: u32,
    /// 编码耗时（毫秒）
    pub encode_time: u32,
}

/// 批量渲染结果
#[napi(object)]
pub struct RenderResult {
    /// 是否成功
    pub success: bool,
    /// 错误信息（如果整体失败）
    pub error: Option<String>,
    /// PDF 总页数
    pub num_pages: u32,
    /// 每页的渲染结果
    pub pages: Vec<PageResult>,
    /// 总耗时（毫秒）
    pub total_time: u32,
}

/// 渲染配置选项
#[napi(object)]
pub struct RenderOptions {
    /// 目标渲染宽度（默认 1280）
    pub target_width: Option<u32>,
    /// 扫描件/图片页面的降级宽度（默认 1024）
    pub image_heavy_width: Option<u32>,
    /// 最大缩放比例（默认 4.0）
    pub max_scale: Option<f64>,
    /// WebP 质量（1-100，默认 70）
    pub webp_quality: Option<u32>,
    /// 是否启用扫描件检测（默认 true）
    pub detect_scan: Option<bool>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            target_width: Some(1280),
            image_heavy_width: Some(1024),
            max_scale: Some(4.0),
            webp_quality: Some(70),
            detect_scan: Some(true),
        }
    }
}

/// 从 PDF Buffer 渲染指定页面为 WebP
///
/// # Arguments
/// * `pdf_buffer` - PDF 文件的二进制数据
/// * `page_nums` - 要渲染的页码数组（从 1 开始）
/// * `options` - 渲染配置选项
///
/// # Returns
/// 包含所有页面渲染结果的对象
#[napi]
pub fn render_pages(
    pdf_buffer: Buffer,
    page_nums: Vec<u32>,
    options: Option<RenderOptions>,
) -> Result<RenderResult> {
    let start_time = std::time::Instant::now();
    let opts = options.unwrap_or_default();
    
    let config = RenderConfig {
        target_width: opts.target_width.unwrap_or(1280),
        image_heavy_width: opts.image_heavy_width.unwrap_or(1024),
        max_scale: opts.max_scale.unwrap_or(4.0) as f32,
        webp_quality: opts.webp_quality.unwrap_or(70) as u8,
        detect_scan: opts.detect_scan.unwrap_or(true),
    };

    let pdfium = match create_pdfium() {
        Ok(p) => p,
        Err(e) => {
            return Ok(RenderResult {
                success: false,
                error: Some(e.to_string()),
                num_pages: 0,
                pages: vec![],
                total_time: start_time.elapsed().as_millis() as u32,
            });
        }
    };

    let renderer = PdfRenderer::new(&pdfium, config);
    
    match renderer.render_from_buffer(&pdf_buffer, &page_nums) {
        Ok((num_pages, pages)) => Ok(RenderResult {
            success: true,
            error: None,
            num_pages,
            pages,
            total_time: start_time.elapsed().as_millis() as u32,
        }),
        Err(e) => Ok(RenderResult {
            success: false,
            error: Some(e),
            num_pages: 0,
            pages: vec![],
            total_time: start_time.elapsed().as_millis() as u32,
        }),
    }
}

/// 获取 PDF 页数（不渲染）
///
/// # Arguments
/// * `pdf_buffer` - PDF 文件的二进制数据
///
/// # Returns
/// PDF 的总页数
#[napi]
pub fn get_page_count(pdf_buffer: Buffer) -> Result<u32> {
    let pdfium = create_pdfium()?;
    
    let document = pdfium
        .load_pdf_from_byte_slice(&pdf_buffer, None)
        .map_err(|e| Error::from_reason(format!("Failed to load PDF: {}", e)))?;
    
    Ok(document.pages().len() as u32)
}

/// 检查 PDFium 库是否可用
#[napi]
pub fn is_pdfium_available() -> bool {
    create_pdfium().is_ok()
}

/// 预热 PDFium 库
/// 
/// 在服务启动时调用，提前加载 PDFium 动态库并初始化，
/// 避免首次请求时的冷启动延迟（约 1-2 秒）
/// 
/// # Returns
/// 预热耗时（毫秒）
#[napi]
pub fn warmup() -> Result<u32> {
    let start_time = std::time::Instant::now();
    
    // 加载 PDFium 库
    let pdfium = create_pdfium()?;
    
    // 创建一个最小的 PDF 来触发完整初始化
    // 这个 PDF 是一个空白单页 PDF 的最小有效二进制
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
    
    // 加载并解析这个最小 PDF，触发 PDFium 完整初始化
    let _ = pdfium.load_pdf_from_byte_slice(minimal_pdf, None);
    
    Ok(start_time.elapsed().as_millis() as u32)
}

/// 获取版本信息
#[napi]
pub fn get_version() -> String {
    format!("pdf-renderer v{}", env!("CARGO_PKG_VERSION"))
}
