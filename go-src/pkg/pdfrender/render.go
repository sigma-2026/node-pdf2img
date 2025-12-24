package pdfrender

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"io"
	"runtime"
	"sync"
	"time"

	"github.com/chai2010/webp"
	"github.com/gen2brain/go-fitz"

	"pdf2img/pkg/rangeloader"
)

// PDFRenderer PDF 渲染器
type PDFRenderer struct {
	mu sync.Mutex
}

// RenderOptions 渲染选项
type RenderOptions struct {
	// DPI 渲染分辨率，默认 150
	DPI int
	// Scale 缩放比例，默认 1.0
	Scale float64
	// Format 输出格式: "png", "webp"
	Format string
	// Quality WebP 质量 (1-100)
	Quality int
}

// DefaultRenderOptions 默认渲染选项
// 与 Node.js 版本保持一致，默认输出 WebP 格式
func DefaultRenderOptions() RenderOptions {
	return RenderOptions{
		DPI:     150,
		Scale:   1.0,
		Format:  "webp",
		Quality: 85,
	}
}

// PageResult 单页渲染结果
type PageResult struct {
	PageIndex int    // 0-based 内部索引
	PageNum   int    // 1-based 页码（与 Node.js 保持一致）
	Width     int
	Height    int
	Data      []byte
	Error     error
}

// RenderResult 渲染结果
type RenderResult struct {
	TotalPages int
	Pages      []PageResult
	Stats      RenderStats
}

// RenderStats 渲染统计
type RenderStats struct {
	LoadTime      time.Duration
	RenderTime    time.Duration
	TotalTime     time.Duration
	// 分片加载统计
	FileSize      int64 // PDF 文件大小（字节）
	TotalRequests int64 // 分片请求总数
	TotalBytes    int64 // 分片请求总字节数
}

// NewPDFRenderer 创建 PDF 渲染器
func NewPDFRenderer() (*PDFRenderer, error) {
	return &PDFRenderer{}, nil
}

// Close 关闭渲染器
func (r *PDFRenderer) Close() error {
	return nil
}

// RenderFromURL 从 URL 渲染 PDF（支持分片加载）
// 注意：go-fitz (MuPDF) 需要完整的 PDF 数据才能渲染，
// 但我们使用分片并行下载来加速大文件的获取
func (r *PDFRenderer) RenderFromURL(ctx context.Context, url string, pages []int, opts RenderOptions) (*RenderResult, error) {
	startTime := time.Now()

	// 创建分片加载器
	loader, err := rangeloader.NewRangeLoader(url)
	if err != nil {
		return nil, fmt.Errorf("failed to create range loader: %w", err)
	}
	defer loader.Close()

	loadStartTime := time.Now()

	// 使用分片并行下载 PDF 数据
	// go-fitz 需要完整数据，但我们通过并行分片下载来加速
	data, err := loader.DownloadAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to download PDF data: %w", err)
	}

	loadTime := time.Since(loadStartTime)
	
	// 获取分片统计
	loaderStats := loader.Stats()

	// 使用 go-fitz 渲染
	return r.renderFromBytesWithStats(ctx, data, pages, opts, loadTime, startTime, loaderStats)
}

// RenderFromBytes 从字节数据渲染 PDF
func (r *PDFRenderer) RenderFromBytes(ctx context.Context, data []byte, pages []int, opts RenderOptions) (*RenderResult, error) {
	startTime := time.Now()
	return r.renderFromBytesWithStats(ctx, data, pages, opts, 0, startTime, rangeloader.LoaderStats{})
}

func (r *PDFRenderer) renderFromBytesWithStats(ctx context.Context, data []byte, pages []int, opts RenderOptions, loadTime time.Duration, startTime time.Time, loaderStats rangeloader.LoaderStats) (*RenderResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// 创建 fitz 文档
	doc, err := fitz.NewFromMemory(data)
	if err != nil {
		return nil, fmt.Errorf("failed to open PDF: %w", err)
	}
	defer doc.Close()

	totalPages := doc.NumPage()

	// 处理页码参数
	if len(pages) == 0 {
		pages = make([]int, totalPages)
		for i := 0; i < totalPages; i++ {
			pages[i] = i
		}
	}

	renderStartTime := time.Now()

	// 渲染指定页面
	results := make([]PageResult, len(pages))
	for i, pageIdx := range pages {
		if pageIdx < 0 || pageIdx >= totalPages {
			results[i] = PageResult{
				PageIndex: pageIdx,
				PageNum:   pageIdx + 1, // 1-based
				Error:     fmt.Errorf("page index out of range: %d", pageIdx),
			}
			continue
		}

		result, err := r.renderPage(doc, pageIdx, opts)
		if err != nil {
			results[i] = PageResult{
				PageIndex: pageIdx,
				PageNum:   pageIdx + 1, // 1-based
				Error:     err,
			}
		} else {
			results[i] = *result
		}

		// 每渲染几页检查内存
		if i > 0 && i%3 == 0 {
			runtime.GC()
		}
	}

	renderTime := time.Since(renderStartTime)
	totalTime := time.Since(startTime)

	return &RenderResult{
		TotalPages: totalPages,
		Pages:      results,
		Stats: RenderStats{
			LoadTime:      loadTime,
			RenderTime:    renderTime,
			TotalTime:     totalTime,
			FileSize:      loaderStats.FileSize,
			TotalRequests: loaderStats.TotalRequests,
			TotalBytes:    loaderStats.TotalBytes,
		},
	}, nil
}

// renderPage 渲染单页
func (r *PDFRenderer) renderPage(doc *fitz.Document, pageIdx int, opts RenderOptions) (*PageResult, error) {
	// 计算 DPI 对应的缩放
	// go-fitz 默认 72 DPI，我们需要按比例缩放
	dpiScale := float64(opts.DPI) / 72.0 * opts.Scale

	// 渲染页面为图像
	img, err := doc.ImageDPI(pageIdx, dpiScale*72)
	if err != nil {
		return nil, fmt.Errorf("failed to render page %d: %w", pageIdx, err)
	}

	// 获取图像尺寸
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()

	// 根据格式编码图像
	var buf bytes.Buffer
	switch opts.Format {
	case "webp":
		// 编码为 WebP（与 Node.js 版本保持一致）
		if err := webp.Encode(&buf, img, &webp.Options{Quality: float32(opts.Quality)}); err != nil {
			return nil, fmt.Errorf("failed to encode webp: %w", err)
		}
	case "png":
		if err := png.Encode(&buf, img); err != nil {
			return nil, fmt.Errorf("failed to encode png: %w", err)
		}
	default:
		// 默认使用 WebP
		if err := webp.Encode(&buf, img, &webp.Options{Quality: float32(opts.Quality)}); err != nil {
			return nil, fmt.Errorf("failed to encode image: %w", err)
		}
	}

	return &PageResult{
		PageIndex: pageIdx,
		PageNum:   pageIdx + 1, // 1-based，与 Node.js 保持一致
		Width:     width,
		Height:    height,
		Data:      buf.Bytes(),
	}, nil
}

// GetPageCount 获取 PDF 页数
func (r *PDFRenderer) GetPageCount(ctx context.Context, url string) (int, error) {
	loader, err := rangeloader.NewRangeLoader(url)
	if err != nil {
		return 0, err
	}
	defer loader.Close()

	data := make([]byte, loader.Size())
	_, err = loader.ReadAt(data, 0)
	if err != nil && err != io.EOF {
		return 0, err
	}

	doc, err := fitz.NewFromMemory(data)
	if err != nil {
		return 0, err
	}
	defer doc.Close()

	return doc.NumPage(), nil
}

// RenderSinglePage 渲染单页
func (r *PDFRenderer) RenderSinglePage(ctx context.Context, url string, pageIdx int, opts RenderOptions) (*PageResult, error) {
	result, err := r.RenderFromURL(ctx, url, []int{pageIdx}, opts)
	if err != nil {
		return nil, err
	}

	if len(result.Pages) == 0 {
		return nil, fmt.Errorf("no pages rendered")
	}

	return &result.Pages[0], nil
}

// ImageToBytes 将图像转换为字节
func ImageToBytes(img image.Image, format string, quality int) ([]byte, error) {
	var buf bytes.Buffer

	switch format {
	case "webp":
		if err := webp.Encode(&buf, img, &webp.Options{Quality: float32(quality)}); err != nil {
			return nil, err
		}
	case "png":
		if err := png.Encode(&buf, img); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported format: %s", format)
	}

	return buf.Bytes(), nil
}
