#!/bin/bash
# 本地测试脚本 - 测试 PDF 渲染和分片加载

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATIC_DIR="$(dirname "$PROJECT_DIR")/static"
OUTPUT_DIR="/tmp/go-pdf2img-test"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  PDF2IMG Go 版本本地测试${NC}"
echo -e "${BLUE}========================================${NC}"

# 创建输出目录
mkdir -p "$OUTPUT_DIR"
echo -e "${YELLOW}输出目录: $OUTPUT_DIR${NC}"

# 检查 PDF 文件
PDF_FILE="$STATIC_DIR/1M.pdf"
if [ ! -f "$PDF_FILE" ]; then
    echo -e "${RED}错误: 找不到测试 PDF 文件: $PDF_FILE${NC}"
    exit 1
fi

PDF_SIZE=$(stat -c%s "$PDF_FILE" 2>/dev/null || stat -f%z "$PDF_FILE")
echo -e "${GREEN}测试 PDF 文件: $PDF_FILE${NC}"
echo -e "${GREEN}PDF 文件大小: $PDF_SIZE bytes ($(echo "scale=2; $PDF_SIZE/1024/1024" | bc) MB)${NC}"

# 编译测试程序
echo -e "\n${YELLOW}编译测试程序...${NC}"
cd "$PROJECT_DIR"

# 创建临时测试文件
cat > /tmp/test_render_with_stats.go << 'GOEOF'
package main

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"os"
	"time"

	"github.com/gen2brain/go-fitz"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: test_render_with_stats <pdf_file> <output_dir>")
		os.Exit(1)
	}

	pdfPath := os.Args[1]
	outputDir := os.Args[2]

	fmt.Println("========================================")
	fmt.Println("  PDF 渲染测试（带统计信息）")
	fmt.Println("========================================")

	startTime := time.Now()

	// 读取 PDF 文件
	data, err := os.ReadFile(pdfPath)
	if err != nil {
		fmt.Printf("❌ 读取 PDF 失败: %v\n", err)
		os.Exit(1)
	}

	fileSize := len(data)
	loadTime := time.Since(startTime)

	fmt.Printf("\n📄 PDF 文件信息:\n")
	fmt.Printf("   文件路径: %s\n", pdfPath)
	fmt.Printf("   文件大小: %d bytes (%.2f MB)\n", fileSize, float64(fileSize)/1024/1024)
	fmt.Printf("   加载耗时: %v\n", loadTime)

	// 打开 PDF
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
	fmt.Printf("\n📊 统计信息:\n")
	fmt.Printf("   PDF 文件大小: %d bytes (%.2f MB)\n", fileSize, float64(fileSize)/1024/1024)
	fmt.Printf("   加载耗时: %v\n", loadTime)
	fmt.Printf("   渲染耗时: %v\n", renderTime)
	fmt.Printf("   总耗时: %v\n", totalTime)
	fmt.Printf("   渲染页数: %d/%d\n", pagesToRender, totalPages)

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
echo -e "\n${YELLOW}运行渲染测试...${NC}"
/usr/local/go/bin/go run /tmp/test_render_with_stats.go "$PDF_FILE" "$OUTPUT_DIR"

# 清理
rm -f /tmp/test_render_with_stats.go

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  测试完成！${NC}"
echo -e "${GREEN}========================================${NC}"
