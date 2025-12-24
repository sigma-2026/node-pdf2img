package middleware

import (
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// LoadProtectionConfig 负载保护配置
type LoadProtectionConfig struct {
	// CPU 使用率阈值 (0-100)
	CPUThreshold float64
	// 堆内存使用率阈值 (0-100)
	HeapThreshold float64
	// 检查间隔
	CheckInterval time.Duration
}

// DefaultLoadProtectionConfig 默认负载保护配置
func DefaultLoadProtectionConfig() LoadProtectionConfig {
	return LoadProtectionConfig{
		CPUThreshold:  85,
		HeapThreshold: 80,
		CheckInterval: time.Second,
	}
}

// LoadProtector 负载保护器
type LoadProtector struct {
	config    LoadProtectionConfig
	mu        sync.RWMutex
	lastCheck time.Time
	overloaded bool
	reasons   []string
}

// NewLoadProtector 创建负载保护器
func NewLoadProtector(config LoadProtectionConfig) *LoadProtector {
	return &LoadProtector{
		config: config,
	}
}

// Check 检查系统负载
func (lp *LoadProtector) Check() (bool, []string) {
	lp.mu.Lock()
	defer lp.mu.Unlock()

	// 限制检查频率
	if time.Since(lp.lastCheck) < lp.config.CheckInterval {
		return lp.overloaded, lp.reasons
	}
	lp.lastCheck = time.Now()

	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	reasons := make([]string, 0)
	overloaded := false

	// 检查堆内存
	heapUsage := float64(memStats.HeapAlloc) / float64(memStats.HeapSys) * 100
	if heapUsage > lp.config.HeapThreshold {
		overloaded = true
		reasons = append(reasons, "堆内存过载: "+formatPercent(heapUsage)+" (阈值: "+formatPercent(lp.config.HeapThreshold)+")")
	}

	// 检查 goroutine 数量（作为负载指标）
	numGoroutines := runtime.NumGoroutine()
	if numGoroutines > 1000 {
		overloaded = true
		reasons = append(reasons, "Goroutine 过多: "+string(rune(numGoroutines)))
	}

	lp.overloaded = overloaded
	lp.reasons = reasons

	return overloaded, reasons
}

func formatPercent(v float64) string {
	return string(rune(int(v*100)/100)) + "%"
}

// LoadProtection 负载保护中间件
func LoadProtection(protector *LoadProtector) gin.HandlerFunc {
	return func(c *gin.Context) {
		overloaded, reasons := protector.Check()

		if overloaded {
			c.Abort()
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"code":    503,
				"message": "Service is overloaded, please try again later",
				"data": gin.H{
					"reasons":    reasons,
					"retryAfter": 5,
				},
			})
			return
		}

		c.Next()
	}
}
