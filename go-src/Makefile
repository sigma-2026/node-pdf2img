.PHONY: all build run test clean docker docker-cgo

# 变量
APP_NAME := pdf2img
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS := -ldflags="-w -s -X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME)"

# 默认目标
all: build

# 下载依赖
deps:
	go mod download
	go mod tidy

# 构建（无 CGO，使用 WASM pdfium）
build:
	CGO_ENABLED=0 go build $(LDFLAGS) -o bin/$(APP_NAME) ./cmd/server

# 构建（CGO，使用原生 pdfium）
build-cgo:
	CGO_ENABLED=1 go build -tags cgo $(LDFLAGS) -o bin/$(APP_NAME)-cgo ./cmd/server

# 运行开发服务器
run:
	go run ./cmd/server -port 3000 -mode debug

# 运行测试
test:
	go test -v -race ./...

# 运行基准测试
bench:
	go test -bench=. -benchmem ./...

# 清理
clean:
	rm -rf bin/
	go clean -cache

# 构建 Docker 镜像（WASM 版本）
docker:
	docker build -t $(APP_NAME):$(VERSION) -f Dockerfile .
	docker tag $(APP_NAME):$(VERSION) $(APP_NAME):latest

# 构建 Docker 镜像（CGO 版本）
docker-cgo:
	docker build -t $(APP_NAME)-cgo:$(VERSION) -f Dockerfile.cgo .
	docker tag $(APP_NAME)-cgo:$(VERSION) $(APP_NAME)-cgo:latest

# 推送镜像到 mirrors.tencent.com
push:
	docker tag $(APP_NAME):$(VERSION) mirrors.tencent.com/tdocs-pdf/$(APP_NAME)-go:$(VERSION)
	docker push mirrors.tencent.com/tdocs-pdf/$(APP_NAME)-go:$(VERSION)

# 推送镜像到 csighub
push-csighub:
	docker tag $(APP_NAME):$(VERSION) csighub.tencentyun.com/pdf-developer/$(APP_NAME)-go:$(VERSION)
	docker push csighub.tencentyun.com/pdf-developer/$(APP_NAME)-go:$(VERSION)

# 本地运行 Docker
docker-run:
	docker run -d --name $(APP_NAME)-go -p 3000:3000 $(APP_NAME):latest

# 停止并删除容器
docker-stop:
	docker stop $(APP_NAME)-go || true
	docker rm $(APP_NAME)-go || true

# 查看日志
docker-logs:
	docker logs -f $(APP_NAME)-go

# 代码检查
lint:
	golangci-lint run ./...

# 格式化代码
fmt:
	go fmt ./...
	goimports -w .

# 生成文档
doc:
	godoc -http=:6060

# 帮助
help:
	@echo "Available targets:"
	@echo "  deps        - Download dependencies"
	@echo "  build       - Build binary (WASM pdfium, no CGO)"
	@echo "  build-cgo   - Build binary (native pdfium, CGO)"
	@echo "  run         - Run development server"
	@echo "  test        - Run tests"
	@echo "  bench       - Run benchmarks"
	@echo "  clean       - Clean build artifacts"
	@echo "  docker      - Build Docker image (WASM)"
	@echo "  docker-cgo  - Build Docker image (CGO)"
	@echo "  push        - Push to mirrors.tencent.com"
	@echo "  lint        - Run linter"
	@echo "  fmt         - Format code"
