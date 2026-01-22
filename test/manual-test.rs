//! Manual test script for pdf2img
//!
//! # Usage
//!
//! ```bash
//! # Use default test file
//! cargo run --release --bin manual-test
//!
//! # Specify a file
//! cargo run --release --bin manual-test -- /path/to/file.pdf
//! ```

use pdf2img_core::{convert, get_page_count, is_pdfium_available, get_version, ConvertOptions, OutputFormat};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    println!("{}", "=".repeat(50));
    println!("PDF2IMG Manual Test");
    println!("{}", "=".repeat(50));
    println!();

    // Check renderer
    println!("Version: {}", get_version());
    println!("PDFium available: {}", if is_pdfium_available() { "yes" } else { "no" });
    println!();

    if !is_pdfium_available() {
        eprintln!("Error: PDFium not available");
        std::process::exit(1);
    }

    // Get input file
    let args: Vec<String> = env::args().collect();
    let default_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("static/发票.pdf");
    
    let input_path = if args.len() > 1 {
        PathBuf::from(&args[1])
    } else {
        default_path
    };

    // Check file exists
    if !input_path.exists() {
        eprintln!("Error: File not found - {}", input_path.display());
        
        // List available PDFs
        let static_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("static");
        
        if static_dir.exists() {
            eprintln!();
            eprintln!("Available PDF files in static/:");
            for entry in fs::read_dir(&static_dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.extension().map(|e| e == "pdf").unwrap_or(false) {
                    eprintln!("  - {}", path.file_name().unwrap().to_string_lossy());
                }
            }
        }
        
        std::process::exit(1);
    }

    let metadata = fs::metadata(&input_path)?;
    let page_count = get_page_count(&input_path)?;

    println!("Input file: {}", input_path.display());
    println!("File size: {}", format_size(metadata.len() as usize));
    println!("Page count: {}", page_count);
    println!();

    // Create output directory
    let output_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("output");
    fs::create_dir_all(&output_dir)?;
    println!("Output directory: {}", output_dir.display());
    println!();

    // Convert
    println!("Converting...");
    let start = Instant::now();

    let prefix = input_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "page".to_string());

    let result = convert(
        &input_path.to_string_lossy(),
        Some(ConvertOptions {
            format: OutputFormat::WebP,
            target_width: Some(1280),
            quality: Some(80),
            ..Default::default()
        }),
    ).await?;

    let duration = start.elapsed();

    println!();
    println!("Conversion completed in {:?}", duration);
    println!();
    println!("Generated files:");

    let mut total_size = 0;
    let mut success_count = 0;

    for page in &result.pages {
        if page.success {
            let filename = format!("{}_{}.webp", prefix, page.page_num);
            let filepath = output_dir.join(&filename);
            
            fs::write(&filepath, &page.data)?;
            
            println!(
                "  {} - {}x{} ({}) [render: {}ms, encode: {}ms]",
                filename,
                page.width,
                page.height,
                format_size(page.data.len()),
                page.render_time_ms,
                page.encode_time_ms,
            );
            
            success_count += 1;
            total_size += page.data.len();
        } else {
            println!(
                "  Page {} - FAILED: {}",
                page.page_num,
                page.error.as_deref().unwrap_or("Unknown error")
            );
        }
    }

    println!();
    println!("Total: {} pages, {}", success_count, format_size(total_size));
    println!("Average: {} ms/page", duration.as_millis() as u64 / success_count.max(1) as u64);

    Ok(())
}
