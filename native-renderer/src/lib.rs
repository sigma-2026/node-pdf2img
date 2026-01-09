//! PDF Renderer - High-performance PDF to WebP converter
//!
//! 使用 PDFium 渲染 PDF 页面，并编码为 WebP 格式
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
use renderer::PdfRenderer;
use stream_reader::{BlockRequest, JsFileStreamer};

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
///              这个函数接收 (offset, size, requestId)，需要异步获取数据后调用 completeStreamRequest
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

    let config = RenderConfig {
        target_width: opts.target_width.unwrap_or(1280),
        image_heavy_width: opts.image_heavy_width.unwrap_or(1024),
        max_scale: opts.max_scale.unwrap_or(4.0) as f32,
        webp_quality: opts.webp_quality.unwrap_or(70) as u8,
        detect_scan: opts.detect_scan.unwrap_or(true),
    };

    // 生成唯一的任务 ID
    let task_id = next_task_id();

    // 创建线程安全函数（在主线程中创建）
    // 注意：回调函数返回的 Vec 会被展开为多个参数传递给 JS
    // 第一个参数总是 error（null 表示无错误），后面是实际参数
    let tsfn: ThreadsafeFunction<BlockRequest, ErrorStrategy::CalleeHandled> = fetcher
        .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<BlockRequest>| {
            // 创建一个对象来传递所有参数
            let mut obj = ctx.env.create_object()?;
            obj.set("offset", ctx.value.offset as f64)?;
            obj.set("size", ctx.value.size)?;
            obj.set("requestId", ctx.value.request_id)?;
            Ok(vec![obj])
        })?;

    // 创建流式读取器和共享状态
    let streamer = JsFileStreamer::new(pdf_size_u64, tsfn, task_id);
    let shared_state = streamer.get_shared_state();

    // 注册共享状态到全局映射
    register_stream_state(task_id, shared_state.clone());

    // 使用 execute_tokio_future 来运行异步任务
    env.execute_tokio_future(
        async move {
            // 使用 spawn_blocking 在独立线程中运行 PDFium
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
            // 清理：移除共享状态
            unregister_stream_state(task_id);

            // 获取统计信息
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
/// 这个函数是 Native Stream 模式的关键部分。
///
/// request_id 的高 16 位是 task_id，低 16 位是该任务内的请求序号。
/// 这样可以支持多个并发任务。
///
/// # Arguments
/// * `request_id` - 请求 ID（从 fetcher 回调中获取，包含 task_id 和请求序号）
/// * `data` - 获取到的数据
/// * `error` - 错误信息（如果获取失败）
#[napi]
pub fn complete_stream_request(
    request_id: u32,
    data: Option<Buffer>,
    error: Option<String>,
) -> Result<()> {
    // 从 request_id 中提取 task_id（高 16 位）
    let task_id = request_id >> 16;
    
    // 获取对应任务的共享状态
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

/// 全局共享状态映射（支持并发请求）
/// 使用 task_id -> SharedState 的映射，允许多个请求同时进行
static GLOBAL_STREAM_STATES: Lazy<StdMutex<HashMap<u32, std::sync::Arc<SharedState>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

/// 全局任务 ID 计数器
static GLOBAL_TASK_ID: Lazy<StdMutex<u32>> = Lazy::new(|| StdMutex::new(0));

/// 生成下一个任务 ID（限制在 16 位范围内，用于与 request_seq 组合）
fn next_task_id() -> u32 {
    let mut id = GLOBAL_TASK_ID.lock().unwrap();
    let current = *id & 0xFFFF; // 只使用低 16 位
    *id = id.wrapping_add(1);
    current
}

/// 注册共享状态
fn register_stream_state(task_id: u32, state: std::sync::Arc<SharedState>) {
    GLOBAL_STREAM_STATES.lock().unwrap().insert(task_id, state);
}

/// 移除共享状态
fn unregister_stream_state(task_id: u32) {
    GLOBAL_STREAM_STATES.lock().unwrap().remove(&task_id);
}
