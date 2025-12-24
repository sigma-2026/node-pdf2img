#!/bin/bash
# 测试分片加载功能 - 启动本地服务器并测试 Range 请求

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATIC_DIR="$(dirname "$PROJECT_DIR")/static"
OUTPUT_DIR="/tmp/go-pdf2img-range-test"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

TEST_SERVER_PORT=18080
TEST_SERVER_PID=""

# 清理函数
cleanup() {
    if [ -n "$TEST_SERVER_PID" ]; then
        echo -e "\n${YELLOW}停止测试服务器 (PID: $TEST_SERVER_PID)...${NC}"
        kill $TEST_SERVER_PID 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  PDF2IMG 分片加载测试${NC}"
echo -e "${BLUE}========================================${NC}"

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 编译测试服务器
echo -e "\n${YELLOW}1. 编译测试服务器...${NC}"
cd "$PROJECT_DIR"
/usr/local/go/bin/go build -o /tmp/testserver ./cmd/testserver

# 启动测试服务器
echo -e "${YELLOW}2. 启动测试服务器 (端口: $TEST_SERVER_PORT)...${NC}"
/tmp/testserver -port $TEST_SERVER_PORT -dir "$STATIC_DIR" -v &
TEST_SERVER_PID=$!
sleep 1

# 检查服务器是否启动
if ! kill -0 $TEST_SERVER_PID 2>/dev/null; then
    echo -e "${RED}❌ 测试服务器启动失败${NC}"
    exit 1
fi
echo -e "${GREEN}✅ 测试服务器已启动 (PID: $TEST_SERVER_PID)${NC}"

# 测试 Range 请求
echo -e "\n${YELLOW}3. 测试 Range 请求...${NC}"
PDF_URL="http://localhost:$TEST_SERVER_PORT/1M.pdf"

# 获取文件大小
echo -e "   获取文件大小..."
FILE_SIZE=$(curl -sI "$PDF_URL" | grep -i content-length | awk '{print $2}' | tr -d '\r')
echo -e "   ${GREEN}文件大小: $FILE_SIZE bytes${NC}"

# 测试 Range 请求
echo -e "   测试 Range 请求 (bytes=0-1023)..."
RANGE_RESPONSE=$(curl -s -I -H "Range: bytes=0-1023" "$PDF_URL")
CONTENT_RANGE=$(echo "$RANGE_RESPONSE" | grep -i content-range | tr -d '\r')
echo -e "   ${GREEN}$CONTENT_RANGE${NC}"

# 运行 Go 测试程序
echo -e "\n${YELLOW}4. 运行分片加载渲染测试...${NC}"

# 创建测试程序
cat > /tmp/test_range_render.go << 'GOEOF'
package main

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"os"
	"time"

	"github.com/gen2brain/go-fitz"
	"pdf2img/pkg/rangeloader"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: test_range_render <pdf_url> <output_dir>")
		os.Exit(1)
	}

	pdfURL := os.Args[1]
	outputDir := os.Args[2]

	fmt.Println("========================================")
	fmt.Println("  分片加载渲染测试")
	fmt.Println("========================================")

	startTime := time.Now()

	// 创建分片加载器
	fmt.Printf("\n📥 创建分片加载器...\n")
	fmt.Printf("   URL: %s\n", pdfURL)
	
	loader, err := rangeloader.NewRangeLoader(pdfURL)
	if err != nil {
		fmt.Printf("❌ 创建加载器失败: %v\n", err)
		os.Exit(1)
	}
	defer loader.Close()

	fileSize := loader.Size()
	fmt.Printf("   文件大小: %d bytes (%.2f MB)\n", fileSize, float64(fileSize)/1024/1024)

	// 读取 PDF 数据
	fmt.Printf("\n📄 读取 PDF 数据...\n")
	loadStartTime := time.Now()
	
	data := make([]byte, fileSize)
	n, err := loader.ReadAt(data, 0)
	if err != nil && err.Error() != "EOF" {
		fmt.Printf("❌ 读取数据失败: %v\n", err)
		os.Exit(1)
	}
	
	loadTime := time.Since(loadStartTime)
	stats := loader.Stats()
	
	fmt.Printf("   读取字节数: %d\n", n)
	fmt.Printf("   加载耗时: %v\n", loadTime)
	fmt.Printf("   分片请求数: %d\n", stats.TotalRequests)
	fmt.Printf("   分片总字节数: %d bytes (%.2f MB)\n", stats.TotalBytes, float64(stats.TotalBytes)/1024/1024)
	fmt.Printf("   缓存命中: %d\n", stats.CacheHits)
	fmt.Printf("   缓存未命中: %d\n", stats.CacheMisses)

	// 打开 PDF
	fmt.Printf("\n🔍 解析 PDF...\n")
	doc, err := fitz.NewFromMemory(data)
	if err != nil {
		fmt.Printf("❌ 打开 PDF 失败: %v\n", err)
		os.Exit(1)
	}
	defer doc.Close()

	totalPages := doc.NumPage()
	fmt.Printf("   总页数: %d\n", totalPages)

	// 渲染页面
	fmt.Printf("\n🖼️  渲染页面:\n")
	renderStartTime := time.Now()

	// 只渲染前 3 页用于测试
	pagesToRender := totalPages
	if pagesToRender > 3 {
		pagesToRender = 3
	}

	for i := 0; i < pagesToRender; i++ {
		pageStartTime := time.Now()

		// 渲染页面 (150 DPI)
		dpiScale := 150.0 / 72.0
		img, err := doc.ImageDPI(i, dpiScale*72)
		if err != nil {
			fmt.Printf("   ❌ 页面 %d 渲染失败: %v\n", i+1, err)
			continue
		}

		bounds := img.Bounds()
		width := bounds.Dx()
		height := bounds.Dy()

		// 编码为 PNG
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			fmt.Printf("   ❌ 页面 %d 编码失败: %v\n", i+1, err)
			continue
		}

		// 保存文件
		outputPath := fmt.Sprintf("%s/page_%d.png", outputDir, i+1)
		if err := os.WriteFile(outputPath, buf.Bytes(), 0644); err != nil {
			fmt.Printf("   ❌ 页面 %d 保存失败: %v\n", i+1, err)
			continue
		}

		pageTime := time.Since(pageStartTime)
		fmt.Printf("   ✅ 页面 %d: %dx%d, %d bytes (%.2f KB), 耗时 %v\n",
			i+1, width, height, buf.Len(), float64(buf.Len())/1024, pageTime)
	}

	renderTime := time.Since(renderStartTime)
	totalTime := time.Since(startTime)

	// 输出统计信息
	fmt.Printf("\n📊 统计汇总:\n")
	fmt.Printf("   ┌─────────────────────────────────────┐\n")
	fmt.Printf("   │ PDF 文件大小: %10d bytes     │\n", fileSize)
	fmt.Printf("   │ 分片请求数:   %10d           │\n", stats.TotalRequests)
	fmt.Printf("   │ 分片总字节:   %10d bytes     │\n", stats.TotalBytes)
	fmt.Printf("   │ 加载耗时:     %18v │\n", loadTime)
	fmt.Printf("   │ 渲染耗时:     %18v │\n", renderTime)
	fmt.Printf("   │ 总耗时:       %18v │\n", totalTime)
	fmt.Printf("   │ 渲染页数:     %10d/%d         │\n", pagesToRender, totalPages)
	fmt.Printf("   └─────────────────────────────────────┘\n")

	fmt.Printf("\n✅ 测试完成！输出目录: %s\n", outputDir)
	
	// 列出生成的文件
	fmt.Printf("\n📁 生成的文件:\n")
	files, _ := os.ReadDir(outputDir)
	for _, f := range files {
		info, _ := f.Info()
		fmt.Printf("   - %s (%d bytes)\n", f.Name(), info.Size())
	}
}
GOEOF

# 运行测试
cd "$PROJECT_DIR"
/usr/local/go/bin/go run /tmp/test_range_render.go "$PDF_URL" "$OUTPUT_DIR"

# 清理
rm -f /tmp/test_range_render.go
rm -f /tmp/testserver

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  测试完成！${NC}"
echo -e "${GREEN}========================================${NC}"
