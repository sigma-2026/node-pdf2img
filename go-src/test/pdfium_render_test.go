package test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pdf2img/pkg/pdfrender"
	"pdf2img/pkg/rangeloader"
)

// TestPdfiumRangeLoaderRender 测试 pdfium + Range 请求加载 PDF 并渲染
// 这个测试验证真正的按需加载效果
func TestPdfiumRangeLoaderRender(t *testing.T) {
	outputDir := "/tmp/go-pdfium-range-test"
	os.MkdirAll(outputDir, 0755)
	defer os.RemoveAll(outputDir)

	// 启动测试服务器
	server := startTestServer(t)
	defer server.Shutdown(context.Background())
	time.Sleep(500 * time.Millisecond)

	pdfFiles, err := filepath.Glob(filepath.Join(staticDir, "*.pdf"))
	if err != nil {
		t.Fatalf("Failed to find PDF files: %v", err)
	}

	if len(pdfFiles) == 0 {
		t.Skip("No PDF files found in static directory")
	}

	renderer, err := pdfrender.NewPdfiumRenderer()
	if err != nil {
		t.Fatalf("Failed to create pdfium renderer: %v", err)
	}
	defer renderer.Close()

	opts := pdfrender.DefaultRenderOptions()

	fmt.Println("\n" + strings.Repeat("=", 80))
	fmt.Println("         Pdfium 分片加载 PDF 渲染测试 (真正的按需加载)")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("🌐 测试服务器: http://localhost:%d\n", testServerPort)
	fmt.Printf("🎨 输出格式: %s (质量: %d, DPI: %d)\n", opts.Format, opts.Quality, opts.DPI)
	fmt.Printf("📦 分片大小: %s (子分片: %s)\n\n",
		formatBytes(rangeloader.DefaultChunkSize),
		formatBytes(rangeloader.DefaultSmallChunkSize))

	var totalStats struct {
		files         int
		success       int
		totalFileSize int64
		totalRequests int64
		totalBytes    int64
	}

	for _, pdfPath := range pdfFiles {
		pdfName := filepath.Base(pdfPath)
		pdfURL := fmt.Sprintf("http://localhost:%d/%s", testServerPort, pdfName)

		t.Run(pdfName, func(t *testing.T) {
			fileInfo, err := os.Stat(pdfPath)
			if err != nil {
				t.Fatalf("Failed to get file info: %v", err)
			}
			fileSize := fileInfo.Size()

			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			defer cancel()

			result, err := renderer.RenderFromURL(ctx, pdfURL, []int{0, 1, 2}, opts)
			if err != nil {
				t.Fatalf("Failed to render: %v", err)
			}

			// 计算分片占比
			bytesRatio := float64(result.Stats.TotalBytes) / float64(fileSize) * 100

			fmt.Printf("\n[%s]\n", pdfName)
			fmt.Println(strings.Repeat("-", 80))
			fmt.Printf("   📊 文件大小: %s\n", formatBytes(fileSize))
			fmt.Printf("   📑 总页数: %d\n", result.TotalPages)
			fmt.Printf("   🖼️  渲染页数: %d\n", len(result.Pages))
			fmt.Printf("   ⏱️  渲染耗时: %v\n", result.Stats.RenderTime)

			// 分片请求统计 - 这里应该能看到真正的按需加载效果
			fmt.Printf("   📦 分片请求统计:\n")
			fmt.Printf("      ├─ 分片请求数: %d\n", result.Stats.TotalRequests)
			fmt.Printf("      ├─ 分片总大小: %s\n", formatBytes(result.Stats.TotalBytes))
			fmt.Printf("      └─ 占文件大小: %.1f%%\n", bytesRatio)

			// 验证按需加载效果
			if bytesRatio > 50 && fileSize > 10*1024*1024 {
				fmt.Printf("   ⚠️  警告: 大文件下载比例过高，可能未实现真正的按需加载\n")
			} else if bytesRatio < 50 && fileSize > 10*1024*1024 {
				fmt.Printf("   ✅ 按需加载生效: 只下载了 %.1f%% 的数据\n", bytesRatio)
			}

			fmt.Printf("   📝 渲染结果:\n")
			for _, page := range result.Pages {
				if page.Error != nil {
					fmt.Printf("      Page %d: ❌ %v\n", page.PageNum, page.Error)
					t.Errorf("Page %d render error: %v", page.PageNum, page.Error)
					continue
				}
				fmt.Printf("      Page %d: ✅ %dx%d, %s\n",
					page.PageNum, page.Width, page.Height, formatBytes(int64(len(page.Data))))
			}

			// 累计统计
			totalStats.success++
			totalStats.totalFileSize += fileSize
			totalStats.totalRequests += result.Stats.TotalRequests
			totalStats.totalBytes += result.Stats.TotalBytes
		})
	}

	totalStats.files = len(pdfFiles)

	// 打印汇总
	fmt.Println("\n" + strings.Repeat("=", 80))
	fmt.Println("                         测试汇总")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("📄 PDF 文件: %d (成功: %d)\n", totalStats.files, totalStats.success)
	fmt.Printf("📦 分片统计汇总:\n")
	fmt.Printf("   ├─ PDF 总大小: %s\n", formatBytes(totalStats.totalFileSize))
	fmt.Printf("   ├─ 分片请求总数: %d\n", totalStats.totalRequests)
	fmt.Printf("   ├─ 分片总字节: %s\n", formatBytes(totalStats.totalBytes))
	fmt.Printf("   └─ 平均占比: %.1f%%\n",
		float64(totalStats.totalBytes)/float64(totalStats.totalFileSize)*100)
	fmt.Println(strings.Repeat("=", 80))
}

// TestCompareFitzVsPdfium 对比 go-fitz 和 pdfium 的分片加载效果
func TestCompareFitzVsPdfium(t *testing.T) {
	// 启动测试服务器
	server := startTestServer(t)
	defer server.Shutdown(context.Background())
	time.Sleep(500 * time.Millisecond)

	// 选择一个大文件测试
	pdfPath := filepath.Join(staticDir, "80M.pdf")
	if _, err := os.Stat(pdfPath); os.IsNotExist(err) {
		t.Skip("80M.pdf not found, skipping comparison test")
	}

	fileInfo, _ := os.Stat(pdfPath)
	fileSize := fileInfo.Size()
	pdfURL := fmt.Sprintf("http://localhost:%d/80M.pdf", testServerPort)

	opts := pdfrender.DefaultRenderOptions()
	ctx := context.Background()

	fmt.Println("\n" + strings.Repeat("=", 80))
	fmt.Println("              go-fitz vs pdfium 分片加载对比测试")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("📄 测试文件: 80M.pdf (%s)\n", formatBytes(fileSize))
	fmt.Printf("📑 渲染页数: 前 3 页\n\n")

	// 测试 go-fitz
	fmt.Println("📚 go-fitz (MuPDF) 测试:")
	fmt.Println(strings.Repeat("-", 40))
	fitzRenderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		t.Fatalf("Failed to create fitz renderer: %v", err)
	}
	defer fitzRenderer.Close()

	fitzResult, err := fitzRenderer.RenderFromURL(ctx, pdfURL, []int{0, 1, 2}, opts)
	if err != nil {
		t.Fatalf("Fitz render failed: %v", err)
	}

	fitzRatio := float64(fitzResult.Stats.TotalBytes) / float64(fileSize) * 100
	fmt.Printf("   分片请求数: %d\n", fitzResult.Stats.TotalRequests)
	fmt.Printf("   下载大小: %s (%.1f%%)\n", formatBytes(fitzResult.Stats.TotalBytes), fitzRatio)
	fmt.Printf("   渲染耗时: %v\n", fitzResult.Stats.RenderTime)

	// 测试 pdfium
	fmt.Println("\n📚 pdfium 测试:")
	fmt.Println(strings.Repeat("-", 40))
	pdfiumRenderer, err := pdfrender.NewPdfiumRenderer()
	if err != nil {
		t.Fatalf("Failed to create pdfium renderer: %v", err)
	}
	defer pdfiumRenderer.Close()

	pdfiumResult, err := pdfiumRenderer.RenderFromURL(ctx, pdfURL, []int{0, 1, 2}, opts)
	if err != nil {
		t.Fatalf("Pdfium render failed: %v", err)
	}

	pdfiumRatio := float64(pdfiumResult.Stats.TotalBytes) / float64(fileSize) * 100
	fmt.Printf("   分片请求数: %d\n", pdfiumResult.Stats.TotalRequests)
	fmt.Printf("   下载大小: %s (%.1f%%)\n", formatBytes(pdfiumResult.Stats.TotalBytes), pdfiumRatio)
	fmt.Printf("   渲染耗时: %v\n", pdfiumResult.Stats.RenderTime)

	// 对比结果
	fmt.Println("\n" + strings.Repeat("=", 80))
	fmt.Println("                         对比结果")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("📦 下载量对比:\n")
	fmt.Printf("   go-fitz: %s (%.1f%%)\n", formatBytes(fitzResult.Stats.TotalBytes), fitzRatio)
	fmt.Printf("   pdfium:  %s (%.1f%%)\n", formatBytes(pdfiumResult.Stats.TotalBytes), pdfiumRatio)
	
	if pdfiumRatio < fitzRatio {
		savings := fitzResult.Stats.TotalBytes - pdfiumResult.Stats.TotalBytes
		savingsPercent := float64(savings) / float64(fitzResult.Stats.TotalBytes) * 100
		fmt.Printf("   ✅ pdfium 节省了 %s (%.1f%%)\n", formatBytes(savings), savingsPercent)
	} else {
		fmt.Printf("   ⚠️  pdfium 未能减少下载量\n")
	}
	fmt.Println(strings.Repeat("=", 80))
}
