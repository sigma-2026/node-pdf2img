//! pdf2img Rust Demo
//!
//! This demo shows how to use the pdf2img-core library to convert PDF to images.

use pdf2img_core::{
    convert_from_buffer, convert_from_file, get_page_count, get_page_count_from_buffer,
    is_pdfium_available, warmup, ConvertOptions, OutputFormat,
};
use std::fs;
use std::path::Path;
use std::time::Instant;

#[tokio::main]
async fn main() {
    println!("=== pdf2img Rust Demo ===");
    println!("Version: {}\n", pdf2img_core::get_version());

    // Check if PDFium is available
    if !is_pdfium_available() {
        eprintln!("Error: PDFium library not found!");
        eprintln!();
        eprintln!("To use this library, you need to install PDFium:");
        eprintln!("  1. Run: ./scripts/download_pdfium.sh");
        eprintln!("  2. Set LD_LIBRARY_PATH to include the PDFium directory");
        eprintln!();
        eprintln!("Example:");
        eprintln!("  export LD_LIBRARY_PATH=/path/to/pdfium/lib:$LD_LIBRARY_PATH");
        std::process::exit(1);
    }
    println!("✓ PDFium is available");

    // Warmup
    match warmup() {
        Ok(time_ms) => println!("✓ Warmup completed in {}ms", time_ms),
        Err(e) => eprintln!("Warning: Warmup failed: {}", e),
    }

    // Get test PDF path
    let pdf_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "../../static/Word数据结构竞品分析.pdf".to_string());

    // Check if file exists
    if !Path::new(&pdf_path).exists() {
        eprintln!("Error: PDF file not found: {}", pdf_path);
        std::process::exit(1);
    }
    println!("✓ PDF file found: {}\n", pdf_path);

    // Get page count
    match get_page_count(&pdf_path) {
        Ok(count) => println!("PDF has {} pages\n", count),
        Err(e) => {
            eprintln!("Error getting page count: {}", e);
            std::process::exit(1);
        }
    }

    // Create output directory
    let output_dir = Path::new("output");
    fs::create_dir_all(output_dir).expect("Failed to create output directory");

    // Test 1: Convert first 2 pages to WebP
    println!("--- Test 1: Convert first 2 pages to WebP ---");
    let start = Instant::now();
    let options = ConvertOptions {
        format: OutputFormat::WebP,
        target_width: Some(1280),
        quality: Some(80),
        pages: vec![1, 2],
        ..Default::default()
    };

    match convert_from_file(&pdf_path, options).await {
        Ok(result) => {
            println!(
                "Success: {}, Total pages: {}, Time: {}ms",
                result.success,
                result.total_pages,
                start.elapsed().as_millis()
            );
            for page in &result.pages {
                if page.success {
                    let filename = output_dir.join(format!("page_{}.webp", page.page_num));
                    fs::write(&filename, &page.data).expect("Failed to write file");
                    println!(
                        "  Page {}: {}x{}, {} bytes, render={}ms, encode={}ms -> {}",
                        page.page_num,
                        page.width,
                        page.height,
                        page.data.len(),
                        page.render_time_ms,
                        page.encode_time_ms,
                        filename.display()
                    );
                } else {
                    println!(
                        "  Page {}: FAILED - {}",
                        page.page_num,
                        page.error.as_deref().unwrap_or("unknown error")
                    );
                }
            }
        }
        Err(e) => eprintln!("Conversion failed: {}", e),
    }
    println!();

    // Test 2: Convert page 1 to PNG
    println!("--- Test 2: Convert page 1 to PNG ---");
    let options = ConvertOptions {
        format: OutputFormat::Png,
        target_width: Some(800),
        pages: vec![1],
        ..Default::default()
    };

    match convert_from_file(&pdf_path, options).await {
        Ok(result) => {
            for page in &result.pages {
                if page.success {
                    let filename = output_dir.join(format!("page_{}.png", page.page_num));
                    fs::write(&filename, &page.data).expect("Failed to write file");
                    println!(
                        "  Page {}: {}x{}, {} bytes -> {}",
                        page.page_num,
                        page.width,
                        page.height,
                        page.data.len(),
                        filename.display()
                    );
                }
            }
        }
        Err(e) => eprintln!("Conversion failed: {}", e),
    }
    println!();

    // Test 3: Convert page 1 to JPEG
    println!("--- Test 3: Convert page 1 to JPEG ---");
    let options = ConvertOptions {
        format: OutputFormat::Jpeg,
        target_width: Some(800),
        quality: Some(90),
        pages: vec![1],
        ..Default::default()
    };

    match convert_from_file(&pdf_path, options).await {
        Ok(result) => {
            for page in &result.pages {
                if page.success {
                    let filename = output_dir.join(format!("page_{}.jpg", page.page_num));
                    fs::write(&filename, &page.data).expect("Failed to write file");
                    println!(
                        "  Page {}: {}x{}, {} bytes -> {}",
                        page.page_num,
                        page.width,
                        page.height,
                        page.data.len(),
                        filename.display()
                    );
                }
            }
        }
        Err(e) => eprintln!("Conversion failed: {}", e),
    }
    println!();

    // Test 4: Convert from buffer
    println!("--- Test 4: Convert from buffer ---");
    match fs::read(&pdf_path) {
        Ok(pdf_data) => {
            // Get page count from buffer
            match get_page_count_from_buffer(&pdf_data) {
                Ok(count) => println!("Buffer page count: {}", count),
                Err(e) => eprintln!("Failed to get page count from buffer: {}", e),
            }

            let options = ConvertOptions {
                format: OutputFormat::WebP,
                target_width: Some(640),
                quality: Some(70),
                pages: vec![1],
                ..Default::default()
            };

            match convert_from_buffer(&pdf_data, options) {
                Ok(result) => {
                    for page in &result.pages {
                        if page.success {
                            let filename =
                                output_dir.join(format!("page_{}_from_buffer.webp", page.page_num));
                            fs::write(&filename, &page.data).expect("Failed to write file");
                            println!(
                                "  Page {}: {}x{}, {} bytes -> {}",
                                page.page_num,
                                page.width,
                                page.height,
                                page.data.len(),
                                filename.display()
                            );
                        }
                    }
                }
                Err(e) => eprintln!("Conversion failed: {}", e),
            }
        }
        Err(e) => eprintln!("Failed to read PDF: {}", e),
    }
    println!();

    // Summary
    println!("=== Demo Complete ===");
    println!("Output files saved to: {}/", output_dir.display());

    // List output files
    if let Ok(entries) = fs::read_dir(output_dir) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                println!(
                    "  - {} ({} bytes)",
                    entry.file_name().to_string_lossy(),
                    metadata.len()
                );
            }
        }
    }
}
