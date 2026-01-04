//! Build script for pdf-renderer
//! 
//! 自动下载 PDFium 预编译库并配置链接路径

extern crate napi_build;

use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;

/// PDFium 版本和下载源 (bblanchon/pdfium-binaries)
const PDFIUM_VERSION: &str = "7606";
const PDFIUM_BASE_URL: &str = "https://github.com/bblanchon/pdfium-binaries/releases/download";

fn main() {
    // NAPI-RS 构建设置
    napi_build::setup();
    
    // 获取输出目录
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let pdfium_dir = out_dir.join("pdfium");
    let lib_dir = pdfium_dir.join("lib");
    
    // 检查是否已经下载
    let lib_name = get_pdfium_lib_name();
    let lib_path = lib_dir.join(lib_name);
    
    if !lib_path.exists() {
        println!("cargo:warning=Downloading PDFium library...");
        if let Err(e) = download_pdfium(&pdfium_dir) {
            println!("cargo:warning=Failed to download PDFium: {}", e);
            println!("cargo:warning=You may need to manually install PDFium or set PDFIUM_DYNAMIC_LIB_PATH");
            return;
        }
        println!("cargo:warning=PDFium downloaded successfully!");
    }
    
    // 设置库搜索路径
    if lib_dir.exists() {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        
        // 设置运行时库路径 (Linux/macOS)
        #[cfg(target_os = "linux")]
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        
        #[cfg(target_os = "macos")]
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
        
        // 设置环境变量供 pdfium-render 使用
        println!("cargo:rustc-env=PDFIUM_DYNAMIC_LIB_PATH={}", lib_dir.display());
    }
    
    // 重新运行条件
    println!("cargo:rerun-if-env-changed=PDFIUM_DYNAMIC_LIB_PATH");
    println!("cargo:rerun-if-changed=build.rs");
}

fn get_platform_name() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x64";
    
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-arm64";
    
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "mac-x64";
    
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "mac-arm64";
    
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "win-x64";
    
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    compile_error!("Unsupported platform for PDFium");
}

fn get_pdfium_lib_name() -> &'static str {
    #[cfg(target_os = "linux")]
    return "libpdfium.so";
    
    #[cfg(target_os = "macos")]
    return "libpdfium.dylib";
    
    #[cfg(target_os = "windows")]
    return "pdfium.dll";
}

fn download_pdfium(pdfium_dir: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let platform = get_platform_name();
    // bblanchon 格式: pdfium-linux-x64.tgz
    let url = format!(
        "{}/chromium%2F{}/pdfium-{}.tgz",
        PDFIUM_BASE_URL, PDFIUM_VERSION, platform
    );
    
    println!("cargo:warning=Downloading from: {}", url);
    
    // 创建目录
    fs::create_dir_all(pdfium_dir)?;
    
    // 下载文件
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()?
        .get(&url)
        .send()?;
    
    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()).into());
    }
    
    let bytes = response.bytes()?;
    
    // 解压 tgz
    let decoder = flate2::read::GzDecoder::new(bytes.as_ref());
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(pdfium_dir)?;
    
    // bblanchon 的压缩包结构是 lib/libpdfium.so
    let lib_dir = pdfium_dir.join("lib");
    let lib_name = get_pdfium_lib_name();
    let lib_path = lib_dir.join(lib_name);
    
    if lib_path.exists() {
        println!("cargo:warning=PDFium library installed at: {}", lib_path.display());
        return Ok(());
    }
    
    // 列出目录内容以便调试
    println!("cargo:warning=PDFium directory contents:");
    list_dir_recursive(pdfium_dir, 0)?;
    
    Err("Could not find PDFium library in downloaded archive".into())
}

fn list_dir_recursive(dir: &PathBuf, depth: usize) -> io::Result<()> {
    if depth > 3 {
        return Ok(());
    }
    
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let indent = "  ".repeat(depth);
            println!("cargo:warning={}  {}", indent, path.file_name().unwrap_or_default().to_string_lossy());
            if path.is_dir() {
                list_dir_recursive(&path, depth + 1)?;
            }
        }
    }
    Ok(())
}
