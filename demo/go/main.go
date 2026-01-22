package main

import (
	"fmt"
	"os"
	"path/filepath"

	pdf2img "github.com/nicepkg/pdf2img/go"
)

func main() {
	fmt.Println("=== pdf2img Go Demo ===")
	fmt.Printf("Version: %s\n\n", pdf2img.GetVersion())

	// Check if PDFium is available
	if !pdf2img.IsAvailable() {
		fmt.Println("Error: PDFium library not found!")
		fmt.Println("")
		fmt.Println("To use this library, you need to install PDFium:")
		fmt.Println("  1. Download PDFium binary for your platform")
		fmt.Println("  2. Place it in the same directory as this executable")
		fmt.Println("  3. Or set LD_LIBRARY_PATH to include the PDFium directory")
		fmt.Println("")
		fmt.Println("PDFium library names by platform:")
		fmt.Println("  - Linux x64:   libpdfium-linux-x64.so")
		fmt.Println("  - Linux ARM64: libpdfium-linux-arm64.so")
		fmt.Println("  - macOS x64:   libpdfium-darwin-x64.dylib")
		fmt.Println("  - macOS ARM64: libpdfium-darwin-arm64.dylib")
		fmt.Println("  - Windows x64: pdfium-win32-x64.dll")
		os.Exit(1)
	}
	fmt.Println("✓ PDFium is available")

	// Warmup
	warmupTime, err := pdf2img.Warmup()
	if err != nil {
		fmt.Printf("Warning: Warmup failed: %v\n", err)
	} else {
		fmt.Printf("✓ Warmup completed in %dms\n", warmupTime)
	}

	// Get test PDF path
	pdfPath := filepath.Join("..", "..", "static", "Word数据结构竞品分析.pdf")
	if len(os.Args) > 1 {
		pdfPath = os.Args[1]
	}

	// Check if file exists
	if _, err := os.Stat(pdfPath); os.IsNotExist(err) {
		fmt.Printf("Error: PDF file not found: %s\n", pdfPath)
		os.Exit(1)
	}
	fmt.Printf("✓ PDF file found: %s\n\n", pdfPath)

	// Get page count
	pageCount, err := pdf2img.GetPageCount(pdfPath)
	if err != nil {
		fmt.Printf("Error getting page count: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("PDF has %d pages\n\n", pageCount)

	// Create output directory
	outputDir := "output"
	os.MkdirAll(outputDir, 0755)

	// Test 1: Convert first 2 pages to WebP
	fmt.Println("--- Test 1: Convert first 2 pages to WebP ---")
	result, err := pdf2img.ConvertFile(pdfPath, &pdf2img.Options{
		Format:      pdf2img.FormatWebP,
		TargetWidth: 1280,
		Quality:     80,
		Pages:       []uint32{1, 2},
	})
	if err != nil {
		fmt.Printf("Conversion failed: %v\n", err)
	} else {
		fmt.Printf("Success: %v, Total pages: %d, Time: %dms\n",
			result.Success, result.TotalPages, result.TotalTimeMs)
		
		for _, page := range result.Pages {
			if page.Success {
				filename := filepath.Join(outputDir, fmt.Sprintf("page_%d.webp", page.PageNum))
				os.WriteFile(filename, page.Data, 0644)
				fmt.Printf("  Page %d: %dx%d, %d bytes, render=%dms, encode=%dms -> %s\n",
					page.PageNum, page.Width, page.Height, len(page.Data),
					page.RenderTimeMs, page.EncodeTimeMs, filename)
			} else {
				fmt.Printf("  Page %d: FAILED - %s\n", page.PageNum, page.Error)
			}
		}
		result.Free()
	}
	fmt.Println()

	// Test 2: Convert page 1 to PNG
	fmt.Println("--- Test 2: Convert page 1 to PNG ---")
	result, err = pdf2img.ConvertFile(pdfPath, &pdf2img.Options{
		Format:      pdf2img.FormatPNG,
		TargetWidth: 800,
		Pages:       []uint32{1},
	})
	if err != nil {
		fmt.Printf("Conversion failed: %v\n", err)
	} else {
		for _, page := range result.Pages {
			if page.Success {
				filename := filepath.Join(outputDir, fmt.Sprintf("page_%d.png", page.PageNum))
				os.WriteFile(filename, page.Data, 0644)
				fmt.Printf("  Page %d: %dx%d, %d bytes -> %s\n",
					page.PageNum, page.Width, page.Height, len(page.Data), filename)
			}
		}
		result.Free()
	}
	fmt.Println()

	// Test 3: Convert page 1 to JPEG
	fmt.Println("--- Test 3: Convert page 1 to JPEG ---")
	result, err = pdf2img.ConvertFile(pdfPath, &pdf2img.Options{
		Format:      pdf2img.FormatJPEG,
		TargetWidth: 800,
		Quality:     90,
		Pages:       []uint32{1},
	})
	if err != nil {
		fmt.Printf("Conversion failed: %v\n", err)
	} else {
		for _, page := range result.Pages {
			if page.Success {
				filename := filepath.Join(outputDir, fmt.Sprintf("page_%d.jpg", page.PageNum))
				os.WriteFile(filename, page.Data, 0644)
				fmt.Printf("  Page %d: %dx%d, %d bytes -> %s\n",
					page.PageNum, page.Width, page.Height, len(page.Data), filename)
			}
		}
		result.Free()
	}
	fmt.Println()

	// Test 4: Convert from buffer
	fmt.Println("--- Test 4: Convert from buffer ---")
	pdfData, err := os.ReadFile(pdfPath)
	if err != nil {
		fmt.Printf("Failed to read PDF: %v\n", err)
	} else {
		bufferPageCount, err := pdf2img.GetPageCountFromBuffer(pdfData)
		if err != nil {
			fmt.Printf("Failed to get page count from buffer: %v\n", err)
		} else {
			fmt.Printf("Buffer page count: %d\n", bufferPageCount)
		}

		result, err = pdf2img.ConvertBuffer(pdfData, &pdf2img.Options{
			Format:      pdf2img.FormatWebP,
			TargetWidth: 640,
			Quality:     70,
			Pages:       []uint32{1},
		})
		if err != nil {
			fmt.Printf("Conversion failed: %v\n", err)
		} else {
			for _, page := range result.Pages {
				if page.Success {
					filename := filepath.Join(outputDir, fmt.Sprintf("page_%d_from_buffer.webp", page.PageNum))
					os.WriteFile(filename, page.Data, 0644)
					fmt.Printf("  Page %d: %dx%d, %d bytes -> %s\n",
						page.PageNum, page.Width, page.Height, len(page.Data), filename)
				}
			}
			result.Free()
		}
	}
	fmt.Println()

	// Summary
	fmt.Println("=== Demo Complete ===")
	fmt.Printf("Output files saved to: %s/\n", outputDir)
	
	// List output files
	files, _ := os.ReadDir(outputDir)
	for _, f := range files {
		info, _ := f.Info()
		fmt.Printf("  - %s (%d bytes)\n", f.Name(), info.Size())
	}
}
