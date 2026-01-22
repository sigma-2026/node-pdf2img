# pdf2img

High-performance PDF to image converter using PDFium, written in pure Rust.

## Features

- **High Performance**: Uses PDFium for fast, accurate PDF rendering
- **Multiple Formats**: Supports WebP, PNG, and JPEG output
- **Streaming Mode**: HTTP Range request support for large remote PDFs
- **Cross-Platform**: Works on Linux, macOS, and Windows
- **Language Bindings**: Native Rust library with Go bindings via FFI

## Installation

### CLI Tool

```bash
cargo install pdf2img-cli
```

### Rust Library

```toml
[dependencies]
pdf2img-core = "0.1"
```

### Go Module

```bash
go get github.com/nicepkg/pdf2img/go
```

## Usage

### CLI

```bash
# Convert PDF to WebP images (default)
pdf2img document.pdf -o output/

# Convert specific pages
pdf2img document.pdf -o output/ -p 1,2,3

# Convert to PNG format
pdf2img document.pdf -o output/ -f png

# Convert from URL with streaming mode
pdf2img https://example.com/doc.pdf -o output/ -m native-stream

# Get PDF info only
pdf2img document.pdf --info
```

### Rust API

```rust
use pdf2img_core::{convert, ConvertOptions, OutputFormat};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = ConvertOptions {
        format: OutputFormat::WebP,
        target_width: Some(1280),
        quality: Some(80),
        ..Default::default()
    };
    
    let result = convert("document.pdf", Some(options)).await?;
    
    for page in result.pages {
        if page.success {
            std::fs::write(
                format!("page_{}.webp", page.page_num),
                &page.data
            )?;
        }
    }
    
    Ok(())
}
```

### Go API

```go
package main

import (
    "fmt"
    "os"
    
    pdf2img "github.com/nicepkg/pdf2img/go"
)

func main() {
    // Check if PDFium is available
    if !pdf2img.IsAvailable() {
        fmt.Println("PDFium not available")
        os.Exit(1)
    }

    // Convert PDF to images
    result, err := pdf2img.ConvertFile("document.pdf", &pdf2img.Options{
        Format:      pdf2img.FormatWebP,
        TargetWidth: 1280,
        Quality:     80,
    })
    if err != nil {
        fmt.Printf("Conversion failed: %v\n", err)
        os.Exit(1)
    }
    defer result.Free()

    // Save pages
    for _, page := range result.Pages {
        if page.Success {
            filename := fmt.Sprintf("page_%d.webp", page.PageNum)
            os.WriteFile(filename, page.Data, 0644)
            fmt.Printf("Saved %s (%dx%d)\n", filename, page.Width, page.Height)
        }
    }
}
```

## Render Modes

| Mode | Description | Best For |
|------|-------------|----------|
| `native` | Load entire PDF into memory | Local files, small PDFs |
| `native-stream` | Stream via HTTP Range requests | Large remote PDFs |

## Output Formats

| Format | Description |
|--------|-------------|
| WebP | Best compression, default format |
| PNG | Lossless, supports transparency |
| JPEG | Good for photos, smaller files |

## Building from Source

### Prerequisites

- Rust 1.70+
- PDFium library (automatically downloaded during build)

### Build

```bash
# Build all crates
cargo build --release

# Build CLI only
cargo build --release -p pdf2img-cli

# Build FFI library (for Go bindings)
cargo build --release -p pdf2img-ffi
```

### Run Tests

```bash
# Rust tests
cargo test

# Go tests (requires FFI library built)
cd go && go test -v
```

### Benchmarks

```bash
# File benchmark
cargo run --release --bin file-benchmark

# Stream benchmark
cargo run --release --bin stream-benchmark

# Manual test
cargo run --release --bin manual-test -- path/to/file.pdf
```

## Project Structure

```
pdf2img/
├── crates/
│   ├── pdf2img-core/     # Core Rust library
│   ├── pdf2img-cli/      # CLI tool
│   └── pdf2img-ffi/      # C-FFI bindings
├── go/                   # Go module bindings
├── demo/go/              # Go demo project
├── test/                 # Benchmark scripts
├── static/               # Test PDF files
└── output/               # Generated output
```

## Go Demo

A demo project showing how to use the Go bindings:

```bash
# Build the FFI library first
cargo build --release -p pdf2img-ffi

# Build and run the demo
cd demo/go
go build -o pdf2img-demo .
LD_LIBRARY_PATH=../../target/release ./pdf2img-demo
```

## PDFium Installation

The library requires PDFium to be available. You can:

1. **Set environment variable**: `PDFIUM_MODULE_DIR=/path/to/pdfium`
2. **Place in executable directory**: Put the PDFium library next to the binary
3. **System path**: Install PDFium in system library path

PDFium library names by platform:
- Linux x64: `libpdfium-linux-x64.so`
- Linux ARM64: `libpdfium-linux-arm64.so`
- macOS x64: `libpdfium-darwin-x64.dylib`
- macOS ARM64: `libpdfium-darwin-arm64.dylib`
- Windows x64: `pdfium-win32-x64.dll`

## License

MIT
