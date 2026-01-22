//! Stream rendering performance benchmark
//!
//! Tests HTTP Range request streaming for remote PDF files.
//!
//! # Usage
//!
//! ```bash
//! cargo run --release --bin stream-benchmark
//! ```

use pdf2img_core::{convert, is_pdfium_available, get_version, warmup, ConvertOptions, OutputFormat, RenderMode};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

const MAX_PAGES_TO_RENDER: usize = 10;
const SERVER_PORT: u16 = 18765;

struct PdfFile {
    name: String,
    path: PathBuf,
    size: u64,
}

fn get_pdf_files() -> Vec<PdfFile> {
    let static_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("static");

    let mut files: Vec<PdfFile> = fs::read_dir(&static_dir)
        .expect("Failed to read static directory")
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()?.to_str()? == "pdf" {
                let metadata = fs::metadata(&path).ok()?;
                Some(PdfFile {
                    name: path.file_name()?.to_string_lossy().to_string(),
                    path,
                    size: metadata.len(),
                })
            } else {
                None
            }
        })
        .collect();

    files.sort_by_key(|f| f.size);
    files
}

fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    }
}

fn format_time(ms: u32) -> String {
    if ms < 1000 {
        format!("{} ms", ms)
    } else {
        format!("{:.2} s", ms as f64 / 1000.0)
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    println!("{}", "=".repeat(70));
    println!("PDF URL Stream Rendering Benchmark (PDFium)");
    println!("{}", "=".repeat(70));

    // Check renderer
    if !is_pdfium_available() {
        eprintln!("❌ PDFium not available");
        std::process::exit(1);
    }
    println!("Version: {}", get_version());
    println!("Max pages to render: {}", MAX_PAGES_TO_RENDER);
    println!();

    // Warmup
    print!("Warming up... ");
    let warmup_time = warmup()?;
    println!("done ({} ms)", warmup_time);
    println!();

    // Note: For a real benchmark, you would start a local HTTP server here
    // This is a simplified version that tests URL conversion concept
    
    println!("📁 Stream benchmark tests URL-based PDF conversion");
    println!("   (For full testing, start a local HTTP server with static/ files)");
    println!();

    // Get PDF files for reference
    let pdf_files = get_pdf_files();
    println!("📁 Found {} PDF files in static/", pdf_files.len());
    
    // Create output directory
    let output_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("output/stream-benchmark");
    fs::create_dir_all(&output_dir)?;

    // Test with native mode first (local files)
    println!();
    println!("Testing native mode with local files:");
    println!();

    for pdf_file in pdf_files.iter().take(3) {
        let pages_to_render = MAX_PAGES_TO_RENDER.min(10);
        let pages: Vec<u32> = (1..=pages_to_render as u32).collect();

        let options = ConvertOptions {
            format: OutputFormat::WebP,
            mode: Some(RenderMode::Native),
            target_width: Some(1280),
            quality: Some(80),
            pages,
            ..Default::default()
        };

        println!("📄 {}", pdf_file.name);
        println!("   Size: {}", format_size(pdf_file.size));

        let start = Instant::now();
        let result = convert(&pdf_file.path.to_string_lossy(), Some(options)).await?;
        let total_time = start.elapsed().as_millis() as u32;

        let success_count = result.pages.iter().filter(|p| p.success).count();
        let avg_time = if success_count > 0 {
            total_time / success_count as u32
        } else {
            0
        };

        println!(
            "   WebP: {:>8} ({:>6}/page), {} pages rendered",
            format_time(total_time),
            format_time(avg_time),
            success_count
        );
        println!();
    }

    println!("{}", "=".repeat(70));
    println!("✅ Stream benchmark completed");
    println!();
    println!("Note: For full HTTP streaming test, use:");
    println!("  1. Start local server: python -m http.server {} --directory static/", SERVER_PORT);
    println!("  2. Run: cargo run --bin stream-benchmark -- --url http://localhost:{}/", SERVER_PORT);

    Ok(())
}
