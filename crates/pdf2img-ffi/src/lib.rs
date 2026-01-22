//! C-FFI bindings for pdf2img
//!
//! This module provides C-compatible FFI functions for use in other languages like Go.
//!
//! # Memory Management
//!
//! - All returned strings and buffers must be freed using the corresponding free functions
//! - `pdf2img_free_string` for strings
//! - `pdf2img_free_result` for conversion results
//!
//! # Thread Safety
//!
//! All functions are thread-safe. The library uses a global PDFium instance that is
//! initialized on first use.

use once_cell::sync::Lazy;
use pdf2img_core::{ConvertOptions, OutputFormat, RenderMode};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;
use std::slice;

/// Global tokio runtime for async operations
static RUNTIME: Lazy<tokio::runtime::Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("Failed to create tokio runtime")
});

/// Page result for FFI
#[repr(C)]
pub struct Pdf2ImgPageResult {
    /// Page number (1-based)
    pub page_num: u32,
    /// Image width
    pub width: u32,
    /// Image height
    pub height: u32,
    /// Encoded image data
    pub data: *mut u8,
    /// Data length
    pub data_len: usize,
    /// Whether rendering succeeded
    pub success: bool,
    /// Error message (null if success)
    pub error: *mut c_char,
    /// Render time in milliseconds
    pub render_time_ms: u32,
    /// Encode time in milliseconds
    pub encode_time_ms: u32,
}

/// Conversion result for FFI
#[repr(C)]
pub struct Pdf2ImgResult {
    /// Whether conversion succeeded
    pub success: bool,
    /// Error message (null if success)
    pub error: *mut c_char,
    /// Total page count
    pub total_pages: u32,
    /// Rendered pages array
    pub pages: *mut Pdf2ImgPageResult,
    /// Number of pages
    pub pages_len: usize,
    /// Total time in milliseconds
    pub total_time_ms: u32,
}

/// Conversion options for FFI
#[repr(C)]
pub struct Pdf2ImgOptions {
    /// Output format: 0=WebP, 1=PNG, 2=JPEG
    pub format: u32,
    /// Render mode: 0=Native, 1=NativeStream
    pub mode: u32,
    /// Target render width
    pub target_width: u32,
    /// Image quality (0-100)
    pub quality: u32,
    /// Pages to render (null or empty = all pages)
    pub pages: *const u32,
    /// Number of pages
    pub pages_len: usize,
    /// Enable scan detection
    pub detect_scan: bool,
}

impl Default for Pdf2ImgOptions {
    fn default() -> Self {
        Self {
            format: 0,
            target_width: 1280,
            quality: 80,
            mode: 0,
            pages: ptr::null(),
            pages_len: 0,
            detect_scan: true,
        }
    }
}

/// Convert options from FFI struct
fn convert_options(opts: *const Pdf2ImgOptions) -> ConvertOptions {
    if opts.is_null() {
        return ConvertOptions::default();
    }

    let opts = unsafe { &*opts };
    
    let format = match opts.format {
        1 => OutputFormat::Png,
        2 => OutputFormat::Jpeg,
        _ => OutputFormat::WebP,
    };

    let mode = match opts.mode {
        1 => RenderMode::NativeStream,
        _ => RenderMode::Native,
    };

    let pages = if opts.pages.is_null() || opts.pages_len == 0 {
        vec![]
    } else {
        unsafe { slice::from_raw_parts(opts.pages, opts.pages_len).to_vec() }
    };

    ConvertOptions {
        format,
        mode: Some(mode),
        target_width: Some(opts.target_width),
        quality: Some(opts.quality),
        detect_scan: Some(opts.detect_scan),
        pages,
        ..Default::default()
    }
}

/// Create error result
fn create_error_result(error: &str) -> *mut Pdf2ImgResult {
    let result = Box::new(Pdf2ImgResult {
        success: false,
        error: CString::new(error).map(|s| s.into_raw()).unwrap_or(ptr::null_mut()),
        total_pages: 0,
        pages: ptr::null_mut(),
        pages_len: 0,
        total_time_ms: 0,
    });
    Box::into_raw(result)
}

/// Convert PDF from file path
///
/// # Safety
///
/// - `path` must be a valid null-terminated UTF-8 string
/// - `options` can be null for defaults
/// - The returned result must be freed with `pdf2img_free_result`
#[no_mangle]
pub unsafe extern "C" fn pdf2img_convert_file(
    path: *const c_char,
    options: *const Pdf2ImgOptions,
) -> *mut Pdf2ImgResult {
    if path.is_null() {
        return create_error_result("Path is null");
    }

    let path = match CStr::from_ptr(path).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return create_error_result("Invalid UTF-8 in path"),
    };

    let opts = convert_options(options);

    // Run async conversion in runtime
    let result = RUNTIME.block_on(async {
        pdf2img_core::convert_from_file(&path, opts).await
    });

    match result {
        Ok(result) => convert_result_to_ffi(result),
        Err(e) => create_error_result(&e.to_string()),
    }
}

/// Convert PDF from URL
///
/// # Safety
///
/// - `url` must be a valid null-terminated UTF-8 string
/// - `options` can be null for defaults
/// - The returned result must be freed with `pdf2img_free_result`
#[no_mangle]
pub unsafe extern "C" fn pdf2img_convert_url(
    url: *const c_char,
    options: *const Pdf2ImgOptions,
) -> *mut Pdf2ImgResult {
    if url.is_null() {
        return create_error_result("URL is null");
    }

    let url = match CStr::from_ptr(url).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return create_error_result("Invalid UTF-8 in URL"),
    };

    let opts = convert_options(options);

    // Run async conversion in runtime
    let result = RUNTIME.block_on(async {
        pdf2img_core::convert_from_url(&url, opts).await
    });

    match result {
        Ok(result) => convert_result_to_ffi(result),
        Err(e) => create_error_result(&e.to_string()),
    }
}

/// Convert PDF from memory buffer
///
/// # Safety
///
/// - `data` must be a valid pointer to `data_len` bytes
/// - `options` can be null for defaults
/// - The returned result must be freed with `pdf2img_free_result`
#[no_mangle]
pub unsafe extern "C" fn pdf2img_convert_buffer(
    data: *const u8,
    data_len: usize,
    options: *const Pdf2ImgOptions,
) -> *mut Pdf2ImgResult {
    if data.is_null() || data_len == 0 {
        return create_error_result("Data is null or empty");
    }

    let data = slice::from_raw_parts(data, data_len);
    let opts = convert_options(options);

    match pdf2img_core::convert_from_buffer(data, opts) {
        Ok(result) => convert_result_to_ffi(result),
        Err(e) => create_error_result(&e.to_string()),
    }
}

/// Convert result to FFI struct
fn convert_result_to_ffi(result: pdf2img_core::ConvertResult) -> *mut Pdf2ImgResult {
    let pages: Vec<Pdf2ImgPageResult> = result
        .pages
        .into_iter()
        .map(|p| {
            let data_len = p.data.len();
            let data = if p.success && !p.data.is_empty() {
                let mut data = p.data.into_boxed_slice();
                let ptr = data.as_mut_ptr();
                std::mem::forget(data);
                ptr
            } else {
                ptr::null_mut()
            };

            Pdf2ImgPageResult {
                page_num: p.page_num,
                width: p.width,
                height: p.height,
                data,
                data_len: if data.is_null() { 0 } else { data_len },
                success: p.success,
                error: p.error
                    .map(|e| CString::new(e).map(|s| s.into_raw()).unwrap_or(ptr::null_mut()))
                    .unwrap_or(ptr::null_mut()),
                render_time_ms: p.render_time_ms,
                encode_time_ms: p.encode_time_ms,
            }
        })
        .collect();

    let pages_len = pages.len();
    let pages_ptr = if pages.is_empty() {
        ptr::null_mut()
    } else {
        let mut pages = pages.into_boxed_slice();
        let ptr = pages.as_mut_ptr();
        std::mem::forget(pages);
        ptr
    };

    let ffi_result = Box::new(Pdf2ImgResult {
        success: result.success,
        error: result.error
            .map(|e| CString::new(e).map(|s| s.into_raw()).unwrap_or(ptr::null_mut()))
            .unwrap_or(ptr::null_mut()),
        total_pages: result.total_pages,
        pages: pages_ptr,
        pages_len,
        total_time_ms: result.total_time_ms,
    });

    Box::into_raw(ffi_result)
}

/// Get page count from file
///
/// # Safety
///
/// - `path` must be a valid null-terminated UTF-8 string
/// - Returns -1 on error
#[no_mangle]
pub unsafe extern "C" fn pdf2img_get_page_count(path: *const c_char) -> i32 {
    if path.is_null() {
        return -1;
    }

    let path = match CStr::from_ptr(path).to_str() {
        Ok(s) => s,
        Err(_) => return -1,
    };

    match pdf2img_core::get_page_count(path) {
        Ok(count) => count as i32,
        Err(_) => -1,
    }
}

/// Get page count from buffer
///
/// # Safety
///
/// - `data` must be a valid pointer to `data_len` bytes
/// - Returns -1 on error
#[no_mangle]
pub unsafe extern "C" fn pdf2img_get_page_count_buffer(data: *const u8, data_len: usize) -> i32 {
    if data.is_null() || data_len == 0 {
        return -1;
    }

    let data = slice::from_raw_parts(data, data_len);
    match pdf2img_core::get_page_count_from_buffer(data) {
        Ok(count) => count as i32,
        Err(_) => -1,
    }
}

/// Check if PDFium is available
#[no_mangle]
pub extern "C" fn pdf2img_is_available() -> bool {
    pdf2img_core::is_pdfium_available()
}

/// Get library version
///
/// # Safety
///
/// - The returned string must NOT be freed
#[no_mangle]
pub extern "C" fn pdf2img_get_version() -> *const c_char {
    static VERSION: Lazy<CString> = Lazy::new(|| {
        CString::new(pdf2img_core::get_version()).unwrap_or_else(|_| CString::new("unknown").unwrap())
    });
    VERSION.as_ptr()
}

/// Warmup PDFium library
///
/// Returns warmup time in milliseconds, or -1 on error
#[no_mangle]
pub extern "C" fn pdf2img_warmup() -> i32 {
    match pdf2img_core::warmup() {
        Ok(time) => time as i32,
        Err(_) => -1,
    }
}

/// Free a conversion result
///
/// # Safety
///
/// - `result` must be a pointer returned by a convert function
/// - The pointer becomes invalid after this call
#[no_mangle]
pub unsafe extern "C" fn pdf2img_free_result(result: *mut Pdf2ImgResult) {
    if result.is_null() {
        return;
    }

    let result = Box::from_raw(result);

    // Free error string
    if !result.error.is_null() {
        drop(CString::from_raw(result.error));
    }

    // Free pages
    if !result.pages.is_null() && result.pages_len > 0 {
        let pages = Vec::from_raw_parts(result.pages, result.pages_len, result.pages_len);
        for page in pages {
            // Free page data
            if !page.data.is_null() && page.data_len > 0 {
                drop(Vec::from_raw_parts(page.data, page.data_len, page.data_len));
            }
            // Free page error
            if !page.error.is_null() {
                drop(CString::from_raw(page.error));
            }
        }
    }
}

/// Free a string returned by the library
///
/// # Safety
///
/// - `s` must be a pointer returned by the library
#[no_mangle]
pub unsafe extern "C" fn pdf2img_free_string(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}
