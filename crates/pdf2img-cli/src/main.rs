//! pdf2img CLI - High-performance PDF to image converter
//!
//! # Usage
//!
//! ```bash
//! # Convert PDF to images (default WebP format)
//! pdf2img document.pdf -o output/
//!
//! # Convert specific pages
//! pdf2img document.pdf -o output/ -p 1,2,3
//!
//! # Convert to PNG format
//! pdf2img document.pdf -o output/ -f png
//!
//! # Convert from URL with streaming
//! pdf2img https://example.com/doc.pdf -o output/ -m native-stream
//!
//! # Get PDF info only
//! pdf2img document.pdf --info
//! ```

use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use pdf2img_core::{
    convert, get_page_count, get_version, is_pdfium_available, warmup,
    ConvertOptions, OutputFormat, RenderMode,
};
use std::path::PathBuf;
use std::time::Instant;

/// High-performance PDF to image converter
#[derive(Parser, Debug)]
#[command(name = "pdf2img")]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Input PDF file path or URL
    #[arg(required_unless_present = "version_flag")]
    input: Option<String>,

    /// Output directory
    #[arg(short, long, default_value = "./output")]
    output: PathBuf,

    /// Output format
    #[arg(short, long, value_enum, default_value = "webp")]
    format: Format,

    /// Pages to convert (e.g., "1,2,3" or "1-5" or empty for all)
    #[arg(short, long)]
    pages: Option<String>,

    /// Target render width
    #[arg(short = 'w', long, default_value = "1280")]
    width: u32,

    /// Image quality (0-100, for WebP/JPEG)
    #[arg(short, long, default_value = "80")]
    quality: u32,

    /// Render mode
    #[arg(short, long, value_enum, default_value = "native")]
    mode: Mode,

    /// Output filename prefix
    #[arg(long)]
    prefix: Option<String>,

    /// Show PDF info only (don't convert)
    #[arg(long)]
    info: bool,

    /// Warmup PDFium before conversion
    #[arg(long)]
    warmup: bool,

    /// Print version
    #[arg(short = 'V', long = "version")]
    version_flag: bool,
}

#[derive(Debug, Clone, ValueEnum)]
enum Format {
    Webp,
    Png,
    Jpg,
    Jpeg,
}

impl From<Format> for OutputFormat {
    fn from(f: Format) -> Self {
        match f {
            Format::Webp => OutputFormat::WebP,
            Format::Png => OutputFormat::Png,
            Format::Jpg | Format::Jpeg => OutputFormat::Jpeg,
        }
    }
}

#[derive(Debug, Clone, ValueEnum)]
enum Mode {
    Native,
    NativeStream,
}

impl From<Mode> for RenderMode {
    fn from(m: Mode) -> Self {
        match m {
            Mode::Native => RenderMode::Native,
            Mode::NativeStream => RenderMode::NativeStream,
        }
    }
}

/// Parse page specification string
fn parse_pages(spec: &str) -> Result<Vec<u32>> {
    let mut pages = Vec::new();

    for part in spec.split(',') {
        let part = part.trim();
        if part.contains('-') {
            let mut iter = part.split('-');
            let start: u32 = iter
                .next()
                .context("Invalid page range")?
                .trim()
                .parse()
                .context("Invalid page number")?;
            let end: u32 = iter
                .next()
                .context("Invalid page range")?
                .trim()
                .parse()
                .context("Invalid page number")?;
            for p in start..=end {
                pages.push(p);
            }
        } else {
            let p: u32 = part.parse().context("Invalid page number")?;
            pages.push(p);
        }
    }

    Ok(pages)
}

/// Format file size for display
fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    }
}

/// Format duration for display
fn format_duration(ms: u32) -> String {
    if ms < 1000 {
        format!("{} ms", ms)
    } else {
        format!("{:.2} s", ms as f64 / 1000.0)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();

    let args = Args::parse();

    // Handle version flag
    if args.version_flag {
        println!("pdf2img {}", get_version());
        return Ok(());
    }

    let input = args.input.context("Input file is required")?;

    // Check PDFium availability
    if !is_pdfium_available() {
        eprintln!("Error: PDFium library not found");
        eprintln!("Please ensure PDFium is installed in the executable directory or system path.");
        std::process::exit(1);
    }

    // Warmup if requested
    if args.warmup {
        print!("Warming up PDFium... ");
        let warmup_time = warmup()?;
        println!("done ({} ms)", warmup_time);
    }

    // Info mode
    if args.info {
        return show_info(&input).await;
    }

    // Parse pages
    let pages = if let Some(ref spec) = args.pages {
        parse_pages(spec)?
    } else {
        vec![] // Empty = all pages
    };

    // Build options
    let options = ConvertOptions {
        format: args.format.clone().into(),
        mode: Some(args.mode.clone().into()),
        target_width: Some(args.width),
        quality: Some(args.quality),
        pages,
        ..Default::default()
    };

    // Create output directory
    std::fs::create_dir_all(&args.output)?;

    // Convert
    println!("Converting: {}", input);
    println!("Output: {}", args.output.display());
    println!("Format: {:?}", args.format);
    println!("Mode: {:?}", args.mode);
    println!();

    let start = Instant::now();
    let result = convert(&input, Some(options)).await?;

    if !result.success {
        if let Some(error) = result.error {
            eprintln!("Conversion failed: {}", error);
            std::process::exit(1);
        }
    }

    // Determine prefix
    let prefix = args.prefix.unwrap_or_else(|| {
        PathBuf::from(&input)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "page".to_string())
    });

    let format: OutputFormat = args.format.into();
    let ext = format.extension();

    // Save pages
    let mut success_count = 0;
    let mut total_size = 0;

    for page in &result.pages {
        if page.success {
            let filename = format!("{}_{}.{}", prefix, page.page_num, ext);
            let filepath = args.output.join(&filename);
            
            std::fs::write(&filepath, &page.data)?;
            
            println!(
                "  {} - {}x{} ({}) [render: {}, encode: {}]",
                filename,
                page.width,
                page.height,
                format_size(page.data.len()),
                format_duration(page.render_time_ms),
                format_duration(page.encode_time_ms),
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
    println!(
        "Converted {} of {} pages in {}",
        success_count,
        result.total_pages,
        format_duration(start.elapsed().as_millis() as u32)
    );
    println!("Total output size: {}", format_size(total_size));

    Ok(())
}

/// Show PDF information
async fn show_info(input: &str) -> Result<()> {
    println!("PDF Information");
    println!("===============");
    println!("File: {}", input);

    if input.starts_with("http://") || input.starts_with("https://") {
        // For URLs, we need to download or stream to get page count
        let data = pdf2img_core::convert_from_url(
            input,
            ConvertOptions {
                pages: vec![1], // Just get first page to get total count
                ..Default::default()
            },
        )
        .await?;
        
        println!("Total pages: {}", data.total_pages);
    } else {
        let page_count = get_page_count(input)?;
        
        // Get file size
        let metadata = std::fs::metadata(input)?;
        println!("Size: {}", format_size(metadata.len() as usize));
        println!("Total pages: {}", page_count);
    }

    println!();
    println!("PDFium available: {}", is_pdfium_available());
    println!("Library version: {}", get_version());

    Ok(())
}
