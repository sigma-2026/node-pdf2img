//! File rendering performance benchmark
//!
//! Tests conversion performance for all PDF files in static directory.
//!
//! # Usage
//!
//! ```bash
//! cargo run --release --bin file-benchmark
//! ```

use pdf2img_core::{convert, get_page_count, is_pdfium_available, get_version, warmup, ConvertOptions, OutputFormat};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

const MAX_PAGES_TO_RENDER: usize = 10;

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
    println!("PDF to Image Performance Benchmark (PDFium)");
    println!("{}", "=".repeat(70));

    // Check renderer
    if !is_pdfium_available() {
        eprintln!("❌ PDFium not available");
        std::process::exit(1);
    }
    println!("Version: {}", get_version());
    println!("Max pages to render: {}", MAX_PAGES_TO_RENDER);

    // Warmup
    print!("Warming up... ");
    let warmup_time = warmup()?;
    println!("done ({} ms)", warmup_time);
    println!();

    // Get PDF files
    let pdf_files = get_pdf_files();
    println!("📁 Found {} PDF files", pdf_files.len());
    println!();

    // Create output directory
    let output_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("output/benchmark");
    fs::create_dir_all(&output_dir)?;

    let formats = vec![OutputFormat::WebP, OutputFormat::Png, OutputFormat::Jpeg];

    for pdf_file in &pdf_files {
        let page_count = get_page_count(&pdf_file.path)?;
        let pages_to_render = MAX_PAGES_TO_RENDER.min(page_count as usize);

        println!("📄 {}", pdf_file.name);
        println!("   Size: {}", format_size(pdf_file.size));
        println!("   Total pages: {}, rendering: first {}", page_count, pages_to_render);

        for format in &formats {
            let pages: Vec<u32> = (1..=pages_to_render as u32).collect();
            
            let options = ConvertOptions {
                format: *format,
                target_width: Some(1280),
                quality: Some(80),
                pages: pages.clone(),
                ..Default::default()
            };

            let start = Instant::now();
            let result = convert(&pdf_file.path.to_string_lossy(), Some(options)).await?;
            let total_time = start.elapsed().as_millis() as u32;

            let total_size: usize = result.pages.iter()
                .filter(|p| p.success)
                .map(|p| p.data.len())
                .sum();

            let avg_time = total_time / result.pages.len() as u32;

            println!(
                "   {:4}: {:>8} ({:>6}/page), output {:>8}",
                match format {
                    OutputFormat::WebP => "WebP",
                    OutputFormat::Png => "PNG",
                    OutputFormat::Jpeg => "JPG",
                },
                format_time(total_time),
                format_time(avg_time),
                format_size(total_size as u64),
            );
        }

        println!();
    }

    println!("{}", "=".repeat(70));
    println!("✅ Benchmark completed");
    println!("   Output directory: {}", output_dir.display());

    Ok(())
}
