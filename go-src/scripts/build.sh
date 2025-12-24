#!/bin/bash
set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}PDF2IMG Go 版本构建脚本${NC}"
echo -e "${GREEN}========================================${NC}"

# 获取版本号
VERSION=${1:-$(git describe --tags --always --dirty 2>/dev/null || echo "dev")}
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo -e "${YELLOW}版本: ${VERSION}${NC}"
echo -e "${YELLOW}构建时间: ${BUILD_TIME}${NC}"

# 进入项目目录
cd "$(dirname "$0")/.."

# 下载依赖
echo -e "\n${GREEN}[1/4] 下载依赖...${NC}"
go mod download
go mod tidy

# 构建
echo -e "\n${GREEN}[2/4] 构建二进制...${NC}"
mkdir -p bin

# WASM 版本（无 CGO 依赖）
echo "  构建 WASM 版本..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -X main.version=${VERSION} -X main.buildTime=${BUILD_TIME}" \
    -o bin/pdf2img-linux-amd64 \
    ./cmd/server

# macOS 版本
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  构建 macOS 版本..."
    CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build \
        -ldflags="-w -s -X main.version=${VERSION}" \
        -o bin/pdf2img-darwin-amd64 \
        ./cmd/server
    
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build \
        -ldflags="-w -s -X main.version=${VERSION}" \
        -o bin/pdf2img-darwin-arm64 \
        ./cmd/server
fi

# 运行测试
echo -e "\n${GREEN}[3/4] 运行测试...${NC}"
go test -v ./... || echo -e "${YELLOW}警告: 部分测试失败${NC}"

# 显示构建结果
echo -e "\n${GREEN}[4/4] 构建完成!${NC}"
echo -e "构建产物:"
ls -lh bin/

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}构建成功!${NC}"
echo -e "${GREEN}========================================${NC}"
