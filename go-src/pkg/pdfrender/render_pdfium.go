package pdfrender

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"io"
	"runtime"
	"sync"
	"time"

	"github.com/chai2010/webp"
	"github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/references"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"

	"pdf2img/pkg/rangeloader"
)

// PdfiumRenderer 基于 pdfium 的 PDF 渲染器
// 支持真正的按需加载（通过 io.ReadSeeker）
// 使用 WebAssembly 模式，无需安装 pdfium C 库
type PdfiumRenderer struct {
	pool     pdfium.Pool
	instance pdfium.Pdfium
	mu       sync.Mutex
}

// NewPdfiumRenderer 创建 pdfium 渲染器
// 使用 WebAssembly 模式，完全支持 io.ReadSeeker
func NewPdfiumRenderer() (*PdfiumRenderer, error) {
	// 初始化 WebAssembly 模式的 pdfium pool
	pool, err := webassembly.Init(webassembly.Config{
		MinIdle:  1,
		MaxIdle:  1,
		MaxTotal: 1,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to init pdfium pool: %w", err)
	}

	instance, err := pool.GetInstance(time.Second * 30)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to get pdfium instance: %w", err)
	}

	return &PdfiumRenderer{
		pool:     pool,
		instance: instance,
	}, nil
}

// Close 关闭渲染器
func (r *PdfiumRenderer) Close() error {
	if r.instance != nil {
		r.instance.Close()
	}
	if r.pool != nil {
		r.pool.Close()
	}
	return nil
}

// RangeReadSeeker 将 RangeLoader 包装为 io.ReadSeeker
// 这样 pdfium 可以按需读取数据，而不是一次性加载整个文件
type RangeReadSeeker struct {
	loader *rangeloader.RangeLoader
	ctx    context.Context
	offset int64
}

// NewRangeReadSeeker 创建 RangeReadSeeker
func NewRangeReadSeeker(ctx context.Context, loader *rangeloader.RangeLoader) *RangeReadSeeker {
	return &RangeReadSeeker{
		loader: loader,
		ctx:    ctx,
		offset: 0,
	}
}

// Read 实现 io.Reader
func (r *RangeReadSeeker) Read(p []byte) (n int, err error) {
	n, err = r.loader.ReadAtContext(r.ctx, p, r.offset)
	r.offset += int64(n)
	return n, err
}

// Seek 实现 io.Seeker
func (r *RangeReadSeeker) Seek(offset int64, whence int) (int64, error) {
	var newOffset int64
	switch whence {
	case io.SeekStart:
		newOffset = offset
	case io.SeekCurrent:
		newOffset = r.offset + offset
	case io.SeekEnd:
		newOffset = r.loader.Size() + offset
	default:
		return 0, fmt.Errorf("invalid whence: %d", whence)
	}

	if newOffset < 0 {
		return 0, fmt.Errorf("negative offset")
	}

	r.offset = newOffset
	return newOffset, nil
}

// RenderFromURL 从 URL 渲染 PDF（支持真正的按需加载）
func (r *PdfiumRenderer) RenderFromURL(ctx context.Context, url string, pages []int, opts RenderOptions) (*RenderResult, error) {
	startTime := time.Now()

	// 创建分片加载器
	loader, err := rangeloader.NewRangeLoader(url)
	if err != nil {
		return nil, fmt.Errorf("failed to create range loader: %w", err)
	}
	defer loader.Close()

	loadStartTime := time.Now()

	// 创建 ReadSeeker 包装器
	readSeeker := NewRangeReadSeeker(ctx, loader)

	// 使用 pdfium 打开文档（按需加载）
	doc, err := r.instance.OpenDocument(&requests.OpenDocument{
		FileReader:     readSeeker,
		FileReaderSize: loader.Size(),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to open PDF: %w", err)
	}
	defer r.instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{
		Document: doc.Document,
	})

	loadTime := time.Since(loadStartTime)

	// 获取页数
	pageCountResp, err := r.instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{
		Document: doc.Document,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get page count: %w", err)
	}
	totalPages := pageCountResp.PageCount

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
				PageNum:   pageIdx + 1,
				Error:     fmt.Errorf("page index out of range: %d", pageIdx),
			}
			continue
		}

		result, err := r.renderPagePdfium(doc.Document, pageIdx, opts)
		if err != nil {
			results[i] = PageResult{
				PageIndex: pageIdx,
				PageNum:   pageIdx + 1,
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

	// 获取分片统计
	loaderStats := loader.Stats()

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

// renderPagePdfium 使用 pdfium 渲染单页
func (r *PdfiumRenderer) renderPagePdfium(doc references.FPDF_DOCUMENT, pageIdx int, opts RenderOptions) (*PageResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// 获取页面尺寸
	pageSizeResp, err := r.instance.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{
		Document: doc,
		Index:    pageIdx,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get page size: %w", err)
	}

	// 计算渲染尺寸
	scale := float64(opts.DPI) / 72.0 * opts.Scale
	width := int(pageSizeResp.Width * scale)
	height := int(pageSizeResp.Height * scale)

	// 渲染页面为图像
	renderResp, err := r.instance.RenderPageInDPI(&requests.RenderPageInDPI{
		Page: requests.Page{
			ByIndex: &requests.PageByIndex{
				Document: doc,
				Index:    pageIdx,
			},
		},
		DPI: opts.DPI,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to render page: %w", err)
	}

	// 编码图像
	var buf bytes.Buffer
	switch opts.Format {
	case "webp":
		if err := webp.Encode(&buf, renderResp.Result.Image, &webp.Options{Quality: float32(opts.Quality)}); err != nil {
			return nil, fmt.Errorf("failed to encode webp: %w", err)
		}
	case "png":
		if err := png.Encode(&buf, renderResp.Result.Image); err != nil {
			return nil, fmt.Errorf("failed to encode png: %w", err)
		}
	default:
		if err := webp.Encode(&buf, renderResp.Result.Image, &webp.Options{Quality: float32(opts.Quality)}); err != nil {
			return nil, fmt.Errorf("failed to encode image: %w", err)
		}
	}

	return &PageResult{
		PageIndex: pageIdx,
		PageNum:   pageIdx + 1,
		Width:     width,
		Height:    height,
		Data:      buf.Bytes(),
	}, nil
}

// RenderFromBytes 从字节数据渲染 PDF
func (r *PdfiumRenderer) RenderFromBytes(ctx context.Context, data []byte, pages []int, opts RenderOptions) (*RenderResult, error) {
	startTime := time.Now()

	// 使用 pdfium 打开文档
	doc, err := r.instance.OpenDocument(&requests.OpenDocument{
		File: &data,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to open PDF: %w", err)
	}
	defer r.instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{
		Document: doc.Document,
	})

	// 获取页数
	pageCountResp, err := r.instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{
		Document: doc.Document,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get page count: %w", err)
	}
	totalPages := pageCountResp.PageCount

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
				PageNum:   pageIdx + 1,
				Error:     fmt.Errorf("page index out of range: %d", pageIdx),
			}
			continue
		}

		result, err := r.renderPagePdfium(doc.Document, pageIdx, opts)
		if err != nil {
			results[i] = PageResult{
				PageIndex: pageIdx,
				PageNum:   pageIdx + 1,
				Error:     err,
			}
		} else {
			results[i] = *result
		}

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
			LoadTime:   0,
			RenderTime: renderTime,
			TotalTime:  totalTime,
			FileSize:   int64(len(data)),
		},
	}, nil
}
