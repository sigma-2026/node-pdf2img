package pdf2img

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsAvailable(t *testing.T) {
	// This test may fail if PDFium is not installed
	available := IsAvailable()
	t.Logf("PDFium available: %v", available)
}

func TestGetVersion(t *testing.T) {
	version := GetVersion()
	if version == "" {
		t.Error("Version should not be empty")
	}
	t.Logf("Version: %s", version)
}

func TestDefaultOptions(t *testing.T) {
	opts := DefaultOptions()
	
	if opts.Format != FormatWebP {
		t.Errorf("Default format should be WebP, got %d", opts.Format)
	}
	if opts.Mode != ModeNative {
		t.Errorf("Default mode should be Native, got %d", opts.Mode)
	}
	if opts.TargetWidth != 1280 {
		t.Errorf("Default target width should be 1280, got %d", opts.TargetWidth)
	}
	if opts.Quality != 80 {
		t.Errorf("Default quality should be 80, got %d", opts.Quality)
	}
}

func TestConvertFile(t *testing.T) {
	if !IsAvailable() {
		t.Skip("PDFium not available")
	}

	// Find a test PDF
	testPDF := findTestPDF()
	if testPDF == "" {
		t.Skip("No test PDF found")
	}

	result, err := ConvertFile(testPDF, &Options{
		Format:      FormatPNG,
		TargetWidth: 800,
		Quality:     80,
		Pages:       []uint32{1},
	})
	if err != nil {
		t.Fatalf("ConvertFile failed: %v", err)
	}
	defer result.Free()

	if !result.Success {
		t.Errorf("Conversion should succeed, error: %s", result.Error)
	}

	if result.TotalPages == 0 {
		t.Error("Total pages should be > 0")
	}

	if len(result.Pages) != 1 {
		t.Errorf("Should have 1 page, got %d", len(result.Pages))
	}

	if len(result.Pages) > 0 {
		page := result.Pages[0]
		if !page.Success {
			t.Errorf("Page should succeed, error: %s", page.Error)
		}
		if len(page.Data) == 0 {
			t.Error("Page data should not be empty")
		}
		t.Logf("Page 1: %dx%d, %d bytes", page.Width, page.Height, len(page.Data))
	}
}

func TestGetPageCount(t *testing.T) {
	if !IsAvailable() {
		t.Skip("PDFium not available")
	}

	testPDF := findTestPDF()
	if testPDF == "" {
		t.Skip("No test PDF found")
	}

	count, err := GetPageCount(testPDF)
	if err != nil {
		t.Fatalf("GetPageCount failed: %v", err)
	}

	if count <= 0 {
		t.Errorf("Page count should be > 0, got %d", count)
	}

	t.Logf("Page count: %d", count)
}

func TestConvertBuffer(t *testing.T) {
	if !IsAvailable() {
		t.Skip("PDFium not available")
	}

	testPDF := findTestPDF()
	if testPDF == "" {
		t.Skip("No test PDF found")
	}

	// Read PDF file
	data, err := os.ReadFile(testPDF)
	if err != nil {
		t.Fatalf("Failed to read test PDF: %v", err)
	}

	result, err := ConvertBuffer(data, &Options{
		Format: FormatWebP,
		Pages:  []uint32{1},
	})
	if err != nil {
		t.Fatalf("ConvertBuffer failed: %v", err)
	}
	defer result.Free()

	if !result.Success {
		t.Errorf("Conversion should succeed, error: %s", result.Error)
	}

	if len(result.Pages) > 0 && result.Pages[0].Success {
		t.Logf("Page 1: %dx%d, %d bytes (WebP)", 
			result.Pages[0].Width, result.Pages[0].Height, len(result.Pages[0].Data))
	}
}

func findTestPDF() string {
	// Look for test PDFs in various locations
	candidates := []string{
		"../static/发票.pdf",
		"../static/test.pdf",
		"testdata/test.pdf",
	}

	for _, path := range candidates {
		absPath, err := filepath.Abs(path)
		if err != nil {
			continue
		}
		if _, err := os.Stat(absPath); err == nil {
			return absPath
		}
	}

	// Also check static directory for any PDF
	staticDir := "../static"
	absDir, err := filepath.Abs(staticDir)
	if err == nil {
		entries, err := os.ReadDir(absDir)
		if err == nil {
			for _, entry := range entries {
				if filepath.Ext(entry.Name()) == ".pdf" {
					return filepath.Join(absDir, entry.Name())
				}
			}
		}
	}

	return ""
}
