package test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pdf2img/pkg/pdfrender"
	"pdf2img/pkg/rangeloader"
)

const (
	testServerPort = 18080
	staticDir      = "/data/code/pdf2img/static"
)

// TestLocalPDFRender 测试本地 PDF 文件渲染（直接读取文件）
func TestLocalPDFRender(t *testing.T) {
	outputDir := "/tmp/go-local-render-test"
	os.MkdirAll(outputDir, 0755)
	defer os.RemoveAll(outputDir)

	pdfFiles, err := filepath.Glob(filepath.Join(staticDir, "*.pdf"))
	if err != nil {
		t.Fatalf("Failed to find PDF files: %v", err)
	}

	if len(pdfFiles) == 0 {
		t.Skip("No PDF files found in static directory")
	}

	renderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		t.Fatalf("Failed to create renderer: %v", err)
	}
	defer renderer.Close()

	opts := pdfrender.DefaultRenderOptions()

	fmt.Println("\n" + strings.Repeat("=", 80))
	fmt.Println("                    本地 PDF 渲染测试")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("输出格式: %s (质量: %d, DPI: %d)\n\n", opts.Format, opts.Quality, opts.DPI)

	for _, pdfPath := range pdfFiles {
		pdfName := filepath.Base(pdfPath)
		t.Run(pdfName, func(t *testing.T) {
			data, err := os.ReadFile(pdfPath)
			if err != nil {
				t.Fatalf("Failed to read PDF: %v", err)
			}

			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			defer cancel()

			result, err := renderer.RenderFromBytes(ctx, data, []int{0, 1, 2}, opts)
			if err != nil {
				t.Fatalf("Failed to render: %v", err)
			}

			fmt.Printf("\n[%s]\n", pdfName)
			fmt.Println(strings.Repeat("-", 80))
			fmt.Printf("   📊 文件大小: %s\n", formatBytes(int64(len(data))))
			fmt.Printf("   📑 总页数: %d\n", result.TotalPages)
			fmt.Printf("   🖼️  渲染页数: %d\n", len(result.Pages))
			fmt.Printf("   ⏱️  渲染耗时: %v\n", result.Stats.RenderTime)
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
		})
	}
}

// TestRangeLoaderRender 测试通过 Range 请求加载 PDF 并渲染（包含分片统计）
func TestRangeLoaderRender(t *testing.T) {
	outputDir := "/tmp/go-range-render-test"
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

	renderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		t.Fatalf("Failed to create renderer: %v", err)
	}
	defer renderer.Close()

	opts := pdfrender.DefaultRenderOptions()

	fmt.Println("\n" + strings.Repeat("=", 80))
	fmt.Println("              分片加载 PDF 渲染测试 (Range Request)")
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

			// 分片请求统计
			fmt.Printf("   📦 分片请求统计:\n")
			fmt.Printf("      ├─ 分片请求数: %d\n", result.Stats.TotalRequests)
			fmt.Printf("      ├─ 分片总大小: %s\n", formatBytes(result.Stats.TotalBytes))
			fmt.Printf("      └─ 占文件大小: %.1f%%\n", bytesRatio)

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

// TestAllPDFsWithStats 完整测试所有 PDF 文件（输出详细统计）
func TestAllPDFsWithStats(t *testing.T) {
	outputDir := "/tmp/go-full-test"
	os.MkdirAll(outputDir, 0755)

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

	renderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		t.Fatalf("Failed to create renderer: %v", err)
	}
	defer renderer.Close()

	opts := pdfrender.DefaultRenderOptions()

	fmt.Println("\n" + strings.Repeat("=", 80))
	fmt.Println("              Go PDF2IMG 完整测试 (保存输出文件)")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("📁 静态目录: %s\n", staticDir)
	fmt.Printf("📂 输出目录: %s\n", outputDir)
	fmt.Printf("🌐 测试服务器: http://localhost:%d\n", testServerPort)
	fmt.Printf("🎨 输出格式: %s (质量: %d, DPI: %d)\n", opts.Format, opts.Quality, opts.DPI)
	fmt.Printf("📦 分片大小: %s (子分片: %s)\n", 
		formatBytes(rangeloader.DefaultChunkSize),
		formatBytes(rangeloader.DefaultSmallChunkSize))
	fmt.Println(strings.Repeat("=", 80))

	var totalStats struct {
		files         int
		success       int
		failed        int
		totalFileSize int64
		totalRequests int64
		totalBytes    int64
		totalPages    int
	}

	for i, pdfPath := range pdfFiles {
		pdfName := filepath.Base(pdfPath)
		pdfOutputDir := filepath.Join(outputDir, strings.TrimSuffix(pdfName, ".pdf"))
		os.MkdirAll(pdfOutputDir, 0755)

		pdfURL := fmt.Sprintf("http://localhost:%d/%s", testServerPort, pdfName)

		fmt.Printf("\n[%d/%d] 📄 %s\n", i+1, len(pdfFiles), pdfName)
		fmt.Println(strings.Repeat("-", 80))

		fileInfo, err := os.Stat(pdfPath)
		if err != nil {
			fmt.Printf("   ❌ 获取文件信息失败: %v\n", err)
			totalStats.failed++
			continue
		}
		fileSize := fileInfo.Size()

		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		result, err := renderer.RenderFromURL(ctx, pdfURL, []int{0, 1, 2}, opts)
		cancel()

		if err != nil {
			fmt.Printf("   ❌ 渲染失败: %v\n", err)
			totalStats.failed++
			continue
		}

		// 计算分片占比
		bytesRatio := float64(result.Stats.TotalBytes) / float64(fileSize) * 100

		fmt.Printf("   📊 文件大小: %s\n", formatBytes(fileSize))
		fmt.Printf("   📑 总页数: %d\n", result.TotalPages)
		fmt.Printf("   🖼️  渲染页数: %d\n", len(result.Pages))
		fmt.Printf("   ⏱️  渲染耗时: %v\n", result.Stats.RenderTime)

		// 分片请求统计
		fmt.Printf("   📦 分片请求统计:\n")
		fmt.Printf("      ├─ 分片请求数: %d\n", result.Stats.TotalRequests)
		fmt.Printf("      ├─ 分片总大小: %s\n", formatBytes(result.Stats.TotalBytes))
		fmt.Printf("      └─ 占文件大小: %.1f%%\n", bytesRatio)

		// 保存渲染结果
		fmt.Printf("   📝 渲染结果:\n")
		for _, page := range result.Pages {
			if page.Error != nil {
				fmt.Printf("      Page %d: ❌ %v\n", page.PageNum, page.Error)
				continue
			}

			filename := filepath.Join(pdfOutputDir, fmt.Sprintf("page_%d.webp", page.PageNum))
			if err := os.WriteFile(filename, page.Data, 0644); err != nil {
				fmt.Printf("      Page %d: ❌ 保存失败: %v\n", page.PageNum, err)
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
		totalStats.totalPages += len(result.Pages)
	}

	totalStats.files = len(pdfFiles)

	// 汇总
	fmt.Println("\n" + strings.Repeat("=", 80))
	fmt.Println("                         测试汇总")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("📄 PDF 文件: %d (成功: %d, 失败: %d)\n", totalStats.files, totalStats.success, totalStats.failed)
	fmt.Printf("🖼️  渲染页数: %d\n", totalStats.totalPages)
	fmt.Println(strings.Repeat("-", 80))
	fmt.Printf("📦 分片统计汇总:\n")
	fmt.Printf("   ├─ PDF 总大小: %s\n", formatBytes(totalStats.totalFileSize))
	fmt.Printf("   ├─ 分片请求总数: %d\n", totalStats.totalRequests)
	fmt.Printf("   ├─ 分片总字节: %s\n", formatBytes(totalStats.totalBytes))
	fmt.Printf("   └─ 平均占比: %.1f%%\n",
		float64(totalStats.totalBytes)/float64(totalStats.totalFileSize)*100)
	fmt.Println(strings.Repeat("-", 80))
	fmt.Printf("📂 输出目录: %s\n", outputDir)
	fmt.Println(strings.Repeat("=", 80))

	// 显示输出文件
	fmt.Println("\n📁 生成的文件:")
	filepath.Walk(outputDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		relPath, _ := filepath.Rel(outputDir, path)
		fmt.Printf("   %s (%s)\n", relPath, formatBytes(info.Size()))
		return nil
	})

	if totalStats.failed > 0 {
		t.Errorf("%d PDF files failed to render", totalStats.failed)
	}
}

func startTestServer(t *testing.T) *http.Server {
	mux := http.NewServeMux()
	fileServer := http.FileServer(http.Dir(staticDir))
	mux.Handle("/", fileServer)

	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", testServerPort),
		Handler: mux,
	}

	go func() {
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			t.Logf("Server error: %v", err)
		}
	}()

	return server
}

func formatBytes(bytes int64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
	)

	switch {
	case bytes >= GB:
		return fmt.Sprintf("%.2f GB", float64(bytes)/GB)
	case bytes >= MB:
		return fmt.Sprintf("%.2f MB", float64(bytes)/MB)
	case bytes >= KB:
		return fmt.Sprintf("%.2f KB", float64(bytes)/KB)
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}
