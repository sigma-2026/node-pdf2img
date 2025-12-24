package handler

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"pdf2img/pkg/pdfrender"
)

// PDF2ImgRequest 请求参数
type PDF2ImgRequest struct {
	URL         string `json:"url" binding:"required"`
	GlobalPadID string `json:"globalPadId" binding:"required"`
	Pages       string `json:"pages"` // "all", "[1,2,3]", "1"
	DPI         int    `json:"dpi"`
	Scale       float64 `json:"scale"`
}

// PDF2ImgResponse 响应结构
type PDF2ImgResponse struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data"`
}

// PageData 单页数据（与 Node.js 版本保持一致）
type PageData struct {
	PageNum   int    `json:"pageNum"`           // 1-based 页码（与 Node.js 保持一致）
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	CosKey    string `json:"cosKey,omitempty"`  // COS 路径（生产环境）
	Data      string `json:"data,omitempty"`    // Base64 编码的图片数据（开发环境）
	Error     string `json:"error,omitempty"`
}

// RenderResultData 渲染结果数据
type RenderResultData struct {
	TotalPages int        `json:"totalPages"`
	Pages      []PageData `json:"pages"`
	Stats      StatsData  `json:"stats"`
}

// StatsData 统计数据
type StatsData struct {
	LoadTimeMs    int64 `json:"loadTimeMs"`
	RenderTimeMs  int64 `json:"renderTimeMs"`
	TotalTimeMs   int64 `json:"totalTimeMs"`
	// 分片加载统计
	FileSize      int64 `json:"fileSize"`      // PDF 文件大小（字节）
	TotalRequests int64 `json:"totalRequests"` // 分片请求总数
	TotalBytes    int64 `json:"totalBytes"`    // 分片请求总字节数
}

// Handler HTTP 处理器
type Handler struct {
	renderer *pdfrender.PDFRenderer
}

// NewHandler 创建处理器
func NewHandler() (*Handler, error) {
	renderer, err := pdfrender.NewPDFRenderer()
	if err != nil {
		return nil, err
	}

	return &Handler{
		renderer: renderer,
	}, nil
}

// Close 关闭处理器
func (h *Handler) Close() error {
	if h.renderer != nil {
		return h.renderer.Close()
	}
	return nil
}

// PDF2Img 处理 PDF 转图片请求
func (h *Handler) PDF2Img(c *gin.Context) {
	var req PDF2ImgRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, PDF2ImgResponse{
			Code:    400,
			Message: fmt.Sprintf("Invalid request: %v", err),
			Data:    nil,
		})
		return
	}

	// 解析页码参数
	pages, err := parsePages(req.Pages)
	if err != nil {
		c.JSON(http.StatusBadRequest, PDF2ImgResponse{
			Code:    400,
			Message: fmt.Sprintf("Invalid pages parameter: %v", err),
			Data:    nil,
		})
		return
	}

	// 设置渲染选项
	opts := pdfrender.DefaultRenderOptions()
	if req.DPI > 0 {
		opts.DPI = req.DPI
	}
	if req.Scale > 0 {
		opts.Scale = req.Scale
	}

	// 设置超时
	ctx, cancel := context.WithTimeout(c.Request.Context(), 40*time.Second)
	defer cancel()

	// 渲染 PDF
	result, err := h.renderer.RenderFromURL(ctx, req.URL, pages, opts)
	if err != nil {
		c.JSON(http.StatusInternalServerError, PDF2ImgResponse{
			Code:    500,
			Message: fmt.Sprintf("Render failed: %v", err),
			Data:    nil,
		})
		return
	}

	// 构建响应
	pagesData := make([]PageData, len(result.Pages))
	for i, page := range result.Pages {
		pd := PageData{
			PageNum: page.PageNum, // 使用 1-based 页码
			Width:   page.Width,
			Height:  page.Height,
		}
		if page.Error != nil {
			pd.Error = page.Error.Error()
		} else {
			// 开发环境返回 Base64，生产环境应上传 COS
			pd.Data = base64.StdEncoding.EncodeToString(page.Data)
		}
		pagesData[i] = pd
	}

	c.JSON(http.StatusOK, PDF2ImgResponse{
		Code:    200,
		Message: "success",
		Data: RenderResultData{
			TotalPages: result.TotalPages,
			Pages:      pagesData,
			Stats: StatsData{
				LoadTimeMs:    result.Stats.LoadTime.Milliseconds(),
				RenderTimeMs:  result.Stats.RenderTime.Milliseconds(),
				TotalTimeMs:   result.Stats.TotalTime.Milliseconds(),
				FileSize:      result.Stats.FileSize,
				TotalRequests: result.Stats.TotalRequests,
				TotalBytes:    result.Stats.TotalBytes,
			},
		},
	})
}

// Health 健康检查
func (h *Handler) Health(c *gin.Context) {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	// 计算内存使用率
	heapUsage := float64(memStats.HeapAlloc) / float64(memStats.HeapSys) * 100

	// 简单的健康检查
	healthy := heapUsage < 80

	status := "healthy"
	code := 200
	if !healthy {
		status = "overloaded"
		code = 503
	}

	c.JSON(code, PDF2ImgResponse{
		Code:    code,
		Message: fmt.Sprintf("Service is %s", status),
		Data: gin.H{
			"healthy": healthy,
			"status":  status,
			"metrics": gin.H{
				"heap": gin.H{
					"usage":     fmt.Sprintf("%.2f", heapUsage),
					"threshold": 80,
					"healthy":   heapUsage < 80,
				},
				"goroutines": runtime.NumGoroutine(),
			},
		},
	})
}

// parsePages 解析页码参数
func parsePages(pagesStr string) ([]int, error) {
	if pagesStr == "" || pagesStr == "all" {
		return nil, nil // nil 表示所有页
	}

	pagesStr = strings.TrimSpace(pagesStr)

	// 尝试解析为单个数字
	if num, err := strconv.Atoi(pagesStr); err == nil {
		return []int{num - 1}, nil // 转换为 0-based
	}

	// 尝试解析为 JSON 数组 [1,2,3]
	if strings.HasPrefix(pagesStr, "[") && strings.HasSuffix(pagesStr, "]") {
		inner := strings.Trim(pagesStr, "[]")
		if inner == "" {
			return nil, nil
		}

		parts := strings.Split(inner, ",")
		pages := make([]int, 0, len(parts))
		for _, p := range parts {
			num, err := strconv.Atoi(strings.TrimSpace(p))
			if err != nil {
				return nil, fmt.Errorf("invalid page number: %s", p)
			}
			pages = append(pages, num-1) // 转换为 0-based
		}
		return pages, nil
	}

	return nil, fmt.Errorf("invalid pages format: %s", pagesStr)
}
