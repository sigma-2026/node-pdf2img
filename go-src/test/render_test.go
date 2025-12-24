package test

import (
	"context"
	"os"
	"testing"
	"time"

	"pdf2img/pkg/pdfrender"
	"pdf2img/pkg/rangeloader"
)

// 测试 PDF URL（使用公开的测试 PDF）
const testPDFURL = "https://www.w3.org/WAI/WCAG21/Techniques/pdf/img/table-word.pdf"

func TestRangeLoader(t *testing.T) {
	loader, err := rangeloader.NewRangeLoader(testPDFURL)
	if err != nil {
		t.Fatalf("Failed to create range loader: %v", err)
	}
	defer loader.Close()

	// 检查文件大小
	size := loader.Size()
	if size <= 0 {
		t.Fatalf("Invalid file size: %d", size)
	}
	t.Logf("PDF file size: %d bytes", size)

	// 测试读取初始数据
	ctx := context.Background()
	initData, err := loader.GetInitialData(ctx)
	if err != nil {
		t.Fatalf("Failed to get initial data: %v", err)
	}
	t.Logf("Initial data size: %d bytes", len(initData))

	// 检查 PDF 魔数
	if len(initData) < 5 || string(initData[:5]) != "%PDF-" {
		t.Fatalf("Invalid PDF header: %v", initData[:10])
	}

	// 测试分片读取
	buf := make([]byte, 1024)
	n, err := loader.ReadAt(buf, 0)
	if err != nil {
		t.Fatalf("Failed to read at offset 0: %v", err)
	}
	t.Logf("Read %d bytes at offset 0", n)

	// 检查统计信息
	stats := loader.Stats()
	t.Logf("Stats: requests=%d, bytes=%d, cacheHits=%d, cacheMisses=%d",
		stats.TotalRequests, stats.TotalBytes, stats.CacheHits, stats.CacheMisses)
}

func TestRangeLoaderChunks(t *testing.T) {
	loader, err := rangeloader.NewRangeLoader(testPDFURL,
		rangeloader.WithChunkSize(512*1024),      // 512KB
		rangeloader.WithSmallChunkSize(128*1024), // 128KB
	)
	if err != nil {
		t.Fatalf("Failed to create range loader: %v", err)
	}
	defer loader.Close()

	// 读取大块数据，触发分片
	buf := make([]byte, 256*1024) // 256KB
	n, err := loader.ReadAt(buf, 0)
	if err != nil {
		t.Fatalf("Failed to read: %v", err)
	}
	t.Logf("Read %d bytes with chunking", n)

	stats := loader.Stats()
	t.Logf("Total requests: %d (should be > 1 due to chunking)", stats.TotalRequests)
}

func TestPDFRenderer(t *testing.T) {
	renderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		t.Fatalf("Failed to create renderer: %v", err)
	}
	defer renderer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 渲染第一页
	result, err := renderer.RenderFromURL(ctx, testPDFURL, []int{0}, pdfrender.DefaultRenderOptions())
	if err != nil {
		t.Fatalf("Failed to render PDF: %v", err)
	}

	t.Logf("Total pages: %d", result.TotalPages)
	t.Logf("Render stats: load=%v, render=%v, total=%v",
		result.Stats.LoadTime, result.Stats.RenderTime, result.Stats.TotalTime)

	if len(result.Pages) != 1 {
		t.Fatalf("Expected 1 page, got %d", len(result.Pages))
	}

	page := result.Pages[0]
	if page.Error != nil {
		t.Fatalf("Page render error: %v", page.Error)
	}

	t.Logf("Page 0: %dx%d, %d bytes", page.Width, page.Height, len(page.Data))

	// 验证 PNG 格式
	if len(page.Data) < 8 || string(page.Data[1:4]) != "PNG" {
		t.Fatalf("Invalid PNG data")
	}
}

func TestPDFRendererAllPages(t *testing.T) {
	renderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		t.Fatalf("Failed to create renderer: %v", err)
	}
	defer renderer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// 渲染所有页（传空数组）
	result, err := renderer.RenderFromURL(ctx, testPDFURL, nil, pdfrender.DefaultRenderOptions())
	if err != nil {
		t.Fatalf("Failed to render PDF: %v", err)
	}

	t.Logf("Total pages: %d", result.TotalPages)
	t.Logf("Rendered pages: %d", len(result.Pages))

	for i, page := range result.Pages {
		if page.Error != nil {
			t.Errorf("Page %d error: %v", i, page.Error)
		} else {
			t.Logf("Page %d: %dx%d, %d bytes", i, page.Width, page.Height, len(page.Data))
		}
	}
}

func TestSaveRenderedImage(t *testing.T) {
	renderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		t.Fatalf("Failed to create renderer: %v", err)
	}
	defer renderer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	result, err := renderer.RenderFromURL(ctx, testPDFURL, []int{0}, pdfrender.DefaultRenderOptions())
	if err != nil {
		t.Fatalf("Failed to render PDF: %v", err)
	}

	if len(result.Pages) == 0 || result.Pages[0].Error != nil {
		t.Skip("No valid page rendered")
	}

	// 保存到临时文件
	tmpFile := "/tmp/test_page_0.png"
	if err := os.WriteFile(tmpFile, result.Pages[0].Data, 0644); err != nil {
		t.Fatalf("Failed to save image: %v", err)
	}
	t.Logf("Saved image to %s", tmpFile)

	// 验证文件
	info, err := os.Stat(tmpFile)
	if err != nil {
		t.Fatalf("Failed to stat file: %v", err)
	}
	t.Logf("File size: %d bytes", info.Size())
}

// 基准测试
func BenchmarkRangeLoaderRead(b *testing.B) {
	loader, err := rangeloader.NewRangeLoader(testPDFURL)
	if err != nil {
		b.Fatalf("Failed to create loader: %v", err)
	}
	defer loader.Close()

	buf := make([]byte, 64*1024) // 64KB

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		loader.ReadAt(buf, 0)
	}
}

func BenchmarkPDFRenderSinglePage(b *testing.B) {
	renderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		b.Fatalf("Failed to create renderer: %v", err)
	}
	defer renderer.Close()

	ctx := context.Background()
	opts := pdfrender.DefaultRenderOptions()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		renderer.RenderFromURL(ctx, testPDFURL, []int{0}, opts)
	}
}
