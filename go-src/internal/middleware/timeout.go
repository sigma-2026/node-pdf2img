package middleware

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// TimeoutConfig 超时配置
type TimeoutConfig struct {
	Timeout time.Duration
	// 豁免的路径
	ExemptPaths []string
}

// DefaultTimeoutConfig 默认超时配置
func DefaultTimeoutConfig() TimeoutConfig {
	return TimeoutConfig{
		Timeout: 40 * time.Second,
		ExemptPaths: []string{
			"/api/health",
			"/health",
		},
	}
}

// Timeout 超时中间件
func Timeout(config TimeoutConfig) gin.HandlerFunc {
	exemptMap := make(map[string]bool)
	for _, path := range config.ExemptPaths {
		exemptMap[path] = true
	}

	return func(c *gin.Context) {
		// 检查是否豁免
		if exemptMap[c.Request.URL.Path] {
			c.Next()
			return
		}

		// 创建带超时的 context
		ctx, cancel := context.WithTimeout(c.Request.Context(), config.Timeout)
		defer cancel()

		// 替换 request context
		c.Request = c.Request.WithContext(ctx)

		// 创建完成通道
		done := make(chan struct{})

		go func() {
			c.Next()
			close(done)
		}()

		select {
		case <-done:
			// 正常完成
		case <-ctx.Done():
			// 超时
			c.Abort()
			c.JSON(http.StatusRequestTimeout, gin.H{
				"code":    408,
				"message": "Request timeout after " + config.Timeout.String(),
				"data":    nil,
			})
		}
	}
}
