package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"pdf2img/internal/handler"
	"pdf2img/internal/middleware"
)

var (
	port    = flag.Int("port", 3000, "Server port")
	mode    = flag.String("mode", "release", "Gin mode: debug, release, test")
	version = "1.0.0"
)

func main() {
	flag.Parse()

	// 设置 Gin 模式
	gin.SetMode(*mode)

	// 创建 handler
	h, err := handler.NewHandler()
	if err != nil {
		log.Fatalf("Failed to create handler: %v", err)
	}
	defer h.Close()

	// 创建负载保护器
	loadProtector := middleware.NewLoadProtector(middleware.DefaultLoadProtectionConfig())

	// 创建路由
	r := gin.New()

	// 全局中间件
	r.Use(gin.Recovery())
	r.Use(gin.Logger())

	// 健康检查（不受超时和负载保护限制）
	r.GET("/api/health", h.Health)
	r.GET("/health", h.Health)

	// API 路由组
	api := r.Group("/api")
	api.Use(middleware.Timeout(middleware.DefaultTimeoutConfig()))
	api.Use(middleware.LoadProtection(loadProtector))
	{
		api.POST("/pdf2img", h.PDF2Img)
	}

	// 版本信息
	r.GET("/version", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"version": version,
			"runtime": "go",
		})
	})

	// 创建 HTTP 服务器
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", *port),
		Handler:      r,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// 启动服务器
	go func() {
		log.Printf("PDF2IMG Go Server starting on port %d...", *port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	// 优雅关闭
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server exited")
}
