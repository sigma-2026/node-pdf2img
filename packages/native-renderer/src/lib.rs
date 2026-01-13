//! PDF Renderer - High-performance PDF to image converter
//!
//! 使用 PDFium 渲染 PDF 页面，支持 WebP、PNG、JPG 格式输出
//! 通过 NAPI-RS 暴露给 Node.js 调用

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction};
use napi::{Env, JsFunction};
use napi_derive::napi;

mod config;
mod error;
mod renderer;
mod stream_reader;

use config::RenderConfig;
use renderer::{PdfRenderer, OutputFormat};
use stream_reader::{BlockRequest, JsFileStreamer};

/// 创建 PDFium 实例
/// 
/// 根据当前平台和架构加载对应的 PDFium 动态库
fn create_pdfium() -> Result<pdfium_render::prelude::Pdfium> {
    use pdfium_render::prelude::*;
    
    // 获取当前模块所在目录
    let module_dir = get_module_dir();
    
    // 根据平台和架构选择正确的库文件
    let lib_name = get_pdfium_lib_name();
    let lib_path = module_dir.join(lib_name);
    
    // 尝试从模块目录加载
    if lib_path.exists() {
        let bindings = Pdfium::bind_to_library(&lib_path)
            .map_err(|e| Error::from_reason(format!("Failed to bind PDFium from {:?}: {}", lib_path, e)))?;
        return Ok(Pdfium::new(bindings));
    }
    
    // 尝试从当前工作目录加载
    let cwd_lib_path = std::path::PathBuf::from(lib_name);
    if cwd_lib_path.exists() {
        let bindings = Pdfium::bind_to_library(&cwd_lib_path)
            .map_err(|e| Error::from_reason(format!("Failed to bind PDFium from {:?}: {}", cwd_lib_path, e)))?;
        return Ok(Pdfium::new(bindings));
    }
    
    // 回退到默认搜索路径（系统路径）
    Ok(Pdfium::default())
}

/// 获取当前模块所在目录
fn get_module_dir() -> std::path::PathBuf {
    // 尝试从环境变量获取（CI 构建时设置）
    if let Ok(path) = std::env::var("PDFIUM_MODULE_DIR") {
        return std::path::PathBuf::from(path);
    }
    
    // 获取当前可执行文件目录
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            return parent.to_path_buf();
        }
    }
    
    // 回退到当前目录
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// 根据平台和架构获取 PDFium 库文件名
fn get_pdfium_lib_name() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "libpdfium-linux-x64.so";
    
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "libpdfium-linux-arm64.so";
    
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "libpdfium-darwin-x64.dylib";
    
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "libpdfium-darwin-arm64.dylib";
    
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "pdfium-win32-x64.dll";
    
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    return "libpdfium.so"; // fallback
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
    /// 编码后的图像数据
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

/// 原始位图结果（不编码）
#[napi(object)]
pub struct RawBitmapResult {
    /// 是否成功
    pub success: bool,
    /// 错误信息（如果失败）
    pub error: Option<String>,
    /// 图像宽度
    pub width: u32,
    /// 图像高度
    pub height: u32,
    /// 通道数（固定为 4，RGBA）
    pub channels: u32,
    /// 原始 RGBA 像素数据
    pub buffer: Buffer,
    /// 渲染耗时（毫秒）
    pub render_time: u32,
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
    /// 图片质量（1-100，用于 webp/jpg，已废弃，请使用 webp_quality/jpeg_quality）
    pub quality: Option<u32>,
    /// 是否启用扫描件检测（默认 true）
    pub detect_scan: Option<bool>,
    /// 输出格式：webp, png, jpg（默认 webp）
    pub format: Option<String>,
    /// WebP 编码质量（0-100，默认 80）
    pub webp_quality: Option<u32>,
    /// WebP 编码方法/速度（0-6，0最快，6最慢，默认 4）
    pub webp_method: Option<i32>,
    /// JPEG 编码质量（0-100，默认 85）
    pub jpeg_quality: Option<u32>,
    /// PNG 压缩级别（0-9，默认 6）
    pub png_compression: Option<u32>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            target_width: Some(1280),
            image_heavy_width: Some(1024),
            max_scale: Some(4.0),
            quality: None,
            detect_scan: Some(true),
            format: Some("webp".to_string()),
            webp_quality: Some(80),
            webp_method: Some(4),
            jpeg_quality: Some(85),
            png_compression: Some(6),
        }
    }
}

/// 从 RenderOptions 构建 RenderConfig
fn build_config(opts: &RenderOptions) -> RenderConfig {
    let format = OutputFormat::from_str(&opts.format.clone().unwrap_or_else(|| "webp".to_string()));
    
    // 兼容旧的 quality 参数
    let legacy_quality = opts.quality.unwrap_or(80) as u8;
    
    RenderConfig {
        target_width: opts.target_width.unwrap_or(1280),
        image_heavy_width: opts.image_heavy_width.unwrap_or(1024),
        max_scale: opts.max_scale.unwrap_or(4.0) as f32,
        detect_scan: opts.detect_scan.unwrap_or(true),
        format,
        webp_quality: opts.webp_quality.map(|q| q as u8).unwrap_or(legacy_quality),
        webp_method: opts.webp_method.unwrap_or(4),
        jpeg_quality: opts.jpeg_quality.map(|q| q as u8).unwrap_or(legacy_quality),
        png_compression: opts.png_compression.unwrap_or(6) as u8,
    }
}

/// 从 PDF Buffer 渲染指定页面
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
    let config = build_config(&opts);

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

/// 从文件路径渲染 PDF 页面
///
/// 直接从文件系统读取 PDF，避免在 Node.js 堆中创建大 Buffer。
/// 这是处理本地大文件的最高效方式。
///
/// # Arguments
/// * `file_path` - PDF 文件的路径
/// * `page_nums` - 要渲染的页码数组（从 1 开始）
/// * `options` - 渲染配置选项
///
/// # Returns
/// 包含所有页面渲染结果的对象
#[napi]
pub fn render_pages_from_file(
    file_path: String,
    page_nums: Vec<u32>,
    options: Option<RenderOptions>,
) -> Result<RenderResult> {
    let start_time = std::time::Instant::now();
    let opts = options.unwrap_or_default();
    let config = build_config(&opts);

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
    
    match renderer.render_from_file(&file_path, &page_nums) {
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

/// 从文件路径获取 PDF 页数（不渲染）
///
/// # Arguments
/// * `file_path` - PDF 文件的路径
///
/// # Returns
/// PDF 的总页数
#[napi]
pub fn get_page_count_from_file(file_path: String) -> Result<u32> {
    let pdfium = create_pdfium()?;
    
    let document = pdfium
        .load_pdf_from_file(&file_path, None)
        .map_err(|e| Error::from_reason(format!("Failed to load PDF: {}", e)))?;
    
    Ok(document.pages().len() as u32)
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

/// 渲染单页到原始位图（不编码）
///
/// 这个函数只进行 PDFium 渲染，跳过图像编码步骤，
/// 返回原始 RGBA 像素数据。编码工作可以交给 Sharp 等更高效的库。
///
/// # Arguments
/// * `file_path` - PDF 文件路径
/// * `page_num` - 页码（从 1 开始）
/// * `options` - 渲染选项
///
/// # Returns
/// 包含原始位图数据和元信息的结果
#[napi]
pub fn render_page_to_raw_bitmap(
    file_path: String,
    page_num: u32,
    options: Option<RenderOptions>,
) -> Result<RawBitmapResult> {
    let render_start = std::time::Instant::now();
    let opts = options.unwrap_or_default();
    let config = build_config(&opts);

    let pdfium = match create_pdfium() {
        Ok(p) => p,
        Err(e) => {
            return Ok(RawBitmapResult {
                success: false,
                error: Some(e.to_string()),
                width: 0,
                height: 0,
                channels: 4,
                buffer: Buffer::from(vec![]),
                render_time: render_start.elapsed().as_millis() as u32,
            });
        }
    };

    let document = match pdfium.load_pdf_from_file(&file_path, None) {
        Ok(d) => d,
        Err(e) => {
            return Ok(RawBitmapResult {
                success: false,
                error: Some(format!("Failed to load PDF: {}", e)),
                width: 0,
                height: 0,
                channels: 4,
                buffer: Buffer::from(vec![]),
                render_time: render_start.elapsed().as_millis() as u32,
            });
        }
    };

    let renderer = renderer::PdfRenderer::new(&pdfium, config);
    let result = renderer.render_page_to_raw_bitmap(&document, page_num);
    
    Ok(result)
}

/// 从 Buffer 渲染单页到原始位图（不编码）
#[napi]
pub fn render_page_to_raw_bitmap_from_buffer(
    pdf_buffer: Buffer,
    page_num: u32,
    options: Option<RenderOptions>,
) -> Result<RawBitmapResult> {
    let render_start = std::time::Instant::now();
    let opts = options.unwrap_or_default();
    let config = build_config(&opts);

    let pdfium = match create_pdfium() {
        Ok(p) => p,
        Err(e) => {
            return Ok(RawBitmapResult {
                success: false,
                error: Some(e.to_string()),
                width: 0,
                height: 0,
                channels: 4,
                buffer: Buffer::from(vec![]),
                render_time: render_start.elapsed().as_millis() as u32,
            });
        }
    };

    let document = match pdfium.load_pdf_from_byte_slice(&pdf_buffer, None) {
        Ok(d) => d,
        Err(e) => {
            return Ok(RawBitmapResult {
                success: false,
                error: Some(format!("Failed to load PDF: {}", e)),
                width: 0,
                height: 0,
                channels: 4,
                buffer: Buffer::from(vec![]),
                render_time: render_start.elapsed().as_millis() as u32,
            });
        }
    };

    let renderer = renderer::PdfRenderer::new(&pdfium, config);
    let result = renderer.render_page_to_raw_bitmap(&document, page_num);
    
    Ok(result)
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
    
    let pdfium = create_pdfium()?;
    
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
    
    Ok(start_time.elapsed().as_millis() as u32)
}

/// 获取版本信息
#[napi]
pub fn get_version() -> String {
    format!("pdf-renderer v{}", env!("CARGO_PKG_VERSION"))
}

/// 流式渲染结果（包含额外的统计信息）
#[napi(object)]
pub struct StreamRenderResult {
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
    /// 流式加载统计
    pub stream_stats: Option<StreamStats>,
}

/// 流式加载统计信息
#[napi(object)]
pub struct StreamStats {
    /// 总请求次数
    pub total_requests: u32,
    /// 缓存命中次数
    pub cache_hits: u32,
    /// 缓存未命中次数
    pub cache_misses: u32,
    /// 总下载字节数
    pub total_bytes_fetched: i64,
}

/// 从流式数据源渲染 PDF 页面（异步版本）
///
/// 这个函数在独立线程中运行 PDFium 渲染，返回 Promise。
/// 主线程保持事件循环运行，可以处理 JS 回调。
///
/// # Arguments
/// * `env` - NAPI 环境
/// * `pdf_size` - PDF 文件的总大小（字节）
/// * `page_nums` - 要渲染的页码数组（从 1 开始）
/// * `options` - 渲染配置选项
/// * `fetcher` - JavaScript 回调函数，用于获取指定范围的数据
///
/// # Returns
/// Promise<StreamRenderResult>
#[napi(
    ts_args_type = "pdfSize: number, pageNums: number[], options: RenderOptions | null | undefined, fetcher: (offset: number, size: number, requestId: number) => void"
)]
pub fn render_pages_from_stream(
    env: Env,
    pdf_size: f64,
    page_nums: Vec<u32>,
    options: Option<RenderOptions>,
    fetcher: JsFunction,
) -> napi::Result<napi::JsObject> {
    let start_time = std::time::Instant::now();
    let opts = options.unwrap_or_default();
    let pdf_size_u64 = pdf_size as u64;

    let config = build_config(&opts);

    let task_id = next_task_id();

    let tsfn: ThreadsafeFunction<BlockRequest, ErrorStrategy::CalleeHandled> = fetcher
        .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<BlockRequest>| {
            let mut obj = ctx.env.create_object()?;
            obj.set("offset", ctx.value.offset as f64)?;
            obj.set("size", ctx.value.size)?;
            obj.set("requestId", ctx.value.request_id)?;
            Ok(vec![obj])
        })?;

    let streamer = JsFileStreamer::new(pdf_size_u64, tsfn, task_id);
    let shared_state = streamer.get_shared_state();

    register_stream_state(task_id, shared_state.clone());

    env.execute_tokio_future(
        async move {
            let result = tokio::task::spawn_blocking(move || {
                let pdfium = create_pdfium().map_err(|e| e.to_string())?;
                let document = pdfium
                    .load_pdf_from_reader(streamer, None)
                    .map_err(|e| format!("Failed to load PDF from stream: {}", e))?;
                let renderer = PdfRenderer::new(&pdfium, config);
                renderer.render_document_pages(&document, &page_nums)
            })
            .await
            .map_err(|e| napi::Error::from_reason(format!("Task join error: {}", e)))?;

            Ok((result, shared_state, start_time, task_id))
        },
        |env: &mut Env, (result, shared_state, start_time, task_id): (std::result::Result<(u32, Vec<PageResult>), String>, std::sync::Arc<SharedState>, std::time::Instant, u32)| {
            unregister_stream_state(task_id);

            let stats = shared_state.stats.lock().unwrap();
            let stream_stats = StreamStats {
                total_requests: stats.total_requests,
                cache_hits: stats.cache_hits,
                cache_misses: stats.cache_misses,
                total_bytes_fetched: stats.total_bytes_fetched as i64,
            };

            match result {
                Ok((num_pages, pages)) => {
                    let mut obj = env.create_object()?;
                    obj.set("success", true)?;
                    obj.set("error", env.get_null()?)?;
                    obj.set("numPages", num_pages)?;
                    obj.set("pages", pages)?;
                    obj.set("totalTime", start_time.elapsed().as_millis() as u32)?;
                    obj.set("streamStats", stream_stats)?;
                    Ok(obj)
                }
                Err(e) => {
                    let mut obj = env.create_object()?;
                    obj.set("success", false)?;
                    obj.set("error", e)?;
                    obj.set("numPages", 0u32)?;
                    obj.set("pages", Vec::<PageResult>::new())?;
                    obj.set("totalTime", start_time.elapsed().as_millis() as u32)?;
                    obj.set("streamStats", stream_stats)?;
                    Ok(obj)
                }
            }
        },
    )
}

/// 完成流式请求
///
/// 当 JS 端获取到数据后，调用这个函数将数据发送给 Rust 端。
///
/// # Arguments
/// * `request_id` - 请求 ID
/// * `data` - 获取到的数据
/// * `error` - 错误信息（如果获取失败）
#[napi]
pub fn complete_stream_request(
    request_id: u32,
    data: Option<Buffer>,
    error: Option<String>,
) -> Result<()> {
    let task_id = request_id >> 16;
    
    let states = GLOBAL_STREAM_STATES
        .lock()
        .map_err(|e| Error::from_reason(format!("Failed to lock global states: {}", e)))?;
    
    if let Some(shared_state) = states.get(&task_id) {
        let result = match (data, error) {
            (Some(buffer), _) => Ok(buffer.to_vec()),
            (None, Some(err)) => Err(err),
            (None, None) => Err("No data or error provided".to_string()),
        };
        shared_state.complete_request(request_id, result);
    }
    
    Ok(())
}

use std::sync::Mutex as StdMutex;
use std::collections::HashMap;
use once_cell::sync::Lazy;
use stream_reader::SharedState;

static GLOBAL_STREAM_STATES: Lazy<StdMutex<HashMap<u32, std::sync::Arc<SharedState>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

static GLOBAL_TASK_ID: Lazy<StdMutex<u32>> = Lazy::new(|| StdMutex::new(0));

fn next_task_id() -> u32 {
    let mut id = GLOBAL_TASK_ID.lock().unwrap();
    let current = *id & 0xFFFF;
    *id = id.wrapping_add(1);
    current
}

fn register_stream_state(task_id: u32, state: std::sync::Arc<SharedState>) {
    GLOBAL_STREAM_STATES.lock().unwrap().insert(task_id, state);
}

fn unregister_stream_state(task_id: u32) {
    GLOBAL_STREAM_STATES.lock().unwrap().remove(&task_id);
}
